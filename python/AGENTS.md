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
- Uvicorn binds `0.0.0.0`, never its `127.0.0.1` default. It logs JSON, with no access log (agent.cloud's router keeps one).
- Sign-in checks `state` before trading the code. Sessions last a day. Cookies are `__Host-` cookies outside a mirror: apps share the agent.cloud site, and the prefix stops a neighbour app from planting one. Any cookie you add keeps that rule (`secure=True`, `path="/"`, no `domain`).
- On SIGTERM, web and the worker finish what's in flight and exit.
