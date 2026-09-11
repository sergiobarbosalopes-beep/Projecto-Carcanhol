-- Fase 1 (Foundation) — schema "carcanhol" and user profiles table.
--
-- This Supabase project is SHARED with other applications of the user.
-- Every object created by this app MUST live in the "carcanhol" schema,
-- never in "public", so it does not collide with other apps' objects.
--
-- How to apply:
--   1. Open the Supabase Dashboard → SQL Editor (for the shared project).
--   2. Paste the contents of this file and run it.
--   3. Repeat for any later files added under database/migrations/, in
--      filename order (this project does not use a migration runner yet;
--      files are numbered so they can be applied manually in sequence).
--
-- Safe to re-run: statements use IF NOT EXISTS / OR REPLACE where possible.

-- 1. Dedicated schema for this app -------------------------------------------------
create schema if not exists carcanhol;

-- Allow the standard Supabase roles to use the schema. Table-level access is
-- still governed by GRANTs below + Row Level Security policies.
grant usage on schema carcanhol to anon, authenticated, service_role;

-- 2. profiles table -----------------------------------------------------------------
-- One row per Supabase Auth user (auth.users), holding app-specific profile data.
-- Kept intentionally minimal in Phase 1.
create table if not exists carcanhol.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

comment on table carcanhol.profiles is
  'Carcanhol app profile, 1:1 with auth.users. Lives in the carcanhol schema (shared Supabase project).';

-- Default privileges for future tables created in this schema by this role.
alter default privileges in schema carcanhol
  grant select, insert, update, delete on tables to authenticated;

grant select, insert, update, delete on carcanhol.profiles to authenticated;
grant select on carcanhol.profiles to anon;
grant all on carcanhol.profiles to service_role;

-- 3. Row Level Security ---------------------------------------------------------------
alter table carcanhol.profiles enable row level security;

-- Each user can only see their own profile.
drop policy if exists "profiles_select_own" on carcanhol.profiles;
create policy "profiles_select_own"
  on carcanhol.profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- Each user can only insert their own profile row.
drop policy if exists "profiles_insert_own" on carcanhol.profiles;
create policy "profiles_insert_own"
  on carcanhol.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

-- Each user can only update their own profile.
drop policy if exists "profiles_update_own" on carcanhol.profiles;
create policy "profiles_update_own"
  on carcanhol.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No delete policy: profiles are removed automatically via the
-- `on delete cascade` foreign key when the auth.users row is deleted.

-- 4. Auto-create a profile row whenever a new auth user is created -------------------
-- search_path is intentionally empty: this is a SECURITY DEFINER function in
-- a shared database, so every identifier below is fully-qualified to avoid
-- any risk of resolving to an object from another schema/app.
create or replace function carcanhol.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into carcanhol.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Trigger name is namespaced with the "carcanhol_" prefix (even though it
-- lives on auth.users, outside our schema) so that dropping/recreating it
-- can never affect a trigger belonging to another app in this shared
-- Supabase project.
drop trigger if exists carcanhol_on_auth_user_created on auth.users;
create trigger carcanhol_on_auth_user_created
  after insert on auth.users
  for each row
  execute function carcanhol.handle_new_user();
