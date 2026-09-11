-- Replace the retired GitHub Models provider with GitHub Copilot metadata.
--
-- Apply after 0003_llm_accounts.sql. This migration is transactional and safe
-- to re-run. It does not install or execute the GitHub Copilot SDK.

begin;

alter table carcanhol.llm_account_secrets
  add column if not exists aad_provider text;

-- Preserve the provider used in each existing AES-256-GCM AAD before the
-- account provider is renamed. Future rotations replace it atomically.
update carcanhol.llm_account_secrets as secret
set aad_provider = account.provider
from carcanhol.llm_accounts as account
where account.id = secret.account_id
  and account.user_id = secret.user_id
  and secret.aad_provider is null;

alter table carcanhol.llm_account_secrets
  alter column aad_provider set not null;

alter table carcanhol.llm_accounts
  drop constraint if exists llm_accounts_provider_allowed;
alter table carcanhol.llm_accounts
  drop constraint if exists llm_accounts_credential_type_allowed;
alter table carcanhol.llm_accounts
  drop constraint if exists llm_accounts_credential_type_by_provider;

update carcanhol.llm_accounts
set credential_type = case credential_type
  when 'oauth' then 'oauth_app_user'
  else 'fine_grained_pat'
end
where provider = 'github_models';

update carcanhol.llm_accounts
set provider = 'github_copilot'
where provider = 'github_models';

alter table carcanhol.llm_accounts
  add constraint llm_accounts_provider_allowed
  check (
    provider in (
      'github_copilot',
      'anthropic',
      'google_gemini',
      'deepseek',
      'openai_compatible'
    )
  );

alter table carcanhol.llm_accounts
  add constraint llm_accounts_credential_type_allowed
  check (
    credential_type in (
      'fine_grained_pat',
      'oauth_app_user',
      'github_app_user',
      'api_key',
      'token',
      'oauth'
    )
  );

alter table carcanhol.llm_accounts
  add constraint llm_accounts_credential_type_by_provider
  check (
    (
      provider = 'github_copilot'
      and credential_type in (
        'fine_grained_pat',
        'oauth_app_user',
        'github_app_user'
      )
    )
    or (
      provider <> 'github_copilot'
      and credential_type in ('api_key', 'token', 'oauth')
    )
  );

alter table carcanhol.llm_account_secrets
  drop constraint if exists llm_account_secrets_aad_provider_format;
alter table carcanhol.llm_account_secrets
  add constraint llm_account_secrets_aad_provider_format
  check (
    char_length(aad_provider) between 1 and 64
    and aad_provider ~ '^[a-z0-9_]+$'
  );

comment on column carcanhol.llm_account_secrets.aad_provider is
  'Provider value authenticated by the AES-256-GCM envelope. It can retain github_models for envelopes created before migration 0004.';

create or replace function carcanhol.create_llm_account_with_secret(
  p_account_id uuid,
  p_user_id uuid,
  p_provider text,
  p_display_name text,
  p_credential_type text,
  p_custom_endpoint text,
  p_credential_suffix text,
  p_ciphertext text,
  p_nonce text,
  p_auth_tag text,
  p_algorithm text,
  p_envelope_version smallint,
  p_key_version text
)
returns setof carcanhol.llm_accounts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_account carcanhol.llm_accounts;
begin
  if not exists (
    select 1
    from carcanhol.profiles as profile
    where profile.id = p_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'Carcanhol membership is required.';
  end if;

  insert into carcanhol.llm_accounts (
    id,
    user_id,
    provider,
    display_name,
    credential_type,
    custom_endpoint,
    credential_suffix
  )
  values (
    p_account_id,
    p_user_id,
    p_provider,
    p_display_name,
    p_credential_type,
    p_custom_endpoint,
    p_credential_suffix
  )
  returning * into created_account;

  insert into carcanhol.llm_account_secrets (
    account_id,
    user_id,
    aad_provider,
    ciphertext,
    nonce,
    auth_tag,
    algorithm,
    envelope_version,
    key_version
  )
  values (
    created_account.id,
    created_account.user_id,
    created_account.provider,
    p_ciphertext,
    p_nonce,
    p_auth_tag,
    p_algorithm,
    p_envelope_version,
    p_key_version
  );

  return next created_account;
end;
$$;

create or replace function carcanhol.rotate_llm_account_secret(
  p_account_id uuid,
  p_user_id uuid,
  p_credential_suffix text,
  p_ciphertext text,
  p_nonce text,
  p_auth_tag text,
  p_algorithm text,
  p_envelope_version smallint,
  p_key_version text
)
returns setof carcanhol.llm_accounts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  rotated_account carcanhol.llm_accounts;
begin
  update carcanhol.llm_account_secrets as secret
  set
    aad_provider = account.provider,
    ciphertext = p_ciphertext,
    nonce = p_nonce,
    auth_tag = p_auth_tag,
    algorithm = p_algorithm,
    envelope_version = p_envelope_version,
    key_version = p_key_version,
    credential_version = secret.credential_version + 1,
    updated_at = now()
  from carcanhol.llm_accounts as account
  where secret.account_id = p_account_id
    and secret.user_id = p_user_id
    and account.id = secret.account_id
    and account.user_id = secret.user_id;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Owned LLM account secret was not found.';
  end if;

  update carcanhol.llm_accounts
  set
    credential_suffix = p_credential_suffix,
    credential_updated_at = now(),
    status = 'pending_validation',
    last_validation_status = null,
    last_validation_at = null,
    last_validation_error_code = null,
    updated_at = now()
  where id = p_account_id
    and user_id = p_user_id
  returning * into rotated_account;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Owned LLM account was not found.';
  end if;

  return next rotated_account;
end;
$$;

revoke all on function carcanhol.create_llm_account_with_secret(
  uuid, uuid, text, text, text, text, text, text, text, text, text, smallint, text
) from public, anon, authenticated;
revoke all on function carcanhol.rotate_llm_account_secret(
  uuid, uuid, text, text, text, text, text, smallint, text
) from public, anon, authenticated;

grant execute on function carcanhol.create_llm_account_with_secret(
  uuid, uuid, text, text, text, text, text, text, text, text, text, smallint, text
) to service_role;
grant execute on function carcanhol.rotate_llm_account_secret(
  uuid, uuid, text, text, text, text, text, smallint, text
) to service_role;

commit;
