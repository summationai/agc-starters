// SPEC.md AMCP-6, AMCP-7 on edge sign-in: a grant names its person by the gate's signed x-agc-identity, its issuer and
// provider_id (agent.cloud's EDGE-15), never the email; it's rechecked by them; and the owner is the gate's own role on
// the request. Its own process, with AGC_AUTH_PROVIDER=edge, a throwaway local Postgres (skipped without one), and a fake
// agent.cloud that publishes the gate's key and answers rechecks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, test } from 'node:test';

const db = `starter_mcp_edge_${process.pid}`;
const pg = spawnSync('createdb', [db], { encoding: 'utf8' }).status === 0;
if (pg) for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
  const r = spawnSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', new URL(`../migrations/${file}`, import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

// The fake agent.cloud: the gate's public key, and the answer to each recheck (AMCP-15's GET /people).
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const asked: string[] = [];
let people = 200;
const fake = createServer((req, res) => {
  if (req.url === '/.well-known/jwks.json') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'ES256' }] }));
  if (req.url?.startsWith('/people?')) { asked.push(req.url); return void res.writeHead(people, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { role: 'member' } })); }
  res.writeHead(500).end();
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
const ISS = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

process.env.DATABASE_URL = pg ? `postgres://localhost/${db}` : 'postgres://test@127.0.0.1:9/test';
process.env.AGC_AUTH_PROVIDER = 'edge';
process.env.AGC_AUTH_URL = ISS;
process.env.AGC_IDENTITY_ISSUER = ISS;
process.env.AGC_AUTH_TOKEN ||= 'test-token-not-a-secret';
const { app } = await import('./app.ts');
const { pool } = await import('./db.ts');
after(async () => { await pool.end(); fake.close(); if (pg) spawnSync('dropdb', ['--if-exists', db]); });
const skip = !pg && 'no local Postgres (createdb failed)';

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
function assertion(email: string, claims: Record<string, unknown> = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: 'k1', typ: 'JWT' });
  const body = b64({ iss: ISS, sub: email, name: '', aud: 'starter', presence: 'session', jti: randomUUID(), iat: now, exp: now + 300, ...claims });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
// What the gate puts on a signed-in person's request: who they are, signed, and their role.
const gate = (email: string, providerId: string | undefined, role = 'member', claims: Record<string, unknown> = {}) => ({
  host: 'localhost', 'x-agc-user-email': email, 'x-agc-user-role': role,
  'x-agc-identity': assertion(email, { ...(providerId === undefined ? {} : { provider_id: providerId }), ...claims }),
});
const same = { 'content-type': 'application/json', origin: 'http://localhost' };
const rpc = (token: string, method: string, params?: unknown) => app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

async function authorize(headers: Record<string, string>) {
  const reg = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:43210/cb'], client_name: 'Claude' }) });
  const { client_id } = await reg.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://127.0.0.1:43210/cb', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's' });
  return { res: await app.request(`/oauth/authorize?${q}`, { headers }), client_id, verifier };
}
async function connect(headers: Record<string, string>) {
  const { res, client_id, verifier } = await authorize(headers);
  assert.equal(res.status, 302, await res.clone().text());
  const request = new URL(res.headers.get('location')!, 'http://localhost').searchParams.get('request')!;
  const decided = await app.request('/mcp/agents/consent', { method: 'POST', headers: { ...headers, ...same }, body: JSON.stringify({ request, allow: true, scope: 'act' }) });
  assert.equal(decided.status, 200, await decided.clone().text());
  const code = new URL((await decided.json() as { redirect: string }).redirect).searchParams.get('code')!;
  const tok = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'localhost' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, redirect_uri: 'http://127.0.0.1:43210/cb', code_verifier: verifier }) });
  assert.equal(tok.status, 200);
  return (await tok.json() as { access_token: string }).access_token;
}

