-- ============================================================================
-- Migration 10 -- several workflow changes agreed after real-world testing:
--   1. Deactivating a staff member (soft delete, not a true account erase --
--      see note below) -- reuses the existing profiles.is_active column.
--   3. Marker can mark/edit attendance for any future date, but only up to
--      2 days in the past.
--   4. Marker gets the same full access as owner to Notifications +
--      Approvals (leave_requests, leave_request_days, notifications).
--   5. (no schema change -- confirmation + "unmark" are frontend-only,
--      using the delete/update rights already granted here.)
--   6. One-off per-person paid-leave override (so one specific marker gets
--      3/month instead of the usual 2), and letting a marker see/calculate
--      their OWN salary (previously blocked for every marker, no exceptions).
--
-- Note on #1: Supabase can't safely delete a login (auth.users row) from
-- this plain frontend -- that needs an admin key, which can never live in
-- client-side code. So "delete" here means permanently deactivating: they
-- disappear from every active list and can no longer sign in, but their
-- attendance/salary/leave history stays intact. Recoverable later with a
-- plain `update profiles set is_active = true where id = ...` if ever needed.
--
-- Safe to run multiple times.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 6a. Per-person paid-leave override. Null = use the usual 2/month default.
-- ----------------------------------------------------------------------------
alter table profiles
  add column if not exists paid_leave_override numeric;

comment on column profiles.paid_leave_override is
  'Overrides the default 2/month paid-leave accrual for this one person specifically (e.g. a longtime marker gets 3). Null = use the standard default.';

create or replace function paid_leave_balance(p_staff_id uuid, p_year int, p_month int) returns numeric as $$
declare
  base           numeric;
  overtime_bonus numeric;
  adjustments    numeric;
  consumed       numeric;
begin
  select coalesce(paid_leave_override, 2.0) into base from profiles where id = p_staff_id;

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

-- ----------------------------------------------------------------------------
-- 6b. Let a marker calculate/view their OWN salary (previously blocked
-- outright, no exceptions). Still blocked from anyone else's.
-- ----------------------------------------------------------------------------
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

  select monthly_salary into v_salary from staff_salary where staff_id = p_staff_id;
  if v_salary is null then return null; end if;

  v_days := extract(day from (date_trunc('month', make_date(p_year, p_month, 1)) + interval '1 month - 1 day'))::int;
  select effective_days into v_eff from effective_working_days(p_staff_id, p_year, p_month);
  v_bal := paid_leave_balance(p_staff_id, p_year, p_month);

  return round(v_salary / v_days * (v_eff + v_bal), 2);
end;
$$ language plpgsql stable security definer;

-- ----------------------------------------------------------------------------
-- 3. Marker: attendance writes bounded to [today - 2 days, unlimited future].
-- (No change to the owner's own unrestricted "for all" policy.)
-- ----------------------------------------------------------------------------
drop policy if exists "marker_write_attendance" on attendance;
create policy "marker_write_attendance" on attendance for insert
  with check (app_role() = 'marker' and date >= current_date - 2);

drop policy if exists "marker_update_attendance" on attendance;
create policy "marker_update_attendance" on attendance for update
  using (app_role() = 'marker' and date >= current_date - 2);

drop policy if exists "marker_delete_attendance" on attendance;
create policy "marker_delete_attendance" on attendance for delete
  using (app_role() = 'marker' and date >= current_date - 2);

-- ----------------------------------------------------------------------------
-- 4. Marker: full access to leave_requests / leave_request_days /
-- notifications, mirroring the owner's existing policies exactly (no date
-- bound here -- same as owner, so a marker can also log/approve future
-- leave, which is the whole point of #3's "mark leave for next week today").
-- ----------------------------------------------------------------------------
drop policy if exists "marker_all_leave_requests" on leave_requests;
create policy "marker_all_leave_requests" on leave_requests for all
  using (app_role() = 'marker');

drop policy if exists "marker_all_leave_days" on leave_request_days;
create policy "marker_all_leave_days" on leave_request_days for all
  using (app_role() = 'marker');

drop policy if exists "marker_all_notifications" on notifications;
create policy "marker_all_notifications" on notifications for all
  using (app_role() = 'marker');

-- ----------------------------------------------------------------------------
-- To give your longtime marker 3 paid leaves/month instead of 2, fill in
-- his email and run this once:
-- ----------------------------------------------------------------------------
-- update profiles set paid_leave_override = 3
-- where id = (select id from auth.users where email = 'marker@example.com');
