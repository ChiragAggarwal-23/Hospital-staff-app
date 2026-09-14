-- ============================================================================
-- Hospital Staff Management App — Database Schema (final, consolidated)
-- Run this in Supabase: Project -> SQL Editor -> New query -> paste -> Run
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type user_role as enum ('owner', 'marker', 'staff');
create type leave_type as enum ('paid', 'unpaid');
create type day_portion as enum ('full', 'half');
create type leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');
create type day_status as enum ('active', 'cancelled');
create type leave_source as enum ('staff_request', 'marker_logged', 'owner_logged');

create type attendance_status as enum (
  'present',
  'half_day_no_notice',        -- unplanned half-day absence -> 0.75 day deduction (payroll phase)
  'absent_no_notice',          -- unplanned full-day absence -> 1.5 day deduction (payroll phase)
  'approved_paid_leave',
  'approved_unpaid_leave',
  'half_day_approved_paid',
  'half_day_approved_unpaid'
);

-- ----------------------------------------------------------------------------
-- profiles: one row per login. No salary here on purpose (marker can read
-- this table, so nothing sensitive belongs in it).
--
-- employee_code and role are both nullable: a self-signed-up account lands
-- here with both null ("pending" -- see handle_new_user() below) and gets
-- neither until the owner approves it and fills them in. A null role means
-- app_role() returns null, which every RLS policy below treats as "no
-- access" -- so a pending account can read nothing but its own row until
-- the owner assigns it a real role.
-- ----------------------------------------------------------------------------
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  employee_code text unique,
  full_name     text not null,
  role          user_role,
  department    text,
  designation   text,
  join_date     date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Auto-creates the matching profiles row the moment someone signs themself
-- up (sb.auth.signUp()). full_name comes from the signup form via
-- supabase's user metadata; everything else is left null/pending until the
-- owner approves the account in the app's Staff Directory tab.
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, full_name, is_active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', 'New sign-up'), false);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_user();

-- ----------------------------------------------------------------------------
-- staff_salary: separate table so the marker's access can exclude it
-- entirely. Only owner + the staff member themself can ever read a row here.
-- ----------------------------------------------------------------------------
create table staff_salary (
  staff_id       uuid primary key references profiles(id) on delete cascade,
  monthly_salary numeric(12,2),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references profiles(id)
);

-- ----------------------------------------------------------------------------
-- attendance: one row per staff member per calendar date.
-- No row for a date = not marked yet. locked_by_leave = auto-filled by an
-- approved leave day, and can't be hand-edited by the marker.
-- ----------------------------------------------------------------------------
create table attendance (
  id              uuid primary key default uuid_generate_v4(),
  staff_id        uuid not null references profiles(id) on delete cascade,
  date            date not null,
  status          attendance_status not null,
  time_in         time,
  time_out        time,
  locked_by_leave boolean not null default false,
  marked_by       uuid references profiles(id),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (staff_id, date)
);

create index idx_attendance_staff_date on attendance (staff_id, date);

-- ----------------------------------------------------------------------------
-- overtime_credits: one half-day credit per staff member per date logged.
-- Feeds directly into that month's paid-leave balance (see the balance
-- function below) -- doesn't touch attendance or leave_requests at all.
-- ----------------------------------------------------------------------------
create table overtime_credits (
  id           uuid primary key default uuid_generate_v4(),
  staff_id     uuid not null references profiles(id) on delete cascade,
  date         date not null,
  day_portion  day_portion not null default 'half',  -- 'half' today; 'full' reserved for when full-day overtime is confirmed
  reason       text,
  recorded_by  uuid references profiles(id),
  created_at   timestamptz not null default now(),
  unique (staff_id, date)
);

create index idx_overtime_staff_date on overtime_credits (staff_id, date);

-- ----------------------------------------------------------------------------
-- leave_balance_adjustments: owner-only manual correction to a staff
-- member's paid-leave balance for a given month, for fixing discrepancies.
-- Just adds (or subtracts) into the same balance calculation everything
-- else already uses -- no separate logic needed anywhere else.
-- ----------------------------------------------------------------------------
create table leave_balance_adjustments (
  id                uuid primary key default uuid_generate_v4(),
  staff_id          uuid not null references profiles(id) on delete cascade,
  year              int not null,
  month             int not null check (month between 1 and 12),
  adjustment_amount numeric(4,1) not null,   -- positive to add, negative to subtract
  reason            text,
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now()
);

