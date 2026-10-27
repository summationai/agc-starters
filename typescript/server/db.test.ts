// DATA-8: the pool keeps idle connections 30 s on a mirror (AGENTCLOUD_MIRROR set) and closes them after 1 s everywhere
// else. Each case loads db.ts in its own process, with that environment, and reads the pool it made. No database is
// involved: a pool connects only when it's asked for a connection, and the address below is a fake nobody answers on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function poolIdle(env: Record<string, string>): number {
  const base = { ...process.env };
  delete base.AGENTCLOUD_MIRROR;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const { pool } = await import('./server/db.ts'); console.log(pool.options.idleTimeoutMillis); await pool.end();",
  ], { cwd: new URL('..', import.meta.url), env: { ...base, DATABASE_URL: 'postgres://test@127.0.0.1:9/test', ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
}

test('DATA-8: on a mirror the pool keeps idle connections 30 s, so a request seconds after the last one skips a ~1.7 s connect', () => {
  assert.equal(poolIdle({ AGENTCLOUD_MIRROR: 'dev' }), 30_000);
});

test('DATA-8: in production (and a rehearsal) idle connections close after 1 s, so a quiet app\'s database can sleep', () => {
  assert.equal(poolIdle({ AGC_RUN: 'live' }), 1_000);
  assert.equal(poolIdle({ AGC_RUN: 'rehearsal' }), 1_000);
  assert.equal(poolIdle({ AGENTCLOUD_MIRROR: '' }), 1_000, 'an empty AGENTCLOUD_MIRROR is no mirror, as for cookies');
});
