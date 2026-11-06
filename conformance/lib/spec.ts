// The rules, read from SPEC.md itself: each `- **ID:**` or `- **ID (SHOULD):**` line, and the tests its text names
// (`LINT:name`, `CONF:name`). The suite reports every rule the spec has, so a rule nobody tests can't go unnoticed.
import { readFileSync } from 'node:fs';

export type Level = 'MUST' | 'SHOULD';
export interface Rule { id: string; level: Level; text: string; tests: string[]; review: boolean; line: number }

const RULE = /^- \*\*([A-Z]+-\d+)( \(SHOULD\))?:\*\* (.*)$/;
const TEST = /`((?:LINT|CONF):[a-z0-9-]+)`/g;

export function readRules(specPath: string): Rule[] {
  return parseRules(readFileSync(specPath, 'utf8'));
}

export function parseRules(spec: string): Rule[] {
  const rules: Rule[] = [];
  let current: Rule | null = null;
  for (const [i, line] of spec.split('\n').entries()) {
    const m = RULE.exec(line);
    if (m) {
      current = { id: m[1]!, level: m[2] ? 'SHOULD' : 'MUST', text: m[3]!, tests: [], review: false, line: i + 1 };
      rules.push(current);
    } else if (current && (/^\s+\S/.test(line) || line.trim() === '')) {
      current.text += `\n${line}`; // a rule's continuation lines (lists, code) belong to it
    } else current = null;
  }
  for (const r of rules) {
    r.tests = [...new Set([...r.text.matchAll(TEST)].map((t) => t[1]!))];
    r.review = /`review`/.test(r.text);
  }
  return rules;
}

// Each rule ID defined on more than one rule line, with every line it's on. Only a definition counts: a rule
// mentioned in prose or a table isn't a rule line, so parallel PRs that each take the same next ID are caught here.
export function duplicateRules(rules: Rule[]): string[] {
  const lines = new Map<string, number[]>();
  for (const r of rules) lines.set(r.id, [...(lines.get(r.id) ?? []), r.line]);
  return [...lines]
    .filter(([, at]) => at.length > 1)
    .map(([id, at]) => `${id} is defined more than once, on lines ${at.join(', ')} of SPEC.md: give the later one the next free ID`);
}