create index idx_adjustments_staff_month on leave_balance_adjustments (staff_id, year, month);

-- ----------------------------------------------------------------------------
-- leave_requests: the header of a leave application. Can span multiple
-- dates -- the per-date paid/unpaid breakdown lives in leave_request_days
-- below, not here.
-- ----------------------------------------------------------------------------
create table leave_requests (
  id             uuid primary key default uuid_generate_v4(),
  staff_id       uuid not null references profiles(id) on delete cascade,
  from_date      date not null,
  to_date        date not null,
  day_portion    day_portion not null default 'full',   -- 'half' only valid when from_date = to_date
  requested_type leave_type not null,                    -- staff's (or marker's/owner's) overall ask
  reason         text not null,
  status         leave_status not null default 'pending',
  source         leave_source not null default 'staff_request',
  reviewed_by    uuid references profiles(id),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  check (to_date >= from_date),
  check (day_portion = 'full' or from_date = to_date)
);

create index idx_leave_requests_staff_status on leave_requests (staff_id, status);

-- ----------------------------------------------------------------------------
-- leave_request_days: one row per date within a leave request. This is
-- what actually drives the attendance calendar and the payroll balance.
--   requested_type   = what was originally asked for this date (never
--                       changed by auto-recalculation, only by an owner
--                       override)
--   type             = the CURRENT, effective tag for this date (paid or
--                       unpaid) -- auto-computed against the balance, and
--                       re-computed whenever a sibling day in the same
--                       request is cancelled or shortened
--   owner_overridden = true once the owner has manually set this row --
--                       from then on, auto-recalculation leaves it alone
-- ----------------------------------------------------------------------------
create table leave_request_days (
  id               uuid primary key default uuid_generate_v4(),
  leave_request_id uuid not null references leave_requests(id) on delete cascade,
  staff_id         uuid not null references profiles(id) on delete cascade,
  date             date not null,
  day_portion      day_portion not null default 'full',
  requested_type   leave_type not null,
  type             leave_type not null,
  day_status       day_status not null default 'active',
  owner_overridden boolean not null default false,
  cancelled_at     timestamptz,
  cancelled_by     uuid references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (leave_request_id, date)
);

create index idx_leave_days_staff_date on leave_request_days (staff_id, date);

-- at most one ACTIVE leave day per staff per date, across every request
create unique index uniq_active_leave_day_per_date
  on leave_request_days (staff_id, date)
  where day_status = 'active';

-- ============================================================================
-- Helper functions
-- ============================================================================

create or replace function app_role() returns user_role as $$
  select role from profiles where id = auth.uid();
$$ language sql stable security definer;

