-- ============================================================================
-- Migration 2 — additive changes only, safe to run once on the existing
-- database (does NOT touch or re-create anything from the original
-- schema.sql besides the one function replace noted below).
-- Run this in Supabase: Project -> SQL Editor -> New query -> paste -> Run
--
-- What this adds:
--   1. overtime_credits gets a day_portion column (defaults to 'half', so
--      every existing row is unaffected) + a guard requiring overtime to
--      only be logged on a date already marked Present.
--   2. paid_leave_balance() is updated (CREATE OR REPLACE, safe) to read
--      that new day_portion column instead of assuming every credit is 0.5.
--   3. Two new payroll functions: effective_working_days() and
--      calculate_salary().
--   4. A new notifications table + the triggers that populate it.
-- ============================================================================

-- ---- 1. overtime_credits: day_portion column -------------------------------
alter table overtime_credits add column if not exists day_portion day_portion not null default 'half';

-- ---- 2. paid_leave_balance(): updated to use day_portion -------------------
create or replace function paid_leave_balance(p_staff_id uuid, p_year int, p_month int) returns numeric as $$
declare
  base           numeric := 2.0;
  overtime_bonus numeric;
  adjustments    numeric;
  consumed       numeric;
begin
  select coalesce(sum(case when day_portion = 'half' then 0.5 else 1.0 end), 0) into overtime_bonus
  from overtime_credits
  where staff_id = p_staff_id
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

-- ============================================================================
-- Trigger: overtime_credits -- overtime presumes a full day was already
-- worked, so it can only be logged for a date already marked 'present'.
-- ============================================================================
create or replace function guard_overtime_write() returns trigger as $$
declare
  att_status attendance_status;
begin
  select status into att_status from attendance where staff_id = NEW.staff_id and date = NEW.date;
  if att_status is distinct from 'present' then
    raise exception 'Overtime can only be logged for a date already marked Present.';
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_guard_overtime_write
before insert or update on overtime_credits
for each row execute function guard_overtime_write();

-- ============================================================================
-- Payroll: effective working days + calculated salary
-- ============================================================================

-- Per-date effective-day value for each attendance status, per the agreed
-- rule (present/paid leave = 1, half-day paid leave = 1 [half worked +
-- half paid], half-day unpaid leave = 0.5 [half worked only], half-day
-- no-notice = 0.25, full no-notice absence = -0.5 net [0 for the missed
-- day, minus an extra 0.5-day penalty]). Overtime never gets a separate
-- line here -- it only tops up the paid-leave balance; the Present day it
-- rides on is already counted at 1.0.
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
      when 'present'                  then 1.0
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

-- Calculated salary for one month: monthly salary / actual days in that
-- month * effective working days. Owner can compute for anyone; a staff
-- member only for themself (the app only surfaces this once the viewed
-- month has fully ended -- enforced client-side, not here, since a staff
-- member checking their own in-progress-month number isn't a security
-- issue, just not a meaningful one yet). Marker never gets access.
create or replace function calculate_salary(p_staff_id uuid, p_year int, p_month int) returns numeric as $$
declare
  v_salary  numeric;
  v_days    int;
  v_eff     numeric;
begin
  if not (app_role() = 'owner' or p_staff_id = auth.uid()) then
    raise exception 'Not permitted.';
  end if;
  if app_role() = 'marker' then
    raise exception 'Not permitted.';
  end if;

  select monthly_salary into v_salary from staff_salary where staff_id = p_staff_id;
  if v_salary is null then return null; end if;

  v_days := extract(day from (date_trunc('month', make_date(p_year, p_month, 1)) + interval '1 month - 1 day'))::int;
  select effective_days into v_eff from effective_working_days(p_staff_id, p_year, p_month);

  return round(v_salary / v_days * v_eff, 2);
end;
$$ language plpgsql stable security definer;

-- ============================================================================
-- Notifications: owner-facing feed of exception events only (never routine
-- day-to-day marking). Populated entirely by triggers below.
-- ============================================================================
create type notification_type as enum (
  'leave_requested', 'leave_altered', 'absent_no_notice', 'half_day_no_notice',
  'overtime_logged', 'balance_adjusted'
);

