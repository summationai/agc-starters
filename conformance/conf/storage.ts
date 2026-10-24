// STOR-1 to STOR-8: storage helpers and example routes. Signing and the S3 calls are the stack's own SDK's, so the stack's own tests
// prove them against a fake S3 endpoint with fake keys: the command `conformance.toml` names as `[storage] test`, run in
// the starter's folder once its dependencies are installed (CI installs them before the suite runs).
import { fail, pass, type TestResult } from '../lib/report.ts';
import { run } from '../lib/sh.ts';
import type { Stack } from '../lib/stack.ts';

export async function storageTests(s: Stack): Promise<TestResult> {
  const cmd = s.descriptor.storageTest;
  if (!cmd) return fail('conformance.toml names no [storage] test');
  const r = await run('sh', ['-c', cmd], { cwd: s.dir, timeoutMs: 300_000 });
  const lines = (r.stdout + r.stderr).trim().split('\n').filter((l) => l.trim());
  const counts = lines.filter((l) => /\b(pass|fail|passed|failed)\b/.test(l));
  const tail = (r.code === 0 && counts.length ? counts.slice(-2) : lines.slice(-4)).map((l) => l.trim()).join(' | ');
  return r.code === 0 ? pass(`${cmd}: ${tail}`) : fail(`${cmd} failed (${r.code}): ${tail}`);
}
