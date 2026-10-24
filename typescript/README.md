# agent.cloud starter: TypeScript

A small, complete app to grow from. It opens on a welcome page that says truthfully where it runs and what's working, and its Notes example at `/notes` shows every piece together: people sign in with Google or an email link, keep notes, and get an email for each note. It covers everything an agent.cloud app needs: sign-in, a worker with a job queue, email, migrations, checks and observability. It passes the [starter spec](https://github.com/summationai/agc-starters/blob/main/SPEC.md).

## Run it

```sh
agc init --stack typescript --name <what-it-does>   # in an empty folder: copies this, creates the app
npm ci                                               # once, and after a dependency changes
agc up --detach                                      # your mirror: http://localhost:<port>, reloading on save
agc check && agc ship
```

You only need Node 24. `agc up` doesn't install dependencies: run `npm ci` first.

## User uploads

[STORAGE.md](STORAGE.md) covers `signUpload` and `signDownload`, the authenticated `/api/uploads` example, and adoption by existing apps.
The helpers return browser URLs for GCS, S3, and the customer file gateway. Run `npm test` for their synthetic tests.

## Layout

The server is `server/app.ts` (routes), `auth.ts` (sign-in), `worker.ts` (jobs) and `db.ts`. The UI is in `web/src/`: the welcome page in `App.tsx` (its facts come from `server/welcome.ts`, `GET /api/welcome`) and the Notes example in `Notes.tsx`. Both are yours to replace. Schema changes go in `migrations/`, and the checks in `agentcloud.toml`. AGENTS.md says how to add a route, a table or a job.
