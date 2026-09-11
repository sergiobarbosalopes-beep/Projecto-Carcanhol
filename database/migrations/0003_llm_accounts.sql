-- Fase 3A - user-owned LLM provider accounts and future runtime metadata.
--
-- Apply after 0002_admin_settings_and_skills.sql. This migration is safe to
-- re-run and creates objects only inside the dedicated "carcanhol" schema.
--
-- No provider calls are enabled by this migration. Credentials are encrypted
-- by the Next.js backend before they reach Postgres.

create schema if not exists carcanhol;

revoke all on schema carcanhol from public, anon;
grant usage on schema carcanhol to authenticated, service_role;

create table if not exists carcanhol.llm_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  display_name text not null,
  credential_type text not null,
  status text not null default 'pending_validation',
  custom_endpoint text,
  credential_suffix text not null,
  credential_updated_at timestamptz not null default now(),
  last_validation_status text,
  last_validation_at timestamptz,
  last_validation_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint llm_accounts_id_user_unique unique (id, user_id),
  constraint llm_accounts_provider_allowed
    check (
      provider in (
        'github_models',
        'anthropic',
        'google_gemini',
        'deepseek',
        'openai_compatible'
      )
    ),
  constraint llm_accounts_display_name_not_blank
    check (char_length(btrim(display_name)) > 0),
  constraint llm_accounts_display_name_length
    check (char_length(display_name) <= 120),
  constraint llm_accounts_credential_type_allowed
    check (credential_type in ('token', 'api_key', 'oauth')),
  constraint llm_accounts_status_allowed
    check (status in ('pending_validation', 'inactive')),
  constraint llm_accounts_endpoint_by_provider
    check (
      (
        provider = 'openai_compatible'
        and custom_endpoint is not null
        and custom_endpoint
          ~ '^https://[^/?#@[:space:]]+(/[^?#@[:space:]]*)?$'
        and char_length(custom_endpoint) <= 2048
      )
      or (
        provider <> 'openai_compatible'
        and custom_endpoint is null
      )
    ),
  constraint llm_accounts_credential_suffix_length
    check (
      char_length(credential_suffix) between 1 and 8
      and credential_suffix !~ '[[:space:]]'
    ),
  constraint llm_accounts_validation_status_allowed
    check (
      last_validation_status is null
      or last_validation_status in ('succeeded', 'failed')
    ),
  constraint llm_accounts_validation_metadata_consistent
    check (
      (
        last_validation_status is null
        and last_validation_at is null
        and last_validation_error_code is null
      )
      or (
        last_validation_status is not null
        and last_validation_at is not null
        and (
          last_validation_error_code is null
          or char_length(last_validation_error_code) <= 120
        )
      )
    )
);

comment on table carcanhol.llm_accounts is
  'User-owned LLM provider account metadata. This phase permits pending_validation and inactive only.';
comment on column carcanhol.llm_accounts.custom_endpoint is
  'HTTPS base URL for OpenAI-compatible providers. SSRF and DNS protections are required before any outbound call is enabled.';
comment on column carcanhol.llm_accounts.credential_suffix is
  'Non-secret final characters used only to render a masked credential hint.';

create unique index if not exists llm_accounts_user_name_unique_idx
  on carcanhol.llm_accounts (user_id, lower(btrim(display_name)));

create index if not exists llm_accounts_user_updated_idx
  on carcanhol.llm_accounts (user_id, updated_at desc);

create index if not exists llm_accounts_user_provider_idx
  on carcanhol.llm_accounts (user_id, provider, updated_at desc);

create table if not exists carcanhol.llm_account_secrets (
  account_id uuid primary key,
  user_id uuid not null,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  algorithm text not null,
  envelope_version smallint not null,
  key_version text not null,
  credential_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint llm_account_secrets_account_owner_fk
    foreign key (account_id, user_id)
    references carcanhol.llm_accounts (id, user_id)
    on delete cascade,
  constraint llm_account_secrets_ciphertext_base64
    check (
      char_length(ciphertext) > 0
      and char_length(ciphertext) <= 24576
      and ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'
    ),
  constraint llm_account_secrets_nonce_base64
    check (
      char_length(nonce) = 16
      and nonce ~ '^[A-Za-z0-9+/]{16}$'
    ),
  constraint llm_account_secrets_auth_tag_base64
    check (
      char_length(auth_tag) = 24
      and auth_tag ~ '^[A-Za-z0-9+/]{22}==$'
    ),
  constraint llm_account_secrets_algorithm_allowed
    check (algorithm = 'aes-256-gcm'),
  constraint llm_account_secrets_envelope_version_allowed
    check (envelope_version = 1),
  constraint llm_account_secrets_key_version_format
    check (
      char_length(key_version) between 1 and 32
      and key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    ),
  constraint llm_account_secrets_credential_version_positive
    check (credential_version > 0)
);

