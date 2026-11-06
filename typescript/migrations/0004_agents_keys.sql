-- SPEC.md DATA-9: every table has a primary key and every foreign key an index, which 0003 missed once each.
-- agent.cloud's review files them as no-primary-key and unindexed-fk, and each ship warned. Registrations only count
-- toward a budget and are kept a day, so their key is a plain sequence.
ALTER TABLE mcp_registrations ADD COLUMN id bigserial PRIMARY KEY;
CREATE INDEX mcp_blocked_blocked_by ON mcp_blocked (blocked_by);
