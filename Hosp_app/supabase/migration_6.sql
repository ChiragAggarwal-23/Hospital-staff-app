-- ============================================================================
-- Migration 6 -- Clock-in/clock-out time tracking replaces the old
-- "mark Present + separately log Overtime" flow.
--
--   * A day marked Present now has a real time_in / time_out (picked
--     manually by the marker/owner, never taken from the device clock).
--   * Hours actually worked drive that day's contribution to effective
--     working days: exactly 8h = 1.0 (same as before), less than 8h = that
--     fraction of a day (e.g. 5h20m = 0.67), more than 8h caps the day at
--     1.0 and credits the extra as paid leave -- same net effect as the old
--     overtime button, just detected automatically instead of logged by
--     hand. No clock-out yet logged for a day = treated as a full day until
--     one is added.
--   * The old overtime_credits table, its "Log Overtime" button, and its
--     guard trigger are removed entirely -- there's now exactly one way a
--     day gets credited for extra time, not two.
--   * Nothing about leave requests, no-notice absent/half-day marking, or
--     the payroll formula itself changes.
--
-- Safe to run multiple times.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New attendance columns
-- ----------------------------------------------------------------------------
alter table attendance
  add column if not exists worked_minutes    int,
  add column if not exists day_fraction      numeric(4,2),
  add column if not exists overtime_fraction numeric(4,2) not null default 0;

comment on column attendance.worked_minutes is
  'Minutes between time_in and time_out. Null until both are logged.';
comment on column attendance.day_fraction is
  'This date''s contribution to effective working days (status = present only), capped at 1.00. Null for every other status -- effective_working_days() uses a fixed value for those instead.';
comment on column attendance.overtime_fraction is
  'Fraction of a day worked beyond 8h (status = present only), added straight into that month''s paid-leave balance.';

-- Backfill: any existing Present row with no times logged yet is a full day,
-- same as it always implicitly was.
update attendance
set day_fraction = 1.00, overtime_fraction = 0
where status = 'present' and day_fraction is null;

-- ----------------------------------------------------------------------------
-- 2. Retire the overtime_credits table and its guard trigger entirely --
--    cascades away its own triggers, policies and index automatically.
-- ----------------------------------------------------------------------------
drop table if exists overtime_credits cascade;
drop function if exists guard_overtime_write();

-- ----------------------------------------------------------------------------
-- 3. compute_attendance_hours() -- derives worked_minutes / day_fraction /
--    overtime_fraction from time_in + time_out whenever status = 'present'.
-- ----------------------------------------------------------------------------
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
        raise exception 'Clock-out time must be after clock-in time.';
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

drop trigger if exists trg_compute_attendance_hours on attendance;
create trigger trg_compute_attendance_hours
before insert or update on attendance
for each row execute function compute_attendance_hours();

-- ----------------------------------------------------------------------------
-- 4. Payroll functions: read the new columns instead of overtime_credits.
-- ----------------------------------------------------------------------------
create or replace function paid_leave_balance(p_staff_id uuid, p_year int, p_month int) returns numeric as $$
declare
  base           numeric := 2.0;
  overtime_bonus numeric;
  adjustments    numeric;
  consumed       numeric;
begin
  select coalesce(sum(overtime_fraction), 0) into overtime_bonus
  from attendance
  where staff_id = p_staff_id
    and status = 'present'
    and extract(year from date) = p_year
    and extract(month from date) = p_month;

  select coalesce(sum(adjustment_amount), 0) into adjustments
  from leave_balance_adjustments
  where staff_id = p_staff_id and year = p_year and month = p_month;

  select coalesce(sum(case when lrd.day_portion = 'half' then 0.5 else 1.0 end), 0) into consumed
  from leave_request_days lrd
  join leave_requests lr on lr.id = lrd.leave_request_id
  where lrd.staff_id = p_staff_id
    and lrd.type = 'paid'
    and lrd.day_status = 'active'
    and lr.status in ('pending', 'approved')
    and extract(year from lrd.date) = p_year
    and extract(month from lrd.date) = p_month;

  return base + overtime_bonus + adjustments - consumed;
end;
$$ language plpgsql stable security definer;

create or replace function effective_working_days(p_staff_id uuid, p_year int, p_month int)
returns table(effective_days numeric, marked_days int, unmarked_days int, total_days int) as $$
declare
  v_total   int;
  v_marked  int;
  v_effective numeric;
begin
  if app_role() not in ('owner', 'marker') and p_staff_id <> auth.uid() then
    raise exception 'Not permitted.';
  end if;

  v_total := extract(day from (date_trunc('month', make_date(p_year, p_month, 1)) + interval '1 month - 1 day'))::int;

  select count(*), coalesce(sum(
    case status
      when 'present'                  then coalesce(day_fraction, 1.0)
      when 'approved_paid_leave'      then 1.0
      when 'approved_unpaid_leave'    then 0.0
      when 'half_day_approved_paid'   then 1.0
      when 'half_day_approved_unpaid' then 0.5
      when 'half_day_no_notice'       then 0.25
      when 'absent_no_notice'         then -0.5
      else 0
    end
  ), 0)
  into v_marked, v_effective
  from attendance
  where staff_id = p_staff_id
    and extract(year from date) = p_year
    and extract(month from date) = p_month;

  return query select v_effective, v_marked, (v_total - v_marked), v_total;
end;
$$ language plpgsql stable security definer;

-- ----------------------------------------------------------------------------
-- 5. Notifications: overtime's relevant date + the auto-fired notification
--    itself now both live on the attendance row instead of overtime_credits.
-- ----------------------------------------------------------------------------
create or replace function notification_relevant_date(p_type notification_type, p_related_id uuid) returns date as $$
declare
  v_date date;
begin
  if p_type in ('leave_requested', 'leave_altered') then
    select to_date into v_date from leave_requests where id = p_related_id;
  elsif p_type in ('absent_no_notice', 'half_day_no_notice') then
    select date into v_date from attendance where id = p_related_id;
  elsif p_type = 'overtime_logged' then
    select date into v_date from attendance where id = p_related_id;
  elsif p_type = 'balance_adjusted' then
    select (make_date(year, month, 1) + interval '1 month - 1 day')::date into v_date
    from leave_balance_adjustments where id = p_related_id;
  end if;
  return v_date;
end;
$$ language plpgsql stable security definer;

create or replace function notify_overtime_logged() returns trigger as $$
declare
  staff_name text;
begin
  if coalesce(current_setting('app.system_write', true), 'false') = 'true' then
    return NEW;
  end if;
  if NEW.status <> 'present' or NEW.overtime_fraction <= 0 then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.overtime_fraction = NEW.overtime_fraction then
    return NEW;
  end if;

  select full_name into staff_name from profiles where id = NEW.staff_id;
  insert into notifications (type, staff_id, message, related_id)
  values ('overtime_logged', NEW.staff_id,
    coalesce(staff_name, 'A staff member') || ' logged ' || NEW.overtime_fraction || ' day(s) of overtime for ' || NEW.date,
    NEW.id);
  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_notify_overtime_logged on attendance;
create trigger trg_notify_overtime_logged
after insert or update on attendance
for each row execute function notify_overtime_logged();

-- ============================================================================
-- Done. After running this, re-upload the web/ files -- the new Clock
-- in/Clock out UI in app.js depends on these columns and functions.
-- ============================================================================
