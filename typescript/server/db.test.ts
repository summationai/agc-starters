// DATA-8: the pool keeps idle connections 60 s, in production and on a mirror (AGENTCLOUD_MIRROR set) alike, at most 10.
// Each case loads db.ts in its own process, with that environment, and reads the pool it made. No database is
// involved: a pool connects only when it's asked for a connection, and the address below is a fake nobody answers on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function poolOf(env: Record<string, string>): { idle: number; max: number; min: number } {
  const base = { ...process.env };
  delete base.AGENTCLOUD_MIRROR;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const { pool } = await import('./server/db.ts'); console.log(JSON.stringify({ idle: pool.options.idleTimeoutMillis, max: pool.options.max, min: pool.options.min ?? 0 })); await pool.end();",
  ], { cwd: new URL('..', import.meta.url), env: { ...base, DATABASE_URL: 'postgres://test@127.0.0.1:9/test', ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

test('DATA-8: idle connections stay 60 s in production, a rehearsal and on a mirror, so a request within a minute reuses one, and none are held below that', () => {
  const want = { idle: 60_000, max: 10, min: 0 };
  assert.deepEqual(poolOf({ AGC_RUN: 'live' }), want);
  assert.deepEqual(poolOf({ AGC_RUN: 'rehearsal' }), want);
  assert.deepEqual(poolOf({ AGENTCLOUD_MIRROR: 'dev' }), want);
});

test('DATA-8: a quiet app holds no connection a minute after its last request, well inside the 5 minutes after which its database sleeps', () => {
  const { idle, min } = poolOf({ AGC_RUN: 'live' });
  assert.equal(min, 0);
  assert.ok(idle <= 60_000 && idle < 5 * 60_000);
});
