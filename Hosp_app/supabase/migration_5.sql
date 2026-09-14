-- ============================================================================
-- Migration 5
--   1. Adds profiles.is_test -- lets you keep one owner / marker / staff test
--      account fully working (login, RLS, everything) but hidden from every
--      staff-listing screen a real user would see.
--   2. Adds auto-cleanup of old notifications, based on the date the
--      notification is actually ABOUT (not when it was created), with a
--      4-day grace period into the next month, and a daily pg_cron schedule
--      to run it automatically.
--   3. Leaves "Leave history" (Approvals tab) alone -- per your call, old
--      approved/rejected leave requests are NOT deleted. They already only
--      show the 30 most recent decided requests (see loadApprovalsHistory in
--      app.js), so the list stays short on its own without deleting anything.
--      Data volume here is tiny either way -- a leave_requests row is well
--      under 1KB, so even years of history for a full staff is a few MB at
--      most, nowhere near a real storage concern.
--
-- Safe to run multiple times.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. is_test flag
-- ----------------------------------------------------------------------------
alter table profiles
  add column if not exists is_test boolean not null default false;

comment on column profiles.is_test is
  'Excluded from every staff-listing view (Staff Directory, Attendance, Monthly Overview, Payroll, Adjustments) but otherwise fully functional -- for your own ongoing testing, invisible to real users.';

-- ----------------------------------------------------------------------------
-- 2. Notification cleanup
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
    select date into v_date from overtime_credits where id = p_related_id;
  elsif p_type = 'balance_adjusted' then
    select (make_date(year, month, 1) + interval '1 month - 1 day')::date into v_date
    from leave_balance_adjustments where id = p_related_id;
  end if;
  return v_date;
end;
$$ language plpgsql stable security definer;

-- A notification is eligible once its relevant date's month has fully ended
-- AND a 4-day grace period has passed on top of that (so a Sept 30 item
-- clears on/after Oct 4 -- not the instant the calendar turns October).
-- A notification about a FUTURE date (e.g. a leave request submitted in
-- September covering Oct 10-12) is untouched until Oct 10-12's own month
-- (October) has itself ended + grace period, i.e. it survives well past
-- Nov 4. Falls back to created_at if the source row was itself deleted.
create or replace function cleanup_old_notifications() returns void as $$
declare
  grace_days constant int := 4;
begin
  delete from notifications n
  where (
    date_trunc('month', coalesce(notification_relevant_date(n.type, n.related_id), n.created_at::date))
    + interval '1 month - 1 day'
  )::date + grace_days < current_date;
end;
$$ language plpgsql security definer;

-- ----------------------------------------------------------------------------
-- 2b. Schedule it to run automatically, once a day.
--     Requires the pg_cron extension. In the Supabase dashboard:
--     Database -> Extensions -> search "pg_cron" -> Enable.
--     (Or run the "create extension" line below in the SQL Editor -- same
--     effect. If it errors with "permission denied", use the dashboard
--     toggle instead; Supabase project owners can always enable it there.)
-- ----------------------------------------------------------------------------
create extension if not exists pg_cron with schema extensions;

-- Remove any previous schedule with the same name before re-adding it, so
-- re-running this migration doesn't create duplicate jobs.
select cron.unschedule(jobid) from cron.job where jobname = 'cleanup_old_notifications_daily';

select cron.schedule(
  'cleanup_old_notifications_daily',
  '30 3 * * *',            -- 03:30 UTC every day -- adjust if you'd prefer a different time
  $$select cleanup_old_notifications();$$
);

-- ============================================================================
-- 3. One-time manual steps -- fill in and run the ones you need.
--    These are NOT automatic; edit the placeholders below yourself.
-- ============================================================================

-- ---- (a) Promote an account to owner ---------------------------------------
-- There's no in-app way to self-assign the owner role (deliberately -- it
-- would be a security hole). Have the person sign up normally first (so a
-- profiles row exists), then run this once, replacing the email and any
-- other fields you want set:
--
-- update profiles
-- set role = 'owner',
--     employee_code = 'OWNER-01',      -- pick any unique code
--     is_active = true
-- where id = (select id from auth.users where email = 'owner-email@example.com');

-- ---- (b) Mark your 3 existing test accounts as hidden ----------------------
-- Replace the emails below with your actual owner-test / marker-test /
-- staff-test account emails, then run:
--
-- update profiles
-- set is_test = true
-- where id in (
--   select id from auth.users where email in (
--     'owner-test@example.com',
--     'marker-test@example.com',
--     'staff-test@example.com'
--   )
-- );

-- ---- (c) One-time cleanup of existing test/demo clutter --------------------
-- If you also want to run the notification cleanup once right now (instead
-- of waiting for tomorrow's 3:30am scheduled run), just run:
--
-- select cleanup_old_notifications();
