# Starter: TypeScript

This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.

Once a mirror's work has shipped, delete its copy with `agc down <name> --delete`: `agc down` alone keeps it, and agent.cloud's review files a copy made over a week ago (`idle-copy`).

- **Business logic:** keep it in the app's code, not in database triggers. Use a trigger only for simple per-row bookkeeping, such as setting `updated_at`: a trigger hides behaviour from the code a reviewer reads, and agent.cloud's masked copies and migration checks handle triggers poorly.
- **A foreign key:** index it in the migration that adds it. Postgres doesn't make one, so lookups by it scan the whole table; agent.cloud's review files one without as `unindexed-fk`.
- **A primary key on every table:** `id uuid PRIMARY KEY`, or `PRIMARY KEY (a, b)` on a table that links two others. Without one, duplicate rows can appear and a single row can't be updated or deleted reliably. `agc check` and a ship's rehearsal warn about a table with none, before agent.cloud's review files it (`no-primary-key`).

## Say what you're doing

At each step, before you start it, run `agc now "<what you're about to do>"`.
- **Admin routes answer only an admin.** A route under `/admin`, `/internal`, `/debug`, `/manage` or `/dashboard`, or the same under `/api/`, checks that the signed-in person is an admin, and a smoke flow that calls it before any `SIGN IN` and expects `401|403` proves it.
- **A lake connection** (`ducklake` or `flightsql`): add `GET /api/status`, answering JSON with peak memory and lake timings. Without it, agent.cloud's review files `no-status-route`.
- **Crashes:** a crash restarts the app in production and fails every request in flight; agent.cloud's review reports that as `restarts`. Keep each error where it belongs, and exit only on SIGTERM.
- Every route answers in under a second: agent.cloud's review flags a route whose p95 in production passes 1 s (`slow-route`). Fetch what it needs in one query rather than one per row, index what it filters and joins by, and put an outside call in a job rather than make the person wait on it.
- **A table that only grows:** when you add a table, decide how long its rows are needed. A table that records things that happen (events, logs, jobs, sessions, notifications) needs code that deletes older rows on a schedule (skip it when `AGC_RUN` is `rehearsal`), or partitions it and drops old partitions: a table that only grows makes every backup, rehearsal and mirror larger and its queries slower, and agent.cloud's review files it (`unbounded-table`). The starter's own `jobs` table keeps every done job: once the app does real work, delete the ones done long enough ago (by `done_at`).
