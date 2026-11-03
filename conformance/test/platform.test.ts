// The fake platform answers the way agent.cloud's test mode and email endpoint do.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const auth = `${base}/auth/test/conformance`;
let child: ReturnType<typeof spawn>;

before(async () => {
  child = spawn(process.execPath, [join(import.meta.dirname, '..', 'platform', 'server.ts')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/_fake/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the fake platform didn’t start');
});
after(() => { child.kill(); });

const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

test('a test sign-in: a code once, for the right token, with a stable identity per email', async () => {
  assert.equal((await fetch(`${auth}/authorize?state=short`)).status, 400);
  assert.equal((await fetch(`${auth}/authorize?state=abcdefgh12345678`)).status, 200, 'without as: the test page');
  const go = await fetch(`${auth}/authorize?state=abcdefgh12345678&as=Pat@Example.test`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  const back = new URL(go.headers.get('location')!);
  assert.equal(back.pathname, '/auth/callback');
  assert.equal(back.searchParams.get('state'), 'abcdefgh12345678');
  const code = back.searchParams.get('code')!;
  assert.equal(((await (await fetch(`${auth}/codes/${code}`, { headers: bearer('agca_conformance') })).json()) as { traded: boolean }).traded, false);
  assert.equal((await fetch(`${auth}/token`, { method: 'POST', headers: bearer('wrong'), body: JSON.stringify({ code }) })).status, 401);
  const r = await fetch(`${auth}/token`, { method: 'POST', headers: bearer('agca_conformance'), body: JSON.stringify({ code }) });
  const { user } = (await r.json()) as { user: { id: string; email: string } };
  assert.equal(user.email, 'pat@example.test');
  assert.match(user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal((await fetch(`${auth}/token`, { method: 'POST', headers: bearer('agca_conformance'), body: JSON.stringify({ code }) })).status, 400, 'once');
  assert.equal(((await (await fetch(`${auth}/codes/${code}`, { headers: bearer('agca_conformance') })).json()) as { traded: boolean }).traded, true);
  const again = new URL((await fetch(`${auth}/authorize?state=abcdefgh12345678&as=pat@example.test`, { redirect: 'manual' })).headers.get('location')!);
  const user2 = ((await (await fetch(`${auth}/token`, { method: 'POST', headers: bearer('agca_conformance'), body: JSON.stringify({ code: again.searchParams.get('code') }) })).json()) as { user: { id: string } }).user;
  assert.equal(user2.id, user.id, 'the same person keeps the same id');
});

test('email: each key once, attempts counted', async () => {
  const send = (key: string) => fetch(`${base}/email/v1/messages`, { method: 'POST', headers: bearer('agce_conformance'), body: JSON.stringify({ to: 'a@example.test', subject: 'Hi', text: 'Hello', key }) });
  assert.equal(((await (await send('note-1/created')).json()) as { status: string }).status, 'captured');
  assert.equal(((await (await send('note-1/created')).json()) as { status: string }).status, 'duplicate');
  assert.equal((await fetch(`${base}/email/v1/messages`, { method: 'POST', headers: bearer('nope'), body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/email/v1/messages`, { method: 'POST', headers: bearer('agce_conformance'), body: JSON.stringify({ to: 'a@example.test', subject: 'Hi', text: 'x' }) })).status, 400, 'a key is required');
  const { messages } = (await (await fetch(`${base}/_fake/mail`)).json()) as { messages: { key: string; attempts: number }[] };
  assert.deepEqual(messages.map((m) => [m.key, m.attempts]), [['note-1/created', 2]]);
});

test('AUTH-8: a recheck is recorded with its session start, and answers what the suite set', async () => {
  const id = '0b7c2f1e-1111-4222-8333-444455556666';
  const recheck = (start?: string) => fetch(`${auth}/users/${id}`, { redirect: 'manual', headers: { ...bearer('agca_conformance'), ...(start ? { 'x-agc-session-start': start } : {}) } });
  assert.equal((await recheck('1700000000000')).status, 200);
  assert.equal((await fetch(`${auth}/users/${id}`, { headers: bearer('wrong') })).status, 401);
  for (const status of [404, 503, 401]) {
    assert.equal((await fetch(`${base}/_fake/users/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) })).status, 200);
    assert.equal((await recheck()).status, status);
  }
  await fetch(`${base}/_fake/users/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 302 }) });
  const moved = await recheck();
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), `/_fake/redirected/${id}`);
  assert.equal((await fetch(new URL(moved.headers.get('location')!, base))).status, 200, 'where it leads would let them in');
  const { rechecks } = (await (await fetch(`${base}/_fake/rechecks`)).json()) as { rechecks: { id: string; session_start: string | null }[] };
  assert.deepEqual(rechecks.map((r) => [r.id, r.session_start]), [[id, '1700000000000'], [id, null], [id, null], [id, null], [id, null], [id, null]]);
});
