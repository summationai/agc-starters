# agent.cloud starters

App starters for [agent.cloud](https://agent.cloud), the spec every starter follows, and the suite that proves it.

| | |
|---|---|
| [SPEC.md](SPEC.md) | The contract: 66 rules any starter must meet, in any language, each with the test that proves it |
| [typescript/](typescript/) | React + Vite UI, one Node 24 server (Hono), a worker, Postgres in plain SQL |
| [python/](python/) | The same UI; FastAPI on uvicorn, psycopg 3, uv, a worker |
| [conformance/](conformance/) | The linter and the black-box suite: builds a stack with agent.cloud's default image and runs it against a fake platform |

Start an app from one with `agc init --stack typescript` or `agc init --stack python`, in an empty folder.

Each starter is the same small app: a welcome page at `/` that says truthfully where the app runs and what's working, and a Notes example at `/notes` where people sign in with Google or an email link, keep notes, and get an email for each note. It has sign-in, a job queue, email, migrations, checks, observability, graceful shutdown, auto-reload on a mirror, and an idle worker that lets the database sleep. Grow from there.

Adding a stack (Rust, Java…)? See [CONTRIBUTING.md](CONTRIBUTING.md).
