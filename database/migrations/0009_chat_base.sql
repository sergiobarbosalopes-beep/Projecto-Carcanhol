-- Fase 4 - persistent, user-owned text chat.
--
-- Apply after 0008_llm_inference_default.sql. The migration is additive,
-- transactional and safe to re-run. It does not enable tools, agents,
-- attachments, financial data or native Copilot skills.

begin;

create table if not exists carcanhol.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Nova conversa',
  current_account_model_id uuid not null,
  skill_mode text not null default 'manual',
  selected_skill_ids uuid[] not null default '{}'::uuid[],
  version bigint not null default 0,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_conversations_id_user_unique unique (id, user_id),
  constraint chat_conversations_model_owner_fk
    foreign key (current_account_model_id, user_id)
    references carcanhol.llm_account_models (id, user_id),
  constraint chat_conversations_title_not_blank
    check (char_length(btrim(title)) between 1 and 120),
  constraint chat_conversations_skill_mode_allowed
    check (skill_mode in ('manual', 'automatic')),
  constraint chat_conversations_skill_count
    check (cardinality(selected_skill_ids) <= 20),
  constraint chat_conversations_version_nonnegative check (version >= 0)
);

comment on table carcanhol.chat_conversations is
  'User-owned text conversations. The current account/model and confirmed Skill selection apply only to future turns.';

create index if not exists chat_conversations_user_activity_idx
  on carcanhol.chat_conversations (
    user_id,
    last_message_at desc nulls last,
    updated_at desc
  );

create table if not exists carcanhol.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null,
  sequence bigint not null,
  role text not null,
  status text not null,
  content text not null default '',
  client_request_id uuid not null,
  reply_to_message_id uuid,
  account_model_id uuid,
  provider text,
  account_name text,
  provider_model_id text,
  model_name text,
  skill_audit jsonb not null default '[]'::jsonb,
  usage jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint chat_messages_id_conversation_user_unique
    unique (id, conversation_id, user_id),
  constraint chat_messages_conversation_owner_fk
    foreign key (conversation_id, user_id)
    references carcanhol.chat_conversations (id, user_id)
    on delete cascade,
  constraint chat_messages_reply_fk
    foreign key (reply_to_message_id, conversation_id, user_id)
    references carcanhol.chat_messages (id, conversation_id, user_id)
    on delete cascade,
  constraint chat_messages_model_owner_fk
    foreign key (account_model_id, user_id)
    references carcanhol.llm_account_models (id, user_id),
  constraint chat_messages_sequence_positive check (sequence > 0),
  constraint chat_messages_role_allowed
    check (role in ('user', 'assistant')),
  constraint chat_messages_status_allowed
    check (status in ('complete', 'streaming', 'cancelled', 'failed')),
  constraint chat_messages_content_length
    check (char_length(content) <= 120000),
  constraint chat_messages_skill_audit_array
    check (jsonb_typeof(skill_audit) = 'array'),
  constraint chat_messages_usage_object
    check (usage is null or jsonb_typeof(usage) = 'object'),
  constraint chat_messages_role_state_consistent
    check (
      (
        role = 'user'
        and status = 'complete'
        and reply_to_message_id is null
        and account_model_id is null
        and provider is null
        and account_name is null
        and provider_model_id is null
        and model_name is null
        and error_code is null
        and completed_at is not null
      )
      or (
        role = 'assistant'
        and reply_to_message_id is not null
        and account_model_id is not null
        and provider is not null
        and account_name is not null
        and provider_model_id is not null
        and model_name is not null
      )
    ),
  constraint chat_messages_terminal_consistent
    check (
      (status = 'streaming' and completed_at is null and error_code is null)
      or
      (status = 'complete' and completed_at is not null and error_code is null)
      or
      (
        status in ('cancelled', 'failed')
        and completed_at is not null
        and error_code is not null
      )
    ),
  constraint chat_messages_error_code_allowed
    check (
      error_code is null
      or error_code in (
        'cancelled',
        'timeout',
        'provider_unavailable',
        'invalid_response',
        'stream_interrupted'
      )
    )
);

comment on table carcanhol.chat_messages is
  'Visible user and assistant chat content only. Assistant rows retain safe account/model labels, bounded usage and Skill id/name/version/hash audit metadata; never credentials, hidden prompts, reasoning or raw errors.';

create unique index if not exists chat_messages_conversation_sequence_idx
  on carcanhol.chat_messages (conversation_id, sequence);

