// The storage helper against a fake S3 endpoint: what it signs, what it asks the bucket, and where it asks it from.
// Run with `npm test`. No real bucket or key is involved: the credentials below are fakes.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import * as storage from './storage.ts';
import { NOT_ON_MIRROR, signDownload, signUpload } from './storage.ts';

const SECRET = 'fake-secret-for-tests';
const seen: { method: string; path: string; query: URLSearchParams }[] = [];
const held = new Set<string>(); // "/<bucket>/<key>" the fake bucket holds
// How the fake answers a DELETE of a key it doesn't hold: S3's 204, GCS's 404 NoSuchKey, or a 403 refusal.
let deleteMissing: 'S3' | 'GCS' | 'refuse' = 'S3';
const s3Error = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
let s3: Server;
let endpoint = '';

before(async () => {
  s3 = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = decodeURIComponent(url.pathname);
    seen.push({ method: req.method ?? '', path, query: url.searchParams });
    if (req.method === 'HEAD') return res.writeHead(held.has(path) ? 200 : 404).end();
    if (req.method === 'DELETE') {
      if (!held.delete(path) && deleteMissing === 'GCS') return res.writeHead(404, { 'content-type': 'application/xml' }).end(s3Error('NoSuchKey'));
      if (deleteMissing === 'refuse') return res.writeHead(403, { 'content-type': 'application/xml' }).end(s3Error('AccessDenied'));
      return res.writeHead(204).end();
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
});
after(() => s3.close());

const BASE = {
  AGC_STORAGE_ENDPOINT: '', AGC_STORAGE_REGION: 'auto', AGC_STORAGE_BUCKET: 'agc-staging-0123456789abcdef-d', AGC_STORAGE_PREFIX: 'mirror-one/',
  AGC_STORAGE_MAX_OBJECT_MB: '25', AGC_STORAGE_ACCESS_KEY_ID: 'fake-key-id', AGC_STORAGE_SECRET_ACCESS_KEY: SECRET,
};
const NAMES = [...Object.keys(BASE), 'AGC_STORAGE_FALLBACK_BUCKET', 'AGC_STORAGE_FALLBACK_PREFIX', 'AGC_STORAGE_GATEWAY_URL', 'AGENTCLOUD_MIRROR', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'HTTP_PROXY', 'http_proxy'];
function env(over: Record<string, string> = {}) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, BASE, { AGC_STORAGE_ENDPOINT: endpoint }, over);
}
beforeEach(() => { seen.length = 0; held.clear(); deleteMissing = 'S3'; env(); });

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

test('STOR-2: signUpload signs a POST policy for one new key under the prefix, capped at the size limit, for 10 minutes', async () => {
  const before = Date.now();
  const up = await signUpload('receipts/scan.pdf');
  assert.match(up.key, /^[0-9a-f-]{36}\/receipts\/scan\.pdf$/, 'the key the app records: a fresh uuid, then the name');
  assert.equal(up.fields.key, `mirror-one/${up.key}`, 'the object lands under this place\u2019s prefix');
  assert.equal(up.url, `${endpoint}/agc-staging-0123456789abcdef-d`, 'path-style, on the endpoint\u2019s own host');
  const policy = JSON.parse(Buffer.from(up.fields.Policy!, 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };
  const conditions = JSON.stringify(policy.conditions);
  assert.ok(conditions.includes(JSON.stringify(['content-length-range', 0, 25 * 1024 * 1024])), conditions);
  assert.ok(conditions.includes(JSON.stringify({ key: `mirror-one/${up.key}` })), 'exactly one key, no starts-with');
  assert.ok(conditions.includes(JSON.stringify({ bucket: 'agc-staging-0123456789abcdef-d' })), conditions);
  const lasts = Date.parse(policy.expiration) - before;
  assert.ok(lasts > 9.9 * 60_000 && lasts <= 10 * 60_000 + 2000, `valid for ${lasts} ms`);
  // The policy is signed with this place's key (SigV4: the signing key signs the base64 policy itself).
  const [, date, region, service] = up.fields['X-Amz-Credential']!.split('/');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, date!), region!), service!), 'aws4_request');
  assert.equal(up.fields['X-Amz-Signature'], hmac(signingKey, up.fields.Policy!).toString('hex'));
  assert.equal(seen.length, 0, 'signing asks the bucket nothing');
});

test('STOR-2: the cap follows AGC_STORAGE_MAX_OBJECT_MB', async () => {
  env({ AGC_STORAGE_MAX_OBJECT_MB: '100' });
  const up = await signUpload('big.bin');
  const policy = Buffer.from(up.fields.Policy!, 'base64').toString('utf8');
  assert.ok(policy.includes(JSON.stringify(['content-length-range', 0, 100 * 1024 * 1024])), policy);
});

