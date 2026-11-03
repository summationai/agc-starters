// The fake platform: agent.cloud's test-mode sign-in and its email endpoint, as an app sees them on a mirror or in a
// rehearsal (agent-cloud packages/control/src/app-signin.ts test routes, and src/email.ts). No dependencies, so it runs
// in a plain node:24-slim container: `node server.ts`.
//
//   GET  /auth/test/<t>/authorize?state=…[&as=…]   the test page, or straight back to the app with a code
//   POST /auth/test/<t>/token                     {code} + Bearer AGC_AUTH_TOKEN → { user }
//   GET  /auth/test/<t>/users/<uuid>              Bearer → { user }
//   GET  /auth/test/<t>/codes/<code>              Bearer → { traded }: how the state probe tells
//   POST /email/v1/messages                       {to, subject, text, key} + Bearer AGC_EMAIL_TOKEN; each key once
//   GET  /_fake/mail                              what was sent, for the suite (not part of agent.cloud)
//   GET  /_fake/rechecks                          each GET users/<uuid>: its id and x-agc-session-start (the same)
//   POST /_fake/users/<uuid>                      {status}: what GET users/<uuid> answers from now on (the same)
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PORT ?? 8099);
const TICKET = process.env.TICKET ?? 'conformance';
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? 'agca_conformance';
const EMAIL_TOKEN = process.env.EMAIL_TOKEN ?? 'agce_conformance';
const ORIGIN = process.env.ORIGIN ?? 'http://app.invalid'; // where codes go back to; flows use only the path
const CALLBACK = process.env.CALLBACK ?? '/auth/callback';