create table notifications (
  id          uuid primary key default uuid_generate_v4(),
  type        notification_type not null,
  staff_id    uuid references profiles(id) on delete cascade,  -- who the notification is about
  message     text not null,
  related_id  uuid,   -- informational only: leave_request id / attendance id / overtime id / adjustment id
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index idx_notifications_created on notifications (created_at desc);

-- New pending leave request submitted.
create or replace function notify_leave_requested() returns trigger as $$
declare
  staff_name text;
begin
  if NEW.status = 'pending' then
    select full_name into staff_name from profiles where id = NEW.staff_id;
    insert into notifications (type, staff_id, message, related_id)
    values ('leave_requested', NEW.staff_id,
      coalesce(staff_name, 'A staff member') || ' requested leave for ' || NEW.from_date ||
      case when NEW.to_date <> NEW.from_date then ' to ' || NEW.to_date else '' end,
      NEW.id);
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_notify_leave_requested
after insert on leave_requests
for each row execute function notify_leave_requested();

-- An already-approved leave day gets cancelled or shortened (by staff or
-- by owner override) -- flags anything that changes a decision already made.
create or replace function notify_leave_altered() returns trigger as $$
declare
  staff_name text;
  actor_name text;
  req_status leave_status;
  action_word text;
begin
  if coalesce(current_setting('app.system_write', true), 'false') = 'true' then
    return NEW; -- internal recalculation write, not a real edit
  end if;

  select status into req_status from leave_requests where id = NEW.leave_request_id;
  if req_status <> 'approved' then
    return NEW; -- only flag changes to leave that was already approved
  end if;

  if NEW.day_status = 'cancelled' and OLD.day_status = 'active' then
    action_word := 'cancelled';
  elsif NEW.day_portion = 'half' and OLD.day_portion = 'full' then
    action_word := 'shortened to half-day';
  else
    return NEW;
  end if;

  select full_name into staff_name from profiles where id = NEW.staff_id;
  select full_name into actor_name from profiles where id = auth.uid();

  insert into notifications (type, staff_id, message, related_id)
  values ('leave_altered', NEW.staff_id,
    coalesce(actor_name, 'Someone') || ' ' || action_word || ' ' ||
    coalesce(staff_name, 'a staff member') || '''s approved leave for ' || NEW.date,
    NEW.leave_request_id);

  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_notify_leave_altered
after update on leave_request_days
for each row execute function notify_leave_altered();

-- A no-notice absence or half-day gets marked.
create or replace function notify_notable_attendance() returns trigger as $$
declare
  staff_name text;
  actor_name text;
begin
  if coalesce(current_setting('app.system_write', true), 'false') = 'true' then
    return NEW; -- system write from leave sync, not a real marking action
  end if;
  if NEW.status not in ('absent_no_notice', 'half_day_no_notice') then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.status = NEW.status then
    return NEW; -- already notified once for this status
  end if;

  select full_name into staff_name from profiles where id = NEW.staff_id;
  select full_name into actor_name from profiles where id = auth.uid();

  insert into notifications (type, staff_id, message, related_id)
  values (
    case when NEW.status = 'absent_no_notice' then 'absent_no_notice' else 'half_day_no_notice' end,
    NEW.staff_id,
    coalesce(staff_name, 'A staff member') || ' marked ' ||
    (case when NEW.status = 'absent_no_notice' then 'Absent (no notice)' else 'Half-day (no notice)' end) ||
    ' for ' || NEW.date || ' by ' || coalesce(actor_name, 'someone'),
    NEW.id
  );
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_notify_notable_attendance
after insert or update on attendance
for each row execute function notify_notable_attendance();

-- Overtime logged.
create or replace function notify_overtime_logged() returns trigger as $$
declare
  staff_name text;
begin
  select full_name into staff_name from profiles where id = NEW.staff_id;
  insert into notifications (type, staff_id, message, related_id)
  values ('overtime_logged', NEW.staff_id, coalesce(staff_name, 'A staff member') || ' logged overtime for ' || NEW.date, NEW.id);
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_notify_overtime_logged
after insert on overtime_credits
for each row execute function notify_overtime_logged();

-- Owner manually adjusted someone's paid-leave balance.
create or replace function notify_balance_adjusted() returns trigger as $$
declare
  staff_name text;
begin
  select full_name into staff_name from profiles where id = NEW.staff_id;
  insert into notifications (type, staff_id, message, related_id)
  values ('balance_adjusted', NEW.staff_id,
    'Paid leave balance adjusted for ' || coalesce(staff_name, 'a staff member') ||
    ' (' || NEW.month || '/' || NEW.year || '): ' ||
    (case when NEW.adjustment_amount > 0 then '+' else '' end) || NEW.adjustment_amount,
    NEW.id);
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_notify_balance_adjusted
after insert on leave_balance_adjustments
for each row execute function notify_balance_adjusted();

-- ---- Row Level Security for the new table ----------------------------------
alter table notifications enable row level security;

create policy "owner_all_notifications" on notifications for all
  using (app_role() = 'owner');
