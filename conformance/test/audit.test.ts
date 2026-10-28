// Each starter's package-lock.json is what every new app installs with `npm ci` (the Python starter's builds the shared React
// UI), so a high-severity advisory in it reaches every app made from the starter. npm audit reads the registry's advisories as
// of the run: a newly published one turns this red with no change here, and `npm audit fix --package-lock-only` in the
// stack's folder fixes it within package.json's ranges.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../lib/sh.ts';

const ROOT = join(import.meta.dirname, '..', '..');

// Every stack (a folder with agentcloud.toml) that ships a lockfile, so a new stack is covered without editing this file.
const STACKS = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'agentcloud.toml')) && existsSync(join(ROOT, d.name, 'package-lock.json')))
  .map((d) => d.name)
  .sort();

interface Audit {
  error?: { summary?: string };
  vulnerabilities?: Record<string, { severity: string; range: string; fixAvailable: unknown }>;
}

test('the audit covers both starters\' lockfiles', () => {
  // A stack that lost its agentcloud.toml or lockfile would drop out of the audit silently; this keeps the two known ones in.
  for (const stack of ['python', 'typescript']) assert.ok(STACKS.includes(stack), `${stack}/package-lock.json isn't audited: found ${STACKS.join(', ')}`);
});

for (const stack of STACKS) {
  test(`the ${stack} starter's lockfile has no high or critical npm audit finding`, async () => {
    // npm audit reads package-lock.json alone; it needs no node_modules.
    const r = await run('npm', ['audit', '--json', '--audit-level=high'], { cwd: join(ROOT, stack), timeoutMs: 120_000 });
    let audit: Audit;
    try {
      audit = JSON.parse(r.stdout) as Audit;
    } catch {
      assert.fail(`npm audit gave no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')}`);
    }
    // An audit that couldn't run proves nothing, so it fails rather than passes.
    assert.equal(audit.error, undefined, `npm audit couldn't run: ${audit.error?.summary}`);
    const high = Object.entries(audit.vulnerabilities ?? {})
      .filter(([, v]) => v.severity === 'high' || v.severity === 'critical')
      .map(([name, v]) => `${name} ${v.range} (${v.severity})`);
    assert.deepEqual(high, [], `${stack}/package-lock.json has high-severity advisories: ${high.join(', ')}. Run npm audit fix --package-lock-only in ${stack}/.`);
    assert.equal(r.code, 0, `npm audit --audit-level=high exited ${r.code}`);
  });
}
