-- ============================================================================
-- Migration 9 -- shift type (morning / evening / night), each with its own
-- full-shift-length hours: morning & evening are 8h, night is 12h.
--
-- Fixes a real bug: a straight 12h night shift was being computed against
-- the old fixed 8h base, so it came out as "capped at 1.0 effective day,
-- plus 0.5 day credited as overtime/paid leave" -- which is wrong, since a
-- full 12h night shift is just the regular night-duty day, not overtime.
--
-- shift_type is NOT NULL, defaulting to 'morning'. The app always sends one
-- (the clock-in/edit-times screen pre-selects Morning, switchable to
-- Evening or Night) -- nothing is ever left blank. It's purely informational
-- on leave/no-notice-absence rows; nothing reads it there.
--
-- Overtime conversion rate is unchanged (still /8h, i.e. /480), even on a
-- night shift -- only the "what counts as a full day" threshold changes for
-- night. Confirmed: 2h beyond a 12h night shift = 2/8 = 0.25 day of paid
-- leave, same rate as any other shift's overtime.
--
-- Safe to run multiple times.
-- ============================================================================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'shift_type') then
    create type shift_type as enum ('morning', 'evening', 'night');
  end if;
end $$;

alter table attendance
  add column if not exists shift_type shift_type not null default 'morning';

comment on column attendance.shift_type is
  'Which shift this day''s hours belong to. Only changes the payroll math for ''night'' (12h base instead of 8h). Recorded on every present day for shift-mix reporting; meaningless on leave/absence rows.';

create or replace function compute_attendance_hours() returns trigger as $$
declare
  v_base_minutes int;
begin
  if NEW.status = 'present' then
    v_base_minutes := case when NEW.shift_type = 'night' then 720 else 480 end;
    if NEW.time_in is null or NEW.time_out is null then
      NEW.worked_minutes    := null;
      NEW.day_fraction      := 1.00;
      NEW.overtime_fraction := 0;
    else
      NEW.worked_minutes := round(extract(epoch from (NEW.time_out - NEW.time_in)) / 60)::int;
      if NEW.worked_minutes < 0 then
        NEW.worked_minutes := NEW.worked_minutes + 1440;
      end if;
      NEW.day_fraction      := round(least(NEW.worked_minutes::numeric / v_base_minutes, 1.0), 2);
      NEW.overtime_fraction := round(greatest(NEW.worked_minutes - v_base_minutes, 0) / 480.0, 2);
    end if;
  else
    NEW.worked_minutes    := null;
    NEW.day_fraction      := null;
    NEW.overtime_fraction := 0;
  end if;
  return NEW;
end;
$$ language plpgsql;

-- Trigger itself is unchanged (same function name/timing) -- CREATE OR
-- REPLACE takes effect immediately for the existing trg_compute_attendance_hours.

-- ----------------------------------------------------------------------------
-- To fix any night shift you already entered under the old (wrong) formula:
-- just reopen that date in the app, use "Edit times", switch the shift
-- selector to Night, and save -- the trigger recalculates everything
-- automatically. No SQL needed for that. (The equivalent backend one-liner,
-- if you ever want it, is:
--   update attendance set shift_type = 'night' where staff_id = '...' and date = '2026-08-xx';
-- )
-- ----------------------------------------------------------------------------
