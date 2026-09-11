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

-- Anonymous users do not need Data API access to this app schema. Authenticated
-- requests use the schema only after Supabase Auth has established a session.
revoke all on schema carcanhol from public, anon;
grant usage on schema carcanhol to authenticated, service_role;

-- 2. profiles table -----------------------------------------------------------------
-- Explicit app allowlist: a Supabase Auth user belongs to Carcanhol only when
-- an administrator inserts that user's UUID here. There is deliberately no
-- auth.users trigger because the Supabase project is shared with other apps.
create table if not exists carcanhol.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

comment on table carcanhol.profiles is
  'Explicit Carcanhol membership allowlist keyed by auth.users.id.';

-- Membership is administered in the SQL Editor, not by app users. Authenticated
-- clients only need to read their own row; anon receives no table privileges.
revoke all on carcanhol.profiles from public, anon, authenticated;
grant select on carcanhol.profiles to authenticated;
grant all on carcanhol.profiles to service_role;

-- Do not grant future app tables to authenticated users implicitly. Each table
-- must receive only the privileges required by its own access pattern.
alter default privileges in schema carcanhol
  revoke all on tables from public, anon, authenticated;

-- 3. Row Level Security ---------------------------------------------------------------
alter table carcanhol.profiles enable row level security;

-- Each user can only see their own profile.
drop policy if exists "profiles_select_own" on carcanhol.profiles;
create policy "profiles_select_own"
  on carcanhol.profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- Remove obsolete draft policies/automation if an earlier version of this
-- not-yet-production migration was tested in the shared project.
drop policy if exists "profiles_insert_own" on carcanhol.profiles;
drop policy if exists "profiles_update_own" on carcanhol.profiles;
drop trigger if exists carcanhol_on_auth_user_created on auth.users;
drop function if exists carcanhol.handle_new_user();

-- No delete policy: profiles are removed automatically via the
-- `on delete cascade` foreign key when the auth.users row is deleted.
