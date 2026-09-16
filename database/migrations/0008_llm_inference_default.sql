-- Atomic, ownership-bound resolution of the current global LLM inference target.

begin;

create or replace function carcanhol.get_llm_inference_target(
  p_user_id uuid,
  p_account_model_id uuid
)
returns table (
  account_id uuid,
  provider text,
  provider_model_id text,
  aad_provider text,
  ciphertext text,
  nonce text,
  auth_tag text,
  algorithm text,
  envelope_version smallint,
  key_version text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    account.id,
    account.provider,
    model.provider_model_id,
    secret.aad_provider,
    secret.ciphertext,
    secret.nonce,
    secret.auth_tag,
    secret.algorithm,
    secret.envelope_version,
    secret.key_version
  from carcanhol.llm_model_preferences as preference
  join carcanhol.llm_account_models as model
    on model.id = preference.account_model_id
   and model.user_id = preference.user_id
  join carcanhol.llm_accounts as account
    on account.id = model.account_id
   and account.user_id = model.user_id
  join carcanhol.llm_account_secrets as secret
    on secret.account_id = account.id
   and secret.user_id = account.user_id
  where preference.user_id = p_user_id
    and preference.account_model_id = p_account_model_id
    and preference.scope = 'global'
    and preference.feature_key is null
    and account.provider = 'github_copilot'
    and account.status = 'active'
    and account.last_validation_status = 'succeeded'
    and not model.is_stale;
end;
$$;

revoke all on function carcanhol.get_llm_inference_target(uuid, uuid)
  from public, anon, authenticated;
grant execute on function carcanhol.get_llm_inference_target(uuid, uuid)
  to service_role;

commit;
