// A stack directory as the platform sees it: its manifest, its descriptor, its language, and the files `agc ship`
// would send (git-tracked plus untracked-but-not-ignored, exactly as packages/cli/src/commands/ship.ts snapshots).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'smol-toml';
import { appConfig, type AppConfig } from '../vendor/agc/config.ts';
import { stackOf } from '../vendor/agc/stack.ts';
import { run } from './sh.ts';

export type Language = 'node' | 'python';
export interface Reload { file: string; find: string; replace: string; url?: string; expect: string }
export interface Descriptor { setup?: string; storageTest?: string; reload: { api?: Reload; ui?: Reload; worker?: Reload } }
export interface Stack {
  dir: string;
  name: string;
  language: Language;
  raw: Record<string, unknown>; // agentcloud.toml as parsed
  app: AppConfig;
  descriptor: Descriptor;
  files: string[]; // what agc ship would send
}

const table = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// How agent.cloud decides (PYB-1), with its own code: a uv project is Python; otherwise package.json is Node.
export function languageOf(dir: string): Language | null {
  const py = join(dir, 'pyproject.toml');
  const stack = stackOf((n) => existsSync(join(dir, n)), existsSync(py) ? readFileSync(py, 'utf8') : null);
  if (stack === 'python') return 'python';
  return existsSync(join(dir, 'package.json')) ? 'node' : null; // a Dockerfile is LINT:no-dockerfile's business
}

export async function shippedFiles(dir: string): Promise<string[]> {
  const inGit = (await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })).stdout.trim() === 'true';
  if (inGit) {
    const out = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '.'], { cwd: dir });
    return out.stdout.split('\0').filter((f) => f && existsSync(join(dir, f)) && !statSync(join(dir, f)).isDirectory()).sort();
  }
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
    if (n === '.git' || n === 'node_modules' || n === '.venv') return [];
    const full = join(d, n);
    return statSync(full).isDirectory() ? walk(full) : [relative(dir, full)];
  });
  return walk(dir).sort();
}

export async function readStack(dir: string): Promise<Stack> {
  const manifestPath = join(dir, 'agentcloud.toml');
  if (!existsSync(manifestPath)) throw new Error(`${dir} has no agentcloud.toml`);
  const raw = parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const language = languageOf(dir);
  if (!language) throw new Error(`${dir} is neither a uv project (pyproject.toml with dependencies) nor a Node app (package.json)`);
  const dPath = join(dir, 'conformance.toml');
  const d = existsSync(dPath) ? (parse(readFileSync(dPath, 'utf8')) as Record<string, unknown>) : {};
  const reload = (v: unknown): Reload | undefined => {
    const t = table(v);
    return typeof t.file === 'string' && typeof t.find === 'string' && typeof t.replace === 'string' && typeof t.expect === 'string'
      ? { file: t.file, find: t.find, replace: t.replace, expect: t.expect, ...(typeof t.url === 'string' ? { url: t.url } : {}) } : undefined;
  };
  const r = table(d.reload);
  const setup = table(d.dev).setup;
  const storageTest = table(d.storage).test;
  return {
    dir, name: String(table(raw.app).name ?? ''), language, raw, app: appConfig({ path: manifestPath, app: table(raw.app) as { name?: string }, raw }),
    descriptor: { ...(typeof setup === 'string' ? { setup } : {}), ...(typeof storageTest === 'string' ? { storageTest } : {}), reload: { api: reload(r.api), ui: reload(r.ui), worker: reload(r.worker) } },
    files: await shippedFiles(dir),
  };
}
