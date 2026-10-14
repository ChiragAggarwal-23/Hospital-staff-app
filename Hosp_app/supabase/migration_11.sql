-- ============================================================================
-- Migration 11 -- two related changes to who can touch an approved leave day:
--
--   1. Staff can no longer cancel or shorten their own approved leave at
--      all (previously allowed for a future, non-owner-overridden date).
--      If a staff member wants to change an approved leave now, they tell
--      the marker or owner, who does it from their own account.
--
--   2. Fixes a gap in migration_10: giving the marker full RLS access to
--      leave_request_days didn't actually let him cancel/shorten a day,
--      because a separate trigger (guard_leave_day_edit) still explicitly
--      blocked any role other than 'owner' or 'staff' -- so his "Unmark"
--      button on an approved leave day would have failed with "Not
--      permitted." This adds the marker branch that migration_10 should
--      have included alongside the RLS change.
--
-- (Withdrawing a still-PENDING request -- before anyone's approved it --
-- is untouched; that's not an attendance edit, there's no locked date yet.)
--
-- Safe to run multiple times.
-- ============================================================================

-- 1. Remove staff's RLS write access to leave_request_days entirely.
drop policy if exists "staff_update_own_leave_days" on leave_request_days;

-- 2. Rewrite the trigger-level guard: owner and marker get full access
-- (same as each other); staff gets none (falls through to the final
-- "Not permitted."); internal system writes are unaffected.
create or replace function guard_leave_day_edit() returns trigger as $$
declare
  actor_role user_role;
begin
  if coalesce(current_setting('app.system_write', true), 'false') = 'true' then
    return NEW; -- internal system write (recalculation / cascade), not a raw client edit
  end if;

  select role into actor_role from profiles where id = auth.uid();

  if actor_role in ('owner', 'marker') then
    NEW.owner_overridden := true;
    return NEW;
  end if;

  raise exception 'Not permitted.';
end;
$$ language plpgsql security definer;

-- Trigger itself is unchanged (same function name/timing) -- CREATE OR
-- REPLACE takes effect immediately for the existing trg_guard_leave_day_edit.