create unique index if not exists chat_messages_user_request_idx
  on carcanhol.chat_messages (user_id, client_request_id);

create unique index if not exists chat_messages_one_active_assistant_idx
  on carcanhol.chat_messages (conversation_id)
  where role = 'assistant' and status = 'streaming';

create index if not exists chat_messages_conversation_created_idx
  on carcanhol.chat_messages (conversation_id, sequence);

drop trigger if exists chat_conversations_set_updated_at
  on carcanhol.chat_conversations;
create trigger chat_conversations_set_updated_at
  before update on carcanhol.chat_conversations
  for each row execute function carcanhol.set_updated_at();

revoke all on carcanhol.chat_conversations
  from public, anon, authenticated;
grant select on carcanhol.chat_conversations to authenticated;
grant all on carcanhol.chat_conversations to service_role;

revoke all on carcanhol.chat_messages
  from public, anon, authenticated;
grant select on carcanhol.chat_messages to authenticated;
grant all on carcanhol.chat_messages to service_role;

alter table carcanhol.chat_conversations enable row level security;
alter table carcanhol.chat_messages enable row level security;

drop policy if exists "chat_conversations_select_own"
  on carcanhol.chat_conversations;
create policy "chat_conversations_select_own"
  on carcanhol.chat_conversations
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "chat_conversations_insert_own"
  on carcanhol.chat_conversations;
create policy "chat_conversations_insert_own"
  on carcanhol.chat_conversations
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "chat_conversations_update_own"
  on carcanhol.chat_conversations;
create policy "chat_conversations_update_own"
  on carcanhol.chat_conversations
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "chat_conversations_delete_own"
  on carcanhol.chat_conversations;
create policy "chat_conversations_delete_own"
  on carcanhol.chat_conversations
  for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "chat_messages_select_own"
  on carcanhol.chat_messages;
create policy "chat_messages_select_own"
  on carcanhol.chat_messages
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

create or replace function carcanhol.chat_model_is_eligible(
  p_user_id uuid,
  p_account_model_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from carcanhol.llm_account_models as model
    join carcanhol.llm_accounts as account
      on account.id = model.account_id
     and account.user_id = model.user_id
    where model.id = p_account_model_id
      and model.user_id = p_user_id
      and not model.is_stale
      and account.status = 'active'
      and account.last_validation_status = 'succeeded'
      and account.provider = 'github_copilot'
  );
$$;

create or replace function carcanhol.create_chat_conversation(
  p_user_id uuid,
  p_title text default 'Nova conversa',
  p_account_model_id uuid default null
)
returns carcanhol.chat_conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_model_id uuid;
  v_conversation carcanhol.chat_conversations;
begin
  if (select auth.uid()) is distinct from p_user_id
    or not exists (
      select 1 from carcanhol.profiles as p where p.id = p_user_id
    ) then
    raise exception using errcode = '42501', message = 'Not authorized.';
  end if;

  if p_title is null or char_length(btrim(p_title)) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Invalid title.';
  end if;

  v_model_id := p_account_model_id;

  if v_model_id is null then
    select preference.account_model_id
    into v_model_id
    from carcanhol.llm_model_preferences as preference
    where preference.user_id = p_user_id
      and preference.scope = 'global'
      and preference.feature_key is null;
  end if;

  if v_model_id is null
    or not carcanhol.chat_model_is_eligible(p_user_id, v_model_id) then
    raise exception using errcode = 'P0001', message = 'No eligible model.';
  end if;

  insert into carcanhol.chat_conversations (
    user_id,
    title,
    current_account_model_id
  )
  values (p_user_id, btrim(p_title), v_model_id)
  returning * into v_conversation;

  return v_conversation;
end;
$$;

create or replace function carcanhol.update_chat_conversation(
  p_user_id uuid,
  p_conversation_id uuid,
  p_title text default null,
  p_account_model_id uuid default null,
  p_skill_mode text default null,
  p_skill_ids uuid[] default null
)
returns carcanhol.chat_conversations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation carcanhol.chat_conversations;
  v_skill_count integer;