-- The core payroll number: how many paid-leave days does this staff member
-- have left for this specific month.
--   = base 2/month
--   + 0.5 for every overtime day logged this month
--   + any manual owner adjustment for this month
--   - every currently-active date this month tagged 'paid', across every
--     pending or approved request (pending counts too, so two requests
--     submitted close together can't both assume the full balance)
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

-- Safe wrapper the app can call directly: a staff member can only ever
-- fetch their own balance; the owner can fetch anyone's.
create or replace function staff_paid_leave_balance(p_staff_id uuid, p_year int, p_month int) returns numeric as $$
begin
  if app_role() <> 'owner' and p_staff_id <> auth.uid() then
    raise exception 'Not permitted.';
  end if;
  return paid_leave_balance(p_staff_id, p_year, p_month);
end;
$$ language plpgsql stable security definer;

-- Re-runs the paid/unpaid auto-cap across a request's own active days.
-- p_include_past = true only at initial creation (nothing is "history" yet);
-- every later recalculation (cancel / shorten) only ever touches
-- today-or-future dates, never rewrites an already-passed day.
create or replace function recalc_request_days(p_leave_request_id uuid, p_include_past boolean default false) returns void as $$
declare
  r    record;
  bal  numeric;
  yr   int;
  mo   int;
  unit numeric;
  s_id uuid;
begin
  select staff_id into s_id from leave_requests where id = p_leave_request_id;

  perform set_config('app.system_write', 'true', true);

  update leave_request_days
  set type = 'unpaid', updated_at = now()
  where leave_request_id = p_leave_request_id
    and day_status = 'active'
    and (p_include_past or date >= current_date)
    and owner_overridden = false
    and requested_type = 'paid';

  for r in
    select * from leave_request_days
    where leave_request_id = p_leave_request_id
      and day_status = 'active'
      and (p_include_past or date >= current_date)
      and owner_overridden = false
      and requested_type = 'paid'
    order by date
  loop
    yr   := extract(year from r.date)::int;
    mo   := extract(month from r.date)::int;
    bal  := paid_leave_balance(s_id, yr, mo);
    unit := case when r.day_portion = 'half' then 0.5 else 1.0 end;
    if bal >= unit then
      update leave_request_days set type = 'paid', updated_at = now() where id = r.id;
    end if;
  end loop;

  perform set_config('app.system_write', 'false', true);
end;
$$ language plpgsql security definer;

-- Writes (or removes) attendance rows to match a request's current
-- leave_request_days state. Bypasses the attendance guard trigger, since
-- this is the system acting on an already-decided leave, not a raw edit.
create or replace function sync_leave_to_attendance(p_leave_request_id uuid) returns void as $$
declare
  r        record;
  atype    attendance_status;
  reviewer uuid;
begin
  select reviewed_by into reviewer from leave_requests where id = p_leave_request_id;

  perform set_config('app.system_write', 'true', true);

  for r in select * from leave_request_days where leave_request_id = p_leave_request_id loop
    if r.day_status = 'cancelled' then
      delete from attendance
      where staff_id = r.staff_id and date = r.date and locked_by_leave = true;
    else
      atype := case
        when r.day_portion = 'full' and r.type = 'paid'   then 'approved_paid_leave'::attendance_status
        when r.day_portion = 'full' and r.type = 'unpaid' then 'approved_unpaid_leave'::attendance_status
        when r.day_portion = 'half' and r.type = 'paid'   then 'half_day_approved_paid'::attendance_status
        else 'half_day_approved_unpaid'::attendance_status
      end;
      insert into attendance (staff_id, date, status, locked_by_leave, marked_by)
      values (r.staff_id, r.date, atype, true, reviewer)
      on conflict (staff_id, date) do update
        set status = excluded.status, locked_by_leave = true,
            marked_by = excluded.marked_by, updated_at = now();
    end if;
  end loop;

  perform set_config('app.system_write', 'false', true);
end;
$$ language plpgsql security definer;

-- ============================================================================
-- Triggers: leave_requests
-- ============================================================================

-- Whenever a request is created, generate one leave_request_days row per
-- date, run the auto-cap, and -- if it's already approved (marker/owner
-- logging something directly) -- write it straight to the calendar.
create or replace function generate_leave_request_days() returns trigger as $$
declare
  d date;
begin
  d := NEW.from_date;
  while d <= NEW.to_date loop
    insert into leave_request_days
      (leave_request_id, staff_id, date, day_portion, requested_type, type, day_status)
    values
      (NEW.id, NEW.staff_id, d, NEW.day_portion, NEW.requested_type, 'unpaid', 'active');
    d := d + 1;
  end loop;

  perform recalc_request_days(NEW.id, true);

  if NEW.status = 'approved' then
    perform sync_leave_to_attendance(NEW.id);
  end if;

  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_generate_leave_request_days
after insert on leave_requests
for each row execute function generate_leave_request_days();

-- A pending request becoming approved -> write it to the calendar.
create or replace function on_leave_request_approved() returns trigger as $$
begin
  if NEW.status = 'approved' and OLD.status is distinct from 'approved' then
    perform sync_leave_to_attendance(NEW.id);
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_on_leave_request_approved
after update on leave_requests
for each row execute function on_leave_request_approved();

-- A staff member withdrawing their own still-pending request -> cancel
-- every day in it that hasn't happened yet (a day that's already passed
-- while stuck pending is left for the owner to sort out).
create or replace function cascade_cancel_request_days() returns trigger as $$
begin
  if NEW.status = 'cancelled' and OLD.status is distinct from 'cancelled' then
    perform set_config('app.system_write', 'true', true);
    update leave_request_days
    set day_status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    where leave_request_id = NEW.id
      and day_status = 'active'
      and date > current_date;
    perform set_config('app.system_write', 'false', true);
    perform sync_leave_to_attendance(NEW.id);
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_cascade_cancel_request_days
after update on leave_requests
for each row execute function cascade_cancel_request_days();