test('STOR-2: signUpload never reuses a key, even for the same name', async () => {
  const keys = new Set<string>();
  for (let i = 0; i < 20; i++) keys.add((await signUpload('photo.jpg')).key);
  assert.equal(keys.size, 20);
});

test('STOR-2: a key that would leave the prefix is refused', async () => {
  for (const bad of ['', '/etc/passwd', '../other-mirror/x', 'a/../../b', 'a//b', 'a/', 'line\nbreak', '${filename}']) {
    await assert.rejects(signUpload(bad), /storage key/, JSON.stringify(bad));
    await assert.rejects(signDownload(bad, () => true), /storage key/, JSON.stringify(bad));
    await assert.rejects(storage.delete(bad), /storage key/, JSON.stringify(bad));
  }
});

test('STOR-3: signDownload signs a GET for at most 5 minutes, only after the app\u2019s own check', async () => {
  held.add('/agc-staging-0123456789abcdef-d/mirror-one/k1/scan.pdf');
  const order: string[] = [];
  const r = await signDownload('k1/scan.pdf', () => { order.push(`check, ${seen.length} requests so far`); return true; });
  assert.ok(r.ok);
  assert.deepEqual(order, ['check, 0 requests so far'], 'the check runs before the bucket is asked anything');
  const url = new URL(r.url);
  assert.equal(url.origin, endpoint);
  assert.equal(decodeURIComponent(url.pathname), '/agc-staging-0123456789abcdef-d/mirror-one/k1/scan.pdf');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.deepEqual(seen.map((s) => s.method), ['HEAD']);
});

test('STOR-3: a person the check refuses gets 403, and nothing is asked or signed', async () => {
  held.add('/agc-staging-0123456789abcdef-d/mirror-one/k1/scan.pdf');
  const r = await signDownload('k1/scan.pdf', async () => false);
  assert.deepEqual(r, { ok: false, status: 403, error: { code: 'forbidden', message: 'You can\u2019t see this file.' } });
  assert.equal(seen.length, 0);
});

test('STOR-3: in production a missing key answers 404, with one HEAD', async () => {
  env({ AGC_STORAGE_PREFIX: '', AGC_STORAGE_BUCKET: 'agc-staging-0123456789abcdef-p' });
  const r = await signDownload('gone.pdf', () => true);
  assert.equal(!r.ok && r.status, 404);
  assert.equal(!r.ok && r.error.code, 'not_found');
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ['HEAD /agc-staging-0123456789abcdef-p/gone.pdf']);
});

test('STOR-3: in a rehearsal, a key missing from its own prefix is read from production, with one HEAD and no list', async () => {
  env({ AGC_STORAGE_BUCKET: 'agc-staging-0123456789abcdef-r', AGC_STORAGE_PREFIX: 'op_1/task_2/', AGC_STORAGE_FALLBACK_BUCKET: 'agc-staging-0123456789abcdef-p' });
  const r = await signDownload('k9/receipt.png', () => true);
  assert.ok(r.ok);
  assert.equal(decodeURIComponent(new URL(r.url).pathname), '/agc-staging-0123456789abcdef-p/k9/receipt.png', 'production\u2019s bucket, at production\u2019s (empty) prefix');
  assert.equal(new URL(r.url).searchParams.get('X-Amz-Expires'), '300');
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ['HEAD /agc-staging-0123456789abcdef-r/op_1/task_2/k9/receipt.png']);
  assert.ok(!seen.some((s) => s.query.has('list-type') || s.method === 'GET'), 'never a list');
});

test('STOR-3: a customer rehearsal uses its production fallback prefix after one HEAD', async () => {
  env({ AGC_STORAGE_FALLBACK_BUCKET: 'customer-bucket', AGC_STORAGE_FALLBACK_PREFIX: 'apps/one/prod/' });
  const r = await signDownload('k1/receipt.pdf', () => true);
  assert.ok(r.ok);
  assert.equal(decodeURIComponent(new URL(r.url).pathname), '/customer-bucket/apps/one/prod/k1/receipt.pdf');
  assert.deepEqual(seen.map((s) => s.method), ['HEAD']);
});

test('STOR-6: gateway URLs retain the signed path, query and POST fields', async () => {
  const gateway = 'https://files.example.test/app/place/attempt';
  env({ AGC_STORAGE_GATEWAY_URL: gateway + '/' });
  const up = await signUpload('person/literal %2F+ café?#.txt');
  assert.equal(up.url, gateway + '/agc-staging-0123456789abcdef-d');
  assert.equal(up.fields.key, 'mirror-one/' + up.key);
  held.add('/agc-staging-0123456789abcdef-d/mirror-one/person/literal %2F+ café?#.txt');
  const down = await signDownload('person/literal %2F+ café?#.txt', () => true);
  assert.ok(down.ok);
  assert.ok(down.url.startsWith(gateway + '/agc-staging-0123456789abcdef-d/'));
  assert.match(down.url, /%252F%2B%20caf%C3%A9%3F%23\.txt\?/);
  assert.deepEqual(seen.map((s) => s.method), ['HEAD']);
});

