-- Real GitHub Copilot account validation and model discovery.
--
-- Apply after 0004_github_copilot_provider.sql. The migration is
-- transactional, safe to re-run, and changes objects only in "carcanhol".
-- Validation runs outside Postgres; service-role-only RPCs atomically persist
-- already-sanitized results and reject stale completions.

begin;

alter table carcanhol.llm_accounts
  add column if not exists validation_generation bigint not null default 0;
alter table carcanhol.llm_accounts
  add column if not exists last_validation_request_id uuid;

alter table carcanhol.llm_account_models
  add column if not exists is_stale boolean not null default true;

update carcanhol.llm_account_models
set enabled = false
where is_stale
  and enabled;

alter table carcanhol.llm_accounts
  drop constraint if exists llm_accounts_status_allowed;
alter table carcanhol.llm_accounts
  add constraint llm_accounts_status_allowed
  check (
    status in (
      'pending_validation',
      'active',
      'invalid',
      'error',
      'inactive'
    )
  );

alter table carcanhol.llm_accounts
  drop constraint if exists llm_accounts_validation_status_allowed;
alter table carcanhol.llm_accounts
  add constraint llm_accounts_validation_status_allowed
  check (
    last_validation_status is null
    or last_validation_status in ('succeeded', 'failed')
  );

alter table carcanhol.llm_accounts
  drop constraint if exists llm_accounts_validation_metadata_consistent;
alter table carcanhol.llm_accounts
  add constraint llm_accounts_validation_metadata_consistent
  check (
    (
      status in ('pending_validation', 'inactive')
      and last_validation_status is null
      and last_validation_at is null
      and last_validation_error_code is null
    )
    or (
      status = 'active'
      and last_validation_status = 'succeeded'
      and last_validation_at is not null
      and last_validation_error_code is null
    )
    or (
      status in ('invalid', 'error')
      and last_validation_status = 'failed'
      and last_validation_at is not null
      and last_validation_error_code in (
        'invalid_token',
        'no_subscription',
        'org_policy_blocked',
        'timeout',
        'unavailable',
        'no_models',
        'unknown',
        'provider_validation_unavailable'
      )
    )
  );

alter table carcanhol.llm_accounts
  drop constraint if exists llm_accounts_validation_generation_valid;
alter table carcanhol.llm_accounts
  add constraint llm_accounts_validation_generation_valid
  check (validation_generation >= 0);

alter table carcanhol.llm_account_models
  drop constraint if exists llm_account_models_metadata_size;
alter table carcanhol.llm_account_models
  add constraint llm_account_models_metadata_size
  check (pg_column_size(discovery_metadata) <= 8192);

alter table carcanhol.llm_account_models
  drop constraint if exists llm_account_models_stale_disabled;
alter table carcanhol.llm_account_models
  add constraint llm_account_models_stale_disabled
  check (not is_stale or not enabled);

comment on column carcanhol.llm_accounts.validation_generation is
  'Monotonic generation used with last_validation_request_id to reject stale validation results.';
comment on column carcanhol.llm_accounts.last_validation_request_id is
  'Opaque BFF request id for the latest validation attempt; never a provider credential.';
comment on column carcanhol.llm_account_models.is_stale is
  'True when the model was not confirmed by the latest successful validation. Stale models are always disabled.';

create index if not exists llm_accounts_user_validation_idx
  on carcanhol.llm_accounts (
    user_id,
    provider,
    status,
    last_validation_at desc
  );

create index if not exists llm_account_models_account_stale_idx
  on carcanhol.llm_account_models (
    account_id,
    is_stale,
    display_name
  );

