-- ============================================================================
-- ONE-TIME RESET before real staff start using the app.
--
-- Wipes every bit of test-phase data (notifications, leave/approval
-- history, adjustments history, attendance, overtime, salary records) and
-- every account EXCEPT the 3 test accounts you're keeping. Those 3 stay
-- completely intact -- same login, same role, still fully usable.
--
-- IRREVERSIBLE -- there is no undo once this runs. Double-check the email
-- list right below matches your 3 keeper accounts exactly, then run this
-- once in the Supabase SQL Editor.
-- ============================================================================

begin;

-- Notifications -- every one, regardless of date
delete from notifications;

-- Approval history -- leave requests and their day-by-day breakdown
delete from leave_request_days;
delete from leave_requests;

-- Adjustments history
delete from leave_balance_adjustments;

-- Attendance, overtime and salary records from the testing phase
delete from attendance;
delete from overtime_credits;
delete from staff_salary;

-- Every account except the 3 you're keeping. Deleting from auth.users
-- cascades to its profiles row (and everything still tied to that
-- profile), so this one delete removes an account completely. Safe to run
-- now because everything that could reference these profiles was already
-- cleared above.
delete from auth.users
where email not in (
  'chiragaggarwal2302@gmail.com',
  'f20190186p@alumni.bits-pilani.ac.in',
  'aggarwal.chirag2323@gmail.com'
);

commit;

-- After this runs, the app is a clean slate: only your 3 hidden test
-- accounts remain, with no leftover notifications/history/attendance.
-- Real staff and your marker can now self sign-up as planned.
