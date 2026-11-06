# agent.cloud starter spec, v1

**Status:** draft, for review (phase 1 of the starters repo).
**For:** anyone writing an agent.cloud starter in any language, and the agents that grow apps from them. A starter that passes this spec builds and runs on agent.cloud with no Dockerfile, works on a mirror with auto-reload, signs people in, sends email, runs background jobs, and is legible in observability from its first release.

Every rule is **MUST** unless it says **SHOULD**. Each rule names the conformance test that proves it: `CONF:<name>` runs the built app against a fake platform; `LINT:<name>` reads the files. A rule with no test is marked `review`, and a person checks it in the starter's PR.

The platform facts behind each rule are cited as `repo:file` from [agent-cloud](https://github.com/summationai/agent-cloud), so this spec changes when the platform does.

## 0. What a starter is

A starter is a directory, `<language>/`, holding a complete, working app: a React + Vite UI, one server process serving the UI and the API on one port, a worker, SQL migrations, checks, and an `AGENTS.md` section. `agc init --stack <language>` copies it into an empty folder. It is a real app, small enough to read in ten minutes: people sign in, create a note, and get an email about it.

The same UI is shared by every stack, so stacks differ only in the server, the worker and the build.

**How an app grows from it.** An agent builds the main flow first, with whatever keeps the app's data, secrets and sign-in safe, and ships it. It adds a guard, retry or fallback when a check, a log or a person's report shows the case, not for one nobody has seen yet, and notes those as later work. Before adding code, it looks for what it can delete. It proves a change with `agc check` and `agc verify` on its mirror, and says how it proved it, or that it isn't proven. The starter has that shape: the notes app is its main flow, and its rules are what keeps it safe.

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
- **DEV-2:** Saving a server source file changes what the API serves within 5 s, with no manual restart. The suite makes one untimed warm-up edit first (a first compile can be slow on a cold CI runner), then times the next one. `CONF:reload-api` (with a connection held open at each save, as a browser preconnects one, so a dev server that waits on open connections before it restarts fails it)
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
- **DATA-8 (SHOULD):** The pool keeps idle connections about 60 s, in production and on a mirror alike, holds none at its minimum, and opens at most 10. So a request within a minute of the last reuses a connection instead of opening one. In production each new connection goes out through the platform's NAT with its own TLS handshake; closing idle ones after a second, as before, opened one for nearly every request (agent-cloud ASK-009, rc: "no pooler, only cheap fixes"). On a mirror, from a laptop through agc's proxy, a new connection costs about 1.7 s and a query about 0.25 s. A quiet app sheds its idle connections afterwards, so its database can still sleep (JOB-4: Neon suspends a compute 5 minutes after its last connection closes). The worker never uses this pool: it opens one connection for each poll or job and closes it right after (JOB-4). In TypeScript each idle connection closes 60 s after its last use. Python's pool (psycopg_pool) closes at most one idle connection per 60 s, so after a burst that opened all 10, the last one closes about 11 minutes later; one or two connections, a small app's usual, close within 2 or 3 minutes. `review` (TypeScript: `server/db.test.ts`, Python: `tests/test_db.py`; each loads the pool with and without `AGENTCLOUD_MIRROR`)
- **DATA-9:** Every table the migrations make has a primary key, and every foreign key an index that starts with its columns, in order. Otherwise agent.cloud's review files `no-primary-key` or `unindexed-fk`, and every ship warns about each. `CONF:keys` (after the migrations, the same catalog queries `agc check` and the rehearsal run, `packages/cli/src/preserve.ts`, find nothing)

## 6. Platform services

### Sign-in (`docs/AGENTS.md` "Sign-in"; `packages/control/src/app-signin.ts`)
- **AUTH-1:** `GET /auth/sign-in` sets a state cookie (`HttpOnly`, `SameSite=Lax`, at least 128 bits of randomness, at most 10 minutes) and answers a redirect to `$AGC_AUTH_URL/authorize?state=<state>`. It may carry a `return_to` path, which must be relative. `CONF:signin`
- **AUTH-2:** `GET /auth/callback` compares `state` with the cookie before anything else. On a mismatch it answers 400 and never calls `/token`. `CONF:signin-state` (`checkSignInState`, the same probe rehearsals run)
- **AUTH-3:** The callback trades the code with `POST $AGC_AUTH_URL/token`, using `Authorization: Bearer $AGC_AUTH_TOKEN` and `{code}`, then finds or creates the user by `user.id` in a uuid column, and starts its own session. `CONF:signin`
- **AUTH-4:** The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` outside a mirror, and lasts a day or less. Or the app rechecks `GET $AGC_AUTH_URL/users/<id>` at least daily and ends the session on 404. `CONF:cookies`
- **AUTH-8:** **Each session is rechecked with agent.cloud, at most once every 5 minutes.** On a request, a session last checked 5 minutes ago or more (a new one counts as checked when it began) is asked about with `GET $AGC_AUTH_URL/users/<id>`, `Authorization: Bearer $AGC_AUTH_TOKEN`, and `x-agc-session-start`: when this session began, in ms since the epoch, as agent.cloud's own gate sends it. agent.cloud then judges the session by when it began, so one from before a cutoff (agent-cloud's directory-reviewer-signin RVW-12, console-sessions CSN-6) stays refused even after the person signs in again. That is at most 12 calls an hour for each active session, and a person agent.cloud no longer lets in is out within 5 minutes instead of a day. Not on a target with its own sign-in (AUTH-7): its gate rechecks.
  - **The interval:** a session younger than 5 minutes, or checked in the last 5, is never asked about. The session's own row says when it was last checked, so a restart or a second process doesn't ask again sooner. `CONF:recheck-interval`
  - **Only a 2xx keeps the session; every other answer ends it**, unless agent.cloud couldn't answer (below): a 404, a 401 (as for a bad or stale `AGC_AUTH_TOKEN`), a 400, a 403, a 429 and any 3xx. A redirect is never followed: it ends the session too. The session ends before the request goes on, so that request is signed out, as is each one the same process held for the answer, and every one after it. `CONF:recheck-404` `CONF:recheck-401` `CONF:recheck-redirect`
  - **A refused session stays refused, even when the app can't delete it:** no request with it is let in again, whatever agent.cloud answers later. Claiming a recheck marks the session as under recheck, which lets no one in, and only an answer that keeps the session, once written, lets anyone in again. A refused session the app can't delete is marked refused; if that can't be written either, the claim's mark stays. So a refusal, or an answer the app fails to write, leaves the session refused, and the person signs in again. A request in another process while a recheck is under way waits up to 6 seconds for its answer to be written, and is refused without one. `CONF:recheck-delete-fails`
  - **When agent.cloud can't answer** (a timeout: 5 seconds for the whole answer in TypeScript, 5 seconds for each network operation in Python, which is not an overall deadline; a 5xx; a network error), the session goes on, and it's asked about again 5 minutes later. An outage of agent.cloud must never sign every app's people out. A failure of the app's own database is never agent.cloud not answering. `CONF:recheck-unreachable`
- **AUTH-7:** **On a target with its own sign-in** (`AGC_AUTH_PROVIDER=edge`, set by agent.cloud for apps whose manifest says `[auth] provider = "edge"`), the target's gate signs people in before a request reaches the app and passes who it is in `x-agc-user-email` and `x-agc-user-name` (agent.cloud's edge-signin spec: the gate empties any client-sent copies first). The app trusts those headers, keeps no session of its own, and fixes a user's id by their email (a name-based uuid). `/auth/sign-in` redirects home, since signing in belongs to the target's sign-in. So does signing out: behind the gate, `POST /auth/sign-out` never reaches the app, and the page's fetch gets the gate's `401 {"signed_out":true}` (agent.cloud's edge-signin spec, EDGE-14), which the page takes as signed out. On a mirror, where no gate stands in front, the app's own `/auth/sign-out` answers ok. `AGC_EDGE_DEV_USER` (set by agent.cloud on mirrors and in rehearsals, never in production) stands in when the headers are absent. `review`
- **AUTH-5:** `GET /api/me` answers 200 with the signed-in user, or 401. `POST /auth/sign-out` ends the session. `CONF:signin`
- **AUTH-6:** No passwords. No password hashing (bcrypt, scrypt, argon2, PBKDF2) anywhere near the word "password" (`agc ship` warns on it). `LINT:no-passwords`

### Email (`docs/AGENTS.md` "Background work")
- **MAIL-1:** Email is sent by a job, never inside a request's response: by the worker, or by the web process just after it has answered (JOB-5): `POST $AGC_EMAIL_URL` with `Authorization: Bearer $AGC_EMAIL_TOKEN` and `{to, subject, text, key}`. `CONF:mail`
- **MAIL-2:** `key` names the message for good (`note-<uuid>/created`), so a retried job never emails twice. `CONF:mail-once` (a worker killed mid-job: each key arrives once)

### Background jobs
- **JOB-1:** A `jobs` table, created by a migration, with the columns in `docs/AGENTS.md`. Work is inserted in the same transaction as the write it belongs to. `LINT:migrations`, `review`
- **JOB-2:** The worker claims with a lease (`FOR UPDATE SKIP LOCKED`, `locked_until`), so two workers never run one job at the same time, and a dead worker's job runs again. `CONF:jobs-race` (two workers, a batch of jobs, each email key exactly once)
- **JOB-3:** Every job is safe to run twice. `CONF:mail-once`
- **JOB-4:** An idle worker lets the database sleep (Neon suspends a compute after 5 minutes without connections). The worker listens for nothing (no `LISTEN`), and holds no database connection between polls. It polls every `WORKER_POLL_SECONDS` (default 10) while it finds work. After an empty poll it doubles the wait, up to `WORKER_IDLE_MAX_SECONDS` (default 600), and goes back to the short interval as soon as it finds a job. On its own, that would make the first email after a quiet spell wait up to ten minutes; JOB-5 runs a request's own job at once instead, and the worker's idle poll is the backstop. `CONF:jobs-idle` (with a 0.5 s poll and a 4 s ceiling: the gaps between claims grow while idle and snap back once a job arrives, and the worker holds no connection between polls)

- **JOB-5:** A job a request queues runs at once, not at the worker's next poll (agentcloud-apps/agc-feedback#316: everleaf's first email after a quiet spell took 391 s).
  - After the web process has sent its response, it claims the job it just committed, with JOB-2's lease, and runs it with the worker's own handler. So the person's request never waits on the job, and the database is only woken by work that's there.
  - If that run can't finish (the process stops, the lease is already held, or the job fails), the job stays queued and the worker runs it at its next poll, as JOB-4 says. Each job runs at most once at a time and is safe to run twice (JOB-2, JOB-3), so a run in both places sends each email key once (MAIL-2).
  - The web process never polls, never listens and holds no connection once the run ends, so JOB-4's sleeping database still holds.

  `CONF:jobs-prompt` (with the worker stopped, a note's email arrives within 5 s of its POST; a second web process, whose email service takes the send and never answers, owns the job's lease with its send open and is killed mid-send; the worker, started only then, sends that email once after the lease lapses)

### Storage (`docs/specs/app-storage.md`: STO-3, STO-6, STO-12; `agc help storage`)
Files people upload go to the app's bucket through signed URLs, never through the server or into Postgres. Each starter carries the helper an app calls once its `agentcloud.toml` declares `[storage]`; the starter itself declares none. STOR-1 through STOR-7 are proven by the stack's own tests against a fake S3 endpoint with fake keys, which `conformance.toml` names (`[storage] test`, §12) and `CONF:storage` runs. STOR-8 is a documentation review.

- **STOR-1:** The helper is `server/storage.ts` (TypeScript) or `app/storage.py` (Python), with `signUpload(key)`, `signDownload(key, mayRead)` and `delete(key)` (`sign_upload`, `sign_download` and `delete` in Python). Nothing in the starter imports it, and it reads `AGC_STORAGE_*` only when called, so an app without `[storage]` starts and runs as before (STO-0). Called without `AGC_STORAGE_BUCKET`, it throws an error that says to declare `[storage]`. Keys are relative to `AGC_STORAGE_PREFIX`, so a row names the same file in every environment; a key with a leading slash, an empty, `.` or `..` part, a control character, or S3's `${filename}` substitution syntax is refused. `CONF:storage`
- **STOR-2:** `signUpload(key)` signs a POST policy for exactly one new key, `<uuid>/<key>` under `AGC_STORAGE_PREFIX`, with `content-length-range` from 0 to `AGC_STORAGE_MAX_OBJECT_MB` MB, valid for 10 minutes, and returns `{url, fields, key}`: the browser posts the fields and the file to `url`, and the app records `key`. The uuid is fresh every time, so a key is never reused and no upload overwrites a file a row already names (STO-12). Signing asks the bucket nothing. `CONF:storage`
- **STOR-3:** `signDownload(key, mayRead)` runs the app's own access check first. Refused, it answers 403 and asks the bucket nothing. Otherwise it asks the key under the prefix with one HEAD, and signs a GET for 5 minutes on the place that holds it. A key the prefix doesn't hold:
  - on a mirror (`AGENTCLOUD_MIRROR`), answers 404 `not_on_mirror`, "This file isn't on this mirror" (STO-6), and never reads production's bucket;
  - in a rehearsal or a preview (`AGC_STORAGE_FALLBACK_BUCKET` set), signs a GET on the same key in production's bucket, with an optional `AGC_STORAGE_FALLBACK_PREFIX` for a customer target's production path, with no second request and never a list (STO-12);
  - otherwise answers 404 `not_found`.

  Refusals come in the app's error shape, `{"error": {"code", "message"}}`, with their status. `CONF:storage`
- **STOR-4:** `delete(key)` removes one key under the prefix, never anything in the fallback bucket. `CONF:storage`
- **STOR-5:** The S3 client uses path-style URLs on `AGC_STORAGE_ENDPOINT`, and goes through `HTTPS_PROXY` (honouring `NO_PROXY`) when it's set. On a mirror that's agc's egress proxy, the only way out, which lets through the endpoint's own host and not `<bucket>.<host>` (agent.cloud's `docs/specs/mirror-egress.md`, MEG-2). The AWS JS SDK ignores `HTTPS_PROXY` by default, so the TypeScript helper gives its HTTPS agent the proxy (Node's `proxyEnv`); botocore reads it itself. Keys come from `AGC_STORAGE_ACCESS_KEY_ID` and `AGC_STORAGE_SECRET_ACCESS_KEY` when they're set, and otherwise from the SDK's container credentials (an AWS target). Checksums are sent only where S3 requires one, since GCS's S3 API refuses the SDKs' default ones. `CONF:storage` (with `HTTPS_PROXY` set, the request is a `CONNECT` for the endpoint's host)
- **STOR-6:** When `AGC_STORAGE_GATEWAY_URL` is set for a customer AWS target, signed browser POST and GET URLs replace only the `AGC_STORAGE_ENDPOINT` base with that gateway base; the encoded bucket/key path, signature query and POST fields are unchanged. Backend S3 requests still use the endpoint. Without the variable, browser URLs use the endpoint directly (STO-3, STO-8, STO-15). `CONF:storage`
- **STOR-7:** Before making a 10-minute browser upload policy or a 5-minute download URL, the signer checks that temporary container credentials have at least 11 minutes remaining. It refreshes through the SDK credential chain or refuses a too-short credential. It checks again after the download's HEAD. Static HMAC credentials are unaffected, and backend clients keep their own credential chain (STO-8, STO-15). `CONF:storage`
- **STOR-8:** Each `STORAGE.md` shows an optional `uploads` migration and authenticated `POST /api/uploads` and `GET /api/uploads/download?key=...` routes. The upload example creates a relative key under the signed-in person's namespace and saves only that key and the owner; bytes go from browser to storage. The download example checks that row's owner before calling `signDownload(key, mayRead)` and returns its 403 or 404 result in the app's error shape. Both responses are `Cache-Control: no-store`. No storage helper runs for a signed-out request or a key another person owns (STO-3, STO-11). The starter installs neither the migration nor these routes. `review`

### Agents over MCP (agent.cloud's `docs/specs/app-mcp.md`; the canvas's `docs/mcp-submission.md`, SUB-1 to SUB-4)
A person's own agent (Claude, ChatGPT, Codex, Cursor) can do in the app what the person can, after they say yes once.
- **Where it's served:** the app serves MCP itself, with its own OAuth on its own sign-in, as the canvas does at `canvas.agent.cloud/mcp`.
- **The tools are the app's own `/api/*` routes.** So a route a builder adds is a tool at its next release, and the builder writes no MCP code.
- **Where the code lives:** in `server/mcp/` (TypeScript) or `app/mcp/` (Python), with its tables in the migration.

Each rule names the check that proves it, over HTTP against the built app and the fake platform.

- **AMCP-1:** **`POST /mcp` serves MCP.**
  - **The protocol:** Streamable HTTP, stateless, one JSON answer per request, protocol versions `2025-06-18` and `2025-11-25`.
  - **Methods:** `initialize`, `ping`, `tools/list` and `tools/call`. A notification gets 202, and `GET /mcp` gets 405.
  - **The manifest line:** `agentcloud.toml` says `[mcp] server = "app"`, so agent.cloud's edge lets the MCP and OAuth paths through (agent.cloud's AMCP-12).
  - `CONF:mcp`
- **AMCP-2:** **The app is its own OAuth server, on its own sign-in.**
  - **Metadata:** `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414) name the app's origin. `POST /mcp` without a valid token answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"`.
  - **Registration:** `POST /oauth/register` (RFC 7591) takes public clients only.
    - A callback must be loopback HTTP with a port, or exactly one on the starter's list: `https://claude.ai/api/mcp/auth_callback`, plus each client's callback once it's proven on agent.cloud's staging.
    - At most 20 registrations an hour per address. A client id is sealed, carrying its own callbacks, so registration stores nothing.
  - **Consent:** `GET /oauth/authorize` takes S256 PKCE only, and needs the app's session; without one, it signs the person in first and comes back.
    - The consent page shows the client's self-declared name, marked unverified, and its callback host.
    - It offers *Read* (preselected) or *Read and act*.
    - Allow or Cancel spends the request once.
  - **Tokens:** `POST /oauth/token` gives the following, and only hashes are stored:
    - a code that works once, within 60 s;
    - an access token that lasts 10 minutes;
    - a refresh token that rotates, with a 30-day absolute end. A replay revokes the grant.
  - **Revoking:** `POST /oauth/revoke` (RFC 7009).
  - `CONF:mcp-oauth`
- **AMCP-3:** **Every `/api/*` route is a tool, read from the framework's own route table.**
  - **TypeScript:** routes are registered with one helper, which mounts the Hono route with `zValidator`, as before, and records its tool from the same zod schemas: `api(app, 'post', '/api/notes', { summary: 'Add a note', json: NoteIn }, handler)`.
  - **Python:** the module reads each FastAPI `APIRoute`'s own metadata (path, methods, docstring, and parameters as the in-process `app.openapi()` describes them). `openapi_url` stays `None`.
  - **Each tool's name** is the method and path: `GET /api/notes/{id}` is `get_notes_by_id`, unless the route names itself.
  - **Each tool's description** is the route's summary or docstring.
  - **Each tool's input** is one object: the route's path and query parameters and its JSON body's fields, side by side.
  - **Opting out:** a route can be left out, but only with a reason: `exclude: '<why>'` (TypeScript), or `openapi_extra={"x-mcp-exclude": "<why>"}` (Python). The starter leaves out `/api/health`, `/api/welcome` and its debug routes.
  - **Nothing is missed:** an `/api/*` route that's neither a tool nor left out is **missing**. That covers a TypeScript route registered without `api()`, a route without a summary, and a name used twice in one input.
  - **`GET /mcp/manifest`** answers only `Authorization: Bearer $AGC_AUTH_TOKEN`, with `{tools, excluded, missing}`. That's what agent.cloud's ship receipt diffs (agent.cloud's AMCP-14).
  - `CONF:mcp-tools` (the starter's manifest has nothing missing). A route added with `api()` becoming a tool with no other edit, and a bare one listed as missing, is proven by each stack's own tests (TypeScript: `server/mcp.test.ts`, Python: `tests/test_mcp.py`).
- **AMCP-4:** **A tool call runs its route in-process, as the person.**
  - **How it's called:**
    - TypeScript: `app.request()`, with the grant's person in `c.env`;
    - Python: an ASGI call to the app, with the person in the request scope's `state`.

    No header, cookie or argument can set either, and the build's checks forge each one to prove it.
  - **The session step** takes that person first. After that, the route's own middleware, validation and handler run unchanged, so the agent can do exactly what the person can.
  - **The answer:** the route's JSON body is the tool's result, and a status of 400 or more is a tool error carrying the route's `error.message`.
  - `CONF:mcp-tools`
- **AMCP-5:** **Hints, read grants, and asking first.**
  - **Hints:**
    - `GET` is `readOnlyHint`;
    - `DELETE`, or a route marked `destructive: true`, is `destructiveHint`.
  - **Read grants:** a *Read* grant lists and calls only `GET` tools.
  - **A destructive tool asks first:**
    - the first call runs nothing, and answers with a link to `/agents/approve/<id>` and a sentence for the agent to say;
    - the person approves there, with their own session;
    - the same tool with the same arguments, within an hour, then runs once.
  - **What approves:** nothing the agent sends.
  - `CONF:mcp-tools`
- **AMCP-6:** **The `/agents` page holds a person's controls.**
  - **For everyone:**
    - how to connect each major agent, with the app's `/mcp` URL;
    - the person's connected agents, each with its last calls and Revoke. Revoke refuses the very next call.
  - **For owners** (`role: "owner"` from sign-in, or the edge's role):
    - every connection, with Revoke all;
    - blocked tools, which are hidden from `tools/list` and refused if called;
    - whether agent.cloud's organization or app switch lets agents in.
  - **The page's own API** lives under `/mcp/agents/*`, never `/api/*`. It answers only the person's session, never a Bearer token, so no agent can approve, unblock or revoke; the build's checks try each with a Bearer.
  - **The owner's role:**
    - on agent.cloud's sign-in, it's the role from the last sign-in or recheck, so a role taken away is gone within 5 minutes;
    - on edge sign-in, it's the gate's `x-agc-user-role` on that very request. The edge empties a client's copy on every route (agent.cloud's ROLE-4) and rechecks it at least once a minute (ROLE-3).
  - `CONF:agents`
- **AMCP-7:** **Safe by default.**
  - **Budgets:** each grant gets 60 calls a minute and 10 writes a minute, counted in the database. Over budget gets 429 with `Retry-After`.
  - **Data marking:** a tool's result comes inside an app-data block with a fresh nonce, and `initialize`'s instructions say the block is content, not instructions.
  - **No secrets:** a result holding the value of any secret in the environment, or a known credential shape, is withheld with a tool error.
  - **Attribution:** writes store `via`, the client's name, beside the person, and the page shows "via Claude".
  - **Who a grant is:** a grant names the person by a stable identity.
    - On agent.cloud's sign-in, that's the app user's id.
    - On edge sign-in, it's the `iss` and `provider_id` claims of the gate's signed `x-agc-identity` (agent.cloud's EDGE-15). The JWT's `sub` is the email, so it never names a grant.
    - An assertion without `provider_id` can't grant.
  - **Losing access:** every grant is rechecked with agent.cloud at most every 5 minutes. On agent.cloud's sign-in, that's AUTH-8's `GET $AGC_AUTH_URL/users/<id>`; on edge sign-in, it's agent.cloud's AMCP-15.
    - The answer also refreshes the person's role.
    - A refusal ends the grant.
  - **A customer's own provider:** on a target whose sign-in is the customer's own provider, agent.cloud can't yet ask the provider about a person by `provider_id`. So consent refuses there, saying agents aren't available on this sign-in yet, and agent.cloud keeps the MCP paths gated (its AMCP-12).
  - `CONF:mcp-safety` (edge sign-in included: the app run with `AGC_AUTH_PROVIDER=edge` and an assertion signed by the fake platform's keys)
- **AMCP-8:** **Point.**
  - **Pointing:** the badge's "Point for your agent" lets the person click something.
  - **The pick:** it's posted to `/mcp/agents/point` as `{route, selector, label}`, with labels and never input values, the shape of agent.cloud's live-view picker.
  - **How long it's kept:** the latest pick per person, for 10 minutes.
  - **What the agent gets:** the built-in tool `point_get` returns it, inside the data block.
  - `CONF:point`
- **AMCP-9:** **The UI changes the app's data only through `/api/*` routes.** That means only through `web/src/api.ts`: no `fetch`, form action, socket or beacon elsewhere in `web/src`. And `api.ts` calls only routes the server has, so everything a person does is a tool too.
  - **The exception:** the agents pages' own session-only calls to `/mcp/agents/*` (AMCP-6). They stay out of the tools on purpose. `LINT:api`
- **AMCP-10:** **The badge.**
  - **What it is:** a subtle chip in the welcome page's chip row (APP-9), "Use with your agent", linking to `/agents`.
  - **When it shows:** while agents can reach the app.
  - **Hiding it:** the person can hide it in their browser.
  - `CONF:badge` (the chip's place, its answer and the bundle; Hide's localStorage, read from the source, since the suite runs no browser)

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
- **DOC-3:** `AGENTS.md` tells the agent to keep business logic in the app's code, not in database triggers, and to use a trigger only for simple per-row bookkeeping such as `updated_at`, with the reason: a trigger hides behaviour from the code a reviewer reads, and agent.cloud's masked copies and migration checks handle triggers poorly. It's guidance; nothing refuses a trigger. agent.cloud's own AGENTS.md says the same (its TRG-1 and TRG-2). `LINT:agents-md`
- **DOC-4:** `AGENTS.md` asks the agent to say what it's about to do at each step with `agc now "<text>"`, one line of up to 120 characters, so the people watching it build an open Work item read its steps in its own words (agent.cloud's LIVE-21). It's a request; nothing refuses a build without it. `LINT:agents-md`
- **DOC-5:** `AGENTS.md` tells the agent to index every foreign key in the migration that adds it (an index that starts with its columns, in order), with the reason: Postgres doesn't make one, so lookups by the key and deletes from the table it references scan the whole table. It names the rule agent.cloud's review files it under, `unindexed-fk`, as agent.cloud's own AGENTS.md does (its RFR-10). It's guidance; `agc check` and a ship's rehearsal warn, and nothing refuses. `LINT:agents-md`
- **DOC-6:** `AGENTS.md` tells the agent to give every table a primary key (`id uuid PRIMARY KEY`, or a composite key on a table that links two others), with the reason: without one, duplicate rows can appear and a single row can't be updated or deleted reliably. It names agent.cloud's review rule, `no-primary-key`, which `agc check` and a ship's rehearsal warn about first. It's guidance; nothing refuses such a table. agent.cloud's own AGENTS.md says the same (its RFR-10 and PKEY-1). `LINT:agents-md`
- **DOC-7:** `AGENTS.md` says admin routes answer only an admin: a route under `/admin`, `/internal`, `/debug`, `/_debug`, `/manage` or `/dashboard`, or the same under `/api/`, checks that the signed-in person is an admin and refuses anyone else with 401 or 403, and a smoke flow that calls it before any `SIGN IN` proves it. It's guidance; nothing refuses a route. agent.cloud's review files `admin-route-answers` for such a route that answers, and agent.cloud's own AGENTS.md says the same (its RFR-16). `LINT:agents-md`
- **DOC-8:** `AGENTS.md` tells the agent to delete a mirror's copy once its work has shipped, with `agc down <name> --delete`, since `agc down` alone keeps it and agent.cloud's review files a copy made over a week ago (`idle-copy`), naming the finding's title as agent.cloud's control writes it, "Copy <name> has been idle for over a week". agent.cloud's own AGENTS.md says the same (its RFR-10 and MIRROR-65). `LINT:agents-md`
- **DOC-9:** `AGENTS.md` tells an app with a lake connection (`ducklake` or `flightsql`) to serve `GET /api/status` with the process's peak memory and the timings of its recent lake calls, in the route's own handler, and no data from the lake, naming the review rule it avoids, `no-status-route`. It's guidance; nothing refuses an app without it. agent.cloud's own AGENTS.md says the same (its RFR-10 and RFR-16). `LINT:agents-md`
- **DOC-10:** `AGENTS.md` tells the agent how to avoid agent.cloud's review finding `restarts` ("The app restarts unexpectedly"), naming it with the words "reports that as `restarts`": a crash restarts the app in production and fails the requests in flight, so each error stays where it belongs (a route's in the error handler, a job's in the worker's loop, a connection's in an `error` listener where the stack has them), and the app exits only on SIGTERM. agent.cloud's own AGENTS.md says the same (its RFR-10, which keeps a recurring review finding's guidance in every app's AGENTS.md). `LINT:agents-md`
- **DOC-11:** `AGENTS.md` tells the agent how to keep every route under a second, naming the review rule it avoids, as `` (`slow-route`) ``: one query for what a route needs rather than one per row, an index on what it filters and joins by, and outside calls in a job rather than while the person waits. It's guidance; nothing refuses a slow route. agent.cloud's own AGENTS.md says the same, kept in step with its review's rules by its RFR-10 test. `LINT:agents-md`
- **DOC-12:** `AGENTS.md` tells the agent to decide how long a new table's rows are needed, and that a table recording things that happen (events, logs, jobs, sessions, notifications) needs code that deletes older rows on a schedule, skipped when `AGC_RUN` is `rehearsal`, or partitions it and drops old partitions, with the reason: a table that only grows makes backups, rehearsals and mirrors larger and its queries slower, and agent.cloud's review files it as `unbounded-table`. It names the starter's own `jobs` table, which keeps every done job. It's guidance; nothing refuses a table. agent.cloud's own AGENTS.md says the same (its RFR-10). `LINT:agents-md`
- **DOC-13:** `AGENTS.md` tells an app with a lake connection (`ducklake` or `flightsql`) to name a lake query's columns, never `SELECT *`, and bound it with a `WHERE` on the table's partition column or a `LIMIT`, with the reason: a lake table can hold billions of rows, and an unbounded query reads all of them. It names agent.cloud's review rule, `lake-unbounded-query`, and its title as agent.cloud's control writes it, "Lake queries read more than they need", which `agc check` and a ship's rehearsal warn about first. It's guidance; nothing refuses a query. agent.cloud's own AGENTS.md says the same (its RFR-10). `LINT:agents-md`
- **DOC-15:** `AGENTS.md` tells the agent that on an app granted a lake connection, every scheduled job (the worker's loop, a cron or a timer) checks `AGC_RUN` and skips its work, logging that it did, when it's `rehearsal`, and names the review's rule, `unguarded-schedule`: a rehearsal runs the worker with production's secrets and the organization's real lake connections. agent.cloud's own AGENTS.md says the same (its RFR-10). `LINT:agents-md`

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

### The welcome page (APP-7 to APP-13)

The welcome page is frame 0 of every app: what a person sees the first time `agc up` opens it, before their agent has built anything. It must never claim more than is true. In particular, it never says the app is live before its first release.

- **APP-7:** `/` serves the welcome page, and `/notes` serves the Notes example: sign-in, the person's notes and the add form, as before. Both are routes of the one UI bundle, so a reload of either answers `index.html` (PROC-2). APP-2 to APP-6 stand unchanged. The Notes page says it's an example the agent removes once the app takes shape, and signing in from it returns to `/notes` (`/auth/sign-in?return_to=/notes`, AUTH-1). `CONF:welcome-copy` (the stack's own UI modules rendered with `react-dom/server`: `/` renders the welcome page and `/notes` renders Notes, each with its own text, so a missing route fails even though the SPA fallback answers HTML), `CONF:signin-return` (signing in through `/auth/sign-in?return_to=/notes` on the fake platform ends at `/notes`)
- **APP-8:** `GET /api/welcome` answers 200 with what the page shows, no sign-in, never a secret or a variable's value:
  ```json
  {"app": "folio", "stack": "typescript", "run": "mirror",
   "parts": {"web": "running", "api": "running", "database": "running", "worker": "configured",
             "signin": "configured", "email": "configured"},
   "database": {"migrations": 1, "checked_at": "2026-10-21T04:00:00Z"},
   "checks": {"smoke": 1, "invariants": 1}, "preview_expires_at": null,
   "production": {"url": "https://folio.agent.cloud", "version": null}}
  ```
  `app` is `[app] name` from `agentcloud.toml`, read when the server starts, never a literal. `stack` is the starter's own name. The answer has exactly the fields above. `run` and the part states are derived from the manifest and the environment (APP-9, APP-10), and `run` also from one request header agent.cloud's preview gate sets (APP-9's `private`); `preview_expires_at` is `AGC_PREVIEW_EXPIRES_AT` when it parses as a timestamp, re-written as ISO 8601 UTC, and `null` otherwise. `production` is what agc tells a mirror about the app (agent.cloud's mirror-release-state spec, MREL): on a mirror, when `AGENTCLOUD_APP_URL` is an `https://` origin and `AGENTCLOUD_RELEASED` is set, `{"url": <that origin>, "version": <the number, or null when it's empty>}`; otherwise `null`, meaning unknown. The app's public address is public, so it may be returned. No raw command, path, other URL, token or other value from the manifest or the environment is returned. The page's stack lines are fixed labels in the UI (APP-11). `CONF:welcome` (the answer has exactly these fields; its `app` is the manifest's name; with a sentinel secret in an environment variable, in `AGC_AUTH_URL` and in `[service.worker] command`, the answer contains none of them)
- **APP-9:** `run` says where this process runs, from what the platform sets and an app can't fake:

  | `run` | When | The page says |
  | - | - | - |
  | `mirror` | `AGENTCLOUD_MIRROR` is set (agc up, `packages/cli/src/mirror.ts`) | "Running on this machine", with the address the browser is on, and then, from `production` (APP-8): "`<url>` reserved, not released" when `version` is `null`; "live at `<url>` (v`<version>`) · this is your local copy" when it's a number; and, when `production` is `null`, "`agc ship` releases it", with no address and no claim either way, since only agent.cloud knows the app's address (a target's can differ). agc reports production as of when the mirror's processes started (MREL-3), so the released and not-released lines add "when this copy started". |
  | `private` | `AGC_RUN=live`, and the request for `/api/welcome` carries `X-Agc-Preview: private` (agent.cloud's preview gate sets it on every request it lets through, replacing any copy the client sent; publish-is-sign-up.md PUBLISH-3) | "Private preview: publish to go live at" the address the browser is on. |
  | `live` | `AGC_RUN=live` (agent.cloud sets it on a release's pods after the app's own env, `packages/runner/src/release.ts` podEnv) | "Live at" the address the browser is on. |
  | `rehearsal` | `AGC_RUN=rehearsal` | "A rehearsal of a release, not live yet." |
  | `preview` | `AGC_PREVIEW_EXPIRES_AT` is set (agent.cloud's managed previews, `packages/runner/src/preview-runtime.ts`, which pass neither of the above) | "A preview, not live", with when it expires. |
  | `unknown` | none of these | "This page can't tell where it's running." |

  The first row that matches wins, top to bottom, so a mirror is a mirror even when its shell happens to carry `AGC_RUN`. That order is only trustworthy because agent.cloud never lets `AGENTCLOUD_MIRROR` reach a release, rehearsal or preview pod: it is a reserved name that an app secret can't take, and the runner removes it from a pod's environment before setting `AGC_RUN` (agent.cloud's secrets and podEnv; this rule depends on that platform change landing first, and DEV-6's `Secure` cookies depend on it too). Only `live` claims the app is live: the page's status line reads "Live at <address>" only then, and the progress line (started, building, released) marks "released" done only then. Every other row's status line is exactly the words in the table, whose only use of "live" is "not live". `unknown` claims nothing, because a process with no signal could be anywhere. `CONF:welcome-run` (the app started with each row's variables, and with `AGENTCLOUD_MIRROR` and `AGC_RUN=live` both set, answers each `run`; on a mirror, `production` is `{url, version: null}` with `AGENTCLOUD_RELEASED` empty, `{url, version: 3}` with it `3`, and `null` with it absent or the URL not an `https://` origin; agent.cloud's own tests prove an app secret named `AGENTCLOUD_MIRROR` is refused and a release pod never carries one), `CONF:welcome-copy` (the page rendered for each `run` shows exactly that row's status line; "Live at" and a done "released" step appear for `live` and for no other row; a mirror rendered with each `production` shows its own line, and "live at" on a mirror only with a version) `private` only lowers `live`: a visitor can send the header to a published app, which then says less than "live" to that visitor alone, so the header never grants, hides or turns off anything.
- **APP-10:** Every part the page marks "running" was checked, and the page says when; the rest say "configured" or "not set up", never "running":
  - `web` and `api` are `running`: the page loaded, and `/api/welcome` answered.
  - `database` is the last verified state: `running` only when `SELECT count(*) FROM agentcloud_migrations` answered within 2 s, with `database.migrations` that count. `database.checked_at` is when the last probe finished, whether it succeeded or failed, and `database.migrations` is `null` whenever the state is `not verified`. The page shows how long ago it was checked ("checked 40 s ago"). Otherwise it's `not verified`, with `database.reason`: `unreachable` (no connection), `timeout` (no answer in 2 s) or `query_failed` (an error, such as no ledger yet). The answer is always 200.
  - The query is bounded, since `/api/welcome` is public once released and anyone can call it: in each process, at most one probe runs at a time, every caller during it shares its result, and a result (success or failure) is reused for 60 s. So each web process uses at most one connection for it and wakes the database at most once a minute, however often the page is fetched; there's no cache shared across processes. `/api/health` still never touches the database (PROC-3).
  - `worker` is `configured` when the manifest has `[service.worker]`. Nothing checks that it's running: the worker holds no connection between polls (JOB-4), so a heartbeat would keep the database awake.
  - `email` is `configured` only when both `AGC_EMAIL_URL` and `AGC_EMAIL_TOKEN` are set (agent.cloud passes them as a pair, and the app needs both); otherwise `not set up`. `signin` follows the same rule, but a starter needs sign-in to start at all (PROC-9), so a running starter's `signin` is always `configured`: the rule only matters to an app that makes sign-in optional.
  - `checks` counts the manifest's `[[check.smoke]]` and `[[check.invariant]]` tables, read with the name.

  `CONF:welcome` (with the fake database up: `database` is `running`, and `migrations` matches `agentcloud_migrations`; with it paused so queries hang: `not verified` with `timeout` within 3 s, still 200, and `/api/health` still 200; 50 concurrent calls open at most one connection, and calls within 60 s run no new query; after a cached `running`, the database stops and the next probe after 60 s answers `not verified` with a later `checked_at`; with only `AGC_EMAIL_URL`, or only `AGC_EMAIL_TOKEN`, `email` is `not set up`; with only half of sign-in's pair, the app doesn't start, and its last log line names the missing variable, PROC-9)
- **APP-11:** Each part's stack line is the starter's own:
  - TypeScript: web "React 19 + Vite 8", API "Hono on Node 24", worker "a Node 24 worker".
  - Python: web "React 19 + Vite 8", API "FastAPI on Python 3.12", worker "a Python 3.12 worker".
  - Both: database "Postgres 18".

  These are labels in the UI, chosen by `stack`, never the manifest's commands, which can carry arguments an app wouldn't publish.

  `review`
- **APP-12:** The welcome page and the Notes example are both the agent's to remove. Nothing else depends on them: no table or migration is the welcome page's own, and `/api/welcome` is its only route. The page links to the platform guide (`https://agent.cloud/agents.md`) and names `AGENTS.md` in the app's folder as the agent's instructions. Its header names the starter by stack ("TypeScript starter", "Python starter"), with no version, and it has no console link. `LINT:app-pages` (no migration names the welcome page), `review`

- **APP-13:** The welcome page and Notes follow rc's design in [`design/welcome/`](design/welcome/): the light and dark screenshots, the Notes screenshot, and the two mockup pages, which hold the exact colors, sizes and spacing. The starter rebuilds them in its own React and CSS; it doesn't copy the mockup's markup. It keeps:
  - the agent.cloud mark;
  - the status chips (APP-9);
  - the progress line;
  - the "Tell your agent what to build" card, with its Copy prompt button and highlighted placeholders;
  - the `agc up`, `agc check` and `agc ship` cards;
  - "What's running" as Browser → Web → API → Database ← Worker, with Sign-in and Checks below;
  - the Notes example card;
  - the footer.

  Where the mockup and these rules differ, the rules win:
  - Every part's label comes from `/api/welcome` (APP-10), never the mockup's text: the Worker and Sign-in say "configured" or "not set up", and never "running".
  - The chips come from APP-9.
  - The app's address anywhere on the page (the `agc ship` card, the progress line) is `production.url` or the address the browser is on when `run` is `live` or `private`; otherwise the page names no address.
  - Copy that says the app isn't released ("Nothing was public when this copy started", "When this copy started, nothing was released at …") appears only on a mirror whose `production.version` is `null`. On a mirror with a version, it says what was released then ("When this copy started, … ran v<n>"). agc's word on production holds from when the mirror's processes started (MREL-3), so every such line says so and none promises the current state. When `run` is `live`, which carries no version, the page says so without one ("Your next release replaces this one"). With `production` `null`, it makes no claim either way ("agc ship releases it").
  - A part described as doing work is one APP-10 checked; the Worker, only `configured`, is "set up to run background jobs", never said to run them.
  - The Notes page shows no email status per note: APP-2 returns none and the seed (APP-6) sends no mail. The screenshot's "emailed" and "email queued" badges are illustrative and aren't built. The page says once that each new note sends an email.
  - There's no console link.
  - The footer names the stack ("TypeScript starter"), with no version.

  Both themes follow `prefers-color-scheme`. Fonts are rc's call for the starter, an exception to agent.cloud's Geist rule for its own pages: Bricolage Grotesque for text and JetBrains Mono for code, on both pages, loaded from Google Fonts as the design does, with system fallbacks so the page reads the same offline. They're set in one CSS variable each, so changing them is a one-line edit.

  Motion stays small and never stands between a person and the text: the mark's bars settling, the live dot's pulse, packets along the connectors, the Building ring and the cursor. Under `prefers-reduced-motion: reduce` nothing moves, and the page reads the same with every animation off. `CONF:welcome-copy` (rendered with reduced motion, no element carries an animation; the console link is absent, and the footer names no version; rendered as a mirror with `production.version` `null`, a number, and `production` `null`, the not-released copy appears only for `null`, the released copy only for a number, and neither for `null` production; the Notes page shows no per-note email status), `review` (against the screenshots)

### The app's icon and link preview (APP-14)

- **APP-14:** Every page the starter serves has agent.cloud's icon and link-preview tags in its `<head>`, served in the HTML itself so a link unfurler that runs no JavaScript sees them. This is proposed with agent.cloud's [app-icons spec](https://github.com/summationai/agent-cloud/blob/main/docs/specs/app-icons.md) (agent-cloud#4295) (ICON-7) and isn't built yet, so conformance doesn't check it until the build lands. The tags:
  - `<link rel="icon" href="/.agc/brand/favicon.ico" sizes="any">`, `<link rel="icon" type="image/svg+xml" href="/.agc/brand/favicon.svg">` and `<link rel="apple-touch-icon" href="/.agc/brand/apple-touch-icon.png">`;
  - `<link rel="manifest" href="/.agc/brand/site.webmanifest">`;
  - `og:image` and `twitter:image` (with `twitter:card` set to `summary_large_image`) as the absolute URL `<AGENTCLOUD_APP_URL>/.agc/brand/preview.png`, which the server fills in when it serves the page;
  - `og:title` and `og:description`, the page's own title and description.

  These are agent.cloud's paths, not the app's files: the starter ships no icon of its own, and agent.cloud serves the app's icon set there (ICON-6). Where `AGENTCLOUD_APP_URL` isn't set, the page leaves out `og:image` and `twitter:image` instead of writing a relative URL. `review` until the build adds its conformance check.

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

[storage]        # the stack's own storage tests (STOR-1 to STOR-7), run in the starter's folder once its dependencies are installed
test = "node --test server/storage.test.ts"
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
