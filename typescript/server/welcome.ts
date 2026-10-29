// GET /api/welcome: what the welcome page shows (SPEC.md APP-8 to APP-10). Every claim is one the process can back:
// where it runs comes from what agent.cloud sets, "running" only for what was just checked, and nothing else from the
// manifest or the environment leaves the process. Remove this file, and its route in app.ts, with the welcome page.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { parse } from 'smol-toml';

type Run = 'mirror' | 'live' | 'rehearsal' | 'preview' | 'unknown';
type Database = { state: 'running'; migrations: number; checked_at: string } | { state: 'not verified'; reason: 'unreachable' | 'timeout' | 'query_failed'; checked_at: string };

// The manifest, read once at start: the app's name, whether it was started from Start, whether it has a worker, and how
// many checks it runs.
const manifest = parse(readFileSync('agentcloud.toml', 'utf8')) as {
  app?: { name?: string; started?: unknown }; service?: { worker?: unknown }; check?: { smoke?: unknown[]; invariant?: unknown[] };
};

// APP-9: where this process runs, first match wins. AGENTCLOUD_MIRROR is agc's; agent.cloud reserves the name, so no
// release carries it. AGC_RUN is set by agent.cloud after the app's own env, so an app can't claim to be live.
export function runOf(env: NodeJS.ProcessEnv): Run {
  if (env.AGENTCLOUD_MIRROR) return 'mirror';
  if (env.AGC_RUN === 'live') return 'live';
  if (env.AGC_RUN === 'rehearsal') return 'rehearsal';
  if (env.AGC_PREVIEW_EXPIRES_AT) return 'preview';
  return 'unknown';
}

// APP-8: what agc said about production when this mirror started (MREL), or null: unknown, so the page claims nothing.
export function productionOf(env: NodeJS.ProcessEnv): { url: string; version: number | null } | null {
  if (!env.AGENTCLOUD_MIRROR || env.AGENTCLOUD_RELEASED === undefined || !env.AGENTCLOUD_APP_URL) return null;
  let url: URL;
  try { url = new URL(env.AGENTCLOUD_APP_URL); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== env.AGENTCLOUD_APP_URL) return null;
  if (env.AGENTCLOUD_RELEASED === '') return { url: url.origin, version: null };
  return /^[1-9]\d*$/.test(env.AGENTCLOUD_RELEASED) ? { url: url.origin, version: Number(env.AGENTCLOUD_RELEASED) } : null;
}

const iso = (s: string | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// APP-10: the database check. Its own connection for each probe, one probe at a time shared by every caller, and each
// result kept for 60 s, so a public page fetched by anyone wakes the database at most once a minute. A probe that hasn't
// answered in 2 s is torn down, connection and all, so nothing it started outlives it. /api/health never gets here.
let last: { at: number; result: Database } | undefined;
let running: Promise<Database> | undefined;

async function probe(): Promise<Database> {
  const checked = () => new Date().toISOString();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on('error', () => {}); // a torn-down or lost connection is just this probe's "not verified"
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), 2_000); });
  try {
    const answer = await Promise.race([client.connect().then(() => client.query<{ n: string }>('SELECT count(*) AS n FROM agentcloud_migrations')), timeout]);
    if (answer === 'timeout') {
      // Torn down, not awaited: a socket waiting on a frozen database is destroyed, and the query it carried with it.
      (client as unknown as { connection?: { stream?: { destroy: () => void } } }).connection?.stream?.destroy();
      return { state: 'not verified', reason: 'timeout', checked_at: checked() };
    }
    return { state: 'running', migrations: Number(answer.rows[0]!.n), checked_at: checked() };
  } catch (e) {
    // Postgres answered with an error (no ledger yet, say): the database is there, the check failed. Otherwise no connection.
    const answered = typeof (e as { code?: unknown }).code === 'string' && /^[0-9A-Z]{5}$/.test((e as { code: string }).code);
    return { state: 'not verified', reason: answered ? 'query_failed' : 'unreachable', checked_at: checked() };
  } finally {
    clearTimeout(timer);
    void client.end().catch(() => {});
  }
}

async function database(now = Date.now()): Promise<Database> {
  if (last && now - last.at < 60_000) return last.result;
  running ??= probe().then((result) => { last = { at: Date.now(), result }; return result; }).finally(() => { running = undefined; });
  return running;
}

const pair = (url: string | undefined, token: string | undefined) => (url && token ? 'configured' : 'not set up');

export async function welcome(env: NodeJS.ProcessEnv = process.env) {
  const db = await database();
  return {
    app: String(manifest.app?.name ?? ''),
    stack: 'typescript',
    run: runOf(env),
    // APP-8, APP-14: "live" only when agc init wrote exactly that (an app made through Start); never any other value.
    started: manifest.app?.started === 'live' ? 'live' as const : null,
    parts: {
      web: 'running', api: 'running', database: db.state,
      worker: manifest.service?.worker ? 'configured' : 'not set up',
      signin: pair(env.AGC_AUTH_URL, env.AGC_AUTH_TOKEN),
      email: pair(env.AGC_EMAIL_URL, env.AGC_EMAIL_TOKEN),
    },
    database: db.state === 'running' ? { migrations: db.migrations, checked_at: db.checked_at } : { migrations: null, reason: db.reason, checked_at: db.checked_at },
    checks: { smoke: manifest.check?.smoke?.length ?? 0, invariants: manifest.check?.invariant?.length ?? 0 },
    preview_expires_at: iso(env.AGC_PREVIEW_EXPIRES_AT),
    production: productionOf(env),
  };
}