test('AMCP-7: the same email with a different provider_id is a different person', { skip }, async () => {
  const a = gate('sam@example.test', 'provider-a');
  const b = gate('sam@example.test', 'provider-b');
  const token = await connect(a);
  const { rows: [g] } = await pool.query<{ id: string; subject_iss: string; subject_id: string }>('SELECT id, subject_iss, subject_id FROM mcp_grants');
  assert.deepEqual([g!.subject_iss, g!.subject_id], [ISS, 'provider-a']); // never the email
  const asA = await (await app.request('/mcp/agents', { headers: a })).json() as { connections: unknown[] };
  const asB = await (await app.request('/mcp/agents', { headers: b })).json() as { connections: unknown[] };
  assert.deepEqual([asA.connections.length, asB.connections.length], [1, 0]);
  const revoke = await app.request('/mcp/agents/revoke', { method: 'POST', headers: { ...b, ...same }, body: JSON.stringify({ id: g!.id }) });
  assert.equal((await revoke.json() as { revoked: number }).revoked, 0);
  // A's agent asks to delete; B can't approve it, A can.
  const { rows: [n] } = await pool.query<{ id: string }>("INSERT INTO notes (user_id, title) SELECT id, 'edge note' FROM users WHERE email = 'sam@example.test' RETURNING id");
  const asked1 = await (await rpc(token, 'tools/call', { name: 'delete_notes_by_id', arguments: { id: n!.id } })).json() as { result: { content: { text: string }[] } };
  const id = /\/agents\/approve\/([0-9a-f-]{36})/.exec(asked1.result.content[0]!.text)![1]!;
  assert.equal((await app.request(`/mcp/agents/approvals/${id}`, { method: 'POST', headers: { ...b, ...same }, body: JSON.stringify({ approve: true }) })).status, 400);
  assert.equal((await app.request(`/mcp/agents/approvals/${id}`, { method: 'POST', headers: { ...a, ...same }, body: JSON.stringify({ approve: true }) })).status, 200);
});

test('AMCP-7: consent needs a verified assertion from agent.cloud’s own issuer, with a provider_id', { skip }, async () => {
  const noId = await authorize(gate('nid@example.test', undefined));
  assert.equal(noId.res.status, 403);
  assert.match(await noId.res.text(), /stable id/);
  const foreign = await authorize(gate('cust@example.test', 'p1', 'member', { iss: 'https://login.customer.example' }));
  assert.equal(foreign.res.status, 403);
  assert.equal(await foreign.res.text(), 'Agents aren’t available on this sign-in yet.');
  const forged = { ...gate('forge@example.test', 'p2'), 'x-agc-identity': assertion('forge@example.test', { provider_id: 'p2' }, other) };
  assert.equal((await authorize(forged)).res.status, 403);
  const otherEmail = { ...gate('x@example.test', 'p3'), 'x-agc-user-email': 'y@example.test' };
  assert.equal((await authorize(otherEmail)).res.status, 403);
  const expired = gate('old@example.test', 'p4', 'member', { exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal((await authorize(expired)).res.status, 403);
});

test('AMCP-7: an edge grant is rechecked by its issuer and provider_id, and a refusal ends it', { skip }, async () => {
  const token = await connect(gate('re@example.test', 'provider-r'));
  await pool.query("UPDATE mcp_grants SET checked_at = now() - interval '6 minutes' WHERE subject_id = 'provider-r'");
  people = 404;
  assert.equal((await rpc(token, 'tools/list')).status, 401);
  const url = new URL(asked.at(-1)!, ISS);
  assert.deepEqual([url.searchParams.get('iss'), url.searchParams.get('provider_id')], [ISS, 'provider-r']);
  assert.ok(!asked.at(-1)!.includes('re%40example'));
  people = 200;
});

test('AMCP-6: on edge sign-in the owner is the gate’s role on the request, on the session pages only', { skip }, async () => {
  const body = JSON.stringify({ tool: 'get_me', blocked: true });
  assert.equal((await app.request('/mcp/agents/block', { method: 'POST', headers: { ...gate('m@example.test', 'pm'), ...same }, body })).status, 403);
  assert.equal((await app.request('/mcp/agents/block', { method: 'POST', headers: { ...gate('o@example.test', 'po', 'owner'), ...same }, body })).status, 200);
  // A Bearer call with the gate's role header still administers nothing.
  const token = await connect(gate('t@example.test', 'pt'));
  const bearer = { ...same, host: 'localhost', 'x-agc-user-role': 'owner', authorization: `Bearer ${token}` };
  assert.equal((await app.request('/mcp/agents/block', { method: 'POST', headers: bearer, body: JSON.stringify({ tool: 'get_me', blocked: false }) })).status, 401);
});
