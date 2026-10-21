# agent.cloud starter: Python

A small, complete app to grow from. It opens on a welcome page that says truthfully where it runs and what's working, and its Notes example at `/notes` shows every piece together: people sign in with Google or an email link, keep notes, and get an email for each note. It's built on FastAPI, psycopg 3 and uv, with a React UI. It covers everything an agent.cloud app needs: sign-in, a worker with a job queue, email, migrations, checks and observability. It passes the [starter spec](https://github.com/summationai/agc-starters/blob/main/SPEC.md).

## Run it

```sh
agc init --stack python --name <what-it-does>   # in an empty folder: copies this, creates the app
uv sync && npm ci                                # once, and after a dependency changes
agc up --detach                                  # your mirror: http://localhost:<port>, reloading on save
agc check && agc ship
```

You need uv and Node 24 (for the UI). `agc up` doesn't install dependencies: run `uv sync && npm ci` first.

## Layout

The server is `app/main.py` (routes), `auth.py` (sign-in), `worker.py` (jobs) and `db.py`. The UI is in `web/src/`, the same as the TypeScript starter's: the welcome page in `App.tsx` (its facts come from `app/welcome.py`, `GET /api/welcome`) and the Notes example in `Notes.tsx`. Both are yours to replace. Schema changes go in `migrations/`, and the checks in `agentcloud.toml`. AGENTS.md says how to add a route, a table or a job.
