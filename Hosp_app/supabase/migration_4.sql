-- ============================================================================
-- Migration 4 — self-signup for staff/marker accounts, with owner approval.
-- Safe to run once on top of migrations 2 and 3.
-- Run this in Supabase: Project -> SQL Editor -> New query -> paste -> Run
--
-- What this adds:
--   1. profiles.employee_code and profiles.role become nullable -- a
--      self-signed-up account has both null ("pending") until the owner
--      approves it in the app and fills them in.
--   2. A trigger that auto-creates a profiles row the moment someone signs
--      themselves up, so the app has something to show them right away
--      ("your account is waiting for approval").
--
-- Nothing here changes access for any EXISTING account -- a null role only
-- ever means "no access to anything but your own profile row", so this is
-- purely additive.
-- ============================================================================

-- ---- 1. Make employee_code and role nullable --------------------------------
alter table profiles alter column employee_code drop not null;
alter table profiles alter column role drop not null;
alter table profiles alter column role drop default;

-- ---- 2. Auto-create a profile row on signup ----------------------------------
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, full_name, is_active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', 'New sign-up'), false);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();
