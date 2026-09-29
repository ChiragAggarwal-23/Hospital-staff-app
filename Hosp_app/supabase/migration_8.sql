-- ============================================================================
-- Migration 8 -- actual (real) clock times, separate from the salary times.
--
-- time_in / time_out stay exactly what they were: the times salary is
-- calculated from (e.g. the leniently-rounded 8:00 AM for someone who
-- really walked in at 8:15). New actual_time_in / actual_time_out are a
-- purely informational log of what really happened -- never read by any
-- payroll function, never affecting worked_minutes/day_fraction/
-- overtime_fraction. Leave them null whenever they'd just match the salary
-- time (i.e. no leniency was applied that day) -- the app treats a blank
-- actual time as "same as salary time".
--
-- Safe to run multiple times.
-- ============================================================================

alter table attendance
  add column if not exists actual_time_in  time,
  add column if not exists actual_time_out time;

comment on column attendance.actual_time_in is
  'Real clock-in time, only set when different from time_in (the salary time). Null = same as time_in. Informational only.';
comment on column attendance.actual_time_out is
  'Real clock-out time, only set when different from time_out (the salary time). Null = same as time_out. Informational only.';
