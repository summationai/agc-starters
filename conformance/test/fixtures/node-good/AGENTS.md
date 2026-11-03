# Starter: TypeScript

This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.

- **Business logic:** keep it in the app's code, not in database triggers. Use a trigger only for simple per-row bookkeeping, such as setting `updated_at`: a trigger hides behaviour from the code a reviewer reads, and agent.cloud's masked copies and migration checks handle triggers poorly.
- **A table that only grows:** when you add a table, decide how long its rows are needed. A table that records things that happen (events, logs, jobs, sessions, notifications) needs code that deletes older rows on a schedule (skip it when `AGC_RUN` is `rehearsal`), or partitions it and drops old partitions: a table that only grows makes every backup, rehearsal and mirror larger and its queries slower, and agent.cloud's review files it (`unbounded-table`). `agc check` and `agc ship` warn about such a table when nothing in the code deletes from it. The starter's own `jobs` table keeps every done job: once the app does real work, delete the ones done long enough ago (by `done_at`).
