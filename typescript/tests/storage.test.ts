import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, mock } from 'node:test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { signUpload, signDownload, StorageKeyError, StorageNotFoundError } from '../server/storage.ts';

const secret = 'synthetic-secret';
let endpoint = '';
let status = 200;
let requests: string[] = [];
let credentialCalls = 0;
let short = false;
let alwaysShort = false;
const authorizations: string[] = [];
const server = createServer((req, res) => {
  if (req.url === '/credentials') {
    credentialCalls++;
    authorizations.push(req.headers.authorization ?? '');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: secret, Token: `token-${credentialCalls}`,
      Expiration: new Date(Date.now() + (short || alwaysShort ? 10 : 15) * 60_000).toISOString(),
    }));
    short = false;
    return;
  }
  requests.push(`${req.method} ${req.url}`);
  res.writeHead(status);
  res.end();
});
let dir = '';
const savedEnv = { ...process.env };
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = await mkdtemp(join(tmpdir(), 'agc-storage-'));
  for (const name of Object.keys(process.env)) if (name.startsWith('AGC_STORAGE_') || name.startsWith('AWS_')) delete process.env[name];
  Object.assign(process.env, {
    AGC_STORAGE_ENDPOINT: endpoint, AGC_STORAGE_REGION: 'auto', AGC_STORAGE_BUCKET: 'own-bucket',
    AGC_STORAGE_PREFIX: 'branch/task/', AGC_STORAGE_MAX_OBJECT_MB: '25',
    AGC_STORAGE_ACCESS_KEY_ID: 'synthetic-hmac', AGC_STORAGE_SECRET_ACCESS_KEY: secret,
    AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: join(dir, 'absent'), AWS_CONFIG_FILE: join(dir, 'absent'),
  });
});
after(async () => {
  server.close();
  server.closeAllConnections();
  await rm(dir, { recursive: true, force: true });
  process.env = savedEnv;
});

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
function signingKey(credential: string) {
  const [, date, region, service] = credential.split('/');
  return hmac(hmac(hmac(hmac('AWS4' + secret, date!), region!), service!), 'aws4_request');
}
function verifyGet(url: string) {
  const u = new URL(url);
  const credential = u.searchParams.get('X-Amz-Credential')!;
  const query = u.search.slice(1).split('&').filter((part) => !part.startsWith('X-Amz-Signature=')).sort().join('&');
  const canonical = `GET\n${u.pathname}\n${query}\nhost:${u.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const scope = credential.split('/').slice(1).join('/');
  const toSign = `AWS4-HMAC-SHA256\n${u.searchParams.get('X-Amz-Date')}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
  assert.equal(u.searchParams.get('X-Amz-Signature'), hmac(signingKey(credential), toSign).toString('hex'));
  assert.equal(u.searchParams.get('X-Amz-Expires'), '300');
}

