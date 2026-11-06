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
  assert.equal(outcome('LINT:secrets', await broken((d) => writeFileSync(join(d, 'server', 'token.ts'), `export const t = '${['agc', 'oa_', 'x'.repeat(16)].join('')}';\n`))), 'fail', 'an agent.cloud token shape, as control scans today');
  assert.equal(outcome('LINT:secrets', await broken((d) => writeFileSync(join(d, '.env'), 'X=1\n'))), 'fail');
  assert.equal(outcome('LINT:no-migrator', await broken((d) => writeFileSync(join(d, 'package.json'), '{ "name": "starter", "dependencies": { "prisma": "^6" } }\n'))), 'fail');
  assert.equal(outcome('LINT:no-migrator', await broken((d) => writeFileSync(join(d, 'server', 'olap.py'), "duck.execute('CREATE TABLE t AS SELECT 1')\n"))), 'pass', 'in-process DuckDB DDL is fine');
  assert.equal(outcome('LINT:uuid-keys', await broken((d) => writeFileSync(join(d, 'migrations', '0001_init.sql'), readFileSync(join(GOOD, 'migrations', '0001_init.sql'), 'utf8').replace('users (id uuid', 'users (id bigserial')))), 'fail');
  assert.equal(outcome('LINT:migrations', await broken((d) => writeFileSync(join(d, 'migrations', 'Init.sql'), 'SELECT 1;\n')), 'DATA-2'), 'fail', 'a misnamed migration');
  assert.equal(outcome('LINT:manifest', await broken((d) => writeFileSync(join(d, 'agentcloud.toml'), readFileSync(join(GOOD, 'agentcloud.toml'), 'utf8').replace('health = "/api/health"', 'health = "/healthz"'))), 'MAN-3'), 'fail');
  assert.equal(outcome('LINT:checks', await broken((d) => writeFileSync(join(d, 'agentcloud.toml'), readFileSync(join(GOOD, 'agentcloud.toml'), 'utf8').replace('"SIGN IN racer-{run}@example.test",', ''))), 'CHK-1'), 'fail', 'no SIGN IN');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), '# agent.cloud: how to work on this app\n'))), 'fail');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*Business logic:\*\*[^\n]*\n/, '')))), 'fail', 'DOC-3: no word on triggers');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*A scheduled job on a lake app:\*\*[^\n]*\n/, '')))), 'fail', 'DOC-15: no word on AGC_RUN in rehearsals');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/## Say what you're doing\n\n[^\n]*\n/, '')))), 'fail', 'DOC-4: no word on agc now');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*A foreign key:\*\*[^\n]*\n/, '')))), 'fail', 'DOC-5: no word on indexing foreign keys');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*A primary key on every table:\*\*[^\n]*\n/, '')))), 'fail', 'DOC-6: no word on primary keys');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*Admin routes answer only an admin\.\*\*[^\n]*\n/, '')))), 'fail', 'DOC-7: no word on admin routes');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(', `/manage` or `/dashboard`', '')))), 'fail', 'DOC-7: a path family left out');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(' `/_debug`,', '')))), 'fail', 'DOC-7: /_debug left out');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/^Once a mirror's work[^\n]*\n/m, '')))), 'fail', 'DOC-8: no word on deleting copies');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(', "Copy <name> has been idle for over a week"', '')))), 'fail', 'DOC-8: the finding\u2019s title left out');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*A lake connection\*\*[^\n]*\n/, '')))), 'fail', 'DOC-9: no word on /api/status');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*Crashes:\*\*[^\n]*\n/, '')))), 'fail', 'DOC-10: no word on restarts');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- Every route answers[^\n]*\n/, '')))), 'fail', 'DOC-11: no word on slow routes');
  for (const [cut, what] of [[/ rather than one per row/, 'a query per row'], [/, index what it filters and joins by/, 'an index'], [/, and put an outside call in a job rather than make the person wait on it/, 'outside calls']] as const) {
    assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(cut, '')))), 'fail', `DOC-11: no word on ${what}`);
  }
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*A table that only grows:\*\*[^\n]*\n/, '')))), 'fail', 'DOC-12: no word on tables that only grow');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(/- \*\*A lake query:\*\*[^\n]*\n/, '')))), 'fail', 'DOC-13: no line for lake-unbounded-query');
  assert.equal(outcome('LINT:agents-md', await broken((d) => writeFileSync(join(d, 'AGENTS.md'), readFileSync(join(GOOD, 'AGENTS.md'), 'utf8').replace(', "Lake queries read more than they need"', '')))), 'fail', 'DOC-13: the lake line without its title');
  assert.equal(outcome('LINT:descriptor', await broken((d) => writeFileSync(join(d, 'server', 'health.ts'), "export const a = { status: 'ok' }; export const b = { status: 'ok' };\n"))), 'fail', 'find occurs twice');
  assert.equal(outcome('LINT:fixed-values', await broken((d) => writeFileSync(join(d, 'migrations', '0002_status.sql'), 'CREATE TABLE tasks (id uuid PRIMARY KEY, status text NOT NULL);\n'))), 'fail');
  assert.equal(outcome('LINT:api', await broken((d) => writeFileSync(join(d, 'web', 'src', 'Notes.tsx'), "export const save = () => fetch('/api/notes', { method: 'POST' });\n"))), 'fail', 'AMCP-9: a fetch outside api.ts');
  assert.equal(outcome('LINT:api', await broken((d) => writeFileSync(join(d, 'web', 'src', 'Notes.tsx'), 'export const live = () => new WebSocket("wss://x");\n'))), 'fail', 'AMCP-9: a socket outside api.ts');
  assert.equal(outcome('LINT:api', await broken((d) => writeFileSync(join(d, 'web', 'src', 'api.ts'), readFileSync(join(GOOD, 'web', 'src', 'api.ts'), 'utf8').replace("'/api/health'", "'/api/notes'")))), 'fail', 'AMCP-9: a call to a route the server lacks');
  assert.equal(outcome('LINT:api', await broken((d) => writeFileSync(join(d, 'web', 'src', 'api.ts'), readFileSync(join(GOOD, 'web', 'src', 'api.ts'), 'utf8').replace("'/api/health'", "'/internal/health'")))), 'fail', 'AMCP-9: a call outside /api');
  assert.equal(outcome('LINT:app-pages', await broken((d) => rmSync(join(d, 'web', 'src', 'Notes.tsx')))), 'fail', 'no Notes page');
  assert.equal(outcome('LINT:app-pages', await broken((d) => writeFileSync(join(d, 'web', 'src', 'main.tsx'), "import { App } from './App.tsx';\n"))), 'fail', '/notes not routed');
  assert.equal(outcome('LINT:app-pages', await broken((d) => writeFileSync(join(d, 'migrations', '0002_welcome.sql'), 'CREATE TABLE welcome_views (id uuid PRIMARY KEY);\n'))), 'fail', 'a migration for the welcome page');
  assert.equal(outcome('LINT:build-outputs', await broken((d) => writeFileSync(join(d, '.gitignore'), 'node_modules/\n'))), 'fail', 'dist not ignored');
});
