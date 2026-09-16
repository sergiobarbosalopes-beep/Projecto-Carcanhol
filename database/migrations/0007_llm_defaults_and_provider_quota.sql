-- Global LLM default selection and provider-reported account quota.
--
-- Apply after 0006_preserve_transient_validation_catalog.sql. The migration
-- is transactional and keeps the previous validation RPC overloads available
-- during a rolling application deployment.

begin;

-- `enabled` used to mean a future manual authorization. Keep the column for
-- rolling compatibility, but make `is_stale` the only source of truth.
update carcanhol.llm_account_models
set enabled = not is_stale;

create or replace function carcanhol.mirror_llm_model_enabled()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.enabled := not new.is_stale;
  return new;
end;
$$;

drop trigger if exists llm_models_mirror_enabled
  on carcanhol.llm_account_models;
create trigger llm_models_mirror_enabled
before insert or update of enabled, is_stale
on carcanhol.llm_account_models
for each row
execute function carcanhol.mirror_llm_model_enabled();

alter table carcanhol.llm_account_models
  drop constraint if exists llm_account_models_stale_disabled;
alter table carcanhol.llm_account_models
  add constraint llm_account_models_enabled_matches_currency
  check (enabled = not is_stale);

comment on column carcanhol.llm_account_models.enabled is
  'Deprecated compatibility mirror generated from NOT is_stale by trigger. It is not an authorization, user choice or source of truth and may be removed after older application versions are retired.';

create table if not exists carcanhol.llm_model_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_model_id uuid not null,
  scope text not null,
  feature_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint llm_model_preferences_model_owner_fk
    foreign key (account_model_id, user_id)
    references carcanhol.llm_account_models (id, user_id)
    on delete cascade,
  constraint llm_model_preferences_scope_allowed
    check (scope in ('global', 'feature')),
  constraint llm_model_preferences_scope_feature_consistent
    check (
      (scope = 'global' and feature_key is null)
      or (
        scope = 'feature'
        and feature_key is not null
        and char_length(btrim(feature_key)) between 1 and 120
      )
    )
);

comment on table carcanhol.llm_model_preferences is
  'One selected account+model per scope. Only the global scope is exposed now; feature rows reserve future overrides.';

create unique index if not exists llm_model_preferences_global_unique_idx
  on carcanhol.llm_model_preferences (user_id)
  where scope = 'global';

create unique index if not exists llm_model_preferences_feature_unique_idx
  on carcanhol.llm_model_preferences (user_id, feature_key)
  where scope = 'feature';

-- Preserve any previously prepared primary routing choices when they are
-- currently eligible. No feature-routing API is exposed by this release.
insert into carcanhol.llm_model_preferences (
  user_id,
  account_model_id,
  scope,
  feature_key
)
select distinct on (rule.user_id, rule.scope, rule.feature_key)
  rule.user_id,
  rule.account_model_id,
  case rule.scope when 'general' then 'global' else 'feature' end,
  rule.feature_key
from carcanhol.llm_routing_rules as rule
join carcanhol.llm_account_models as model
  on model.id = rule.account_model_id
 and model.user_id = rule.user_id
join carcanhol.llm_accounts as account
  on account.id = model.account_id
 and account.user_id = model.user_id
where account.status = 'active'
  and not model.is_stale
order by
  rule.user_id,
  rule.scope,
  rule.feature_key,
  rule.fallback_order,
  rule.created_at
on conflict do nothing;