create or replace function carcanhol.llm_model_catalog_is_valid(
  p_models jsonb
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_models) <> 'array' then false
    when jsonb_array_length(p_models) < 1 then false
    when jsonb_array_length(p_models) > 100 then false
    when pg_column_size(p_models) > 262144 then false
    else
      not exists (
        select 1
        from jsonb_array_elements(p_models) as entry(model)
        where jsonb_typeof(model) <> 'object'
          or model - array[
            'id',
            'displayName',
            'capabilities',
            'policy',
            'billing'
          ] <> '{}'::jsonb
          or not (model ? 'id')
          or jsonb_typeof(model -> 'id') <> 'string'
          or char_length(btrim(model ->> 'id')) < 1
          or char_length(model ->> 'id') > 255
          or not (model ? 'displayName')
          or jsonb_typeof(model -> 'displayName') <> 'string'
          or char_length(btrim(model ->> 'displayName')) < 1
          or char_length(model ->> 'displayName') > 255
          or not (model ? 'capabilities')
          or jsonb_typeof(model -> 'capabilities') <> 'object'
          or (model -> 'capabilities') - array[
            'supportsVision',
            'supportsReasoningEffort',
            'maxPromptTokens',
            'maxContextWindowTokens'
          ] <> '{}'::jsonb
          or pg_column_size(model -> 'capabilities') > 4096
          or not (model ? 'policy')
          or jsonb_typeof(model -> 'policy') <> 'object'
          or (model -> 'policy') - array['state'] <> '{}'::jsonb
          or (
            model -> 'policy' ? 'state'
            and (
              jsonb_typeof(model -> 'policy' -> 'state') <> 'string'
              or model -> 'policy' ->> 'state' not in (
                'enabled',
                'disabled',
                'unconfigured'
              )
            )
          )
          or pg_column_size(model -> 'policy') > 2048
          or not (model ? 'billing')
          or jsonb_typeof(model -> 'billing') <> 'object'
          or (model -> 'billing') - array['multiplier'] <> '{}'::jsonb
          or (
            model -> 'billing' ? 'multiplier'
            and jsonb_typeof(model -> 'billing' -> 'multiplier') <> 'number'
          )
          or pg_column_size(model -> 'billing') > 2048
      )
      and jsonb_array_length(p_models) = (
        select count(distinct model ->> 'id')
        from jsonb_array_elements(p_models) as entry(model)
      )
  end;
$$;

