// AMCP-2: the app is its own OAuth server for its /mcp, on its own sign-in: the canvas's (SUB-1 to SUB-4), unchanged in
// shape. A client's id is its own metadata, sealed; a consent request and a code are sealed too, and spent once.
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: /mcp, and who signs agents in for it
//   GET  /.well-known/oauth-authorization-server        RFC 8414: the endpoints below
//   POST /oauth/register     a public client (RFC 7591); at most 20 an hour from one address
//   GET  /oauth/authorize    signed in to the app, the person goes to /agents/consent, which asks /mcp/agents/consent
//   POST /oauth/token        code + S256 verifier → ten-minute access and rotating refresh tokens
//   POST /oauth/revoke       RFC 7009
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import type { Env, User } from '../auth.ts';
import { pool, tx } from '../db.ts';
import { log } from '../log.ts';
import { identityOf, type Subject } from './identity.ts';

export const ACCESS_SECONDS = 600;
export const GRANT_SECONDS = 30 * 86_400;
export type Scope = 'read' | 'act';
export const SCOPES: Record<Scope, string> = { read: 'mcp:read', act: 'mcp:read mcp:write' };

const KEY = createHmac('sha256', String(process.env.AGC_AUTH_TOKEN)).update('starter: agents over mcp').digest();
const sign = (kind: string, payload: string) => createHmac('sha256', KEY).update(`${kind}.${payload}`).digest('base64url');
const seal = (kind: string, v: object) => { const p = Buffer.from(JSON.stringify(v)).toString('base64url'); return `${kind}.${p}.${sign(kind, p)}`; };
export function open<T>(kind: string, sealed: unknown): T | null {
  const m = /^([a-z0-9]{3})\.([A-Za-z0-9_-]{10,6000})\.([A-Za-z0-9_-]{43})$/.exec(typeof sealed === 'string' ? sealed : '');
  if (!m || m[1] !== kind) return null;
  const a = Buffer.from(m[3]!), b = Buffer.from(sign(kind, m[2]!));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as T; } catch { return null; }
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
interface Client { r: string[]; n: string }
// si and sp: who said yes, by a stable identity (identity.ts, AMCP-7), carried from the consent page into the grant.
export interface ConsentRequest { n: string; a: string; u: string; si: string; sp: string; cl: string; r: string; ch: string; st: string | null; e: number }
interface Code { a: string; u: string; si: string; sp: string; cl: string; r: string; ch: string; e: number; n: string; s: Scope }
interface AccessToken { g: string; u: string; a: string; e: number }
export interface Grant { id: string; user_id: string; subject_iss: string; subject_id: string; client_id: string; client_name: string; scope: Scope; resource: string; created_at: Date; expires_at: Date; revoked_at: Date | null; checked_at: Date }

export const originOf = (c: Context) => { const host = c.req.header('host') || new URL(c.req.url).host; return `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}`; };
export const resourceOf = (c: Context) => `${originOf(c)}/mcp`;
export const challenge = (c: Context) => `Bearer resource_metadata="${originOf(c)}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`;