comment on table carcanhol.llm_account_secrets is
  'Service-role-only AES-256-GCM envelopes. Never expose this table through browser-facing APIs.';

create index if not exists llm_account_secrets_user_idx
  on carcanhol.llm_account_secrets (user_id);

create table if not exists carcanhol.llm_account_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  provider_model_id text not null,
  display_name text not null,
  enabled boolean not null default false,
  discovery_metadata jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint llm_account_models_id_user_unique unique (id, user_id),
  constraint llm_account_models_id_user_account_unique
    unique (id, user_id, account_id),
  constraint llm_account_models_account_owner_fk
    foreign key (account_id, user_id)
    references carcanhol.llm_accounts (id, user_id)
    on delete cascade,
  constraint llm_account_models_provider_id_not_blank
    check (
      char_length(btrim(provider_model_id)) > 0
      and char_length(provider_model_id) <= 255
    ),
  constraint llm_account_models_display_name_not_blank
    check (
      char_length(btrim(display_name)) > 0
      and char_length(display_name) <= 255
    ),
  constraint llm_account_models_metadata_object
    check (jsonb_typeof(discovery_metadata) = 'object'),
  constraint llm_account_models_account_provider_unique
    unique (account_id, provider_model_id)
);

comment on table carcanhol.llm_account_models is
  'Automatically discovered provider model catalog. enabled remains an explicit future user authorization.';

create index if not exists llm_account_models_user_enabled_idx
  on carcanhol.llm_account_models (user_id, enabled, display_name);

create table if not exists carcanhol.llm_routing_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_model_id uuid not null,
  scope text not null,
  feature_key text,
  fallback_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint llm_routing_rules_model_owner_fk
    foreign key (account_model_id, user_id)
    references carcanhol.llm_account_models (id, user_id)
    on delete cascade,
  constraint llm_routing_rules_scope_allowed
    check (scope in ('general', 'feature')),
  constraint llm_routing_rules_scope_feature_consistent
    check (
      (scope = 'general' and feature_key is null)
      or (
        scope = 'feature'
        and feature_key is not null
        and char_length(btrim(feature_key)) > 0
        and char_length(feature_key) <= 120
      )
    ),
  constraint llm_routing_rules_fallback_order_valid
    check (fallback_order between 0 and 100)
);

comment on table carcanhol.llm_routing_rules is
  'Future routing chains. fallback_order 0 is primary; higher values are ordered fallbacks.';

create unique index if not exists llm_routing_general_order_unique_idx
  on carcanhol.llm_routing_rules (user_id, fallback_order)
  where scope = 'general';

create unique index if not exists llm_routing_general_model_unique_idx
  on carcanhol.llm_routing_rules (user_id, account_model_id)
  where scope = 'general';

create unique index if not exists llm_routing_feature_order_unique_idx
  on carcanhol.llm_routing_rules (user_id, feature_key, fallback_order)
  where scope = 'feature';

create unique index if not exists llm_routing_feature_model_unique_idx
  on carcanhol.llm_routing_rules (user_id, feature_key, account_model_id)
  where scope = 'feature';

create table if not exists carcanhol.llm_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null,
  account_model_id uuid,
  feature_key text,
  status text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  latency_ms integer,
  estimated_cost numeric(18, 8),
  cost_currency text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint llm_usage_events_account_owner_fk
    foreign key (account_id, user_id)
    references carcanhol.llm_accounts (id, user_id)
    on delete cascade,
  constraint llm_usage_events_model_account_owner_fk
    foreign key (account_model_id, user_id, account_id)
    references carcanhol.llm_account_models (id, user_id, account_id),
  constraint llm_usage_events_feature_key_length
    check (feature_key is null or char_length(feature_key) <= 120),
  constraint llm_usage_events_status_allowed
    check (status in ('succeeded', 'failed', 'cancelled')),
  constraint llm_usage_events_token_counts_valid
    check (input_tokens >= 0 and output_tokens >= 0),
  constraint llm_usage_events_latency_valid
    check (latency_ms is null or latency_ms >= 0),
  constraint llm_usage_events_cost_valid
    check (
      (estimated_cost is null and cost_currency is null)
      or (
        estimated_cost is not null
        and estimated_cost >= 0
        and cost_currency is not null
        and cost_currency ~ '^[A-Z]{3}$'
      )
    )
);

