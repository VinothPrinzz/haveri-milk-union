-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Employee Route Assignment
-- 0037_employee_route.sql
--
-- Lets employees be assigned to a delivery route with a per-route
-- position, so that:
--   • employee-subsidy sales ride along on the Route Sheet, and
--   • employees appear in the Assign Route screen interleaved with
--     dealers, ordered by the same position sequence.
--
-- Decision (Option A): a single route per employee — `employees.route_id`
-- — rather than a dealer_routes-style junction. Employees realistically
-- belong to one route. `route_position` mirrors dealer_routes.position
-- (gaps of 10, default 9999 = end of list).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Standing route for an employee ──
-- ON DELETE SET NULL: deleting a route unassigns its employees rather
-- than cascading the employee away (mirrors dealers.route_id behaviour
-- via the routes DELETE handler).
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS route_id uuid REFERENCES routes(id) ON DELETE SET NULL;

-- ── 2. Per-route position ──
-- NOT NULL with default 9999 so any employee without an explicit
-- position sorts to the end of the route, where the Assign Route
-- screen's renumbering can pick it up. Backfilled to 9999 for all
-- existing rows by the ADD COLUMN default.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS route_position integer NOT NULL DEFAULT 9999;

-- ── 3. Index for ORDER BY (route_id, route_position) ──
-- The Route Sheet and Assign Route screen both filter by route then
-- order by position — a composite covers both. Partial: only assigned,
-- non-deleted employees matter.
CREATE INDEX IF NOT EXISTS idx_employees_route_position
  ON employees (route_id, route_position)
  WHERE deleted_at IS NULL AND route_id IS NOT NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • employees.route_id    → standing delivery route (nullable).
--   • employees.route_position → ordering within that route (default 9999).
--   • Deliberately NOT a junction table: one route per employee.
--   • Deliberately NOT a UNIQUE constraint on (route_id, route_position)
--     — same rationale as dealer_routes (0028): swaps would need a
--     3-step shuffle; ties break on (employee_code, name) at query time.
-- ════════════════════════════════════════════════════════════════════
