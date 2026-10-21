# agent.cloud starter spec, v1

**Status:** draft, for review (phase 1 of the starters repo).
**For:** anyone writing an agent.cloud starter in any language, and the agents that grow apps from them. A starter that passes this spec builds and runs on agent.cloud with no Dockerfile, works on a mirror with auto-reload, signs people in, sends email, runs background jobs, and is legible in observability from its first release.

Every rule is **MUST** unless it says **SHOULD**. Each rule names the conformance test that proves it: `CONF:<name>` runs the built app against a fake platform; `LINT:<name>` reads the files. A rule with no test is marked `review`, and a person checks it in the starter's PR.

The platform facts behind each rule are cited as `repo:file` from [agent-cloud](https://github.com/summationai/agent-cloud), so this spec changes when the platform does.

## 0. What a starter is

A starter is a directory, `<language>/`, holding a complete, working app: a React + Vite UI, one server process serving the UI and the API on one port, a worker, SQL migrations, checks, and an `AGENTS.md` section. `agc init --stack <language>` copies it into an empty folder. It is a real app, small enough to read in ten minutes: people sign in, create a note, and get an email about it.

The same UI is shared by every stack, so stacks differ only in the server, the worker and the build.

## 1. Manifest

- **MAN-1:** `agentcloud.toml` at the starter's root has `[app] name = "starter"` (`agc init` replaces it), `[service.web]` with `port`, `dev` and `health`, `[service.worker]` with `command` and `dev`, and `[data.db]` with `env = "DATABASE_URL"` and `migrations = "migrations/"`. `LINT:manifest` (keys as `packages/cli/src/config.ts` appConfig reads them).
- **MAN-2:** `[service.web] command` is omitted when the language's default image already starts the app the standard way (Node: `npm start`); otherwise it is the production start command. `LINT:manifest`
- **MAN-3:** `[service.web] health = "/api/health"`. `LINT:manifest`
- **MAN-4:** The manifest's checks parse with no warnings: `lintChecks` from `packages/cli/src/checks.ts` returns nothing. `LINT:checks`

## 2. Build

- **BLD-1:** The starter has no Dockerfile. It builds with agent.cloud's default image for its language (Node: `packages/runner/src/build.ts` defaultDockerfile; Python: the default the platform adds next, mirrored in `conformance/images/`). `LINT:no-dockerfile`, `CONF:build`
- **BLD-2:** The image builds everything it runs, including the UI bundle. Build outputs (`dist/`, `build/`, `.venv/`, `node_modules/`) are in `.gitignore` and are never committed: `agc ship` sends only files git tracks or would track (`git ls-files --cached --others --exclude-standard`), so an ignored artifact is never shipped. `LINT:build-outputs`, `CONF:build`
- **BLD-3:** Dependencies are locked (`package-lock.json`, `uv.lock`), and the image installs them frozen. `LINT:lockfile`
- **BLD-4:** The build needs no secrets and no network beyond the language's package registry. `CONF:build` (built with the fake platform unreachable)
- **BLD-5 (SHOULD):** The image is under 400 MB. `CONF:build` (reported, not failed)

## 3. Processes

The platform runs `web` as a Deployment with a readiness probe on `health` every 2 s (`packages/runner/src/release.ts` webDeployment), a 512 MiB memory limit, all capabilities dropped, and a non-root user (`USER node` in the Node image).

- **PROC-1:** `web` listens on `0.0.0.0:$PORT`, never `127.0.0.1` or a fixed port. `CONF:bind` (reached from another container)
- **PROC-2:** One port serves both: the UI at `/` (HTML), and the API under `/api/`. An unknown `/api/...` path answers JSON 404; any other unknown path answers the UI's `index.html`, so client-side routes survive a reload. `CONF:routes`
- **PROC-3:** `GET /api/health` answers 200 with JSON, no sign-in, within 30 s of the process starting (the platform waits up to 3 minutes: `release.ts` ready), and never touches the database. The platform probes it every 2 s for the life of the pod (`release.ts` readinessProbe), so a database query there would keep the database awake forever and turn a short database blip into a full outage. Database trouble shows as a 503 on the request that needs the database, and in the logs. `CONF:health` (it stays 200 with the fake database stopped)
- **PROC-4:** On SIGTERM, `web` stops taking new connections, finishes requests in flight, and exits within 25 s with status 0 or 143 (128 + SIGTERM: uvicorn re-raises the signal after a graceful shutdown, and Kubernetes ignores the status after SIGTERM). The platform gives web 30 s before SIGKILL. `CONF:sigterm-web` (a `GET /api/debug/slow?ms=3000` in flight when SIGTERM arrives still completes)
- **PROC-5:** On SIGTERM, the worker finishes the job in hand, claims no new one, and exits within 50 s with status 0 or 143 (the worker's grace is 60 s: `terminationGracePeriodSeconds: 60`). `CONF:sigterm-worker`
- **PROC-6:** Signals reach the app through the platform's wrappers (`build.ts` forwarding and agc-start), so the app must not detach, fork into the background, or ignore SIGTERM. `CONF:sigterm-web`, `CONF:sigterm-worker` (run under the same wrapper)
- **PROC-7:** `web` and the worker each stay under 256 MiB at rest, and under 512 MiB while the checks run. `CONF:memory` (containers capped at 512 MiB; an OOM fails it)
- **PROC-8:** The app runs as the image's non-root user and writes only to `/tmp` and the database, never inside its own directory. `CONF:readonly` (the app directory is mounted read-only)
- **PROC-9:** If a required variable (`PORT`, `DATABASE_URL`) is missing, the process exits non-zero within 10 s and its last stderr line names the variable. That's what agent.cloud's crash causes read (`packages/control/src/startup.ts`). `CONF:missing-env`

## 4. Development and auto-reload

`agc up` runs `[service.web] dev` and `[service.worker] dev` with the mirror's environment: `PORT`, `DATABASE_URL`, `AGC_*`, and `AGENTCLOUD_MIRROR` (`packages/cli/src/commands/mirror.ts`).

- **DEV-1:** `dev` serves the whole app, UI and API, on `$PORT`. `CONF:dev-routes` (including same-origin POSTs through any dev proxy, while another origin is still refused under SEC-6)
- **DEV-2:** Saving a server source file changes what the API serves within 5 s, with no manual restart. The suite makes one untimed warm-up edit first (a first compile can be slow on a cold CI runner), then times the next one. `CONF:reload-api`
- **DEV-3:** Saving a UI source file changes what the browser loads within 5 s (hot module reload, or the next page load), with no manual restart. `CONF:reload-ui`
- **DEV-4:** Saving a worker source file restarts the worker within 5 s. `CONF:reload-worker`
- **DEV-5:** `dev` needs nothing a fresh clone lacks beyond the language's toolchain: the first run installs dependencies itself, or the README says the one command that does. `CONF:dev-routes` (run from a clean copy)
- **DEV-6:** On a mirror (`AGENTCLOUD_MIRROR` set), cookies drop `Secure` so `http://localhost` works; in production they keep it. `CONF:cookies`

## 5. Data

- **DATA-1:** The app connects with `DATABASE_URL` exactly as given (it carries `sslmode=verify-full`). It never sets its own host, user, password or TLS options. For libpq-based drivers the platform sets `PGSSLROOTCERT=system`. `CONF:db-tls` (the fake database only accepts verified TLS), `LINT:db-config`
- **DATA-2:** The schema changes only through plain SQL files in `migrations/`, named `<digits>_<slug>.sql`, applied by `agc migrate` and recorded in `agentcloud_migrations` (`packages/cli/src/migrations.ts`). `LINT:migrations`
- **DATA-3:** The app runs no DDL at runtime, and depends on no ORM migrator (Prisma Migrate, drizzle-kit, Knex migrations, TypeORM, Sequelize CLI, Alembic, Django migrations, yoyo). `LINT:no-migrator`, `CONF:no-ddl` (Postgres's schema is the same before and after the app runs; DDL in an in-process store such as DuckDB is fine)
- **DATA-4:** Users and entities are keyed on `uuid` columns. Masking keeps uuids and masks high-cardinality text (`packages/control/src/policy.ts`), so a mirror's rows still line up with production's ids. `LINT:uuid-keys`
- **DATA-5:** The connection pool holds at most 10 connections per process. `review`
- **DATA-6:** Queries are parameterized; no SQL is built from request input by string concatenation. `review`
- **DATA-7 (SHOULD):** Columns that hold a fixed set of values (a status, a kind) use a `CHECK (col IN (…))` list or an enum. Masking keeps those exactly (`policy.ts`), so mirrors show the real states. `LINT:fixed-values` (reported)

## 6. Platform services

### Sign-in (`docs/AGENTS.md` "Sign-in"; `packages/control/src/app-signin.ts`)
- **AUTH-1:** `GET /auth/sign-in` sets a state cookie (`HttpOnly`, `SameSite=Lax`, at least 128 bits of randomness, at most 10 minutes) and answers a redirect to `$AGC_AUTH_URL/authorize?state=<state>`. It may carry a `return_to` path, which must be relative. `CONF:signin`
- **AUTH-2:** `GET /auth/callback` compares `state` with the cookie before anything else. On a mismatch it answers 400 and never calls `/token`. `CONF:signin-state` (`checkSignInState`, the same probe rehearsals run)
- **AUTH-3:** The callback trades the code with `POST $AGC_AUTH_URL/token`, using `Authorization: Bearer $AGC_AUTH_TOKEN` and `{code}`, then finds or creates the user by `user.id` in a uuid column, and starts its own session. `CONF:signin`
- **AUTH-4:** The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` outside a mirror, and lasts a day or less. Or the app rechecks `GET $AGC_AUTH_URL/users/<id>` at least daily and ends the session on 404. `CONF:cookies`
- **AUTH-7:** **On a target with its own sign-in** (`AGC_AUTH_PROVIDER=edge`, set by agent.cloud for apps whose manifest says `[auth] provider = "edge"`), the target's gate signs people in before a request reaches the app and passes who it is in `x-agc-user-email` and `x-agc-user-name` (agent.cloud's edge-signin spec: the gate empties any client-sent copies first). The app trusts those headers, keeps no session of its own, and fixes a user's id by their email (a name-based uuid). `/auth/sign-in` redirects home, since signing in belongs to the target's sign-in. So does signing out: behind the gate, `POST /auth/sign-out` never reaches the app, and the page's fetch gets the gate's `401 {"signed_out":true}` (agent.cloud's edge-signin spec, EDGE-14), which the page takes as signed out. On a mirror, where no gate stands in front, the app's own `/auth/sign-out` answers ok. `AGC_EDGE_DEV_USER` (set by agent.cloud on mirrors and in rehearsals, never in production) stands in when the headers are absent. `review`
- **AUTH-5:** `GET /api/me` answers 200 with the signed-in user, or 401. `POST /auth/sign-out` ends the session. `CONF:signin`
- **AUTH-6:** No passwords. No password hashing (bcrypt, scrypt, argon2, PBKDF2) anywhere near the word "password" (`agc ship` warns on it). `LINT:no-passwords`

### Email (`docs/AGENTS.md` "Background work")
- **MAIL-1:** Email is sent by the worker, never in the request: `POST $AGC_EMAIL_URL` with `Authorization: Bearer $AGC_EMAIL_TOKEN` and `{to, subject, text, key}`. `CONF:mail`
- **MAIL-2:** `key` names the message for good (`note-<uuid>/created`), so a retried job never emails twice. `CONF:mail-once` (a worker killed mid-job: each key arrives once)

### Background jobs
- **JOB-1:** A `jobs` table, created by a migration, with the columns in `docs/AGENTS.md`. Work is inserted in the same transaction as the write it belongs to. `LINT:migrations`, `review`
- **JOB-2:** The worker claims with a lease (`FOR UPDATE SKIP LOCKED`, `locked_until`), so two workers never run one job at the same time, and a dead worker's job runs again. `CONF:jobs-race` (two workers, a batch of jobs, each email key exactly once)
- **JOB-3:** Every job is safe to run twice. `CONF:mail-once`
- **JOB-4:** An idle worker lets the database sleep (Neon suspends a compute after 5 minutes without connections). The worker listens for nothing (no `LISTEN`), and holds no database connection between polls. It polls every `WORKER_POLL_SECONDS` (default 10) while it finds work. After an empty poll it doubles the wait, up to `WORKER_IDLE_MAX_SECONDS` (default 600), and goes back to the short interval as soon as it finds a job. The trade-off is deliberate: the first email after a quiet spell can take up to ten minutes. `CONF:jobs-idle` (with a 0.5 s poll and a 4 s ceiling: the gaps between claims grow while idle and snap back once a job arrives, and the worker holds no connection between polls)

## 7. Observability (`infra/apps/observability/vector.yaml`)

- **OBS-1:** Logs go to stdout and stderr as one JSON object per line, with `level` (`debug`, `info`, `warn`, `error`) and `msg`. The platform classifies by `level`; plain text falls back to keyword guessing. `CONF:logs-json` (at least 95% of lines parse, and every line from app code parses)
- **OBS-2:** An unhandled error in a request is logged once, at `level: "error"`, on one line with the stack in a field. The request answers a JSON 500 without the stack. `CONF:error-log` (through `GET /api/debug/error`).
- **OBS-6:** Two conformance-only routes, `GET /api/debug/error` (throws) and `GET /api/debug/slow?ms=N` (answers 200 after N ms, at most 10000), exist only when `AGENTCLOUD_CONFORMANCE=1`; otherwise both answer 404. The slow route logs `slow request started` (at info) as it begins, so the suite knows the request is in flight. `CONF:debug-route-hidden`
- **OBS-3:** Business steps emit workflow events: `{"agc":"event","name","entity","related","status","attrs"}`, with `name` matching `^[a-z][a-z0-9_.-]{0,63}$` and `entity` and each `related` matching `^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_.-]{1,64}$`. The starter emits `note.created` and `note.emailed` with `note:<uuid>`. `CONF:events`
- **OBS-4:** No personal data in logs or events: no emails, names or tokens, at any level. `CONF:no-pii` (a distinctive address signs in and creates notes; it never appears in any log line)
- **OBS-5 (SHOULD):** No per-request access log at `info`: Traefik already records every request with its status and latency. `CONF:logs-json` (reported)

## 8. Checks

- **CHK-1:** The manifest has at least one `[[check.smoke]]` flow that starts with `SIGN IN`, and one `[[check.invariant]]` paired with a smoke flow whose write step races (`xN`). `LINT:checks`
- **CHK-2:** Every smoke flow passes against the built app on the fake platform, run by agc's own `runFlow`. `CONF:smoke`
- **CHK-3:** Every invariant returns no rows after the smoke flows. `CONF:invariants`
- **CHK-4:** Checks are safe to run on a branch of production: each smoke flow creates the data it needs (with `{run}` in anything that must be unique) and depends on no row existing beforehand, and every invariant holds on any real data, not only the starter's own. `CONF:smoke` (every flow runs twice against the same database, so the second run meets the first run's rows), `review`

## 9. Security

- **SEC-1:** No secrets in the repo: nothing matching agent.cloud's secret patterns (`packages/control/src/github.ts` secretIn), and no `.env` files. `LINT:secrets`
- **SEC-2:** No CORS for credentialed requests, and nothing trusts an `Origin`, `Referer` or redirect target because it ends in `.agent.cloud`: apps are neighbours on the same site. Every state-changing route checks the session and takes no GETs. `LINT:no-cors`, `review`
- **SEC-4:** Every state-changing route (`POST`, `PUT`, `PATCH`, `DELETE`) requires `Content-Type: application/json` and answers 415 otherwise. Apps on agent.cloud share a site, so `SameSite=Lax` cookies ride along on another app's form posts; a JSON body forces a CORS preflight, which SEC-2 never grants. `CONF:csrf-json` (a form post to `POST /api/notes` is refused and creates nothing)
- **SEC-6:** Every state-changing request whose `Origin` names another origin than the app's own host (or, with no `Origin`, whose `Sec-Fetch-Site` is `same-site` or `cross-site`) is refused with 403 `cross_origin` before anything else runs. `agent.cloud` isn't on the Public Suffix List, so a sibling app's page is the same site and its requests carry this app's cookies; SEC-4's preflight is one wall, this is the second, and it holds for a request a browser sends without a preflight. A request with neither header isn't from a browser (an agent, curl) and goes on to the session check. `CONF:csrf-origin` (a JSON post from another `*.agent.cloud` origin, and one marked `same-site` with no Origin, are both refused and create nothing; the app's own origin creates the note)
- **SEC-7:** Every route of the starter that takes a body checks it against a schema before using it, with the stack's usual schema library: in TypeScript a Zod 4 schema through `@hono/zod-validator`, the handler reading `c.req.valid('json')` with no `as` cast; in Python a Pydantic model as the FastAPI body parameter. A body that isn't JSON, or doesn't fit (a field missing, too long or of the wrong type), answers 400 in the app's error shape `{"error": {"code", "message"}}` naming the first problem, never a 500 and never FastAPI's default 422 `detail`. Agents grow apps by copying the starter's routes, so the routes show the pattern; an app's own routes may use any validation, and nothing in agent.cloud checks for it. Configuration (`env.ts`, `env.py`; PROC-9) and database rows (CHECK constraints) aren't request bodies. `CONF:body-validation` (a body that isn't JSON, and a numeric `title`, to `POST /api/notes` both answer 400 in the error shape and create nothing), `review` (the schema idiom)
- **SEC-5:** Outside a mirror, every cookie the app sets has the `__Host-` prefix, `Secure`, `Path=/` and no `Domain`. Apps share the `agent.cloud` site, so a neighbour app could otherwise set a cookie for the whole domain with the same name: a planted `session` (session fixation) or a planted state (sign-in CSRF). `__Host-` cookies can only be set by the app's own host. On a mirror (DEV-6), where `Secure` is dropped, the plain names stay. `CONF:host-cookies`
- **SEC-3 (SHOULD):** Responses carry `X-Content-Type-Options: nosniff`, and HTML responses a `frame-ancestors` CSP. `CONF:headers`

## 10. Documentation

- **DOC-1:** `README.md` says what the starter is, the one command to run it locally, where the server, worker, UI, migrations and checks live, and how to add an API route and a job. `review`
- **DOC-2:** `AGENTS.md` holds the stack section only: the commands, the layout, and the stack's idioms for sign-in, email, jobs and events. `agc init` appends agent.cloud's own section after it (`packages/cli/src/commands/init.ts` writeAgentsMd), so the starter's file must not contain agc's heading `# agent.cloud: how to work on this app`. `LINT:agents-md`

## 11. The starter app

Every starter is the same small app, so the shared UI works with every stack and the conformance suite can drive it. It has two pages:
- a welcome page at `/`, which says truthfully where the app runs and what's working;
- a Notes example at `/notes`, where people sign in, keep notes, and get an email for each note.

These rules bind the starters in this repo, not the apps grown from them: once an agent turns the starter into something else, the welcome page and the notes can go.

- **APP-1:** A `notes` table with `id uuid`, `user_id uuid`, `title text` (1 to 200 characters) and `created_at`, unique on `(user_id, title)`, and a `users` table keyed on the `user.id` sign-in returns. `LINT:migrations`
- **APP-2:** `GET /api/notes` answers the signed-in person's notes, newest first, as `[{id, title, created_at}]`. Signed out, it answers 401. `CONF:app`
- **APP-3:** `POST /api/notes {title}` answers 201 with the note. A missing or overlong title gets 400, a title the person already has gets 409, and signed out gets 401. In the same transaction it inserts a `note_email` job, and it logs a `note.created` event for `note:<id>`. `CONF:app`, `CONF:events`
- **APP-4:** The worker handles `note_email`: it emails the person (when sign-in gave an email) with the key `note-<id>/created`, then logs `note.emailed` for `note:<id>`. `CONF:mail`, `CONF:events`
- **APP-5:** The manifest's checks include the flow and invariant below, or stricter ones:
  ```toml
  [[check.smoke]]
  name  = "one note per title, even when racing"
  steps = [
    "SIGN IN racer-{run}@example.test",
    "POST /api/notes {title: 'Hello {run}'} -> 201|409 x10",
    "GET /api/notes -> 200",
  ]
  [[check.invariant]]
  name = "a title once per person"
  sql  = "SELECT user_id, title FROM notes GROUP BY user_id, title HAVING count(*) > 1"
  ```
  `LINT:checks`, `CONF:smoke`
- **APP-6:** A `seed.sql`, declared as `[data.db] seed = "seed.sql"`, inserts one demo person (a fixed uuid, `demo@example.test`, "Demo Person") and three notes for them, every insert `ON CONFLICT DO NOTHING`, touching only tables the migrations create and no DDL, in under 200 lines. agc runs it once on a mirror that starts empty, after the migrations (agent.cloud's `docs/specs/seed-data.md`); it never runs in production. `LINT:seed`, `CONF:seed` (after the migrations, the seed applies on the fake database; signed in as the demo person's id, `GET /api/notes` answers exactly those three notes; applying it a second time changes nothing)

### The welcome page (APP-7 to APP-12)

The welcome page is frame 0 of every app: what a person sees the first time `agc up` opens it, before their agent has built anything. It must never claim more than is true. In particular, it never says the app is live before its first release.

- **APP-7:** `/` serves the welcome page, and `/notes` serves the Notes example: sign-in, the person's notes and the add form, as before. Both are routes of the one UI bundle, so a reload of either answers `index.html` (PROC-2). APP-2 to APP-6 stand unchanged. The Notes page says it's an example the agent removes once the app takes shape, and signing in from it returns to `/notes` (`/auth/sign-in?return_to=/notes`, AUTH-1). `CONF:welcome-copy` (the stack's own UI modules rendered with `react-dom/server`: `/` renders the welcome page and `/notes` renders Notes, each with its own text, so a missing route fails even though the SPA fallback answers HTML), `CONF:signin-return` (signing in through `/auth/sign-in?return_to=/notes` on the fake platform ends at `/notes`)
- **APP-8:** `GET /api/welcome` answers 200 with what the page shows, no sign-in, never a secret or a variable's value:
  ```json
  {"app": "folio", "stack": "typescript", "run": "mirror",
   "parts": {"web": "running", "api": "running", "database": "running", "worker": "configured",
             "signin": "configured", "email": "configured"},
   "database": {"migrations": 1}, "checks": {"smoke": 1, "invariants": 1}}
  ```
  `app` is `[app] name` from `agentcloud.toml`, read when the server starts, never a literal. `stack` is the starter's own name. Nothing else from the manifest or the environment reaches the answer: no commands, paths, URLs or values. The page's stack lines are fixed labels in the UI (APP-11). `CONF:welcome` (the answer's `app` is the manifest's name; with a sentinel secret in an environment variable and in `[service.worker] command`, the answer contains neither)
- **APP-9:** `run` says where this process runs, from what the platform sets and an app can't fake:

  | `run` | When | The page says |
  | - | - | - |
  | `mirror` | `AGENTCLOUD_MIRROR` is set (agc up, `packages/cli/src/mirror.ts`) | "Running on this machine", with the address the browser is on. `<app>.agent.cloud` is shown as where `agc ship` releases it, with no claim about whether it's been released. |
  | `live` | `AGC_RUN=live` (agent.cloud sets it on a release's pods after the app's own env, `packages/runner/src/release.ts` podEnv) | "Live at" the address the browser is on. |
  | `rehearsal` | `AGC_RUN=rehearsal` | "A rehearsal of a release, not live yet." |
  | `preview` | `AGC_PREVIEW_EXPIRES_AT` is set (agent.cloud's managed previews, `packages/runner/src/preview-runtime.ts`, which pass neither of the above) | "A preview, not live", with when it expires. |
  | `unknown` | none of these | "This page can't tell where it's running." |

  The first row that matches wins, top to bottom, so a mirror is a mirror whatever else is set. The page says "live", "released" or "public" only when `run` is `live`, and the progress line (started, building, released) marks "released" done only then. `unknown` claims nothing, because a process with no signal could be anywhere. `CONF:welcome-run` (the app started with each row's variables, and with `AGENTCLOUD_MIRROR` and `AGC_RUN=live` both set, answers each `run`), `CONF:welcome-copy` (the page rendered for each `run` shows that row's words, and "live", "released" or "public" appear only for `live`)
- **APP-10:** Every part the page marks "running" is checked when the page asks; the rest say "configured" or "not set up", never "running":
  - `web` and `api` are `running`: the page loaded, and `/api/welcome` answered.
  - `database` is `running` only when `SELECT count(*) FROM agentcloud_migrations` answered within 2 s, and `database.migrations` is that count. Otherwise it's `not verified`, with `database.reason`: `unreachable` (no connection), `timeout` (no answer in 2 s) or `query_failed` (an error, such as no ledger yet). The answer is always 200.
  - The query is bounded, since `/api/welcome` is public once released and anyone can call it: at most one probe runs at a time, every caller during it shares its result, and a result is reused for 60 s. So it uses at most one connection and wakes the database at most once a minute however often the page is fetched. `/api/health` still never touches the database (PROC-3).
  - `worker` is `configured` when the manifest has `[service.worker]`. Nothing checks that it's running: the worker holds no connection between polls (JOB-4), so a heartbeat would keep the database awake.
  - `signin` and `email` are `configured` when `AGC_AUTH_URL` and `AGC_EMAIL_URL` are set, and `not set up` otherwise.
  - `checks` counts the manifest's `[[check.smoke]]` and `[[check.invariant]]` tables, read with the name.

  `CONF:welcome` (with the fake database up: `database` is `running`, and `migrations` matches `agentcloud_migrations`; with it paused so queries hang: `not verified` with `timeout` within 3 s, still 200, and `/api/health` still 200; 50 concurrent calls open at most one connection, and calls within 60 s run no new query)
- **APP-11:** Each part's stack line is the starter's own:
  - TypeScript: web "React 19 + Vite 8", API "Hono on Node 24", worker "a Node 24 worker".
  - Python: web "React 19 + Vite 8", API "FastAPI on Python 3.12", worker "a Python 3.12 worker".
  - Both: database "Postgres 18".

  These are labels in the UI, chosen by `stack`, never the manifest's commands, which can carry arguments an app wouldn't publish.

  `review`
- **APP-12:** The welcome page and the Notes example are both the agent's to remove. Nothing else depends on them: no table or migration is the welcome page's own, and `/api/welcome` is its only route. The page links to the platform guide (`https://agent.cloud/agents.md`) and names `AGENTS.md` in the app's folder as the agent's instructions. `LINT:app-pages` (no migration names the welcome page), `review`

## 12. The conformance descriptor

Auto-reload (DEV-2 to DEV-4) can only be proven by editing a real file, so each starter says which, in `conformance.toml` at its root. `agc init` doesn't copy this file.

```toml
[reload.api]     # edit `file`, replacing `find` with `replace`; within 5 s, GET `url` contains `expect`
file = "server/health.ts"
find = "status: 'ok'"
replace = "status: 'reloaded'"
url = "/api/health"
expect = "reloaded"

[reload.ui]      # the same, for a UI module the dev server serves: the welcome page, the page a person edits first
file = "web/src/App.tsx"
find = "is ready to build"
replace = "is ready to rebuild"
url = "/src/App.tsx"
expect = "is ready to rebuild"

[dev]            # run once in a fresh copy before `dev` (DEV-5): the one install command the README gives
setup = "npm ci"

[reload.worker]  # the same, but `expect` must appear in the worker's log
file = "server/worker.ts"
find = "worker ready"
replace = "worker reloaded"
expect = "worker reloaded"
```

- **DSC-1:** `conformance.toml` has `[dev] setup` and all three reload probes, and each `find` occurs exactly once in its `file`, so every probe edits one exact spot. `LINT:descriptor`

## Out of scope for v1

- Per-app memory and readiness settings, and app secrets (the platform doesn't have them yet).
- Server-side rendering frameworks (Next.js, Remix, Django templates): v1 is one server plus a Vite UI.
- Single-language UIs (Streamlit, Dash, HTMX-only): possible later, as an explicitly lighter third kind.
- Custom domains and multiple web processes.

## Conformance: how it runs

```
conformance/
  run.ts              npx tsx conformance/run.ts <stack-dir> [--only RULE…] [--json report.json]
  lint/               the static rules (LINT:*), file reads only
  platform/           the fake platform: a Postgres 18 container that only accepts verified TLS,
                      a test-mode sign-in server (authorize, token, users, codes), and an email
                      endpoint that records each key once
  images/             each language's default Dockerfile, generated from the vendored runner build.ts
  vendor/agc/         checks.ts, migrations.ts and runner build.ts from agent-cloud at a pinned commit (sync.sh refreshes them)
```

1. **Lint** the stack directory (no Docker needed).
2. **Build** the image with the language's default Dockerfile, with no network to the fake platform.
3. **Start the fake platform** on a private Docker network, and apply `migrations/` the way `agc migrate` does. The fake database serves TLS with a certificate for its network name (`db`), signed by a throwaway CA. The app trusts that CA the way it trusts Neon's in production: Node through `NODE_EXTRA_CA_CERTS`; libpq, with the platform's `PGSSLROOTCERT=system`, through `SSL_CERT_FILE`. So `verify-full` is really checked, hostname included.
4. **Run** `web` and the worker from the image, each capped at 512 MiB, with the app directory read-only and the environment the platform injects (`PORT`, `DATABASE_URL`, `PGSSLROOTCERT`, `AGC_EMAIL_*`, `AGC_AUTH_*`).
5. **Probe** each `CONF:*` rule over HTTP, signals, container logs and SQL, then the checks with agc's own `runFlow`, invariants and `checkSignInState`.
6. **Dev mode:** run `dev` on a copy of the source, edit a server file, a UI file and a worker file, and watch each change land without a restart.
7. **Report:** one line per rule (`PASS`, `FAIL` with evidence, or `SKIP` with the reason), JSON with `--json`, and exit 1 if any MUST fails.

CI runs the suite for every stack on every PR. A new stack is added by passing it ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Decisions (from review)

1. **Web grace period:** web keeps 30 s (agent.cloud now sets `terminationGracePeriodSeconds: 30` on web explicitly), and PROC-4 keeps its 25 s budget.
2. **The Python default image** (agent.cloud builds it): a Node stage builds the UI when `package.json` exists, into `web/dist` (the same path in every stack). Then `python:3.12-slim` with uv: `uv sync --frozen --no-dev` with `UV_COMPILE_BYTECODE=1`, `UV_LINK_MODE=copy` and `UV_PYTHON_DOWNLOADS=never`, `.venv/bin` on `PATH`, `PYTHONUNBUFFERED=1`, a non-root user, and the manifest's `command` under the same signal wrapper.
3. **`/api/debug/error`:** kept for OBS-2, as a 404 unless `AGENTCLOUD_CONFORMANCE=1`, with its own check.
