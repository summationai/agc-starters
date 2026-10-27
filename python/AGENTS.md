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

## Where things are

```text
app/main.py        every route: /api/*, health, the JSON-only rule for changes, error handling, the built UI
app/auth.py        sign-in through agent.cloud, and sessions
app/worker.py      the job loop, and one handler per job kind (python -m app.worker)
app/db.py          the pool, and tx() for writes that belong together
app/log.py         JSON logs, and event() for workflow steps
app/__main__.py    starts uvicorn on 0.0.0.0:$PORT (python -m app)
dev.sh             agc up's dev command: uvicorn --reload behind Vite
app/welcome.py     GET /api/welcome: the welcome page's facts; remove it with the welcome page
app/storage.py     sign_upload, sign_download and delete, for files people upload once agentcloud.toml declares [storage]
web/src/           the UI: App.tsx (the welcome page at /), Notes.tsx (the example at /notes), api.ts
migrations/        schema changes, as plain SQL (agc migration new <slug>)
seed.sql           a demo person and three notes for a mirror that starts empty (agc up); never runs in production
```

## How to add things

- **An API route:** in `app/main.py`, under `/api/`. Call `signed_in(request)` for anything personal. Endpoints that touch the database are plain `def` (FastAPI runs them in a thread). Changes take a JSON body (any other body gets 415), checked by a model (below).
- **A table or column:** `agc migration new <slug>`, then plain SQL in the new file, then `agc migrate`. Key things on `uuid`. Use `CHECK (status IN (…))` for fixed sets of values, so mirrors show them. Never change the schema from code: no Alembic, no `create_all()`.
- **A background job:** insert into `jobs` inside the same `tx()` as the write it belongs to, and add a handler to `HANDLERS` in `app/worker.py`. The worker polls every 10 s while busy and backs off to 10 minutes when idle, holding no connection in between, so the database can sleep: don't make a person wait on a job. A job can run twice, so make it safe to: emails carry a `key` that names the message for good, like `note-<id>/created`.
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
- On a mirror the pool keeps idle connections 30 s; in production it closes them after 1 s, so the database can sleep (`app/db.py`). From a laptop a mirror query costs about 0.25 s and a new connection about 1.7 s: fetch what a page needs in one query, not one per row.
- Uvicorn binds `0.0.0.0`, never its `127.0.0.1` default. It logs JSON, with no access log (agent.cloud's router keeps one).
- Sign-in checks `state` before trading the code. Sessions last a day. Cookies are `__Host-` cookies outside a mirror: apps share the agent.cloud site, and the prefix stops a neighbour app from planting one. Any cookie you add keeps that rule (`secure=True`, `path="/"`, no `domain`).
- On SIGTERM, web and the worker finish what's in flight and exit.
