// RAC-19: .github/root-paths.json, the list root Crew reads from main before it pushes or merges here (agent-runtime-v2's
// src/broker/root-paths.ts). A file Crew can't read refuses every change, so this checks it holds version 2 in full, as that
// reader requires, and the split rc chose: workflows and the list itself denied, SPEC.md held for a person to merge.
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

test('RAC-19: workflows and the list itself are a person\'s alone; SPEC.md is held for a person to merge; nothing else is', () => {
  assert.deepEqual(list.deny, ['.github/**']);
  assert.deepEqual(list.hold, ['SPEC.md']);
});
