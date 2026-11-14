# Starter: TypeScript

## Talking to your person

Your person never runs agc or a terminal: you do, for them. "How do I ship it?" means do it, then report. Ask only when agc returns a decision for a person, when its `next` says to get their yes (a brought app's port plan), or when their request leaves a choice open. Report in at most three plain lines, then one link. When agc's answer carries `data.tell_person`, post it word for word.

## The stack

This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.

Once a mirror's work has shipped, delete its copy with `agc down <name> --delete`: `agc down` alone keeps it, and agent.cloud's review files a copy unused for over a week (`idle-copy`, "Copy <name> has been idle for over a week"). `agc up` names a mirror after the git branch, so each git branch you run it on gets its own copy: delete each once its work has shipped.

- **Business logic:** keep it in the app's code, not in database triggers. Use a trigger only for simple per-row bookkeeping, such as setting `updated_at`: a trigger hides behaviour from the code a reviewer reads, and agent.cloud's masked copies and migration checks handle triggers poorly.
- **A lake call:** give the lake client a timeout, or each call a deadline, and handle the timeout as a failure the caller sees; agent.cloud's review files a call with neither as `lake-no-deadline`.
- **A foreign key:** index it in the migration that adds it. A table that links two others needs one for each: its `PRIMARY KEY (note_id, tag_id)` covers `note_id` only, so add `CREATE INDEX ON note_tags (tag_id);`. Postgres doesn't make one, so lookups by it scan the whole table; agent.cloud's review files one without as `unindexed-fk`, "No index on <table>(<columns>)".
- **A primary key on every table:** `id uuid PRIMARY KEY`, or `PRIMARY KEY (a, b)` on a table that links two others. Without one, duplicate rows can appear and a single row can't be updated or deleted reliably. `agc check` and a ship's rehearsal warn about a table with none, before agent.cloud's review files it (`no-primary-key`, "Table <name> has no primary key").
- **A scheduled job on a lake app:** on an app granted a lake connection, it checks `AGC_RUN` and skips its work when it's `rehearsal`; agent.cloud's review files `unguarded-schedule` otherwise.

## Say what you're doing

At each step, before you start it, run `agc now "<what you're about to do>"`.
- **Admin routes answer only an admin.** A route under `/admin`, `/internal`, `/debug`, `/_debug`, `/manage` or `/dashboard`, or the same under `/api/`, checks that the signed-in person is an admin. agent.cloud's review counts every 2xx on these paths, an admin's own visits included. The UI's page counts too: answer 404 on these paths unless the app has a page there. Prove each with a flow of its own with no `headers`, whose first step, before any `SIGN IN`, expects only `401|403`.
- **A lake connection** (`ducklake` or `flightsql`): add `GET /api/status`, answering JSON with peak memory and lake timings. Without it, agent.cloud's review files `no-status-route`.
- **Crashes:** a crash restarts the app in production and fails every request in flight; agent.cloud's review reports that as `restarts`. Keep each error where it belongs, and exit only on SIGTERM.
- **Bad input:** answers 4xx, never 5xx: agent.cloud's review files `server-errors`, "Requests fail with server errors, most on <METHOD> <path>", once over 1% of a day's requests in production answer 5xx.
- **Server errors:** log each at error level before answering it: agent.cloud's review files `silent-errors`, "Server errors happen, but nothing is logged", once an app answers 5 or more 5xx in 7 days in production with no error-level log line.
- Every route answers in under a second: agent.cloud's review flags a route whose p95 in production passes 1 s (`slow-route`, "<METHOD> <path> is slow"). Fetch what it needs in one query rather than one per row, index what it filters and joins by, and put an outside call in a job rather than make the person wait on it.
- **A table that only grows:** when you add a table, decide how long its rows are needed. A table that records things that happen (events, logs, jobs, sessions, notifications) needs code that deletes older rows on a schedule (skip it when `AGC_RUN` is `rehearsal`), or partitions it and drops old partitions: a table that only grows makes every backup, rehearsal and mirror larger and its queries slower, and agent.cloud's review files it (`unbounded-table`, "Table <name> grows and nothing deletes from it"). A foreign key's `ON DELETE CASCADE` doesn't count, since the review reads only the code's own deletes: delete from each such table by its name, as the starter's MCP tables do. `agc check` and `agc ship` name every table your migrations make that nothing in the code deletes from.
- **A lake query:** name the columns, never `SELECT *`, and bound it with a `WHERE` on the partition column or a `LIMIT` (`lake-unbounded-query`, "Lake queries read more than they need").
