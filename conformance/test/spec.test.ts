// Every test SPEC.md names exists, every test that exists is named by a rule, and every rule is proven somehow.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONF_TESTS } from '../conf/index.ts';
import { lint } from '../lint/index.ts';
import { duplicateRules, parseRules, readRules } from '../lib/spec.ts';

const rules = readRules(join(import.meta.dirname, '..', '..', 'SPEC.md'));
const implemented = new Set([...Object.keys(lint), ...CONF_TESTS]);

test('the spec has its rules, each with a test or a review', () => {
  assert.ok(rules.length >= 60, `${rules.length} rules`);
  for (const r of rules) assert.ok(r.tests.length || r.review, `${r.id} has no test and isn't marked review`);
});

test('the real SPEC.md defines each rule ID once', () => {
  assert.deepEqual(duplicateRules(rules), []);
});

test('DOC-4 defined twice fails, naming DOC-4 and both lines', () => {
  const spec = [
    '## 9. Docs',
    '',
    '- **DOC-4:** `agc now` is in AGENTS.md. `LINT:agents-md`',
    '- **DOC-5:** Another rule. `review`',
    '- **DOC-4:** A second rule that took the same next free ID. `review`',
  ].join('\n');
  assert.deepEqual(duplicateRules(parseRules(spec)), [
    'DOC-4 is defined more than once, on lines 3, 5: give the later one the next free ID',
  ]);
});

test('DOC-4 mentioned in prose and in a table but defined once passes', () => {
  const spec = [
    'DOC-4 says how `agc now` reads; see **DOC-4** below.',
    '',
    '| Rule | Test |',
    '| --- | --- |',
    '| DOC-4 | `LINT:agents-md` |',
    '| **DOC-4:** | again |',
    '',
    '- **DOC-4:** `agc now` is in AGENTS.md, as DOC-4 asks. `LINT:agents-md`',
    '- **DOC-5 (SHOULD):** Follows DOC-4. `review`',
  ].join('\n');
  assert.equal(parseRules(spec).filter((r) => r.id === 'DOC-4').length, 1);
  assert.deepEqual(duplicateRules(parseRules(spec)), []);
});

test('every test the spec names is implemented', () => {
  const named = new Set(rules.flatMap((r) => r.tests));
  for (const t of named) assert.ok(implemented.has(t), `${t} is named in SPEC.md but not implemented`);
});

test('every implemented test is named by a rule', () => {
  const named = new Set(rules.flatMap((r) => r.tests));
  for (const t of implemented) assert.ok(named.has(t), `${t} is implemented but no rule names it`);
});
