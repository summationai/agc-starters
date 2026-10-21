// The linter on a minimal stack that follows the rules, and on copies of it that each break one.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { lint } from '../lint/index.ts';
import { readStack } from '../lib/stack.ts';

const GOOD = join(import.meta.dirname, 'fixtures', 'node-good');
const temps: string[] = [];
after(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });

// A copy outside the repo (so shipped files come from a walk, not git), changed by `change`.
async function broken(change: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'agc-lint-'));
  temps.push(dir);
  cpSync(GOOD, dir, { recursive: true });
  change(dir);
  return readStack(dir);
}
const outcome = (name: string, s: Awaited<ReturnType<typeof readStack>>, rule?: string) => {
  const r = lint[name]!(s);
  return rule ? (r.perRule?.[rule] ?? r).outcome : r.outcome;
};

test('the fixture passes every lint rule', async () => {
  const s = await readStack(GOOD);
  for (const [name, check] of Object.entries(lint)) {
    const r = check(s);
    assert.equal(r.outcome, 'pass', `${name}: ${r.evidence}`);
    for (const [rule, v] of Object.entries(r.perRule ?? {})) assert.equal(v.outcome, 'pass', `${name} ${rule}: ${v.evidence}`);
  }
});

test('each broken copy fails the rule it breaks', async () => {
  assert.equal(outcome('LINT:seed', await broken((d) => rmSync(join(d, 'seed.sql')))), 'fail', 'seed declared but missing');
  assert.equal(outcome('LINT:seed', await broken((d) => writeFileSync(join(d, 'seed.sql'), readFileSync(join(GOOD, 'seed.sql'), 'utf8').replace(/ON CONFLICT DO NOTHING;\s*$/, ';')))), 'fail', 'an insert without ON CONFLICT');
  assert.equal(outcome('LINT:seed', await broken((d) => writeFileSync(join(d, 'seed.sql'), 'CREATE TABLE extra (id int);\n' + readFileSync(join(GOOD, 'seed.sql'), 'utf8')))), 'fail', 'DDL in a seed');
  assert.equal(outcome('LINT:no-dockerfile', await broken((d) => writeFileSync(join(d, 'Dockerfile'), 'FROM node:24\n'))), 'fail');
  assert.equal(outcome('LINT:no-passwords', await broken((d) => writeFileSync(join(d, 'server', 'auth.ts'), "import bcrypt from 'bcrypt';\nexport const check = (password: string) => bcrypt.compare(password, '');\n"))), 'fail');
  assert.equal(outcome('LINT:no-cors', await broken((d) => writeFileSync(join(d, 'server', 'cors.ts'), "import { cors } from 'hono/cors';\n"))), 'fail');
  assert.equal(outcome('LINT:db-config', await broken((d) => writeFileSync(join(d, 'server', 'db.ts'), 'export const ssl = { rejectUnauthorized: false };\n'))), 'fail');
  assert.equal(outcome('LINT:secrets', await broken((d) => writeFileSync(join(d, 'server', 'key.ts'), `export const k = '${['sk', 'live', 'x'.repeat(24)].join('_')}';\n`))), 'fail');
  assert.equal(outcome('LINT:secrets', await broken((d) => writeFileSync(join(d, '.env'), 'X=1\n'))), 'fail');
  assert.equal(outcome('LINT:no-migrator', await broken((d) => writeFileSync(join(d, 'package.json'), '{ "name": "starter", "dependencies": { "prisma": "^6" } }\n'))), 'fail');
  assert.equal(outcome('LINT:no-migrator', await broken((d) => writeFileSync(join(d, 'server', 'olap.py'), "duck.execute('CREATE TABLE t AS SELECT 1')\n"))), 'pass', 'in-process DuckDB DDL is fine');
  assert.equal(outcome('LINT:uuid-keys', await broken((d) => writeFileSync(join(d, 'migrations', '0001_init.sql'), readFileSync(join(GOOD, 'migrations', '0001_init.sql'), 'utf8').replace('users (id uuid', 'users (id bigserial')))), 'fail');
  assert.equal(outcome('LINT:migrations', await broken((d) => writeFileSync(join(d, 'migrations', 'Init.sql'), 'SELECT 1;\n')), 'DATA-2'), 'fail', 'a misnamed migration');
  assert.equal(outcome('LINT:manifest', await broken((d) => writeFileSync(join(d, 'agentcloud.toml'), readFileSync(join(GOOD, 'agentcloud.toml'), 'utf8').replace('health = "/api/health"', 'health = "/healthz"'))), 'MAN-3'), 'fail');
  assert.equal(outcome('LINT:checks', await broken((d) => writeFileSync(join(d, 'agentcloud.toml'), readFileSync(join(GOOD, 'agentcloud.toml'), 'utf8').replace('"SIGN IN racer-{run}@example.test",', ''))), 'CHK-1'), 'fail', 'no SIGN IN');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), '# agent.cloud: how to work on this app\n'))), 'fail');
  assert.equal(outcome('LINT:descriptor', await broken((d) => writeFileSync(join(d, 'server', 'health.ts'), "export const a = { status: 'ok' }; export const b = { status: 'ok' };\n"))), 'fail', 'find occurs twice');
  assert.equal(outcome('LINT:fixed-values', await broken((d) => writeFileSync(join(d, 'migrations', '0002_status.sql'), 'CREATE TABLE tasks (id uuid PRIMARY KEY, status text NOT NULL);\n'))), 'fail');
  assert.equal(outcome('LINT:app-pages', await broken((d) => rmSync(join(d, 'web', 'src', 'Notes.tsx')))), 'fail', 'no Notes page');
  assert.equal(outcome('LINT:app-pages', await broken((d) => writeFileSync(join(d, 'web', 'src', 'main.tsx'), "import { App } from './App.tsx';\n"))), 'fail', '/notes not routed');
  assert.equal(outcome('LINT:app-pages', await broken((d) => writeFileSync(join(d, 'migrations', '0002_welcome.sql'), 'CREATE TABLE welcome_views (id uuid PRIMARY KEY);\n'))), 'fail', 'a migration for the welcome page');
  assert.equal(outcome('LINT:build-outputs', await broken((d) => writeFileSync(join(d, '.gitignore'), 'node_modules/\n'))), 'fail', 'dist not ignored');
});