test('STOR-3: in a rehearsal, a key its own prefix holds is read from there', async () => {
  env({ AGC_STORAGE_BUCKET: 'agc-staging-0123456789abcdef-r', AGC_STORAGE_PREFIX: 'op_1/task_2/', AGC_STORAGE_FALLBACK_BUCKET: 'agc-staging-0123456789abcdef-p' });
  held.add('/agc-staging-0123456789abcdef-r/op_1/task_2/k9/receipt.png');
  const r = await signDownload('k9/receipt.png', () => true);
  assert.ok(r.ok);
  assert.equal(decodeURIComponent(new URL(r.url).pathname), '/agc-staging-0123456789abcdef-r/op_1/task_2/k9/receipt.png');
  assert.equal(seen.length, 1);
});

test('STOR-3: on a mirror, a key its masked rows name but its prefix lacks shows "This file isn\'t on this mirror"', async () => {
  env({ AGENTCLOUD_MIRROR: 'mirror-one' });
  const r = await signDownload('k1/from-production.pdf', () => true);
  assert.deepEqual(r, { ok: false, status: 404, error: { code: 'not_on_mirror', message: NOT_ON_MIRROR } });
  assert.equal(NOT_ON_MIRROR, 'This file isn\'t on this mirror');
  assert.deepEqual(seen.map((s) => s.method), ['HEAD']);
});

test('STOR-3: a mirror never falls back to production, even if it were handed a fallback bucket', async () => {
  env({ AGENTCLOUD_MIRROR: 'mirror-one', AGC_STORAGE_FALLBACK_BUCKET: 'agc-staging-0123456789abcdef-p' });
  const r = await signDownload('k1/from-production.pdf', () => true);
  assert.equal(!r.ok && r.error.code, 'not_on_mirror');
});

test('STOR-4: delete removes one key under the prefix', async () => {
  held.add('/agc-staging-0123456789abcdef-d/mirror-one/k1/scan.pdf');
  await storage.delete('k1/scan.pdf');
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ['DELETE /agc-staging-0123456789abcdef-d/mirror-one/k1/scan.pdf']);
  assert.equal(held.size, 0);
});

test('STOR-4: in a rehearsal, delete touches only its own prefix, never production\u2019s bucket', async () => {
  env({ AGC_STORAGE_BUCKET: 'agc-staging-0123456789abcdef-r', AGC_STORAGE_PREFIX: 'op_1/task_2/', AGC_STORAGE_FALLBACK_BUCKET: 'agc-staging-0123456789abcdef-p' });
  await storage.delete('k9/receipt.png');
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ['DELETE /agc-staging-0123456789abcdef-r/op_1/task_2/k9/receipt.png']);
});

test('STOR-4: delete of a key that isn\u2019t there succeeds on every target: S3\u2019s 204 and GCS\u2019s 404 NoSuchKey', async () => {
  for (const target of ['S3', 'GCS'] as const) {
    deleteMissing = target;
    seen.length = 0;
    await storage.delete('k1/never-uploaded.pdf'); // a delete before an upload
    held.add('/agc-staging-0123456789abcdef-d/mirror-one/k1/scan.pdf');
    await storage.delete('k1/scan.pdf');
    await storage.delete('k1/scan.pdf'); // a second delete of the same key
    assert.equal(seen.filter((s) => s.method === 'DELETE').length, 3, target);
    assert.equal(held.size, 0, target);
  }
});

test('STOR-4: any other error from a delete still throws', async () => {
  deleteMissing = 'refuse';
  await assert.rejects(storage.delete('k1/scan.pdf'), (e: { $metadata?: { httpStatusCode?: number } }) => e.$metadata?.httpStatusCode === 403);
});

test('STOR-1: without [storage] there\u2019s no bucket, and the helper says what to declare', async () => {
  for (const n of NAMES) delete process.env[n];
  await assert.rejects(signUpload('x.pdf'), /AGC_STORAGE_BUCKET is not set: storage needs \[storage\] in agentcloud\.toml/);
});

test('STOR-5: on a mirror, the S3 client goes through agc\u2019s egress proxy (HTTPS_PROXY)', async () => {
  const connects: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (req: IncomingMessage, socket: Socket) => {
    connects.push(req.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); // as agc's proxy answers a host it doesn't grant
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    env({ AGENTCLOUD_MIRROR: 'mirror-one', AGC_STORAGE_ENDPOINT: 'https://storage.googleapis.com', HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` });
    await assert.rejects(signDownload('k1/scan.pdf', () => true));
    assert.ok(connects.length >= 1, 'the request went to the proxy');
    assert.ok(connects.every((c) => c === 'storage.googleapis.com:443'), `CONNECT ${connects.join(', ')}: the endpoint\u2019s own host, path-style`);
  } finally {
    proxy.close();
  }
});
