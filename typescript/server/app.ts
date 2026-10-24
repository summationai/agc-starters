// The app's routes: sign-in, the notes API, health. Shared by the production server (main.ts) and the dev server
// (dev.ts), which add the UI around it.
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { signIn, session, type Env } from './auth.ts';
import { pool, tx } from './db.ts';
import { event, log } from './log.ts';
import { signDownload, signUpload } from './storage.ts';
import { welcome } from './welcome.ts';

export const app = new Hono<Env>();

// Every response: no content sniffing; a page is never framed by another site.
app.use(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) c.header('Content-Security-Policy', "frame-ancestors 'none'");
});

// Changes need a JSON body. Apps on agent.cloud share a site, so a neighbour's page could post a plain form here with
// this app's cookies; a JSON body would need a CORS preflight, which this app never grants.
app.use(async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !(c.req.header('content-type') ?? '').startsWith('application/json')) {
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

// The welcome page's facts (SPEC.md APP-8): public like the page, and goes when the welcome page does.
app.get('/api/welcome', async (c) => c.json(await welcome()));

// Only the API and sign-in look up the session: the UI's files never wait on the database.
app.use('/api/*', session);
app.use('/auth/*', session);
signIn(app);

const signedIn = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Sign in first.' });
  return user;
};

app.get('/api/me', (c) => c.json({ user: signedIn(c) }));

// Every body is checked against its schema before the handler sees it. One that doesn't fit answers 400 in this app's
// error shape, naming the first problem; one that isn't JSON at all, Hono answers 400 through onError below.
const body = <T extends z.ZodType>(schema: T) => zValidator('json', schema, (result, c) => {
  if (!result.success) {
    const issue = result.error.issues[0];
    return c.json({ error: { code: 'bad_request', message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'The request isn\u2019t valid.' } }, 400);
  }
});

const NoteIn = z.object({ title: z.string().trim().min(1).max(200) });

// STOR-8: Postgres keeps ownership and a relative key. File bytes go straight from the browser to storage.
const UploadIn = z.object({ name: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f/\\]+$/).refine((name) => !name.includes('${')) });
app.post('/api/uploads', body(UploadIn), async (c) => {
  const user = signedIn(c);
  const post = await signUpload(`${user.id}/${c.req.valid('json').name}`);
  await pool.query('INSERT INTO uploads (user_id, storage_key) VALUES ($1, $2)', [user.id, post.key]);
  c.header('Cache-Control', 'no-store');
  return c.json(post, 201);
});
app.get('/api/uploads/download', async (c) => {
  const user = signedIn(c);
  c.header('Cache-Control', 'no-store');
  const key = c.req.query('key') ?? '';
  const { rows } = await pool.query<{ storage_key: string }>(
    'SELECT storage_key FROM uploads WHERE storage_key = $1 AND user_id = $2', [key, user.id]);
  if (!rows[0]) return c.json({ error: { code: 'not_found', message: 'There’s no such file.' } }, 404);
  const result = await signDownload(rows[0].storage_key, () => true);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ url: result.url });
});

app.get('/api/notes', async (c) => {
  const user = signedIn(c);
  const { rows } = await pool.query('SELECT id, title, created_at FROM notes WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [user.id]);
  return c.json(rows);
});

app.post('/api/notes', body(NoteIn), async (c) => {
  const user = signedIn(c);
  const { title } = c.req.valid('json');
  try {
    // The note and the job that emails about it are saved together, or not at all.
    const note = await tx(async (db) => {
      const { rows } = await db.query<{ id: string; title: string; created_at: string }>(
        'INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at', [user.id, title]);
      await db.query(`INSERT INTO jobs (kind, payload) VALUES ('note_email', $1)`, [{ note_id: rows[0]!.id }]);
      return rows[0]!;
    });
    event('note.created', `note:${note.id}`, { related: [`user:${user.id}`] });
    return c.json(note, 201);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return c.json({ error: { code: 'duplicate', message: 'You already have a note with that title.' } }, 409);
    throw e;
  }
});

// Only for agent.cloud's conformance suite: an error and a slow request, to prove logging and graceful shutdown.
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
