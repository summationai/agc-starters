// The app's routes: sign-in, the notes API, health, and agents over MCP. Shared by the production server (main.ts) and
// the dev server (dev.ts), which add the UI around it.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { signIn, session, type Env } from './auth.ts';
import { pool, tx } from './db.ts';
import { runNow } from './jobs.ts';
import { event, log } from './log.ts';
import { api, COOKIE_FREE, exclude, mcp } from './mcp/index.ts';
import { welcome } from './welcome.ts';

export const app = new Hono<Env>();

// Every response: no content sniffing; a page is never framed by another site.
app.use(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) c.header('Content-Security-Policy', "frame-ancestors 'none'");
});

// Changes need a JSON body. Apps on agent.cloud share a site, so a neighbour's page could post a plain form here with
// this app's cookies; a JSON body would need a CORS preflight, which this app never grants. OAuth's token and revoke
// requests are forms by their standard, and read no cookie: only the code, verifier or token they carry count.
// DOC-7: on an admin-looking path, a change that carries no credentials at all is refused 401 first, so a smoke flow's
// first step (no body, no headers) gets the refusal agent.cloud's review counts as proof, not this 415.
const ADMIN = /^\/(api\/)?(admin|internal|debug|_debug|manage|dashboard)(\/|$)/i;
app.use(async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  if (ADMIN.test(c.req.path) && !c.req.header('cookie') && !c.req.header('authorization') && !c.req.header('x-agc-user-email')) {
    return c.json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, 401);
  }
  if (!['/oauth/token', '/oauth/revoke'].includes(c.req.path) && !(c.req.header('content-type') ?? '').startsWith('application/json')) {
    return c.json({ error: { code: 'json_required', message: 'Send a JSON body (Content-Type: application/json).' } }, 415);
  }
  await next();
});

// SEC-6: a change comes from this app's own pages. A browser says where a request came from (Origin, or Sec-Fetch-Site
// when it sends no Origin), and agent.cloud isn't a public suffix, so a sibling app's page is "same-site" and its
// requests carry this app's cookies. Anything from another origin is refused; a request with neither header (an agent,
// curl, a server) isn't a browser and passes on to the session check.
app.use(async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  // An agent's own client may say where it runs (claude.ai does) on the paths that read no cookie (AMCP-2).
  if (COOKIE_FREE.includes(c.req.path)) return next();
  const origin = c.req.header('origin');
  const site = c.req.header('sec-fetch-site');
  let ours: boolean;
  if (origin) {
    try { ours = new URL(origin).host === c.req.header('host'); } catch { ours = false; } // "null" and garbage are not ours
  } else {
    ours = !site || site === 'same-origin' || site === 'none';
  }
  if (!ours) return c.json({ error: { code: 'cross_origin', message: 'Changes come from this app\u2019s own pages.' } }, 403);
  await next();
});

// Health answers as soon as the server can serve, without touching the database: agent.cloud asks every 2 seconds.
app.get('/api/health', (c) => c.json({ status: 'ok' }));
exclude('get', '/api/health', 'agent.cloud\u2019s health probe, not something a person does');

// The welcome page's facts (SPEC.md APP-8): public like the page, and goes when the welcome page does.
app.get('/api/welcome', async (c) => c.json(await welcome(process.env, c.req.header('x-agc-preview'))));
exclude('get', '/api/welcome', 'the starter\u2019s welcome page facts, which go with the welcome page');

// Only the API, sign-in and the agent pages look up the session: the UI's files never wait on the database.
for (const path of ['/api/*', '/auth/*', '/oauth/authorize', '/mcp/agents/*']) app.use(path, session);
signIn(app);
// SPEC.md AMCP-1 to AMCP-10: /mcp, its OAuth, and the /agents pages' API. Every route below that goes through api() is
// also a tool a person's own agent can call, as that person.
mcp(app);

const signedIn = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Sign in first.' });
  return user;
};

api(app, 'get', '/api/me', { summary: 'Who is signed in: their id, email and name.' }, (c) => c.json({ user: signedIn(c) }));

// Every route goes through api(): its body (json) and query are checked against their schemas before the handler sees
// them, and it's a tool for agents too. A body that doesn't fit answers 400 in this app's error shape, naming the first
// problem; one that isn't JSON at all, Hono answers 400 through onError below.
const NoteIn = z.object({ title: z.string().trim().min(1).max(200).describe('The note\u2019s title, 1 to 200 characters') });

api(app, 'get', '/api/notes', { summary: 'List your notes, newest first: up to 100, each with its id, title, when it was made, and the agent it came through, if any.' }, async (c) => {
  const user = signedIn(c);
  const { rows } = await pool.query('SELECT id, title, created_at, via FROM notes WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [user.id]);
  return c.json(rows);
});

api(app, 'post', '/api/notes', { summary: 'Add a note with a title. Each new note sends you an email. A title you already have is refused.', json: NoteIn }, async (c, { json: { title } }) => {
  const user = signedIn(c);
  try {
    // The note and the job that emails about it are saved together, or not at all. via: the agent, when one wrote it.
    const { note, job } = await tx(async (db) => {
      const { rows } = await db.query<{ id: string; title: string; created_at: string; via: string | null }>(
        'INSERT INTO notes (user_id, title, via) VALUES ($1, $2, $3) RETURNING id, title, created_at, via', [user.id, title, c.get('via')]);
      const queued = await db.query<{ id: string }>(`INSERT INTO jobs (kind, payload) VALUES ('note_email', $1) RETURNING id`, [{ note_id: rows[0]!.id }]);
      return { note: rows[0]!, job: queued.rows[0]!.id };
    });
    event('note.created', `note:${note.id}`, { related: [`user:${user.id}`] });
    // JOB-5: the email goes now, not at the worker's next poll; the answer doesn't wait for it, and the worker is the backstop.
    setImmediate(() => void runNow(job));
    return c.json(note, 201);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return c.json({ error: { code: 'duplicate', message: 'You already have a note with that title.' } }, 409);
    throw e;
  }
});

api(app, 'delete', '/api/notes/:id', { summary: 'Delete one of your notes, by its id. It can\u2019t be undone.' }, async (c) => {
  const user = signedIn(c);
  const id = c.req.param('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: { code: 'not_found', message: 'No such note.' } }, 404);
  const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, user.id]);
  if (!rowCount) return c.json({ error: { code: 'not_found', message: 'No such note.' } }, 404);
  event('note.deleted', `note:${id}`, { related: [`user:${user.id}`] });
  return c.json({ deleted: id });
});

// Only for agent.cloud's conformance suite: an error and a slow request, to prove logging and graceful shutdown.
exclude('get', '/api/debug/error', 'conformance only: a deliberate failure');
exclude('get', '/api/debug/slow', 'conformance only: a slow request');
if (process.env.AGENTCLOUD_CONFORMANCE === '1') {
  app.get('/api/debug/error', () => { throw new Error('a deliberate failure, for the conformance suite'); });
  app.get('/api/debug/slow', async (c) => {
    log.info('slow request started');
    await new Promise((r) => setTimeout(r, Math.min(Number(c.req.query('ms')) || 0, 10_000)));
    return c.json({ ok: true });
  });
}

app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'No such API route.' } }, 404));

app.onError((e, c) => {
  if (e instanceof HTTPException) return c.json({ error: { code: 'http', message: e.message } }, e.status);
  log.error('request failed', { method: c.req.method, path: c.req.routePath, error: e.message, stack: e.stack });
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});