begin
  if (select auth.uid()) is distinct from p_user_id
    or not exists (
      select 1 from carcanhol.profiles as p where p.id = p_user_id
    ) then
    raise exception using errcode = '42501', message = 'Not authorized.';
  end if;

  if (p_title is not null and char_length(btrim(p_title)) not between 1 and 120)
    or (p_skill_mode is not null and p_skill_mode not in ('manual', 'automatic'))
    or cardinality(coalesce(p_skill_ids, '{}'::uuid[])) > 20
    or (
      p_account_model_id is not null
      and not carcanhol.chat_model_is_eligible(p_user_id, p_account_model_id)
    ) then
    raise exception using errcode = '22023', message = 'Invalid conversation update.';
  end if;

  if p_skill_ids is not null then
    select count(distinct skill.id) into v_skill_count
    from carcanhol.skills as skill
    where skill.user_id = p_user_id
      and skill.status = 'active'
      and skill.id = any(p_skill_ids);

    if v_skill_count <> cardinality(p_skill_ids) then
      raise exception using errcode = '22023', message = 'Invalid Skill selection.';
    end if;
  end if;

  select * into v_conversation
  from carcanhol.chat_conversations
  where id = p_conversation_id and user_id = p_user_id
  for update;

  if not found then
    return null;
  end if;

  update carcanhol.chat_conversations
  set
    title = coalesce(btrim(p_title), title),
    current_account_model_id = coalesce(
      p_account_model_id,
      current_account_model_id
    ),
    skill_mode = coalesce(p_skill_mode, skill_mode),
    selected_skill_ids = coalesce(p_skill_ids, selected_skill_ids),
    version = version + 1
  where id = p_conversation_id
  returning * into v_conversation;

  return v_conversation;
end;
$$;

