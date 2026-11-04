# This app: the Python stack

A FastAPI API on uvicorn and a React UI (Vite), served together on `$PORT`. There's a worker for background jobs, and Postgres through psycopg 3 in plain SQL. Python 3.12 with uv; the UI is the same one the TypeScript stack uses.

## Commands

```text
uv sync && npm ci          install dependencies (once, and after uv.lock or package-lock.json changes)
agc up --detach            the app on your mirror: UI and API on one port, reloading on save
uv run pytest              the app's own tests (agent.cloud's checks run separately: agc check)
uv run ruff check . && uv run ruff format .   lint and format
uv run pyright             type-check
uv add <package>           a new dependency (commit uv.lock with it)
```

## Say what you're doing

While you build an open Work item, people in the app's organization can watch you in the console. At each step, before you start it, run `agc now "<what you're about to do>"`: one line, in the present tense, of up to 120 characters ("Adding the scores table and its migration"). They see it as your words, with the saves that follow under it. It goes through the running mirror (`agc up --detach`).

## Where things are

```text
app/main.py        every route: /api/*, health, the JSON-only rule for changes, error handling, the built UI
app/mcp/           /mcp for people's own agents: its OAuth, the tools (your /api routes), the /agents pages' API
app/auth.py        sign-in through agent.cloud, and sessions
app/worker.py      the job loop, and one handler per job kind (python -m app.worker)
app/db.py          the pool, and tx() for writes that belong together
app/log.py         JSON logs, and event() for workflow steps
app/__main__.py    starts uvicorn on 0.0.0.0:$PORT (python -m app)
dev.sh             agc up's dev command: uvicorn --reload behind Vite
app/welcome.py     GET /api/welcome: the welcome page's facts; remove it with the welcome page
app/storage.py     sign_upload, sign_download and delete, for files people upload once agentcloud.toml declares [storage]
web/src/           the UI: App.tsx (the welcome page at /), Notes.tsx (the example at /notes), Agents.tsx (/agents), api.ts
migrations/        schema changes, as plain SQL (agc migration new <slug>)
seed.sql           a demo person and three notes for a mirror that starts empty (agc up); never runs in production
```

## How to add things