// Callbacks: native loopback clients, and the exact hosted callbacks proven on agent.cloud's staging. Names confer no trust.
export const CALLBACKS = ['https://claude.ai/api/mcp/auth_callback'];
export function redirectOk(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500 || /[\s#]/.test(uri)) return false;
  let u: URL; try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  return CALLBACKS.includes(uri) || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
}
export function sameRedirect(registered: string, actual: string) {
  if (!redirectOk(registered) || !redirectOk(actual)) return false;
  const a = new URL(registered), b = new URL(actual);
  if (a.protocol === 'http:' && b.protocol === 'http:') { a.port = ''; b.port = ''; return a.href === b.href; }
  return registered === actual;
}
export const named = (n: unknown) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 100) : '') || 'An unnamed client';
const whereTo = (u: unknown) => { try { const x = new URL(String(u)); return `${x.protocol}//${x.hostname}`; } catch { return 'unparseable'; } };
export const clientOf = (id: unknown) => open<Client>('mc1', id);
// The proxy nearest the app appends the caller's address last; anything before it, the caller wrote.
const addressOf = (c: Context) => (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop() ?? 'unknown';

type Query = Pick<pg.PoolClient, 'query'>;
export async function claimNonce(nonce: string, expires: number, db: Query = pool) {
  const r = await db.query('INSERT INTO mcp_nonces (nonce, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING nonce', [nonce, new Date(expires)]);
  return r.rows.length === 1;
}
const mint = (v: AccessToken) => { const p = Buffer.from(JSON.stringify(v)).toString('base64url'); return `ma1.${p}.${sign('ma1', p)}`; };
async function pair(db: Query, g: Grant) {
  const refresh = `mr1.${randomBytes(32).toString('base64url')}`;
  await db.query('INSERT INTO mcp_refresh (token_hash, grant_id) VALUES ($1, $2)', [hash(refresh), g.id]);
  const ttl = Math.min(ACCESS_SECONDS, Math.max(0, Math.floor((g.expires_at.getTime() - Date.now()) / 1000)));
  return { access_token: mint({ g: g.id, u: g.user_id, a: g.resource, e: Date.now() + ttl * 1000 }), token_type: 'Bearer', expires_in: ttl, refresh_token: refresh, scope: SCOPES[g.scope] };
}

// The grant behind a bearer token, while it's live, with its person.
export async function grantOf(bearer: string, resource: string): Promise<(Grant & { user: User }) | null> {
  const m = /^ma1\.([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{43})$/.exec(bearer);
  const t = m ? open<AccessToken>('ma1', bearer) : null;
  if (!t || t.e <= Date.now() || t.a !== resource) return null;
  const { rows: [g] } = await pool.query<Grant & { email: string | null; name: string | null; role: string | null }>(
    `SELECT g.*, u.email, u.name, u.role FROM mcp_grants g JOIN users u ON u.id = g.user_id
     WHERE g.id = $1 AND g.user_id = $2 AND g.resource = $3 AND g.revoked_at IS NULL AND g.expires_at > now()`, [t.g, t.u, resource]);
  return g ? { ...g, user: { id: g.user_id, email: g.email, name: g.name, role: g.role } } : null;
}

export function oauth(app: Hono<Env>) {
  app.use('/oauth/*', bodyLimit({ maxSize: 16 * 1024 }));
  const resource = (c: Context) => c.json({ resource: resourceOf(c), authorization_servers: [originOf(c)], scopes_supported: ['mcp:read', 'mcp:write'], bearer_methods_supported: ['header'] });
  app.get('/.well-known/oauth-protected-resource', resource);
  app.get('/.well-known/oauth-protected-resource/mcp', resource);
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const o = originOf(c);
    return c.json({ issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`, revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp:read', 'mcp:write'], authorization_response_iss_parameter_supported: true });
  });

  app.post('/oauth/register', async (c) => {
    const address = hash(`register:${addressOf(c)}`);
    const { rows: [n] } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_registrations WHERE address = $1 AND at > now() - interval '1 hour'", [address]);
    if (n!.n >= 20) return c.json({ error: 'too_many_requests', error_description: 'Too many registrations from this address. Try again in an hour.' }, 429, { 'retry-after': '3600' });
    const m = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const uris = m?.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(redirectOk)) {
      log.warn('oauth register refused', { reason: 'redirect', redirects: Array.isArray(uris) ? uris.slice(0, 5).map(whereTo) : typeof uris, client: named(m?.client_name) });
      return c.json({ error: 'invalid_redirect_uri', error_description: `Use 1 to 5 loopback HTTP callbacks, or exactly one of: ${CALLBACKS.join(', ')}.` }, 400);
    }
    if (m!.token_endpoint_auth_method !== undefined && m!.token_endpoint_auth_method !== 'none') return c.json({ error: 'invalid_client_metadata', error_description: 'Only public clients (token_endpoint_auth_method none).' }, 400);
    if ((m!.grant_types !== undefined && (!Array.isArray(m!.grant_types) || !m!.grant_types.every((x) => ['authorization_code', 'refresh_token'].includes(String(x)))))
      || (m!.response_types !== undefined && (!Array.isArray(m!.response_types) || !m!.response_types.every((x) => x === 'code')))) return c.json({ error: 'invalid_client_metadata', error_description: 'Use authorization_code/refresh_token grants and the code response type.' }, 400);
    await pool.query("INSERT INTO mcp_registrations (address) VALUES ($1)", [address]);
    await pool.query("DELETE FROM mcp_registrations WHERE at < now() - interval '1 day'");
    const client: Client = { r: uris as string[], n: named(m!.client_name) };
    log.info('agent client registered', { client: client.n, redirects: client.r.map(whereTo) });
    return c.json({ client_id: seal('mc1', client), client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: client.r, client_name: client.n,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'mcp:read mcp:write' }, 201);
  });

  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query(), client = clientOf(q.client_id);
    const refuse = (message: string) => c.text(`${message} Start again from your agent.`, 400);
    // Until the client and its callback match, nothing goes back to a URI anyone could have written.
    if (!client) return refuse('The agent that sent you here isn’t registered with this app.');
    if (!client.r.some((uri) => sameRedirect(uri, q.redirect_uri ?? '')) || !redirectOk(q.redirect_uri)) return refuse('The agent asked to come back to an address it didn’t register.');
    const back = (error: string) => c.redirect(`${q.redirect_uri}${q.redirect_uri!.includes('?') ? '&' : '?'}${new URLSearchParams({ error, ...(q.state ? { state: q.state } : {}), iss: originOf(c) })}`);
    if (q.response_type !== 'code') return back('unsupported_response_type');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? '') || (q.state ?? '').length > 500) return back('invalid_request');
    if (q.resource && q.resource.replace(/\/$/, '') !== resourceOf(c)) return back('invalid_target');
    if (q.scope && q.scope.split(' ').some((s) => s && !['mcp:read', 'mcp:write'].includes(s))) return back('invalid_scope');
    const user = c.get('user');
    if (!user) return c.redirect(`/auth/sign-in?return_to=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`);
    // AMCP-7: a grant names its person by a stable identity; a sign-in that can't give one can't grant.
    const who = await identityOf(c, user);
    if (!who.ok) return c.text(who.message, 403);
    const request = seal('mq1', { n: randomUUID(), a: resourceOf(c), u: user.id, si: who.subject.iss, sp: who.subject.id, cl: q.client_id!, r: q.redirect_uri!, ch: q.code_challenge!, st: q.state ?? null, e: Date.now() + 10 * 60_000 } satisfies ConsentRequest);
    return c.redirect(`/agents/consent?request=${encodeURIComponent(request)}`);
  });

  app.post('/oauth/token', async (c) => {
    const type = c.req.header('content-type') ?? '';
    const raw = type.startsWith('application/json') ? await c.req.json().catch(() => null) : await c.req.parseBody().catch(() => null);
    const f = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const fail = (error: string, error_description: string) => c.json({ error, error_description }, 400, { 'cache-control': 'no-store' });
    const resource = resourceOf(c);
    if (f.resource !== undefined && f.resource !== resource) return fail('invalid_target', 'The resource must be this app’s MCP URL.');
    if (f.grant_type === 'refresh_token') {
      const result = await refreshGrant(String(f.refresh_token ?? ''), String(f.client_id ?? ''), resource);
      return result ? c.json(result, 200, { 'cache-control': 'no-store' }) : fail('invalid_grant', 'This connection expired, was revoked, or its refresh token was already used. Connect again.');
    }
    if (f.grant_type !== 'authorization_code') return fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    const code = open<Code>('mo1', f.code);
    if (!code || code.e < Date.now()) return fail('invalid_grant', 'The code is wrong, used or expired. Connect again.');
    const verifier = typeof f.code_verifier === 'string' ? f.code_verifier : '';
    const client = clientOf(code.cl);
    const valid = Boolean(client && f.client_id === code.cl && f.redirect_uri === code.r && code.a === resource
      && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && createHash('sha256').update(verifier).digest('base64url') === code.ch);
    const result = await tx(async (db) => {
      if (!(await claimNonce(code.n, code.e, db)) || !valid) return null;
      const { rows: [g] } = await db.query<Grant>(`INSERT INTO mcp_grants (id, user_id, subject_iss, subject_id, client_id, client_name, scope, resource, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [randomUUID(), code.u, code.si, code.sp, code.cl, client!.n, code.s, resource, new Date(Date.now() + GRANT_SECONDS * 1000)]);
      await db.query("DELETE FROM mcp_nonces WHERE expires_at < now() - interval '1 day'");
      await db.query("DELETE FROM mcp_grants WHERE expires_at < now() - interval '30 days'");
      log.info('agent connected', { user: code.u, client: client!.n, scope: code.s });
      return pair(db, g!);
    });
    return result ? c.json(result, 200, { 'cache-control': 'no-store' }) : fail('invalid_grant', 'The code was used or doesn’t match this client, resource, callback or verifier. Connect again.');
  });

  app.post('/oauth/revoke', async (c) => {
    const f = await c.req.parseBody().catch(() => ({})) as Record<string, unknown>;
    const token = String(f.token ?? ''), client = String(f.client_id ?? ''), resource = resourceOf(c);
    const t = open<AccessToken>('ma1', token);
    if (t) await pool.query('UPDATE mcp_grants SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND resource = $2 AND client_id = $3', [t.g, resource, client]);
    else await pool.query(`UPDATE mcp_grants SET revoked_at = coalesce(revoked_at, now()) WHERE id IN
      (SELECT grant_id FROM mcp_refresh WHERE token_hash = $1) AND client_id = $2 AND resource = $3`, [hash(token), client, resource]);
    return c.body(null, 200, { 'cache-control': 'no-store' });
  });
}