test('STO-3/11/12: exact new POST keys, capped policy, ten-minute expiry and GCS HMAC signatures', async () => {
  const started = Date.now();
  const post = await signUpload('person/literal %2F+ café?#.txt');
  const again = await signUpload('person/literal %2F+ café?#.txt');
  assert.notEqual(post.key, again.key);
  assert.match(post.key, /^person\/[a-f0-9-]{36}\/literal %2F\+ café\?#\.txt$/);
  assert.equal(post.url, `${endpoint}/own-bucket`);
  assert.equal(post.fields.key, `branch/task/${post.key}`);
  const fields = Object.fromEntries(Object.entries(post.fields).map(([k, v]) => [k.toLowerCase(), v]));
  const policy = JSON.parse(Buffer.from(fields.policy!, 'base64').toString());
  assert.deepEqual(policy.conditions.find((c: unknown) => Array.isArray(c)), ['content-length-range', 0, 25 * 1_048_576]);
  assert.ok(policy.conditions.some((c: { key?: string }) => c.key === post.fields.key));
  assert.ok(policy.conditions.some((c: { bucket?: string }) => c.bucket === 'own-bucket'));
  assert.ok(Date.parse(policy.expiration) - started >= 599_000 && Date.parse(policy.expiration) - started <= 601_000);
  assert.equal(fields['x-amz-signature'], hmac(signingKey(fields['x-amz-credential']!), fields.policy!).toString('hex'));
  assert.equal(fields['x-amz-security-token'], undefined);
});

test('STO-3: gateway replaces only the endpoint, preserving POST fields and the signed GET', async () => {
  const gateway = 'https://files.example.test/__agc/storage/files/app/r/attempt';
  process.env.AGC_STORAGE_GATEWAY_URL = gateway + '/';
  const post = await signUpload('person/a.txt');
  assert.equal(post.url, gateway + '/own-bucket');
  assert.equal(post.fields.key, 'branch/task/' + post.key);
  const fields = Object.fromEntries(Object.entries(post.fields).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(fields['x-amz-signature'], hmac(signingKey(fields['x-amz-credential']!), fields.policy!).toString('hex'));
  status = 200;
  requests = [];
  const url = await signDownload('person/literal %2F+ café?#.txt');
  assert.ok(url.startsWith(gateway + '/own-bucket/branch/task/person/'));
  verifyGet(endpoint + url.slice(gateway.length));
  assert.deepEqual(requests, ['HEAD /own-bucket/branch/task/person/literal%20%252F%2B%20caf%C3%A9%3F%23.txt']);
  delete process.env.AGC_STORAGE_GATEWAY_URL;
  const direct = await signDownload('person/a.txt');
  assert.ok(direct.startsWith(endpoint + '/own-bucket/branch/task/'));
  verifyGet(direct);
});

test('STO-12: own HEAD first, 404-only fallback with production prefix, no lists or production HEAD', async () => {
  process.env.AGC_STORAGE_FALLBACK_BUCKET = 'production-bucket';
  process.env.AGC_STORAGE_FALLBACK_PREFIX = 'apps/app/p/';
  status = 200;
  requests = [];
  assert.match(await signDownload('person/a.txt'), /\/own-bucket\/branch\/task\/person\/a.txt\?/);
  status = 404;
  const fallback = await signDownload('person/a.txt');
  assert.match(fallback, /\/production-bucket\/apps\/app\/p\/person\/a.txt\?/);
  verifyGet(fallback);
  assert.deepEqual(requests, Array(2).fill('HEAD /own-bucket/branch/task/person/a.txt'));
  process.env.AGC_STORAGE_GATEWAY_URL = 'https://files.example.test/route';
  const routed = await signDownload('person/a.txt');
  assert.ok(routed.startsWith('https://files.example.test/route/production-bucket/apps/app/p/'));
  verifyGet(endpoint + routed.slice('https://files.example.test/route'.length));
  delete process.env.AGC_STORAGE_GATEWAY_URL;
  delete process.env.AGC_STORAGE_FALLBACK_PREFIX; // GCS production prefix is empty.
  assert.match(await signDownload('person/a.txt'), /\/production-bucket\/person\/a.txt\?/);
  status = 403;
  await assert.rejects(signDownload('person/a.txt'), { name: 'Unknown' });
  delete process.env.AGC_STORAGE_FALLBACK_BUCKET;
  status = 404;
  await assert.rejects(signDownload('person/a.txt'), StorageNotFoundError);
});

test('STO-3/12: traversal, POST substitutions, oversized keys and invalid limits fail before any request', async () => {
  requests = [];
  for (const key of ['', '/abs', '../outside', 'a/../b', 'a//b', 'a\\b', 'a/${filename}', 'a\u0000b', 'é'.repeat(513)]) {
    await assert.rejects(signUpload(key), StorageKeyError);
    await assert.rejects(signDownload(key), StorageKeyError);
  }
  for (const cap of ['0', '101', 'NaN', '1.5']) {
    process.env.AGC_STORAGE_MAX_OBJECT_MB = cap;
    await assert.rejects(signUpload('person/a.txt'));
  }
  process.env.AGC_STORAGE_MAX_OBJECT_MB = '25';
  assert.deepEqual(requests, []);
});

test('STO-2/15: default container credentials refresh below eleven minutes and beyond an hour; backend SDK stays independent', async () => {
  delete process.env.AGC_STORAGE_ACCESS_KEY_ID;
  delete process.env.AGC_STORAGE_SECRET_ACCESS_KEY;
  process.env.AGC_STORAGE_REGION = 'us-west-2';
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = endpoint + '/credentials';
  process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = join(dir, 'token');
  await writeFile(join(dir, 'token'), 'projected-token-1');
  short = true;
  const first = await signUpload('person/a.txt');
  assert.ok(credentialCalls >= 2); // The SDK accepts ten minutes; the signer must refresh it.
  assert.ok(Object.values(first.fields).includes(`token-${credentialCalls}`));
  assert.equal(authorizations[0], 'projected-token-1');
  status = 200;
  const backend = new S3Client({ endpoint, region: 'us-west-2', forcePathStyle: true });
  await backend.send(new HeadObjectCommand({ Bucket: 'own-bucket', Key: 'branch/task/backend' }));
  await writeFile(join(dir, 'token'), 'projected-token-2');
  const realNow = Date.now();
  const clock = mock.method(Date, 'now', () => realNow + 61 * 60_000);
  try {
    const later = await signUpload('person/a.txt');
    assert.ok(Object.values(later.fields).includes(`token-${credentialCalls}`));
    assert.equal(authorizations.at(-1), 'projected-token-2');
    await backend.send(new HeadObjectCommand({ Bucket: 'own-bucket', Key: 'branch/task/backend' }));
    assert.equal(authorizations.at(-1), 'projected-token-2');
    assert.ok(requests.includes('HEAD /own-bucket/branch/task/backend'));
    clock.mock.mockImplementation(() => realNow + 122 * 60_000);
    alwaysShort = true;
    await assert.rejects(signUpload('person/a.txt'), /fewer than 11 minutes/);
  } finally { alwaysShort = false; clock.mock.restore(); backend.destroy(); }
});
