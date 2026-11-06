-- SPEC.md APP-1: a person's row is kept for as long as the app is, so nothing deletes from users on a schedule. Saying so
-- here is what agent.cloud reads (its CHECK-1 and the review's unbounded-table), so neither names users as a table that
-- only grows.
COMMENT ON TABLE users IS 'agc:kept: one row per person who signed in';
