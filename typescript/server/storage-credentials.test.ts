// STOR-7: a synthetic container credential endpoint, never a real cloud account.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, mock, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let calls = 0;
let short = false;
const server = createServer((req, res) => {
  if (req.url !== '/credentials') return res.writeHead(404).end();
  calls += 1;
  const minutes = short || calls === 1 ? 10 : 15;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: 'synthetic-secret',
    Token: `token-${calls}`, Expiration: new Date(Date.now() + minutes * 60_000).toISOString(),
  }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const dir = await mkdtemp(join(tmpdir(), 'stor-credentials-'));
await writeFile(join(dir, 'token'), 'projected-token');
Object.assign(process.env, {
  AGC_STORAGE_ENDPOINT: endpoint, AGC_STORAGE_REGION: 'us-west-2', AGC_STORAGE_BUCKET: 'own-bucket',
  AGC_STORAGE_PREFIX: '', AGC_STORAGE_MAX_OBJECT_MB: '25',
  AWS_CONTAINER_CREDENTIALS_FULL_URI: endpoint + '/credentials',
  AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: join(dir, 'token'),
  AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: join(dir, 'absent'), AWS_CONFIG_FILE: join(dir, 'absent'),
});
delete process.env.AGC_STORAGE_ACCESS_KEY_ID;
delete process.env.AGC_STORAGE_SECRET_ACCESS_KEY;
const { signUpload } = await import('./storage.ts');
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

test('STOR-7: refreshes a ten-minute credential before signing and rejects one that stays short', async () => {
  const first = await signUpload('person/a.txt');
  assert.ok(calls >= 2);
  assert.ok(Object.values(first.fields).includes(`token-${calls}`));
  const now = Date.now();
  const clock = mock.method(Date, 'now', () => now + 5 * 60_000);
  short = true;
  try {
    await assert.rejects(signUpload('person/b.txt'), /fewer than 11 minutes/);
  } finally { clock.mock.restore(); }
});
