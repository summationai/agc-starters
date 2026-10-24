import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

process.env.DATABASE_URL = 'postgresql://test@127.0.0.1:1/test';
process.env.AGC_AUTH_URL = 'https://auth.invalid';
process.env.AGC_AUTH_TOKEN = 'synthetic-auth';
delete process.env.AGC_AUTH_PROVIDER;
delete process.env.AGENTCLOUD_MIRROR;
const { app } = await import('./app.ts');
const { pool } = await import('./db.ts');

test('STOR-8: upload and download require sign-in before storage access', async () => {
  const upload = await app.request('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a.txt"}' });
  assert.equal(upload.status, 401);
  assert.equal((await app.request('/api/uploads/download?key=other/a.txt')).status, 401);
});

test('STOR-8: another person cannot obtain a download signature; upload bodies use the schema', async () => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const query = mock.method(pool, 'query', async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    return { rows: sql.includes('FROM sessions') ? [{ id: 'person', name: null, email: null }] : [] };
  });
  try {
    const headers = { cookie: '__Host-session=synthetic-session', 'content-type': 'application/json' };
    assert.equal((await app.request('/api/uploads/download?key=other/a.txt', { headers })).status, 404);
    for (const body of ['{}', '{"name":42}', '{"name":"../a.txt"}', '{"name":"${filename}"}']) {
      assert.equal((await app.request('/api/uploads', { method: 'POST', headers, body })).status, 400);
    }
    Object.assign(process.env, {
      AGC_STORAGE_ENDPOINT: 'https://storage.googleapis.com', AGC_STORAGE_REGION: 'auto', AGC_STORAGE_BUCKET: 'own-bucket',
      AGC_STORAGE_PREFIX: 'mirror/', AGC_STORAGE_MAX_OBJECT_MB: '25',
      AGC_STORAGE_ACCESS_KEY_ID: 'synthetic-hmac', AGC_STORAGE_SECRET_ACCESS_KEY: 'synthetic-secret',
    });
    const response = await app.request('/api/uploads', { method: 'POST', headers, body: '{"name":"a.txt"}' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const post = await response.json();
    assert.match(post.key, /^[a-f0-9-]{36}\/person\/a.txt$/);
    assert.equal(post.fields.key, `mirror/${post.key}`);
    assert.ok(statements.some(({ sql, values }) => sql.startsWith('INSERT INTO uploads') && values[0] === 'person' && values[1] === post.key));
    assert.ok(statements.some(({ sql, values }) => sql.includes('FROM uploads') && sql.includes('user_id = $2') && values[1] === 'person'));
  } finally { query.mock.restore(); await pool.end(); }
});