-- ============================================================================
-- Triggers: leave_request_days (the per-date cancel / shorten / override path)
-- ============================================================================

-- Validates who is allowed to change what, on which dates.
--   owner : unrestricted, any date, any change -- and marks it overridden
--           so later auto-recalculation never touches it again.
--   staff : only their own row, only a strictly-future date, only if it
--           hasn't already been owner-overridden, and only two possible
--           edits: cancel it, or shorten a full day down to a half day.
--   marker: no update policy on this table at all -- blocked outright.
create or replace function guard_leave_day_edit() returns trigger as $$
declare
  actor_role user_role;
begin
  if coalesce(current_setting('app.system_write', true), 'false') = 'true' then
    return NEW; -- internal system write (recalculation / cascade), not a raw client edit
  end if;

  select role into actor_role from profiles where id = auth.uid();

  if actor_role = 'owner' then
    NEW.owner_overridden := true;
    return NEW;
  end if;

  if actor_role = 'staff' then
    if OLD.staff_id <> auth.uid() then
      raise exception 'Not your leave record.';
    end if;
    if OLD.date <= current_date then
      raise exception 'This date has already passed and can only be changed by the owner.';
    end if;
    if OLD.owner_overridden then
      raise exception 'This entry was manually set by the owner and can no longer be self-edited.';
    end if;

    if NEW.day_status = 'cancelled' and OLD.day_status = 'active' then
      NEW.cancelled_at := now();
      NEW.cancelled_by := auth.uid();
      return NEW;
    elsif NEW.day_portion = 'half' and OLD.day_portion = 'full'
          and NEW.day_status = 'active' and OLD.day_status = 'active' then
      return NEW;
    else
      raise exception 'You may only cancel a future leave day, or shorten a full day to a half day.';
    end if;
  end if;

  raise exception 'Not permitted.';
end;
$$ language plpgsql security definer;

create trigger trg_guard_leave_day_edit
before update on leave_request_days
for each row execute function guard_leave_day_edit();

-- After a genuine client-initiated edit: re-balance the request's other
-- active future days, and re-sync the calendar.
create or replace function after_leave_day_change() returns trigger as $$
begin
  if coalesce(current_setting('app.system_write', true), 'false') = 'true' then
    return NEW;
  end if;
  perform recalc_request_days(NEW.leave_request_id);
  perform sync_leave_to_attendance(NEW.leave_request_id);
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_after_leave_day_change
after update on leave_request_days
for each row execute function after_leave_day_change();

-- ============================================================================
-- Trigger: attendance (marker/owner writing directly to the calendar)
-- ============================================================================
create or replace function guard_attendance_write() returns trigger as $$
declare
  actor_role         user_role;
  has_approved_leave boolean;
begin
  if coalesce(current_setting('app.system_write', true), 'false') = 'true' then
    return NEW; -- internal write coming from sync_leave_to_attendance
  end if;

  select role into actor_role from profiles where id = auth.uid();

  if actor_role = 'owner' then
    return NEW; -- owner override, always allowed
  end if;

  select exists (
    select 1 from leave_request_days
    where staff_id = NEW.staff_id
      and date = NEW.date
      and day_status = 'active'
  ) into has_approved_leave;

  if has_approved_leave then
    raise exception 'This date is locked by an approved leave and cannot be edited.';
  end if;

  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_guard_attendance_write
before insert or update on attendance
for each row execute function guard_attendance_write();

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
-- month * (effective working days + current paid-leave balance). The
-- unused paid-leave balance is added on top of effective days -- an
-- employee who worked every day AND still has paid leave left over is
-- paid for (effective_days + balance) days out of the month, not just
-- effective_days alone. Owner can compute for anyone; a staff member
-- only for themself (the app only surfaces this once the viewed month
-- has fully ended -- enforced client-side, not here, since a staff
-- member checking their own in-progress-month number isn't a security
-- issue, just not a meaningful one yet). Marker never gets access.
create or replace function calculate_salary(p_staff_id uuid, p_year int, p_month int) returns numeric as $$
declare
  v_salary  numeric;
  v_days    int;
  v_eff     numeric;
  v_bal     numeric;
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
  v_bal := paid_leave_balance(p_staff_id, p_year, p_month);

  return round(v_salary / v_days * (v_eff + v_bal), 2);
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
    (case when NEW.status = 'absent_no_notice' then 'absent_no_notice' else 'half_day_no_notice' end)::notification_type,
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

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table profiles enable row level security;
alter table staff_salary enable row level security;
alter table attendance enable row level security;
alter table overtime_credits enable row level security;
alter table leave_balance_adjustments enable row level security;
alter table leave_requests enable row level security;
alter table leave_request_days enable row level security;
alter table notifications enable row level security;