const STATE = /^[A-Za-z0-9._~-]{8,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,253}\.[^\s@<>,;"]{2,}$/;
const KEY = /^[A-Za-z0-9._:/-]{1,200}$/;

type User = { id: string; email: string | null; name: null; method: 'test'; test: true };
const codes = new Map<string, { user: User; expires: number; used: boolean }>(); // by the code's hash
const rechecks: { id: string; session_start: string | null; at: number }[] = [];
const answers = new Map<string, number>(); // user id → the status its recheck answers, when the suite set one
const mail = new Map<string, { key: string; to: string; subject: string; text: string; attempts: number; first_at: string }>();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

// The same identities agent.cloud's test sign-in gives: a uuid as is, an email as a stable uuid of its own.
function identity(as: string): User | null {
  if (UUID.test(as)) return { id: as, email: null, name: null, method: 'test', test: true };
  const email = as.trim().toLowerCase();
  if (!ADDRESS.test(email)) return null;
  const h = hash(`conformance|${email}`);
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { id, email, name: null, method: 'test', test: true };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const error = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { error: { code, message } });
const bearer = (req: IncomingMessage, token: string) => req.headers.authorization === `Bearer ${token}`;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('json')) {
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://platform');
  const auth = new RegExp(`^/auth/test/${TICKET}/(authorize|token|users/([^/]+)|codes/([^/]+))$`).exec(url.pathname);
  try {
    if (auth && auth[1] === 'authorize' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? '';
      if (!STATE.test(state)) return error(res, 400, 'auth.bad_state', 'state must be 8 to 200 characters of A-Z a-z 0-9 . _ ~ -');
      const as = url.searchParams.get('as');
      if (as === null) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><title>Test sign-in</title><form><input type="hidden" name="state" value="${state}"><input name="as" placeholder="anyone@example.test"><button>Sign in</button></form>`);
      }
      const user = identity(as);
      if (!user) return error(res, 400, 'auth.bad_identity', 'as is an email address or a user id');
      const code = randomBytes(32).toString('base64url');
      codes.set(hash(code), { user, expires: Date.now() + 60_000, used: false });
      res.writeHead(302, { location: `${ORIGIN}${CALLBACK}?${new URLSearchParams({ code, state })}` });
      return res.end();
    }
    if (auth && auth[1] === 'token' && req.method === 'POST') {
      if (!bearer(req, AUTH_TOKEN)) return error(res, 401, 'auth.token', 'That isn’t this app’s sign-in token.');
      const c = codes.get(hash(String((await body(req)).code ?? '')));
      if (!c || c.used || c.expires < Date.now()) return error(res, 400, 'auth.bad_code', 'That code is unknown, already used or expired.');
      c.used = true;
      return json(res, 200, { user: c.user });
    }
    if (auth && auth[2] && req.method === 'GET') {
      if (!bearer(req, AUTH_TOKEN)) return error(res, 401, 'auth.token', 'That isn’t this app’s sign-in token.');
      const start = req.headers['x-agc-session-start'];
      rechecks.push({ id: auth[2], session_start: typeof start === 'string' ? start : null, at: Date.now() });
      const answer = answers.get(auth[2]);
      if (answer === 404) return error(res, 404, 'auth.no_user', 'No one with that id can sign in to this app.');
      if (answer) return error(res, answer, 'fake.unavailable', 'The fake platform was told to fail this recheck.');
      return UUID.test(auth[2]) ? json(res, 200, { user: { id: auth[2], email: null, name: null, method: 'test', test: true } }) : error(res, 404, 'auth.no_user', 'That isn’t a user id.');
    }
    if (auth && auth[3] && req.method === 'GET') {
      if (!bearer(req, AUTH_TOKEN)) return error(res, 401, 'auth.token', 'That isn’t this app’s sign-in token.');
      const c = codes.get(hash(decodeURIComponent(auth[3])));
      return c ? json(res, 200, { traded: c.used }) : error(res, 404, 'auth.no_code', 'No such code.');
    }
    if (url.pathname === '/email/v1/messages' && req.method === 'POST') {
      if (!bearer(req, EMAIL_TOKEN)) return error(res, 401, 'email.auth', 'Not an agent.cloud email token.');
      const b = await body(req);
      const to = typeof b.to === 'string' ? b.to.trim().toLowerCase() : '';
      if (!ADDRESS.test(to)) return error(res, 400, 'email.bad_to', '`to` must be one email address.');
      if (typeof b.key !== 'string' || !KEY.test(b.key)) return error(res, 400, 'email.bad_key', '`key` is required: letters, digits and . _ : / -, at most 200.');
      if (typeof b.subject !== 'string' || !b.subject.trim() || b.subject.length > 300 || /[\x00-\x1f\x7f]/.test(b.subject)) return error(res, 400, 'email.bad_subject', '`subject` is required: one line, at most 300 characters.');
      if (typeof b.text !== 'string' || b.text.length > 50_000) return error(res, 400, 'email.bad_text', '`text` is required, at most 50,000 characters.');
      const seen = mail.get(b.key);
      if (seen) {
        seen.attempts++;
        return json(res, 200, { id: hash(b.key).slice(0, 16), status: 'duplicate', first: { status: 'captured', at: seen.first_at } });
      }
      mail.set(b.key, { key: b.key, to, subject: b.subject, text: b.text, attempts: 1, first_at: new Date().toISOString() });
      return json(res, 200, { id: hash(b.key).slice(0, 16), status: 'captured' });
    }
    if (url.pathname === '/_fake/mail' && req.method === 'GET') return json(res, 200, { messages: [...mail.values()] });
    if (url.pathname === '/_fake/rechecks' && req.method === 'GET') return json(res, 200, { rechecks });
    const answering = /^\/_fake\/users\/([^/]+)$/.exec(url.pathname);
    if (answering && UUID.test(answering[1]!) && req.method === 'POST') {
      answers.set(answering[1]!, Number((await body(req)).status));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/_fake/health') return json(res, 200, { ok: true });
    return error(res, 404, 'not_found', 'No such route on the fake platform.');
  } catch (e) {
    return error(res, 500, 'fake.error', (e as Error).message);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', msg: 'fake platform listening', port: PORT })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