// The consent page's question and answer (/agents/consent, through /mcp/agents/consent).
export function consentOf(sealed: unknown, user: User, subject: Subject, resource: string): ConsentRequest | null {
  const q = open<ConsentRequest>('mq1', sealed);
  return q && q.u === user.id && q.si === subject.iss && q.sp === subject.id && q.e >= Date.now() && q.a === resource ? q : null;
}
export async function decide(q: ConsentRequest, allow: boolean, scope: Scope, origin: string): Promise<string | null> {
  if (!(await claimNonce(q.n, q.e))) return null;
  const params = new URLSearchParams(allow ? { code: seal('mo1', { a: q.a, u: q.u, si: q.si, sp: q.sp, cl: q.cl, r: q.r, ch: q.ch, e: Date.now() + 60_000, n: randomUUID(), s: scope } satisfies Code) } : { error: 'access_denied' });
  if (q.st) params.set('state', q.st);
  params.set('iss', origin);
  return `${q.r}${q.r.includes('?') ? '&' : '?'}${params}`;
}

async function refreshGrant(token: string, client: string, resource: string) {
  return tx(async (db) => {
    const { rows: [g] } = await db.query<Grant & { used_at: Date | null }>(`SELECT g.*, r.used_at FROM mcp_refresh r
      JOIN mcp_grants g ON g.id = r.grant_id WHERE r.token_hash = $1 FOR UPDATE OF g, r`, [hash(token)]);
    if (!g || g.client_id !== client || g.resource !== resource || g.revoked_at || g.expires_at.getTime() <= Date.now()) return null;
    if (g.used_at) { // a refresh token used twice: someone else has it, so the whole connection ends
      await db.query('UPDATE mcp_grants SET revoked_at = now() WHERE id = $1', [g.id]);
      return null;
    }
    await db.query('UPDATE mcp_refresh SET used_at = now() WHERE token_hash = $1', [hash(token)]);
    return pair(db, g);
  });
}
