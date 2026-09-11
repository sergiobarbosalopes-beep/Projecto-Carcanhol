-- Fase 2 - administration settings and manually managed Skills.
--
-- Apply after 0001_init_carcanhol_schema.sql. This migration is safe to
-- re-run and creates objects only inside the dedicated "carcanhol" schema.

create schema if not exists carcanhol;

revoke all on schema carcanhol from public, anon;
grant usage on schema carcanhol to authenticated, service_role;

create table if not exists carcanhol.global_assumptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint global_assumptions_content_length
    check (char_length(content) <= 20000)
);

comment on table carcanhol.global_assumptions is
  'Current global LLM assumptions for one Carcanhol user; no version history.';

create table if not exists carcanhol.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text not null default '',
  status text not null default 'draft',
  content_markdown text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skills_name_not_blank check (char_length(btrim(name)) > 0),
  constraint skills_name_length check (char_length(name) <= 120),
  constraint skills_description_length check (char_length(description) <= 500),
  constraint skills_content_length check (char_length(content_markdown) <= 50000),
  constraint skills_status_allowed
    check (status in ('draft', 'active', 'inactive', 'archived'))
);

comment on table carcanhol.skills is
  'User-owned manual Skills. Only active rows are eligible for future LLM runtime loading.';

create index if not exists skills_user_updated_idx
  on carcanhol.skills (user_id, updated_at desc);

create index if not exists skills_user_status_updated_idx
  on carcanhol.skills (user_id, status, updated_at desc);

create or replace function carcanhol.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function carcanhol.prevent_active_skill_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'active' then
    raise exception using
      errcode = '23514',
      message = 'An active skill must be deactivated before permanent deletion.';
  end if;
  return old;
end;
$$;

revoke all on function carcanhol.set_updated_at() from public, anon, authenticated;
revoke all on function carcanhol.prevent_active_skill_delete()
  from public, anon, authenticated;

drop trigger if exists global_assumptions_set_updated_at
  on carcanhol.global_assumptions;
create trigger global_assumptions_set_updated_at
  before update on carcanhol.global_assumptions
  for each row execute function carcanhol.set_updated_at();

drop trigger if exists skills_set_updated_at on carcanhol.skills;
create trigger skills_set_updated_at
  before update on carcanhol.skills
  for each row execute function carcanhol.set_updated_at();

drop trigger if exists skills_prevent_active_delete on carcanhol.skills;
create trigger skills_prevent_active_delete
  before delete on carcanhol.skills
  for each row execute function carcanhol.prevent_active_skill_delete();

revoke all on carcanhol.global_assumptions
  from public, anon, authenticated;
grant select, insert, update on carcanhol.global_assumptions to authenticated;
grant all on carcanhol.global_assumptions to service_role;

revoke all on carcanhol.skills from public, anon, authenticated;
grant select, insert, update, delete on carcanhol.skills to authenticated;
grant all on carcanhol.skills to service_role;

alter table carcanhol.global_assumptions enable row level security;
alter table carcanhol.skills enable row level security;

-- Every app-data policy requires both row ownership and explicit membership.
-- The profiles lookup is safe under RLS: its own policy checks only
-- auth.uid() = id and does not query either table below, so it cannot recurse.
drop policy if exists "global_assumptions_select_own"
  on carcanhol.global_assumptions;
create policy "global_assumptions_select_own"
  on carcanhol.global_assumptions
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "global_assumptions_insert_own"
  on carcanhol.global_assumptions;
create policy "global_assumptions_insert_own"
  on carcanhol.global_assumptions
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "global_assumptions_update_own"
  on carcanhol.global_assumptions;
create policy "global_assumptions_update_own"
  on carcanhol.global_assumptions
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "skills_select_own" on carcanhol.skills;
create policy "skills_select_own"
  on carcanhol.skills
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "skills_insert_own" on carcanhol.skills;
create policy "skills_insert_own"
  on carcanhol.skills
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "skills_update_own" on carcanhol.skills;
create policy "skills_update_own"
  on carcanhol.skills
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

drop policy if exists "skills_delete_own" on carcanhol.skills;
create policy "skills_delete_own"
  on carcanhol.skills
  for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from carcanhol.profiles as p
      where p.id = (select auth.uid())
    )
  );

alter default privileges in schema carcanhol
  revoke all on tables from public, anon, authenticated;
