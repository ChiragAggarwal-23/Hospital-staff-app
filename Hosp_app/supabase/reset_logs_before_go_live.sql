-- ============================================================================
-- ONE-TIME RESET of test-phase data, keeping every day from October 2026
-- onward untouched (the app already went live and has real attendance/
-- leave data for some October dates before this got run).
--
-- Cutoff: 2026-10-01. Anything dated BEFORE this (the testing period) is
-- deleted; anything on or after this date is left exactly as it is.
-- To use a different cutoff, change the date in every line below that
-- has '2026-10-01'::date.
--
-- Unlike reset_before_launch.sql (which deletes accounts outright), this
-- keeps EVERY account exactly as it is -- same logins, same roles, same
-- employee_code/department/designation. Only pre-October history is wiped:
--   - notifications created before the cutoff
--   - leave request DAYS dated before the cutoff (approvals history)
--   - whole leave requests that end entirely before the cutoff (so a
--     request straddling the boundary, e.g. 29 Sep - 2 Oct, keeps its
--     October day(s) and the request header itself; only its September
--     day rows are removed, by the leave_request_days delete below)
--   - leave balance adjustments for any month before October 2026
--   - attendance dated before the cutoff
--
-- staff_salary is NOT touched -- salary configuration stays, for every
-- month. profiles / auth.users are NOT touched -- no account is deleted
-- or deactivated.
--
-- IRREVERSIBLE -- there is no undo once this runs. Run once in the
-- Supabase SQL editor.
-- ============================================================================

begin;

-- Notifications from before the cutoff
delete from notifications
where created_at < '2026-10-01'::date;

-- Leave request DAYS from before the cutoff (approvals history).
-- Must run before the leave_requests delete below, so that check can see
-- which requests still have no days left anywhere on/after the cutoff.
delete from leave_request_days
where date < '2026-10-01'::date;

-- Whole leave requests that are entirely in the past (nothing on or after
-- the cutoff) -- a request that straddles the cutoff keeps its header and
-- whatever October+ days survived the delete above.
delete from leave_requests
where to_date < '2026-10-01'::date;

-- Manual balance corrections from before October 2026
delete from leave_balance_adjustments
where (year < 2026) or (year = 2026 and month < 10);

-- Attendance (clock-in/out, shift type, overtime credit) from before the
-- cutoff
delete from attendance
where date < '2026-10-01'::date;

commit;

-- After this runs: every account is untouched, staff_salary is untouched,
-- and every October-onward attendance/leave/notification row is exactly
-- as it was before this ran. Only pre-October test-phase history is gone.
-- Each staff member's October paid-leave balance recalculates using only
-- what's left (their October attendance/overtime and October-dated leave
-- days) -- nothing from September feeds into it any more.