- **An API route:** in `app/main.py`, under `/api/`, with a docstring that says what it does and returns. Call `signed_in(request)` for anything personal. Endpoints that touch the database are plain `def` (FastAPI runs them in a thread). Changes take a JSON body (any other body gets 415), checked by a model (below).
- **People's agents use it too:** every `/api` route is also a tool a person's own agent (Claude, ChatGPT, Codex, Cursor) calls at `/mcp`, as that person, after they say yes once at `/agents` (`app/mcp/`). Its docstring (or `summary=`) is what the agent reads; its parameters and body model are the tool's input. `DELETE`, or `openapi_extra={"x-mcp-destructive": True}`, asks the person first. A route agents mustn't call takes `openapi_extra=mcp.exclude('<why>')`; one with no docstring is listed as missing. Keep every change the UI makes going through `web/src/api.ts` to an `/api` route, so agents can do it too.
- **Admin routes answer only an admin.** A route under `/admin`, `/internal`, `/debug`, `/manage` or `/dashboard`, or the same under `/api/`, checks that the signed-in person is an admin, never `signed_in(request)` alone, and answers anyone else 403 (401 before sign-in). Add a smoke flow to `agentcloud.toml` that calls it before any `SIGN IN` and expects `401|403`, then signs in as someone who isn't an admin and expects `403`: `agc check` and rehearsals call these paths with no sign-in and as a made-up person who is no admin, and agent.cloud's review asks about any admin-looking route that answers.
- **A table or column:** `agc migration new <slug>`, then plain SQL in the new file, then `agc migrate`. Key things on `uuid`. Use `CHECK (status IN (…))` for fixed sets of values, so mirrors show them. Never change the schema from code: no Alembic, no `create_all()`.
- **A primary key on every table:** `id uuid PRIMARY KEY`, or `PRIMARY KEY (a, b)` on a table that links two others. Without one, duplicate rows can appear and a single row can't be updated or deleted reliably. `agc check` and a ship's rehearsal warn about a table with none, before agent.cloud's review files it (`no-primary-key`).
- **A foreign key:** index it in the migration that adds it, as `sessions_user` does for `sessions.user_id` (for a key over several columns, an index that starts with them, in order). Postgres doesn't make one, so looking rows up by the key, and deleting from the table it references, scan the whole table once it grows. `agc check` warns about one without, and agent.cloud's review files it as `unindexed-fk`.
- **A check:** every main journey gets a `[[check.smoke]]` and every rule the data must keep a `[[check.invariant]]` in `agentcloud.toml`, then `agc check`. Never ship with none: a release that goes live on its own would go live with nothing checked, and agent.cloud's review files that (`no-checks`, "Releases go live with nothing checked"). The notes example's two checks are this app's only ones, so when you remove the example, replace them with your app's own.
- **Business logic:** keep it in the app's code, not in database triggers. Use a trigger only for simple per-row bookkeeping, such as setting `updated_at`: a trigger hides behaviour from the code a reviewer reads, and agent.cloud's masked copies and migration checks handle triggers poorly.
- **A background job:** insert into `jobs` inside the same `tx()` as the write it belongs to, and add a handler to `HANDLERS` in `app/jobs.py`. To run it at once, have the route return its id and call `background.add_task(run_now, job_id)`, as `add_note` does (JOB-5): it runs after the response is sent, so no person waits on it. The worker is the backstop: it polls every 10 s while busy and backs off to 10 minutes when idle, holding no connection in between, so the database can sleep. A job can run twice, so make it safe to: emails carry a `key` that names the message for good, like `note-<id>/created`.
- **A workflow step:** `log.event("order.paid", f"order:{order_id}", related=[f"user:{user_id}"])`. Ids only, never emails or names.
- **Logging:** `log.info("what happened", note=note_id)`. Never log emails, names, tokens or request bodies.
- **Files people upload:** declare `[storage]` in `agentcloud.toml` (then `agc up` again), and use `app/storage.py`, never a `bytea` column. In a plain `def` route behind `signed_in(request)`, `storage.sign_upload(name)` returns `{"url", "fields", "key"}`: the browser posts `fields` and the file straight to `url`, and you save `key` in your table (a fresh key every time, so a file is never overwritten). To show a file, `storage.sign_download(key, lambda: row.user_id == user.id)`: your own check runs first, and the answer has a 5-minute `url`, or a `status` with an `error` (on a mirror, a file its masked rows name but it doesn't hold says "This file isn't on this mirror"). `storage.delete(key)` removes one.
- **Data work:** for analytics in the app, `uv add duckdb` (or polars) and query in-process. Cache under `/tmp`, the only place the app may write.

## Validate every request body

Validate every request body with a schema: it's how a route takes input here. Existing routes and other validators are fine, and nothing in agent.cloud checks for it. The notes route shows the pattern: a Pydantic model is the body parameter, so FastAPI checks the body before the handler runs. Pydantic comes with FastAPI, so there's nothing to install.

```python
class NoteIn(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]

@app.post("/api/notes", status_code=201)
async def add_note(request: Request, body: NoteIn) -> Response:
```

- A body that doesn't fit answers 400 `{"error": {"code": "bad_request", "message": "title: …"}}` (the `RequestValidationError` handler in `app/main.py`), not FastAPI's default 422.
- This is Pydantic 2: `Field(...)` or `Annotated` constraints, `@field_validator` (not `@validator`), `model_dump()` (not `.dict()`). For an email field, `uv add "pydantic[email]"`, then `EmailStr`.
- Unknown fields are ignored; `model_config = ConfigDict(extra="forbid")` refuses them.
- The environment (`app/env.py`) and database rows (CHECK constraints) aren't request bodies: leave them as they are.

## Rules this stack keeps

- Health (`/api/health`) never touches the database. agent.cloud asks it every 2 seconds.
- The pool keeps idle connections about 60 s, in production and on a mirror, so a request within a minute reuses one. It then closes them one per minute until none is left, so the database can sleep (`app/db.py`). From a laptop a mirror query costs about 0.25 s and a new connection about 1.7 s: fetch what a page needs in one query, not one per row.
- Uvicorn binds `0.0.0.0`, never its `127.0.0.1` default. It logs JSON, with no access log (agent.cloud's router keeps one).
- Sign-in checks `state` before trading the code. Sessions last a day, and each is rechecked with agent.cloud at most once every 5 minutes, sending when it began: a 2xx keeps it, so does a recheck agent.cloud can't answer (a 5xx, a timeout, a network error), and every other answer ends it (a 404, a 401, a redirect, which is never followed), even when deleting the session fails. Cookies are `__Host-` cookies outside a mirror: apps share the agent.cloud site, and the prefix stops a neighbour app from planting one. Any cookie you add keeps that rule (`secure=True`, `path="/"`, no `domain`).
- On SIGTERM, web and the worker finish what's in flight and exit.