-- profiles -------------------------------------------------------------------
create policy "owner_all_profiles" on profiles for all
  using (app_role() = 'owner');

create policy "marker_read_profiles" on profiles for select
  using (app_role() = 'marker');

create policy "staff_read_own_profile" on profiles for select
  using (id = auth.uid());

-- staff_salary -- no marker policy at all, on purpose ------------------------
create policy "owner_all_salary" on staff_salary for all
  using (app_role() = 'owner');

create policy "staff_read_own_salary" on staff_salary for select
  using (staff_id = auth.uid());

-- attendance -------------------------------------------------------------------
create policy "owner_all_attendance" on attendance for all
  using (app_role() = 'owner');

create policy "marker_read_attendance" on attendance for select
  using (app_role() = 'marker');

create policy "marker_write_attendance" on attendance for insert
  with check (app_role() = 'marker');

create policy "marker_update_attendance" on attendance for update
  using (app_role() = 'marker');

create policy "staff_read_own_attendance" on attendance for select
  using (staff_id = auth.uid());

-- overtime_credits -------------------------------------------------------------
create policy "owner_all_overtime" on overtime_credits for all
  using (app_role() = 'owner');

create policy "marker_read_overtime" on overtime_credits for select
  using (app_role() = 'marker');

create policy "marker_write_overtime" on overtime_credits for insert
  with check (app_role() = 'marker');

create policy "marker_update_overtime" on overtime_credits for update
  using (app_role() = 'marker');

create policy "staff_read_own_overtime" on overtime_credits for select
  using (staff_id = auth.uid());

-- leave_balance_adjustments -- owner-only, staff can see their own ------------
create policy "owner_all_adjustments" on leave_balance_adjustments for all
  using (app_role() = 'owner');

create policy "staff_read_own_adjustments" on leave_balance_adjustments for select
  using (staff_id = auth.uid());

-- leave_requests -----------------------------------------------------------
create policy "owner_all_leave_requests" on leave_requests for all
  using (app_role() = 'owner');

create policy "marker_read_leave_requests" on leave_requests for select
  using (app_role() = 'marker');

create policy "staff_read_own_leave_requests" on leave_requests for select
  using (staff_id = auth.uid());

create policy "staff_insert_leave_request" on leave_requests for insert
  with check (
    app_role() = 'staff'
    and staff_id = auth.uid()
    and source = 'staff_request'
    and status = 'pending'
    and from_date >= current_date
  );

create policy "staff_cancel_pending_request" on leave_requests for update
  using (staff_id = auth.uid() and status = 'pending')
  with check (status = 'cancelled');

-- marker logging an already-happened, informally-approved leave: single
-- date, today or earlier, immediately approved, tagged with its source
create policy "marker_log_leave_request" on leave_requests for insert
  with check (
    app_role() = 'marker'
    and source = 'marker_logged'
    and status = 'approved'
    and from_date = to_date
    and from_date <= current_date
  );

-- leave_request_days ---------------------------------------------------------
create policy "owner_all_leave_days" on leave_request_days for all
  using (app_role() = 'owner');

create policy "marker_read_leave_days" on leave_request_days for select
  using (app_role() = 'marker');

create policy "staff_read_own_leave_days" on leave_request_days for select
  using (staff_id = auth.uid());

create policy "staff_update_own_leave_days" on leave_request_days for update
  using (staff_id = auth.uid());
  -- fine-grained validation (future dates only, cancel-or-shorten only,
  -- never on an owner-overridden row) happens in trg_guard_leave_day_edit

-- notifications -- owner-only, front to back ---------------------------------
create policy "owner_all_notifications" on notifications for all
  using (app_role() = 'owner');
