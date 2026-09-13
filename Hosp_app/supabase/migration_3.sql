-- ============================================================================
-- Migration 3 — fixes the Payroll calculated-salary formula, and fixes a
-- bug where marking someone Absent (No notice) or Half-day (No notice)
-- failed with "column "type" is of type notification_type but expression
-- is of type text".
-- Safe to run once on top of migration_2.sql (CREATE OR REPLACE only,
-- no tables/columns touched).
-- Run this in Supabase: Project -> SQL Editor -> New query -> paste -> Run
--
-- What changed:
--   1. calculate_salary() now adds the staff member's current paid-leave
--      balance on top of effective working days, instead of using
--      effective days alone. So someone who worked every day of the
--      month (effective days = actual days in month) and still has, say,
--      2 paid-leave days left over is paid for
--      (days_in_month + 2) / days_in_month of their monthly salary, not
--      just days_in_month / days_in_month.
--   2. notify_notable_attendance() now explicitly casts the notification
--      type value to the notification_type enum -- Postgres was reading
--      that CASE expression as plain text and refusing to insert it,
--      which is what threw the "column is of type notification_type"
--      error when marking a no-notice absence/half-day.
-- ============================================================================

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

-- ---- 2. notify_notable_attendance(): cast to the enum type -----------------
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