create or replace function carcanhol.delete_chat_conversation(
  p_user_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted uuid;
begin
  if (select auth.uid()) is distinct from p_user_id
    or not exists (
      select 1 from carcanhol.profiles as p where p.id = p_user_id
    ) then
    raise exception using errcode = '42501', message = 'Not authorized.';
  end if;

  delete from carcanhol.chat_conversations
  where id = p_conversation_id and user_id = p_user_id
  returning id into v_deleted;

  return v_deleted is not null;
end;
$$;

create or replace function carcanhol.begin_chat_turn(
  p_user_id uuid,
  p_conversation_id uuid,
  p_account_model_id uuid,
  p_client_request_id uuid,
  p_content text,
  p_title text,
  p_skill_mode text,
  p_skill_ids uuid[],
  p_skill_audit jsonb,
  p_expected_version bigint
)
returns table (
  conversation_id uuid,
  user_message_id uuid,
  assistant_message_id uuid,
  conversation_version bigint,
  already_exists boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation carcanhol.chat_conversations;
  v_user_message carcanhol.chat_messages;
  v_assistant_message carcanhol.chat_messages;
  v_account carcanhol.llm_accounts;
  v_model carcanhol.llm_account_models;
  v_next bigint;
begin
  if (select auth.uid()) is distinct from p_user_id
    or not exists (
      select 1 from carcanhol.profiles as p where p.id = p_user_id
    ) then
    raise exception using errcode = '42501', message = 'Not authorized.';
  end if;

  select * into v_user_message
  from carcanhol.chat_messages
  where user_id = p_user_id
    and client_request_id = p_client_request_id;

  if found then
    select * into v_assistant_message
    from carcanhol.chat_messages
    where conversation_id = v_user_message.conversation_id
      and user_id = p_user_id
      and reply_to_message_id = v_user_message.id
    order by sequence desc
    limit 1;

    select * into v_conversation
    from carcanhol.chat_conversations
    where id = v_user_message.conversation_id
      and user_id = p_user_id;

    return query select
      v_user_message.conversation_id,
      v_user_message.id,
      v_assistant_message.id,
      v_conversation.version,
      true;
    return;
  end if;

  if p_content is null or char_length(btrim(p_content)) not between 1 and 8000
    or p_skill_mode not in ('manual', 'automatic')
    or cardinality(coalesce(p_skill_ids, '{}'::uuid[])) > 20
    or jsonb_typeof(p_skill_audit) <> 'array' then
    raise exception using errcode = '22023', message = 'Invalid chat turn.';
  end if;

  select * into v_conversation
  from carcanhol.chat_conversations
  where id = p_conversation_id
    and user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Conversation not found.';
  end if;

  if v_conversation.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Conversation changed.';
  end if;

  if not carcanhol.chat_model_is_eligible(p_user_id, p_account_model_id) then
    raise exception using errcode = 'P0001', message = 'No eligible model.';
  end if;

  select * into v_model
  from carcanhol.llm_account_models
  where id = p_account_model_id and user_id = p_user_id;

  select * into v_account
  from carcanhol.llm_accounts
  where id = v_model.account_id and user_id = p_user_id;

  v_next := coalesce((
    select max(message.sequence) + 1
    from carcanhol.chat_messages as message
    where message.conversation_id = p_conversation_id
  ), 1);

  insert into carcanhol.chat_messages (
    conversation_id,
    user_id,
    sequence,
    role,
    status,
    content,
    client_request_id,
    completed_at
  )
  values (
    p_conversation_id,
    p_user_id,
    v_next,
    'user',
    'complete',
    btrim(p_content),
    p_client_request_id,
    now()
  )
  returning * into v_user_message;

  insert into carcanhol.chat_messages (
    conversation_id,
    user_id,
    sequence,
    role,
    status,
    client_request_id,
    reply_to_message_id,
    account_model_id,
    provider,
    account_name,
    provider_model_id,
    model_name,
    skill_audit
  )
  values (
    p_conversation_id,
    p_user_id,
    v_next + 1,
    'assistant',
    'streaming',
    gen_random_uuid(),
    v_user_message.id,
    p_account_model_id,
    v_account.provider,
    v_account.display_name,
    v_model.provider_model_id,
    v_model.display_name,
    p_skill_audit
  )
  returning * into v_assistant_message;

  update carcanhol.chat_conversations
  set
    title = case
      when v_next = 1 then btrim(p_title)
      else title
    end,
    current_account_model_id = p_account_model_id,
    skill_mode = p_skill_mode,
    selected_skill_ids = coalesce(p_skill_ids, '{}'::uuid[]),
    last_message_at = now(),
    version = version + 1
  where id = p_conversation_id
  returning * into v_conversation;

  return query select
    p_conversation_id,
    v_user_message.id,
    v_assistant_message.id,
    v_conversation.version,
    false;
end;
$$;

create or replace function carcanhol.retry_chat_turn(
  p_user_id uuid,
  p_conversation_id uuid,
  p_failed_assistant_id uuid,
  p_account_model_id uuid,
  p_client_request_id uuid,
  p_skill_audit jsonb,
  p_expected_version bigint
)
returns table (
  conversation_id uuid,
  user_message_id uuid,
  assistant_message_id uuid,
  conversation_version bigint,
  already_exists boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation carcanhol.chat_conversations;
  v_previous carcanhol.chat_messages;
  v_existing carcanhol.chat_messages;
  v_assistant carcanhol.chat_messages;
  v_account carcanhol.llm_accounts;
  v_model carcanhol.llm_account_models;
  v_next bigint;
begin
  if (select auth.uid()) is distinct from p_user_id
    or not exists (
      select 1 from carcanhol.profiles as p where p.id = p_user_id
    ) then
    raise exception using errcode = '42501', message = 'Not authorized.';
  end if;

  select * into v_existing
  from carcanhol.chat_messages
  where user_id = p_user_id
    and client_request_id = p_client_request_id;

  if found then
    select version into v_next
    from carcanhol.chat_conversations
    where id = v_existing.conversation_id and user_id = p_user_id;
    return query select
      v_existing.conversation_id,
      v_existing.reply_to_message_id,
      v_existing.id,
      v_next,
      true;
    return;
  end if;

  select * into v_conversation
  from carcanhol.chat_conversations
  where id = p_conversation_id and user_id = p_user_id
  for update;

  if not found or v_conversation.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'Conversation changed.';
  end if;

  select * into v_previous
  from carcanhol.chat_messages
  where id = p_failed_assistant_id
    and conversation_id = p_conversation_id
    and user_id = p_user_id
    and role = 'assistant'
    and status in ('cancelled', 'failed');

  if not found
    or not carcanhol.chat_model_is_eligible(p_user_id, p_account_model_id)
    or jsonb_typeof(p_skill_audit) <> 'array' then
    raise exception using errcode = '22023', message = 'Invalid retry.';
  end if;

  select * into v_model
  from carcanhol.llm_account_models
  where id = p_account_model_id and user_id = p_user_id;

  select * into v_account
  from carcanhol.llm_accounts
  where id = v_model.account_id and user_id = p_user_id;

  select max(message.sequence) + 1 into v_next
  from carcanhol.chat_messages as message
  where message.conversation_id = p_conversation_id;

  insert into carcanhol.chat_messages (
    conversation_id,
    user_id,
    sequence,
    role,
    status,
    client_request_id,
    reply_to_message_id,
    account_model_id,
    provider,
    account_name,
    provider_model_id,
    model_name,
    skill_audit
  )
  values (
    p_conversation_id,
    p_user_id,
    v_next,
    'assistant',
    'streaming',
    p_client_request_id,
    v_previous.reply_to_message_id,
    p_account_model_id,
    v_account.provider,
    v_account.display_name,
    v_model.provider_model_id,
    v_model.display_name,
    p_skill_audit
  )
  returning * into v_assistant;

  update carcanhol.chat_conversations
  set
    current_account_model_id = p_account_model_id,
    last_message_at = now(),
    version = version + 1
  where id = p_conversation_id
  returning * into v_conversation;

  return query select
    p_conversation_id,
    v_previous.reply_to_message_id,
    v_assistant.id,
    v_conversation.version,
    false;
end;
$$;

create or replace function carcanhol.finalize_chat_message(
  p_user_id uuid,
  p_assistant_message_id uuid,
  p_status text,
  p_content text,
  p_usage jsonb default null,
  p_error_code text default null
)
returns carcanhol.chat_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message carcanhol.chat_messages;
begin
  if (select auth.uid()) is distinct from p_user_id
    or not exists (
      select 1 from carcanhol.profiles as p where p.id = p_user_id
    )
    or p_status not in ('complete', 'cancelled', 'failed')
    or char_length(coalesce(p_content, '')) > 120000
    or (p_usage is not null and jsonb_typeof(p_usage) <> 'object')
    or (
      (p_status = 'complete' and p_error_code is not null)
      or (p_status <> 'complete' and p_error_code is null)
    ) then
    raise exception using errcode = '22023', message = 'Invalid final state.';
  end if;

  update carcanhol.chat_messages
  set
    status = p_status,
    content = coalesce(p_content, ''),
    usage = p_usage,
    error_code = p_error_code,
    completed_at = now()
  where id = p_assistant_message_id
    and user_id = p_user_id
    and role = 'assistant'
    and status = 'streaming'
  returning * into v_message;

  if not found then
    select * into v_message
    from carcanhol.chat_messages
    where id = p_assistant_message_id
      and user_id = p_user_id
      and role = 'assistant';
  end if;

  return v_message;
end;
$$;

create or replace function carcanhol.get_llm_chat_target(
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
language sql
security definer
set search_path = ''
as $$
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
  from carcanhol.llm_account_models as model
  join carcanhol.llm_accounts as account
    on account.id = model.account_id
   and account.user_id = model.user_id
  join carcanhol.llm_account_secrets as secret
    on secret.account_id = account.id
   and secret.user_id = account.user_id
  where model.id = p_account_model_id
    and model.user_id = p_user_id
    and account.provider = 'github_copilot'
    and account.status = 'active'
    and account.last_validation_status = 'succeeded'
    and not model.is_stale;
$$;

revoke all on function carcanhol.chat_model_is_eligible(uuid, uuid)
  from public, anon, authenticated;
revoke all on function carcanhol.create_chat_conversation(uuid, text, uuid)
  from public, anon;
revoke all on function carcanhol.update_chat_conversation(
  uuid, uuid, text, uuid, text, uuid[]
) from public, anon;
revoke all on function carcanhol.delete_chat_conversation(uuid, uuid)
  from public, anon;
revoke all on function carcanhol.begin_chat_turn(
  uuid, uuid, uuid, uuid, text, text, text, uuid[], jsonb, bigint
) from public, anon;
revoke all on function carcanhol.retry_chat_turn(
  uuid, uuid, uuid, uuid, uuid, jsonb, bigint
) from public, anon;
revoke all on function carcanhol.finalize_chat_message(
  uuid, uuid, text, text, jsonb, text
) from public, anon;
revoke all on function carcanhol.get_llm_chat_target(uuid, uuid)
  from public, anon, authenticated;

grant execute on function carcanhol.create_chat_conversation(uuid, text, uuid)
  to authenticated;
grant execute on function carcanhol.update_chat_conversation(
  uuid, uuid, text, uuid, text, uuid[]
) to authenticated;
grant execute on function carcanhol.delete_chat_conversation(uuid, uuid)
  to authenticated;
grant execute on function carcanhol.begin_chat_turn(
  uuid, uuid, uuid, uuid, text, text, text, uuid[], jsonb, bigint
) to authenticated;
grant execute on function carcanhol.retry_chat_turn(
  uuid, uuid, uuid, uuid, uuid, jsonb, bigint
) to authenticated;
grant execute on function carcanhol.finalize_chat_message(
  uuid, uuid, text, text, jsonb, text
) to authenticated;
grant execute on function carcanhol.get_llm_chat_target(uuid, uuid)
  to service_role;

commit;