create or replace function carcanhol.sync_llm_model_catalog(
  p_account_id uuid,
  p_user_id uuid,
  p_models jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_models is null
    or not carcanhol.llm_model_catalog_is_valid(p_models)
  then
    raise exception using
      errcode = '22023',
      message = 'Invalid sanitized model catalog.';
  end if;

  update carcanhol.llm_account_models as stored
  set
    enabled = false,
    is_stale = true,
    updated_at = now()
  where stored.account_id = p_account_id
    and stored.user_id = p_user_id
    and not exists (
      select 1
      from jsonb_array_elements(p_models) as entry(model)
      where model ->> 'id' = stored.provider_model_id
    );

  insert into carcanhol.llm_account_models (
    user_id,
    account_id,
    provider_model_id,
    display_name,
    enabled,
    discovery_metadata,
    is_stale,
    discovered_at,
    last_seen_at
  )
  select
    p_user_id,
    p_account_id,
    model ->> 'id',
    model ->> 'displayName',
    false,
    jsonb_build_object(
      'capabilities', model -> 'capabilities',
      'policy', model -> 'policy',
      'billing', model -> 'billing'
    ),
    false,
    now(),
    now()
  from jsonb_array_elements(p_models) as entry(model)
  on conflict (account_id, provider_model_id)
  do update set
    display_name = excluded.display_name,
    discovery_metadata = excluded.discovery_metadata,
    is_stale = false,
    last_seen_at = now(),
    updated_at = now();
end;
$$;

create or replace function carcanhol.create_validated_llm_account(
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
  p_key_version text,
  p_validation_request_id uuid,
  p_models jsonb
)
returns setof carcanhol.llm_accounts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_account carcanhol.llm_accounts;
begin
  if p_validation_request_id is null then
    raise exception using
      errcode = '22023',
      message = 'Validation request id is required.';
  end if;

  if not exists (
    select 1
    from carcanhol.profiles as profile
    where profile.id = p_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'Carcanhol membership is required.';
  end if;

  if p_provider <> 'github_copilot' then
    raise exception using
      errcode = '0A000',
      message = 'Provider validation is not available.';
  end if;

  if p_models is null
    or not carcanhol.llm_model_catalog_is_valid(p_models)
  then
    raise exception using
      errcode = '22023',
      message = 'Invalid sanitized model catalog.';
  end if;

  insert into carcanhol.llm_accounts (
    id,
    user_id,
    provider,
    display_name,
    credential_type,
    status,
    custom_endpoint,
    credential_suffix,
    last_validation_status,
    last_validation_at,
    last_validation_error_code,
    validation_generation,
    last_validation_request_id
  )
  values (
    p_account_id,
    p_user_id,
    p_provider,
    p_display_name,
    p_credential_type,
    'active',
    p_custom_endpoint,
    p_credential_suffix,
    'succeeded',
    now(),
    null,
    1,
    p_validation_request_id
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

  perform carcanhol.sync_llm_model_catalog(
    created_account.id,
    created_account.user_id,
    p_models
  );

  return next created_account;
end;
$$;

create or replace function carcanhol.ensure_active_llm_account_has_models()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'active'
    and not exists (
      select 1
      from carcanhol.llm_account_models as model
      where model.account_id = new.id
        and model.user_id = new.user_id
        and not model.is_stale
    )
  then
    raise exception using
      errcode = '23514',
      message = 'An active LLM account requires a current model catalog.';
  end if;

  return new;
end;
$$;

create or replace function
  carcanhol.ensure_model_change_keeps_active_account_valid()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  changed_account_id uuid;
  changed_user_id uuid;
begin
  if tg_op = 'DELETE' then
    changed_account_id := old.account_id;
    changed_user_id := old.user_id;
  else
    changed_account_id := new.account_id;
    changed_user_id := new.user_id;
  end if;

  if exists (
    select 1
    from carcanhol.llm_accounts as account
    where account.id = changed_account_id
      and account.user_id = changed_user_id
      and account.status = 'active'
  )
    and not exists (
      select 1
      from carcanhol.llm_account_models as model
      where model.account_id = changed_account_id
        and model.user_id = changed_user_id
        and not model.is_stale
    )
  then
    raise exception using
      errcode = '23514',
      message = 'An active LLM account requires a current model catalog.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function carcanhol.begin_llm_account_validation(
  p_account_id uuid,
  p_user_id uuid,
  p_validation_request_id uuid
)
returns table (
  account_id uuid,
  provider text,
  aad_provider text,
  ciphertext text,
  nonce text,
  auth_tag text,
  algorithm text,
  envelope_version smallint,
  key_version text,
  validation_generation bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  next_generation bigint;
begin
  if p_validation_request_id is null then
    raise exception using
      errcode = '22023',
      message = 'Validation request id is required.';
  end if;

  if not exists (
    select 1
    from carcanhol.profiles as profile
    where profile.id = p_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'Carcanhol membership is required.';
  end if;

  update carcanhol.llm_accounts as account
  set
    validation_generation = account.validation_generation + 1,
    last_validation_request_id = p_validation_request_id
  where account.id = p_account_id
    and account.user_id = p_user_id
    and account.provider = 'github_copilot'
  returning account.validation_generation into next_generation;

  if not found then
    return;
  end if;

  return query
  select
    account.id,
    account.provider,
    secret.aad_provider,
    secret.ciphertext,
    secret.nonce,
    secret.auth_tag,
    secret.algorithm,
    secret.envelope_version,
    secret.key_version,
    next_generation
  from carcanhol.llm_accounts as account
  join carcanhol.llm_account_secrets as secret
    on secret.account_id = account.id
   and secret.user_id = account.user_id
  where account.id = p_account_id
    and account.user_id = p_user_id;
end;
$$;

create or replace function carcanhol.apply_llm_account_validation(
  p_account_id uuid,
  p_user_id uuid,
  p_validation_request_id uuid,
  p_validation_generation bigint,
  p_succeeded boolean,
  p_error_code text,
  p_models jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  applied boolean;
  applied_rows bigint;
begin
  if p_validation_request_id is null
    or p_validation_generation < 1
    or p_succeeded is null
  then
    raise exception using
      errcode = '22023',
      message = 'Invalid validation concurrency metadata.';
  end if;

  if not exists (
    select 1
    from carcanhol.profiles as profile
    where profile.id = p_user_id
  ) then
    raise exception using
      errcode = '42501',
      message = 'Carcanhol membership is required.';
  end if;

  if p_succeeded then
    if p_error_code is not null
      or p_models is null
      or not carcanhol.llm_model_catalog_is_valid(p_models)
    then
      raise exception using
        errcode = '22023',
        message = 'Invalid successful validation result.';
    end if;

    update carcanhol.llm_accounts as account
    set
      status = 'active',
      last_validation_status = 'succeeded',
      last_validation_at = now(),
      last_validation_error_code = null
    where account.id = p_account_id
      and account.user_id = p_user_id
      and account.provider = 'github_copilot'
      and account.last_validation_request_id = p_validation_request_id
      and account.validation_generation = p_validation_generation;

    get diagnostics applied_rows = row_count;
    applied := applied_rows > 0;

    if applied then
      perform carcanhol.sync_llm_model_catalog(
        p_account_id,
        p_user_id,
        p_models
      );
    end if;
  else
    if p_error_code is null
      or p_error_code not in (
      'invalid_token',
      'no_subscription',
      'org_policy_blocked',
      'timeout',
      'unavailable',
      'no_models',
      'unknown',
      'provider_validation_unavailable'
      )
      or p_models is null
      or p_models <> '[]'::jsonb
    then
      raise exception using
        errcode = '22023',
        message = 'Invalid sanitized validation error code.';
    end if;

    update carcanhol.llm_accounts as account
    set
      status = case
        when p_error_code in (
          'invalid_token',
          'no_subscription',
          'org_policy_blocked',
          'no_models'
        ) then 'invalid'
        else 'error'
      end,
      last_validation_status = 'failed',
      last_validation_at = now(),
      last_validation_error_code = p_error_code
    where account.id = p_account_id
      and account.user_id = p_user_id
      and account.provider = 'github_copilot'
      and account.last_validation_request_id = p_validation_request_id
      and account.validation_generation = p_validation_generation;

    get diagnostics applied_rows = row_count;
    applied := applied_rows > 0;

    if applied then
      update carcanhol.llm_account_models
      set
        enabled = false,
        is_stale = true,
        updated_at = now()
      where account_id = p_account_id
        and user_id = p_user_id;
    end if;
  end if;

  return applied;
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
    validation_generation = validation_generation + 1,
    last_validation_request_id = null,
    updated_at = now()
  where id = p_account_id
    and user_id = p_user_id
  returning * into rotated_account;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Owned LLM account was not found.';
  end if;

  update carcanhol.llm_account_models
  set
    enabled = false,
    is_stale = true,
    updated_at = now()
  where account_id = p_account_id
    and user_id = p_user_id;

  return next rotated_account;
end;
$$;

drop function if exists carcanhol.create_llm_account_with_secret(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  smallint,
  text
);

drop trigger if exists llm_accounts_require_current_models
  on carcanhol.llm_accounts;
create constraint trigger llm_accounts_require_current_models
  after insert or update of status on carcanhol.llm_accounts
  deferrable initially deferred
  for each row execute function
    carcanhol.ensure_active_llm_account_has_models();

drop trigger if exists llm_models_preserve_active_account
  on carcanhol.llm_account_models;
create constraint trigger llm_models_preserve_active_account
  after delete or update of is_stale on carcanhol.llm_account_models
  deferrable initially deferred
  for each row execute function
    carcanhol.ensure_model_change_keeps_active_account_valid();

revoke all on function carcanhol.llm_model_catalog_is_valid(jsonb)
  from public, anon, authenticated;
revoke all on function carcanhol.sync_llm_model_catalog(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function carcanhol.create_validated_llm_account(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  smallint,
  text,
  uuid,
  jsonb
) from public, anon, authenticated;
revoke all on function carcanhol.begin_llm_account_validation(
  uuid,
  uuid,
  uuid
) from public, anon, authenticated;
revoke all on function carcanhol.apply_llm_account_validation(
  uuid,
  uuid,
  uuid,
  bigint,
  boolean,
  text,
  jsonb
) from public, anon, authenticated;
revoke all on function carcanhol.ensure_active_llm_account_has_models()
  from public, anon, authenticated;
revoke all on function
  carcanhol.ensure_model_change_keeps_active_account_valid()
  from public, anon, authenticated;

grant execute on function carcanhol.llm_model_catalog_is_valid(jsonb)
  to service_role;
grant execute on function carcanhol.sync_llm_model_catalog(uuid, uuid, jsonb)
  to service_role;
grant execute on function carcanhol.create_validated_llm_account(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  smallint,
  text,
  uuid,
  jsonb
) to service_role;
grant execute on function carcanhol.begin_llm_account_validation(
  uuid,
  uuid,
  uuid
) to service_role;
grant execute on function carcanhol.apply_llm_account_validation(
  uuid,
  uuid,
  uuid,
  bigint,
  boolean,
  text,
  jsonb
) to service_role;

revoke all on function carcanhol.rotate_llm_account_secret(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  smallint,
  text
) from public, anon, authenticated;
grant execute on function carcanhol.rotate_llm_account_secret(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  smallint,
  text
) to service_role;

commit;
