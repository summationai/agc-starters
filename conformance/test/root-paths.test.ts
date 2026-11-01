// RAC-19: .github/root-paths.json, the list root Crew reads from main before it pushes or merges here (agent-runtime-v2's
// src/broker/root-paths.ts). A file Crew can't read refuses every change, so this checks it holds version 2 in full, as that
// reader requires, and the split rc chose: workflows and the list itself denied; SPEC.md and every stack's dependencies and
// base images held for a person to merge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const list = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '.github', 'root-paths.json'), 'utf8')) as Record<string, unknown>;
const paths = (value: unknown) => Array.isArray(value) && value.every((p) => typeof p === 'string' && p.length > 0 && !p.startsWith('!'));

test('RAC-19: root-paths.json is version 2 with its deny and hold lists, as root Crew reads it', () => {
  assert.equal(list.version, 2);
  assert.ok(paths(list.deny), 'deny: a list of non-empty globs, none negated');
  assert.ok(paths(list.hold), 'hold: a list of non-empty globs, none negated');
  const deny = list.deny as string[], hold = list.hold as string[];
  assert.deepEqual(deny.filter((glob) => hold.includes(glob)), [], 'no path both denied and held');
});

test('RAC-19: workflows and the list itself are a person\'s alone; SPEC.md, dependencies and base images are held for a person to merge', () => {
  assert.deepEqual(list.deny, ['.github/**']);
  assert.deepEqual(list.hold, ['SPEC.md', '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/.npmrc', '**/.nvmrc',
    '**/pyproject.toml', '**/uv.lock', '**/Dockerfile', '**/Dockerfile.*', '**/.dockerignore']);
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
const held = (path: string) => (list.hold as string[]).some((glob) => globRe(glob).test(path));
const denied = (path: string) => (list.deny as string[]).some((glob) => globRe(glob).test(path));

test('RAC-19: the stacks\' real dependency and image files are held, their source is open, and workflows are denied', () => {
  for (const path of ['SPEC.md', 'typescript/package.json', 'typescript/package-lock.json', 'python/pyproject.toml', 'python/uv.lock', 'python/package.json',
    'conformance/package.json', 'conformance/package-lock.json']) assert.ok(held(path), `${path} is held`);
  for (const path of ['typescript/server/db.ts', 'python/app/db.py', 'conformance/conf/index.ts', 'README.md', 'typescript/AGENTS.md']) assert.ok(!held(path) && !denied(path), `${path} is open`);
  for (const path of ['.github/workflows/conformance.yml', '.github/root-paths.json']) assert.ok(denied(path), `${path} is denied`);
});
