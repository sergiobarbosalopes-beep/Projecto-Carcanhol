-- Preserve the last successful model catalog when validation infrastructure
-- is temporarily unavailable.
--
-- Apply after 0005_github_copilot_validation.sql. This migration is
-- transactional and safe to re-run. It replaces only the service-role RPC
-- that applies validation results.

begin;

comment on column carcanhol.llm_account_models.is_stale is
  'True when a definitive credential/catalog failure invalidated the model or a later successful sync no longer returned it. Transient infrastructure failures preserve the last successful catalog and enabled selection.';

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

    -- Transient infrastructure failures block execution through status =
    -- 'error' but preserve the last successful catalog and explicit enabled
    -- choices. Only definitive credential/entitlement/catalog failures
    -- invalidate those rows.
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

revoke all on function carcanhol.apply_llm_account_validation(
  uuid,
  uuid,
  uuid,
  bigint,
  boolean,
  text,
  jsonb
) from public, anon, authenticated;
grant execute on function carcanhol.apply_llm_account_validation(
  uuid,
  uuid,
  uuid,
  bigint,
  boolean,
  text,
  jsonb
) to service_role;

commit;
