// HTTP the way a browser does it, for the CONF tests: a cookie jar, and a sign-in through the app's own routes and the
// fake platform's test mode (the same steps as agc's SIGN IN, packages/cli/src/checks.ts signInAs).
import type { Container, Env } from '../lib/env.ts';

export interface Res { status: number; headers: Headers; text: string; json: unknown; cookies: string[] }
export type Jar = Map<string, string>;

const keep = (res: Response, jar: Jar) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const at = pair!.indexOf('=');
    if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim());
  }
};
const cookieHeader = (jar: Jar): Record<string, string> => (jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {});

export async function req(env: Env, app: Container, jar: Jar, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await env.fetchFor(app)(`${env.base(app)}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { ...cookieHeader(jar), ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  keep(res, jar);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json, cookies: res.headers.getSetCookie() };
}

export interface SignIn { start: Res; callback: Res | null; problem?: string }

// Signs `who` in: GET /auth/sign-in, the fake platform's test page sends a code back, the app's callback finishes it.
export async function signIn(env: Env, app: Container, jar: Jar, who: string, state?: (s: string) => string, from = '/auth/sign-in'): Promise<SignIn> {
  const start = await req(env, app, jar, 'GET', from);
  const to = start.headers.get('location') ?? '';
  if (!to.startsWith(`${env.authUrl}/authorize?`)) return { start, callback: null, problem: `GET ${from} answered ${start.status}${to ? ` to ${to}` : ''}, not a redirect to $AGC_AUTH_URL/authorize` };
  const minted = await env.fetchFor(app)(`${to}&as=${encodeURIComponent(who)}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const back = minted.headers.get('location');
  if (!back) return { start, callback: null, problem: `the fake platform answered ${minted.status}` };
  const url = new URL(back);
  if (state) url.searchParams.set('state', state(url.searchParams.get('state') ?? ''));
  const callback = await req(env, app, jar, 'GET', `${url.pathname}${url.search}`);
  return { start, callback };
}

// A cookie's attributes, from its Set-Cookie line.
export function cookieAttrs(line: string) {
  const parts = line.split(';').map((p) => p.trim());
  const attrs = new Map(parts.slice(1).map((p) => {
    const at = p.indexOf('=');
    return at < 0 ? [p.toLowerCase(), ''] as const : [p.slice(0, at).toLowerCase(), p.slice(at + 1)] as const;
  }));
  const [name, value] = [parts[0]!.slice(0, parts[0]!.indexOf('=')), parts[0]!.slice(parts[0]!.indexOf('=') + 1)];
  const maxAge = attrs.has('max-age') ? Number(attrs.get('max-age')) : null;
  const expires = attrs.has('expires') ? (Date.parse(attrs.get('expires')!) - Date.now()) / 1000 : null;
  return {
    name, value, httpOnly: attrs.has('httponly'), secure: attrs.has('secure'), sameSite: (attrs.get('samesite') ?? '').toLowerCase(),
    path: attrs.get('path') ?? null, domain: attrs.get('domain') ?? null,
    lifetime: maxAge ?? expires, // seconds, or null for a session cookie
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
