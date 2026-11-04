# Starter: TypeScript

This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.

- **Business logic:** keep it in the app's code, not in database triggers. Use a trigger only for simple per-row bookkeeping, such as setting `updated_at`: a trigger hides behaviour from the code a reviewer reads, and agent.cloud's masked copies and migration checks handle triggers poorly.
- **A foreign key:** index it in the migration that adds it. Postgres doesn't make one, so lookups by it scan the whole table; agent.cloud's review files one without as `unindexed-fk`.

## Say what you're doing

At each step, before you start it, run `agc now "<what you're about to do>"`.
