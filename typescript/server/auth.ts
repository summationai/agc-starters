// Sign-in through agent.cloud: Google or an email link, no passwords (docs: Sign-in in AGENTS.md).
//   GET  /auth/sign-in    a fresh state in a short cookie, then off to $AGC_AUTH_URL/authorize
//   GET  /auth/callback   check state FIRST, then trade the code (once, within a minute) for the person
//   POST /auth/sign-out   end this session
// Sessions are rows in the database (only a hash of the token is stored) and last a day.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { pool } from './db.ts';
import { onMirror, required } from './env.ts';
import { log } from './log.ts';

const { AGC_AUTH_URL, AGC_AUTH_TOKEN } = required('AGC_AUTH_URL', 'AGC_AUTH_TOKEN');
// __Host- cookies outside a mirror: apps share the agent.cloud site, and only this app's own host can set one, so a
// neighbour app can't plant a session or a sign-in state here. On a mirror (plain http) the prefix isn't allowed.
const STATE = onMirror ? 'auth_state' : '__Host-auth_state';
const SESSION = onMirror ? 'session' : '__Host-session';
const RETURN = onMirror ? 'auth_return' : '__Host-auth_return';
// AUTH-1: where to land after signing in: a path on this app only, never another site. `//evil.test` is a host, and a
// browser drops tabs and newlines from a URL, so `/<tab>/evil.test` is one too: refuse control characters and
// backslashes, then keep only what resolves on this app's own origin.
const local = (path: string | undefined) => {
  if (!path || !path.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(path)) return '/';
  const url = new URL(path, 'https://app.invalid');
  return url.origin === 'https://app.invalid' ? url.pathname + url.search + url.hash : '/';
};
const DAY = 86_400;

export interface User { id: string; email: string | null; name: string | null }
export type Env = { Variables: { user: User | null } };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
// Byte lengths, not string lengths: timingSafeEqual throws on unequal buffers, and 'é' is one character but two bytes.
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const cookie = { httpOnly: true, sameSite: 'Lax', secure: !onMirror, path: '/' } as const;

// AUTH-5: on a target with its own sign-in ([auth] provider = "edge"), the target's gate signs people in before a request
// reaches this app and says who it is in two headers; the app trusts them (its pods are reachable only through the gate)
// and keeps no session of its own. A user's id is fixed by their email. On a mirror, agent.cloud's web proxy sets the
// headers to a test identity; it never sets AGC_EDGE_DEV_USER, which stands in only where you set it yourself.
const EDGE = process.env.AGC_AUTH_PROVIDER === 'edge';
const DEV_USER = process.env.AGC_EDGE_DEV_USER ?? '';
const idOf = (email: string) => { const h = createHash('sha256').update(`agc-edge:${email}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
async function edgeUser(c: Context<Env>): Promise<User | null> {
  const email = (c.req.header('x-agc-user-email') ?? DEV_USER).trim().toLowerCase();
  if (!email) return null;
  const name = (c.req.header('x-agc-user-name') ?? '').trim() || null;
  const id = idOf(email);
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = coalesce(EXCLUDED.name, users.name), last_seen_at = now()`, [id, email, name]);
  return { id, email, name };
}

// Who's signed in, for every request: their session cookie, if it's live.
export const session: MiddlewareHandler<Env> = async (c, next) => {
  if (EDGE) {
    c.set('user', await edgeUser(c));
    return next();
  }
  const token = getCookie(c, SESSION);
  c.set('user', null);
  if (token) {
    const { rows } = await pool.query<User>(
      'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [hash(token)]);
    c.set('user', rows[0] ?? null);
  }
  await next();
};

export function signIn(app: Hono<Env>) {
  app.get('/auth/sign-in', (c) => {
    if (EDGE) return c.redirect('/'); // AUTH-5: the target's gate already signed them in
    const state = randomBytes(24).toString('base64url');
    setCookie(c, STATE, state, { ...cookie, maxAge: 600 });
    setCookie(c, RETURN, local(c.req.query('return_to')), { ...cookie, maxAge: 600 });
    return c.redirect(`${AGC_AUTH_URL}/authorize?state=${state}`);
  });

  app.get('/auth/callback', async (c) => {
    // State first: it's what stops someone else's code from signing this person in to the wrong account.
    const expected = getCookie(c, STATE) ?? '';
    const state = c.req.query('state') ?? '';
    const back = local(getCookie(c, RETURN));
    deleteCookie(c, STATE, { path: '/', secure: !onMirror });
    deleteCookie(c, RETURN, { path: '/', secure: !onMirror });
    if (!expected || !same(state, expected)) return c.text('Sign-in expired. Try again.', 400);
    const res = await fetch(`${AGC_AUTH_URL}/token`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${AGC_AUTH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: c.req.query('code') ?? '' }),
    });
    if (!res.ok) {
      log.warn('sign-in code refused', { status: res.status });
      return c.text('Sign-in failed. Try again.', 400);
    }
    const { user } = (await res.json()) as { user: User };
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET email = coalesce(EXCLUDED.email, users.email), name = coalesce(EXCLUDED.name, users.name), last_seen_at = now()`,
      [user.id, user.email, user.name]);
    const token = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [hash(token), user.id]);
    setCookie(c, SESSION, token, { ...cookie, maxAge: DAY });
    log.info('signed in', { user: user.id });
    return c.redirect(back);
  });

  app.post('/auth/sign-out', async (c: Context<Env>) => {
    if (EDGE) return c.json({ ok: true }); // AUTH-5: signing out is the target's sign-in's, not this app's
    const token = getCookie(c, SESSION);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
    deleteCookie(c, SESSION, { path: '/', secure: !onMirror });
    return c.json({ ok: true });
  });
}