create table if not exists carcanhol.llm_account_quotas (
  account_id uuid not null,
  user_id uuid not null,
  provider text not null,
  metric text not null,
  status text not null,
  is_unlimited boolean,
  included_units numeric(18, 6),
  used_units numeric(18, 6),
  remaining_units numeric(18, 6),
  remaining_percentage numeric(5, 2),
  overage_units numeric(18, 6),
  usage_allowed_after_limit boolean,
  overage_allowed boolean,
  reset_at timestamptz,
  observed_at timestamptz,
  attempted_at timestamptz not null default now(),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, metric),
  constraint llm_account_quotas_account_owner_fk
    foreign key (account_id, user_id)
    references carcanhol.llm_accounts (id, user_id)
    on delete cascade,
  constraint llm_account_quotas_provider_metric_allowed
    check (
      provider = 'github_copilot'
      and metric = 'premium_interactions'
    ),
  constraint llm_account_quotas_status_allowed
    check (status in ('available', 'unavailable', 'stale')),
  constraint llm_account_quotas_units_nonnegative
    check (
      (included_units is null or included_units >= 0)
      and (used_units is null or used_units >= 0)
      and (remaining_units is null or remaining_units >= 0)
      and (overage_units is null or overage_units >= 0)
    ),
  constraint llm_account_quotas_percentage_valid
    check (
      remaining_percentage is null
      or remaining_percentage between 0 and 100
    ),
  constraint llm_account_quotas_error_allowed
    check (
      error_code is null
      or error_code in (
        'provider_quota_unavailable',
        'provider_quota_not_available',
        'malformed_provider_quota',
        'provider_validation_failed',
        'credential_changed'
      )
    ),
  constraint llm_account_quotas_available_consistent
    check (
      (
        status = 'available'
        and is_unlimited is not null
        and used_units is not null
        and overage_units is not null
        and usage_allowed_after_limit is not null
        and overage_allowed is not null
        and observed_at is not null
        and error_code is null
        and (
          (
            is_unlimited
            and included_units is null
            and remaining_units is null
            and remaining_percentage is null
          )
          or (
            not is_unlimited
            and included_units is not null
          )
        )
      )
      or (
        status in ('unavailable', 'stale')
        and error_code is not null
      )
    )
);

comment on table carcanhol.llm_account_quotas is
  'Provider-reported account-wide usage snapshots. Unit names stay neutral because premium_interactions can mean AI credits or premium requests by plan. This is not prompt/session telemetry and stores no prompts, responses, headers or credentials.';

create index if not exists llm_account_quotas_user_attempted_idx
  on carcanhol.llm_account_quotas (user_id, attempted_at desc);

