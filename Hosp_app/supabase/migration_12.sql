-- ============================================================================
-- Migration 12 -- widen the marker's attendance edit window from 2 days
-- in the past to 40 days in the past, temporarily, to let the marker
-- backfill the whole of October while testing.
--
-- Future dates are untouched -- that side was never bounded (no "date <="
-- check existed), and nothing here adds one.
--
-- To tighten it back to 2 (or any other number) later, just re-run this
-- same migration with a different number in place of "40" below.
--
-- Safe to run multiple times.
-- ============================================================================

drop policy if exists "marker_write_attendance" on attendance;
create policy "marker_write_attendance" on attendance for insert
  with check (app_role() = 'marker' and date >= current_date - 40);

drop policy if exists "marker_update_attendance" on attendance;
create policy "marker_update_attendance" on attendance for update
  using (app_role() = 'marker' and date >= current_date - 40);

drop policy if exists "marker_delete_attendance" on attendance;
create policy "marker_delete_attendance" on attendance for delete
  using (app_role() = 'marker' and date >= current_date - 40);
