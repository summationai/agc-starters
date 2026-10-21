# This app: the TypeScript stack

A React UI (Vite) and one Node 24 server (Hono) that serves the UI and the API on `$PORT`, a worker for background jobs, and Postgres through plain SQL. Node runs the server's TypeScript directly: there's no server build step.

## Commands

```text
npm ci               install dependencies (once, and after package-lock.json changes)
agc up --detach      the app on your mirror: UI and API on one port, reloading on save
npm run typecheck    tsc over the server and the UI
npm run build        the UI into web/dist (agent.cloud runs this when it builds the image)
```

## Where things are

```text
server/app.ts       every route: /api/*, health, the JSON-only rule for changes, error handling
server/auth.ts      sign-in through agent.cloud, and sessions
server/worker.ts    the job loop, and one handler per job kind
server/db.ts        the pool, and tx() for writes that belong together
server/log.ts       JSON logs, and event() for workflow steps
server/main.ts      production: the API plus web/dist          server/dev.ts  development: the API plus Vite
server/welcome.ts   GET /api/welcome: the welcome page's facts; remove it with the welcome page
web/src/            the UI: App.tsx (the welcome page at /), Notes.tsx (the example at /notes), api.ts
migrations/         schema changes, as plain SQL (agc migration new <slug>)
seed.sql            a demo person and three notes for a mirror that starts empty (agc up); never runs in production
```

## How to add things

- **An API route:** in `server/app.ts`, under `/api/`. Call `signedIn(c)` for anything personal. Changes take a JSON body (any other body gets 415), checked by a schema (below).
- **A table or column:** `agc migration new <slug>`, then plain SQL in the new file, then `agc migrate`. Key things on `uuid`. Use `CHECK (status IN (…))` for fixed sets of values, so mirrors show them. Never change the schema from code.
- **A background job:** insert into `jobs` inside the same `tx()` as the write it belongs to, and add a handler in `server/worker.ts`. The worker polls every 10 s while busy and backs off to 10 minutes when idle, so the database can sleep: don't make a person wait on a job. A job can run twice, so make it safe to: emails carry a `key` that names the message for good, like `note-<id>/created`.
- **A workflow step:** `event('order.paid', 'order:<id>', { related: ['user:<id>'] })`. Ids only, never emails or names.
- **Logging:** `log.info('what happened', { ids })`. Never log emails, names, tokens or request bodies.

## Validate every request body

Validate every request body with a schema: it's how a route takes input here. Existing routes and other validators are fine, and nothing in agent.cloud checks for it. The notes route shows the pattern: a Zod 4 schema checks the body before the handler runs, and the handler reads the parsed value, typed, with no cast.

```ts
const NoteIn = z.object({ title: z.string().trim().min(1).max(200) });
app.post('/api/notes', body(NoteIn), async (c) => {
  const { title } = c.req.valid('json');
```

- `body()` in `server/app.ts` answers 400 `{"error": {"code": "bad_request", "message": "title: …"}}` for a body that doesn't fit. `z.infer<typeof NoteIn>` is its type, if you need one.
- This is Zod 4, and much example code is Zod 3. Write `z.email()`, `z.url()`, `z.uuid()` and `z.iso.datetime()`, not `z.string().email()`; give a custom message as `{ error: '…' }`, not `message` or `errorMap`.
- `z.object` drops unknown fields; `z.strictObject` refuses them.
- The environment (`server/env.ts`) and database rows (CHECK constraints) aren't request bodies: leave them as they are.

## Rules this stack keeps

- Health (`/api/health`) never touches the database. agent.cloud asks it every 2 seconds.
- Sign-in checks `state` before trading the code. Sessions last a day. Cookies are `__Host-` cookies outside a mirror: apps share the agent.cloud site, and the prefix stops a neighbour app from planting one. Any cookie you add keeps that rule (`Secure`, `Path=/`, no `Domain`).
- On SIGTERM, web and the worker finish what's in flight and exit.
- Nothing writes inside the app's folder. Use `/tmp`, or better, the database.
