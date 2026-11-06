// AMCP-7: who a grant is, by a stable identity, never by an email alone.
//   On agent.cloud's sign-in, the app user's id: { iss: 'agent.cloud', id: <users.id> }.
//   On edge sign-in, the iss and provider_id claims of the gate's signed x-agc-identity (agent.cloud's EDGE-15): an ES256
//   JWT whose sub is the email, so sub never names a grant. Only agent.cloud's own issuer is trusted, verified against its
//   published keys; a customer's own provider can't grant yet, and neither can an assertion without provider_id.
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import type { Context } from 'hono';
import type { Env, User } from '../auth.ts';
import { APP_NAME } from './app-name.ts';

export interface Subject { iss: string; id: string }
export type Identity = { ok: true; subject: Subject } | { ok: false; message: string };
export const AGENT_CLOUD = 'agent.cloud';
const EDGE = process.env.AGC_AUTH_PROVIDER === 'edge';

// agent.cloud's own broker issuer, https://auth.<control host> (EDGE-15), or the one agent.cloud names for this app.
export const ownIssuer = () => process.env.AGC_IDENTITY_ISSUER || `https://auth.${new URL(String(process.env.AGC_AUTH_URL)).host}`;

const keys = new Map<string, { at: number; keys: JsonWebKey[] }>(); // issuer → its published keys, for at most a minute
async function keysOf(iss: string): Promise<JsonWebKey[]> {
  const hit = keys.get(iss);
  if (hit && Date.now() - hit.at < 60_000) return hit.keys;
  const res = await fetch(`${iss}/.well-known/jwks.json`, { redirect: 'manual', signal: AbortSignal.timeout(3_000) });
  const j = res.ok ? await res.json() as { keys?: unknown } : null;
  const found = Array.isArray(j?.keys) ? (j!.keys as JsonWebKey[]) : [];
  keys.set(iss, { at: Date.now(), keys: found });
  return found;
}

const part = (s: string | undefined) => { try { return JSON.parse(Buffer.from(s ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return null; } };
const NOT_YET = 'Agents aren’t available on this sign-in yet.';
const UNCONFIRMED = 'We couldn’t confirm who you are from your sign-in, so no agent can connect for you. Reload the page and try again.';

// The person behind this request, by the gate's signed assertion: who signed them in, and that provider's id for them.
export async function edgeIdentity(c: Context<Env>): Promise<Identity> {
  const token = c.req.header('x-agc-identity') ?? '';
  const [h, p, s, extra] = token.split('.');
  const header = part(h), claims = part(p);
  if (!header || !claims || !s || extra !== undefined || header.alg !== 'ES256' || typeof header.kid !== 'string') return { ok: false, message: UNCONFIRMED };
  if (claims.iss !== ownIssuer()) return { ok: false, message: NOT_YET }; // a customer's own provider (agent.cloud's AMCP-12)
  let valid = false;
  try {
    const jwk = (await keysOf(ownIssuer())).find((k) => (k as { kid?: unknown }).kid === header.kid && k.kty === 'EC' && k.crv === 'P-256');
    valid = Boolean(jwk && verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  } catch { valid = false; }
  const now = Date.now() / 1000;
  const email = (c.req.header('x-agc-user-email') ?? '').trim().toLowerCase();
  if (!valid || claims.aud !== APP_NAME || typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.iat > now + 60
    || claims.presence !== 'session' || claims.sub !== email) return { ok: false, message: UNCONFIRMED };
  if (typeof claims.provider_id !== 'string' || !claims.provider_id) return { ok: false, message: 'Your sign-in doesn’t give agent.cloud a stable id for you, so agents can’t connect here yet.' };
  return { ok: true, subject: { iss: claims.iss, id: claims.provider_id } };
}

// Who a signed-in person is, for a grant: on agent.cloud's sign-in, their app user id; on edge sign-in, the assertion.
export async function identityOf(c: Context<Env>, user: User): Promise<Identity> {
  return EDGE ? edgeIdentity(c) : { ok: true, subject: { iss: AGENT_CLOUD, id: user.id } };
}
