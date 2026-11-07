// RAC-19: .github/root-paths.json, the list root Crew reads from main before it pushes or merges here (agent-runtime-v2's
// src/broker/root-paths.ts). A file Crew can't read refuses every change, so this checks it holds version 2 in full, as that
// reader requires, and wave 2's split (rc, 6 Nov 2026: "go ultra lenient"): nothing denied; the list itself held for a person;
// the workflows secure, merged on a security reviewer's approval of the exact head (RINF-11); everything else product.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const list = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '.github', 'root-paths.json'), 'utf8')) as Record<string, unknown>;
const paths = (value: unknown) => Array.isArray(value) && value.every((p) => typeof p === 'string' && p.length > 0 && !p.startsWith('!'));

test('RAC-19, RINF-11: root-paths.json is version 2 with its deny, hold and secure lists, as root Crew reads it', () => {
  assert.equal(list.version, 2);
  assert.ok(paths(list.deny), 'deny: a list of non-empty globs, none negated');
  assert.ok(paths(list.hold), 'hold: a list of non-empty globs, none negated');
  assert.ok(paths(list.secure), 'secure: a list of non-empty globs, none negated');
  const deny = list.deny as string[], hold = list.hold as string[];
  assert.deepEqual(deny.filter((glob) => hold.includes(glob)), [], 'no path both denied and held');
});

test('RAC-19, RINF-11: wave 2: nothing denied, the list itself held, the workflows secure', () => {
  assert.deepEqual(list.deny, []);
  assert.deepEqual(list.hold, ['.github/root-paths.json']);
  assert.deepEqual(list.secure, ['.github/**']);
});

// The globs match as root Crew's reader matches them (agent-runtime-v2 src/broker/root-paths.ts): the whole path, `*` within
// one segment, `**/` zero or more whole segments. Each stack's real dependency files are held, and its source isn't.
function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) { re += '(?:[^/]+/)*'; i += 3; }
    else if (glob.startsWith('/**', i) && i + 3 === glob.length) { re += '(?:/[^/]+)*'; i += 3; }
    else if (glob.startsWith('**', i)) { re += '.*'; i += 2; }
    else if (glob[i] === '*') { re += '[^/]*'; i += 1; }
    else { re += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(`^${re}$`);
}
// A path's tier, strictest first: deny, then hold, then secure, else product (RINF-11).
const tier = (path: string) => (list.deny as string[]).some((glob) => globRe(glob).test(path)) ? 'deny'
  : (list.hold as string[]).some((glob) => globRe(glob).test(path)) ? 'hold'
  : (list.secure as string[]).some((glob) => globRe(glob).test(path)) ? 'secure' : 'product';

test('RAC-19, RINF-11: the list is held, workflows are secure, and SPEC.md, dependencies, images and source are product', () => {
  assert.equal(tier('.github/root-paths.json'), 'hold', 'the list itself, though under .github/');
  for (const path of ['.github/workflows/conformance.yml', '.github/dependabot.yml']) assert.equal(tier(path), 'secure', `${path} is secure`);
  for (const path of ['SPEC.md', 'typescript/package.json', 'typescript/package-lock.json', 'python/pyproject.toml', 'python/uv.lock', 'typescript/Dockerfile',
    'conformance/package.json', 'typescript/server/db.ts', 'python/app/db.py', 'conformance/conf/index.ts', 'README.md', 'typescript/AGENTS.md']) assert.equal(tier(path), 'product', `${path} is product`);
});
