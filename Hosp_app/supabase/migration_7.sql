-- ============================================================================
-- Migration 7 -- fixes night-shift attendance (e.g. 8 PM in, 8 AM out).
--
-- compute_attendance_hours() previously rejected any clock-out that was
-- earlier on the clock than the clock-in, treating it as a data-entry
-- error. That's wrong for a night shift: time_out being "before" time_in
-- just means it happened the next calendar day. Now it wraps forward 24h
-- instead and counts the whole shift on the date duty started -- an 8 PM
-- to 8 AM shift logs as 12 hours on the day it began, same as any other
-- day (capped at 1.0 effective day, the extra 4h credited as 0.5 paid
-- leave, exactly like any other overtime).
--
-- Safe to run multiple times.
-- ============================================================================

create or replace function compute_attendance_hours() returns trigger as $$
begin
  if NEW.status = 'present' then
    if NEW.time_in is null or NEW.time_out is null then
      NEW.worked_minutes    := null;
      NEW.day_fraction      := 1.00;
      NEW.overtime_fraction := 0;
    else
      NEW.worked_minutes := round(extract(epoch from (NEW.time_out - NEW.time_in)) / 60)::int;
      if NEW.worked_minutes < 0 then
        NEW.worked_minutes := NEW.worked_minutes + 1440;
      end if;
      NEW.day_fraction      := round(least(NEW.worked_minutes / 480.0, 1.0)::numeric, 2);
      NEW.overtime_fraction := round(greatest(NEW.worked_minutes / 480.0 - 1.0, 0)::numeric, 2);
    end if;
  else
    NEW.worked_minutes    := null;
    NEW.day_fraction      := null;
    NEW.overtime_fraction := 0;
  end if;
  return NEW;
end;
$$ language plpgsql;

-- The trigger itself is unchanged (same function name, same timing) so no
-- drop/recreate is needed -- CREATE OR REPLACE FUNCTION takes effect
-- immediately for the existing trg_compute_attendance_hours trigger.

-- ----------------------------------------------------------------------------
-- Re-run this for any night-shift day already saved with the old rejection
-- behavior worked around some other way (e.g. you left time_out blank).
-- Harmless no-op for everyone else. Uncomment and adjust if you have one:
-- ----------------------------------------------------------------------------
-- update attendance set time_out = time_out where staff_id = '...' and date = '2026-08-xx';