comment on table carcanhol.llm_usage_events is
  'Future aggregate invocation telemetry. Prompts, responses and credentials must never be stored here.';

create index if not exists llm_usage_events_user_occurred_idx
  on carcanhol.llm_usage_events (user_id, occurred_at desc);

create index if not exists llm_usage_events_account_occurred_idx
  on carcanhol.llm_usage_events (account_id, occurred_at desc);

create or replace function carcanhol.ensure_llm_account_has_secret()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from carcanhol.llm_account_secrets as secret
    where secret.account_id = new.id
      and secret.user_id = new.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'An LLM account must have exactly one encrypted secret.';
  end if;

  return new;
end;
$$;

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
  update carcanhol.llm_account_secrets
  set
    ciphertext = p_ciphertext,
    nonce = p_nonce,
    auth_tag = p_auth_tag,
    algorithm = p_algorithm,
    envelope_version = p_envelope_version,
    key_version = p_key_version,
    credential_version = credential_version + 1,
    updated_at = now()
  where account_id = p_account_id
    and user_id = p_user_id;

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

revoke all on function carcanhol.ensure_llm_account_has_secret()
  from public, anon, authenticated;
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

drop trigger if exists llm_accounts_set_updated_at
  on carcanhol.llm_accounts;
create trigger llm_accounts_set_updated_at
  before update on carcanhol.llm_accounts
  for each row execute function carcanhol.set_updated_at();

drop trigger if exists llm_account_models_set_updated_at
  on carcanhol.llm_account_models;
create trigger llm_account_models_set_updated_at
  before update on carcanhol.llm_account_models
  for each row execute function carcanhol.set_updated_at();

drop trigger if exists llm_routing_rules_set_updated_at
  on carcanhol.llm_routing_rules;
create trigger llm_routing_rules_set_updated_at
  before update on carcanhol.llm_routing_rules
  for each row execute function carcanhol.set_updated_at();

drop trigger if exists llm_accounts_require_secret
  on carcanhol.llm_accounts;
create constraint trigger llm_accounts_require_secret
  after insert on carcanhol.llm_accounts
  deferrable initially deferred
  for each row execute function carcanhol.ensure_llm_account_has_secret();

revoke all on carcanhol.llm_accounts
  from public, anon, authenticated;
grant select, delete on carcanhol.llm_accounts to authenticated;
grant update (display_name, custom_endpoint)
  on carcanhol.llm_accounts to authenticated;
grant all on carcanhol.llm_accounts to service_role;

revoke all on carcanhol.llm_account_secrets
  from public, anon, authenticated;
grant all on carcanhol.llm_account_secrets to service_role;

revoke all on carcanhol.llm_account_models
  from public, anon, authenticated;
grant select on carcanhol.llm_account_models to authenticated;
grant all on carcanhol.llm_account_models to service_role;

revoke all on carcanhol.llm_routing_rules
  from public, anon, authenticated;
grant select on carcanhol.llm_routing_rules to authenticated;
grant all on carcanhol.llm_routing_rules to service_role;

revoke all on carcanhol.llm_usage_events
  from public, anon, authenticated;
grant select on carcanhol.llm_usage_events to authenticated;
grant all on carcanhol.llm_usage_events to service_role;

alter table carcanhol.llm_accounts enable row level security;
alter table carcanhol.llm_account_secrets enable row level security;
alter table carcanhol.llm_account_models enable row level security;
alter table carcanhol.llm_routing_rules enable row level security;
alter table carcanhol.llm_usage_events enable row level security;

-- Every metadata policy requires both row ownership and explicit membership.
-- Secrets intentionally have no client policy and remain service-role-only.
drop policy if exists "llm_accounts_own_member"
  on carcanhol.llm_accounts;
create policy "llm_accounts_own_member"
  on carcanhol.llm_accounts
  for all to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  );

drop policy if exists "llm_account_models_own_member"
  on carcanhol.llm_account_models;
create policy "llm_account_models_own_member"
  on carcanhol.llm_account_models
  for all to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  );

drop policy if exists "llm_routing_rules_own_member"
  on carcanhol.llm_routing_rules;
create policy "llm_routing_rules_own_member"
  on carcanhol.llm_routing_rules
  for all to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  );

drop policy if exists "llm_usage_events_own_member"
  on carcanhol.llm_usage_events;
create policy "llm_usage_events_own_member"
  on carcanhol.llm_usage_events
  for all to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  );

alter default privileges in schema carcanhol
  revoke all on tables from public, anon, authenticated;
