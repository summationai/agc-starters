-- SPEC.md AUTH-8: when agent.cloud was last asked whether this session's person is still let in. Never, for a new
-- session, counts as when it began (a day before it expires), so a session is first rechecked 5 minutes in.
ALTER TABLE sessions ADD COLUMN checked_at timestamptz;