create or replace function carcanhol.llm_provider_quota_is_valid(
  p_quota jsonb
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce((case
    when jsonb_typeof(p_quota) <> 'object' then false
    when p_quota ->> 'metric' <> 'premium_interactions' then false
    when p_quota ->> 'status' = 'unavailable' then
      p_quota - array['status', 'metric', 'errorCode'] = '{}'::jsonb
      and p_quota ->> 'errorCode' in (
        'provider_quota_unavailable',
        'provider_quota_not_available',
        'malformed_provider_quota'
      )
    when p_quota ->> 'status' = 'available' then
      p_quota - array[
        'status',
        'metric',
        'isUnlimited',
        'includedUnits',
        'usedUnits',
        'remainingUnits',
        'remainingPercentage',
        'overageUnits',
        'usageAllowedAfterLimit',
        'overageAllowed',
        'resetAt'
      ] = '{}'::jsonb
      and jsonb_typeof(p_quota -> 'isUnlimited') = 'boolean'
      and jsonb_typeof(p_quota -> 'usedUnits') = 'number'
      and (p_quota ->> 'usedUnits')::numeric >= 0
      and jsonb_typeof(p_quota -> 'overageUnits') = 'number'
      and (p_quota ->> 'overageUnits')::numeric >= 0
      and jsonb_typeof(p_quota -> 'usageAllowedAfterLimit') = 'boolean'
      and jsonb_typeof(p_quota -> 'overageAllowed') = 'boolean'
      and (
        not (p_quota ? 'remainingPercentage')
        or (
          jsonb_typeof(p_quota -> 'remainingPercentage') = 'number'
          and (p_quota ->> 'remainingPercentage')::numeric between 0 and 100
        )
      )
      and (
        not (p_quota ? 'resetAt')
        or jsonb_typeof(p_quota -> 'resetAt') = 'string'
      )
      and (
        (
          (p_quota ->> 'isUnlimited')::boolean
          and not (p_quota ? 'includedUnits')
          and not (p_quota ? 'remainingUnits')
          and not (p_quota ? 'remainingPercentage')
        )
        or (
          not (p_quota ->> 'isUnlimited')::boolean
          and jsonb_typeof(p_quota -> 'includedUnits') = 'number'
          and (p_quota ->> 'includedUnits')::numeric >= 0
          and (
            not (p_quota ? 'remainingUnits')
            or (
              jsonb_typeof(p_quota -> 'remainingUnits') = 'number'
              and (p_quota ->> 'remainingUnits')::numeric >= 0
            )
          )
        )
      )
    else false
  end), false);
$$;

create or replace function carcanhol.sync_llm_account_quota(
  p_account_id uuid,
  p_user_id uuid,
  p_quota jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  account_provider text;
begin
  if p_quota is null
    or not carcanhol.llm_provider_quota_is_valid(p_quota)
  then
    raise exception using
      errcode = '22023',
      message = 'Invalid sanitized provider quota.';
  end if;

  select account.provider
  into account_provider
  from carcanhol.llm_accounts as account
  where account.id = p_account_id
    and account.user_id = p_user_id;

  if account_provider <> 'github_copilot' then
    raise exception using
      errcode = '0A000',
      message = 'Provider quota is not supported.';
  end if;

  if p_quota ->> 'status' = 'available' then
    insert into carcanhol.llm_account_quotas (
      account_id,
      user_id,
      provider,
      metric,
      status,
      is_unlimited,
      included_units,
      used_units,
      remaining_units,
      remaining_percentage,
      overage_units,
      usage_allowed_after_limit,
      overage_allowed,
      reset_at,
      observed_at,
      attempted_at,
      error_code
    )
    values (
      p_account_id,
      p_user_id,
      account_provider,
      'premium_interactions',
      'available',
      (p_quota ->> 'isUnlimited')::boolean,
      (p_quota ->> 'includedUnits')::numeric,
      (p_quota ->> 'usedUnits')::numeric,
      (p_quota ->> 'remainingUnits')::numeric,
      (p_quota ->> 'remainingPercentage')::numeric,
      (p_quota ->> 'overageUnits')::numeric,
      (p_quota ->> 'usageAllowedAfterLimit')::boolean,
      (p_quota ->> 'overageAllowed')::boolean,
      (p_quota ->> 'resetAt')::timestamptz,
      now(),
      now(),
      null
    )
    on conflict (account_id, metric)
    do update set
      provider = excluded.provider,
      status = excluded.status,
      is_unlimited = excluded.is_unlimited,
      included_units = excluded.included_units,
      used_units = excluded.used_units,
      remaining_units = excluded.remaining_units,
      remaining_percentage = excluded.remaining_percentage,
      overage_units = excluded.overage_units,
      usage_allowed_after_limit = excluded.usage_allowed_after_limit,
      overage_allowed = excluded.overage_allowed,
      reset_at = excluded.reset_at,
      observed_at = excluded.observed_at,
      attempted_at = excluded.attempted_at,
      error_code = null,
      updated_at = now();
  else
    insert into carcanhol.llm_account_quotas (
      account_id,
      user_id,
      provider,
      metric,
      status,
      attempted_at,
      error_code
    )
    values (
      p_account_id,
      p_user_id,
      account_provider,
      'premium_interactions',
      'unavailable',
      now(),
      p_quota ->> 'errorCode'
    )
    on conflict (account_id, metric)
    do update set
      status = case
        when carcanhol.llm_account_quotas.observed_at is null
          then 'unavailable'
        else 'stale'
      end,
      attempted_at = now(),
      error_code = excluded.error_code,
      updated_at = now();
  end if;
end;
$$;

create or replace function carcanhol.clear_ineligible_llm_preferences()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  if tg_table_name = 'llm_account_models' and new.is_stale then
    delete from carcanhol.llm_model_preferences
    where user_id = new.user_id
      and account_model_id = new.id;
  elsif tg_table_name = 'llm_accounts' and new.status <> 'active' then
    delete from carcanhol.llm_model_preferences as preference
    using carcanhol.llm_account_models as model
    where preference.user_id = new.user_id
      and preference.account_model_id = model.id
      and model.account_id = new.id
      and model.user_id = new.user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists llm_models_clear_ineligible_preferences
  on carcanhol.llm_account_models;
create trigger llm_models_clear_ineligible_preferences
  after update of is_stale on carcanhol.llm_account_models
  for each row
  when (new.is_stale)
  execute function carcanhol.clear_ineligible_llm_preferences();

drop trigger if exists llm_accounts_clear_ineligible_preferences
  on carcanhol.llm_accounts;
create trigger llm_accounts_clear_ineligible_preferences
  after update of status on carcanhol.llm_accounts
  for each row
  when (new.status <> 'active')
  execute function carcanhol.clear_ineligible_llm_preferences();

create or replace function carcanhol.set_global_llm_default(
  p_user_id uuid,
  p_account_model_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
    or p_user_id is distinct from (select auth.uid())
    or not exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = p_user_id
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Carcanhol membership and ownership are required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if not exists (
    select 1
    from carcanhol.llm_account_models as model
    join carcanhol.llm_accounts as account
      on account.id = model.account_id
     and account.user_id = model.user_id
    where model.id = p_account_model_id
      and model.user_id = p_user_id
      and not model.is_stale
      and account.status = 'active'
  ) then
    raise exception using
      errcode = '22023',
      message = 'The selected account and model are not eligible.';
  end if;

  delete from carcanhol.llm_model_preferences
  where user_id = p_user_id
    and scope = 'global';

  insert into carcanhol.llm_model_preferences (
    user_id,
    account_model_id,
    scope,
    feature_key
  )
  values (
    p_user_id,
    p_account_model_id,
    'global',
    null
  );

  return p_account_model_id;
end;
$$;

-- Current catalogs are available for selection. New rows no longer carry an
-- authorization-pending state.
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
  p_models jsonb,
  p_quota jsonb
)
returns setof carcanhol.llm_accounts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_account carcanhol.llm_accounts;
begin
  if p_validation_request_id is null
    or p_provider <> 'github_copilot'
    or not exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = p_user_id
    )
    or p_models is null
    or not carcanhol.llm_model_catalog_is_valid(p_models)
    or p_quota is null
    or not carcanhol.llm_provider_quota_is_valid(p_quota)
  then
    raise exception using
      errcode = '22023',
      message = 'Invalid validated LLM account input.';
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
  perform carcanhol.sync_llm_account_quota(
    created_account.id,
    created_account.user_id,
    p_quota
  );

  return next created_account;
end;
$$;

create or replace function carcanhol.apply_llm_account_validation(
  p_account_id uuid,
  p_user_id uuid,
  p_validation_request_id uuid,
  p_validation_generation bigint,
  p_succeeded boolean,
  p_error_code text,
  p_models jsonb,
  p_quota jsonb
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
      or p_quota is null
      or not carcanhol.llm_provider_quota_is_valid(p_quota)
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
      perform carcanhol.sync_llm_account_quota(
        p_account_id,
        p_user_id,
        p_quota
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
      or p_quota is not null
    then
      raise exception using
        errcode = '22023',
        message = 'Invalid sanitized validation error.';
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
      update carcanhol.llm_account_quotas
      set
        status = case
          when observed_at is null then 'unavailable'
          else 'stale'
        end,
        attempted_at = now(),
        error_code = 'provider_validation_failed',
        updated_at = now()
      where account_id = p_account_id
        and user_id = p_user_id;
    end if;

    if applied
      and p_error_code in (
        'invalid_token',
        'no_subscription',
        'org_policy_blocked',
        'no_models'
      )
    then
      update carcanhol.llm_account_models
      set
        is_stale = true,
        updated_at = now()
      where account_id = p_account_id
        and user_id = p_user_id;
    end if;
  end if;

  return applied;
end;
$$;

-- Credential replacement invalidates the old quota observation immediately.
create or replace function carcanhol.mark_llm_quota_stale_after_secret_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update carcanhol.llm_account_quotas
  set
    status = case
      when observed_at is null then 'unavailable'
      else 'stale'
    end,
    attempted_at = now(),
    error_code = 'credential_changed',
    updated_at = now()
  where account_id = new.account_id
    and user_id = new.user_id;

  return new;
end;
$$;

drop trigger if exists llm_secret_change_marks_quota_stale
  on carcanhol.llm_account_secrets;
create trigger llm_secret_change_marks_quota_stale
  after update of credential_version on carcanhol.llm_account_secrets
  for each row
  when (new.credential_version <> old.credential_version)
  execute function carcanhol.mark_llm_quota_stale_after_secret_change();

drop trigger if exists llm_model_preferences_set_updated_at
  on carcanhol.llm_model_preferences;
create trigger llm_model_preferences_set_updated_at
  before update on carcanhol.llm_model_preferences
  for each row execute function carcanhol.set_updated_at();

drop trigger if exists llm_account_quotas_set_updated_at
  on carcanhol.llm_account_quotas;
create trigger llm_account_quotas_set_updated_at
  before update on carcanhol.llm_account_quotas
  for each row execute function carcanhol.set_updated_at();

revoke all on carcanhol.llm_model_preferences
  from public, anon, authenticated;
grant select on carcanhol.llm_model_preferences to authenticated;
grant all on carcanhol.llm_model_preferences to service_role;

revoke all on carcanhol.llm_account_quotas
  from public, anon, authenticated;
grant select on carcanhol.llm_account_quotas to authenticated;
grant all on carcanhol.llm_account_quotas to service_role;

alter table carcanhol.llm_model_preferences enable row level security;
alter table carcanhol.llm_account_quotas enable row level security;

drop policy if exists "llm_model_preferences_own_member"
  on carcanhol.llm_model_preferences;
create policy "llm_model_preferences_own_member"
  on carcanhol.llm_model_preferences
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

drop policy if exists "llm_account_quotas_own_member"
  on carcanhol.llm_account_quotas;
create policy "llm_account_quotas_own_member"
  on carcanhol.llm_account_quotas
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as profile
      where profile.id = (select auth.uid())
    )
  );

revoke all on function carcanhol.set_global_llm_default(uuid, uuid)
  from public, anon, authenticated;
grant execute on function carcanhol.set_global_llm_default(uuid, uuid)
  to authenticated;

revoke all on function carcanhol.sync_llm_account_quota(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function carcanhol.create_validated_llm_account(
  uuid, uuid, text, text, text, text, text, text, text, text, text, smallint,
  text, uuid, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function carcanhol.apply_llm_account_validation(
  uuid, uuid, uuid, bigint, boolean, text, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function carcanhol.sync_llm_account_quota(uuid, uuid, jsonb)
  to service_role;
grant execute on function carcanhol.create_validated_llm_account(
  uuid, uuid, text, text, text, text, text, text, text, text, text, smallint,
  text, uuid, jsonb, jsonb
) to service_role;
grant execute on function carcanhol.apply_llm_account_validation(
  uuid, uuid, uuid, bigint, boolean, text, jsonb, jsonb
) to service_role;

revoke all on function carcanhol.clear_ineligible_llm_preferences()
  from public, anon, authenticated;
revoke all on function carcanhol.mark_llm_quota_stale_after_secret_change()
  from public, anon, authenticated;

commit;
