-- ============================================================================
-- Migration 3 — fixes the Payroll calculated-salary formula.
-- Safe to run once on top of migration_2.sql (CREATE OR REPLACE only,
-- no tables/columns touched).
-- Run this in Supabase: Project -> SQL Editor -> New query -> paste -> Run
--
-- What changed:
--   calculate_salary() now adds the staff member's current paid-leave
--   balance on top of effective working days, instead of using effective
--   days alone. So someone who worked every day of the month (effective
--   days = actual days in month) and still has, say, 2 paid-leave days
--   left over is paid for (days_in_month + 2) / days_in_month of their
--   monthly salary, not just days_in_month / days_in_month.
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
