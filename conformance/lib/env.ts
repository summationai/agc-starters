// One conformance run's world, on a private Docker network:
//   db        Postgres 18 that accepts only TLS, with a certificate for "db" from a throwaway CA
//   platform  the fake platform (platform/server.ts): test-mode sign-in and email
//   app       the stack's image, as web and worker containers, each capped at 512 MiB with a read-only filesystem
// The harness reaches each through a port published on 127.0.0.1, and rewrites the in-network addresses the app sees
// (http://platform:8099, http://app:<port>) to those, so agc's own runFlow can drive a sign-in end to end.
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { dockerfileFor, forwarding } from '../images/index.ts';
import { LEDGER, listMigrations } from '../vendor/agc/migrations.ts';
import { must, run, sleep, until } from './sh.ts';
import type { Stack } from './stack.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLATFORM = 'http://platform:8099';
export const AUTH_TOKEN = 'agca_conformance';
export const EMAIL_TOKEN = 'agce_conformance';

export interface Container { name: string; port?: number }

export class Env {
  readonly id = randomBytes(4).toString('hex');
  readonly net = `agc-conf-${this.id}`;
  readonly tmp = mkdtempSync(join(tmpdir(), 'agc-conf-'));
  readonly certs = join(this.tmp, 'certs'); // the CA only, mounted into app containers at /certs
  readonly password = randomBytes(12).toString('hex');
  readonly containers: string[] = [];
  image = '';
  dbPort = 0;
  platformPort = 0;
  private ca = '';
  readonly stack: Stack;

  constructor(stack: Stack) {
    this.stack = stack;
  }

  // In-network addresses, as the app sees them.
  get databaseUrl() { return `postgresql://app:${this.password}@db:5432/app?sslmode=verify-full`; }
  get authUrl() { return `${PLATFORM}/auth/test/conformance`; }
  appEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PORT: String(this.stack.app.web.port), DATABASE_URL: this.databaseUrl,
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem', SSL_CERT_FILE: '/certs/ca.pem', // the throwaway CA, as Neon's is trusted in production
      ...(this.stack.language === 'python' ? { PGSSLROOTCERT: 'system' } : {}),
      AGC_EMAIL_URL: `${PLATFORM}/email/v1/messages`, AGC_EMAIL_TOKEN: EMAIL_TOKEN,
      AGC_AUTH_URL: this.authUrl, AGC_AUTH_TOKEN: AUTH_TOKEN,
      AGENTCLOUD_CONFORMANCE: '1',
      WORKER_POLL_SECONDS: '0.5', WORKER_IDLE_MAX_SECONDS: '4', // JOB-4, scaled down so no test waits out a long sleep
      ...extra,
    };
  }

  // A fetch that reaches in-network addresses through their published ports.
  fetchFor(app: Container): typeof fetch {
    const map: [string, string][] = [[PLATFORM, `http://127.0.0.1:${this.platformPort}`], [`http://app:${this.stack.app.web.port}`, `http://127.0.0.1:${app.port}`]];
    return (input, init) => {
      let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      for (const [from, to] of map) if (url.startsWith(from)) url = to + url.slice(from.length);
      return fetch(url, init);
    };
  }
  base(app: Container) { return `http://127.0.0.1:${app.port}`; }
  platformBase() { return `http://127.0.0.1:${this.platformPort}`; }

  db(): pg.Client {
    const c = new pg.Client({ host: '127.0.0.1', port: this.dbPort, user: 'app', password: this.password, database: 'app', ssl: { ca: this.ca, servername: 'db' } });
    c.on('error', () => {});
    return c;
  }
  async sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = this.db();
    await c.connect();
    try { return (await c.query<T>(text, params)).rows; } finally { await c.end(); }
  }

  private async docker(args: string[], timeoutMs = 600_000) { return must('docker', args, { timeoutMs }); }
  private async publishedPort(name: string, port: number): Promise<number> {
    const out = await this.docker(['port', name, `${port}/tcp`]);
    return Number(/:(\d+)\s*$/m.exec(out)?.[1] ?? 0);
  }

  private async makeCerts() {
    mkdirSync(this.certs, { recursive: true });
    const k = (f: string) => join(this.tmp, f);
    await must('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k('ca.key'), '-out', join(this.certs, 'ca.pem'), '-days', '2', '-subj', '/CN=agent.cloud conformance CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    await must('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', k('server.key'), '-out', k('server.csr'), '-subj', '/CN=db']);
    writeFileSync(k('ext'), 'subjectAltName=DNS:db\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    await must('openssl', ['x509', '-req', '-in', k('server.csr'), '-CA', join(this.certs, 'ca.pem'), '-CAkey', k('ca.key'), '-CAcreateserial', '-out', k('server.crt'), '-days', '2', '-extfile', k('ext')]);
    writeFileSync(k('pg_hba.conf'), 'local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\n');
    chmodSync(this.certs, 0o755);
    chmodSync(join(this.certs, 'ca.pem'), 0o644);
    this.ca = (await must('cat', [join(this.certs, 'ca.pem')]));
  }

  async startPlatform() {
    await this.docker(['network', 'create', this.net]);
    await this.makeCerts();
    const db = `db-${this.id}`;
    this.containers.push(db);
    await this.docker(['run', '-d', '--name', db, '--network', this.net, '--network-alias', 'db', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=app', '-e', `POSTGRES_PASSWORD=${this.password}`, '-e', 'POSTGRES_DB=app',
      '-v', `${this.tmp}:/in:ro`, '--entrypoint', 'sh', 'postgres:18', '-c',
      'mkdir -p /tls && cp /in/server.crt /in/server.key /in/pg_hba.conf /tls/ && chown postgres:postgres /tls/* && chmod 600 /tls/server.key && '
      + 'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tls/server.key -c hba_file=/tls/pg_hba.conf '
      + '-c log_statement=all -c log_connections=on']); // every statement, timestamped: how JOB-4\'s polling is timed
    const fp = `platform-${this.id}`;
    this.containers.push(fp);
    await this.docker(['run', '-d', '--name', fp, '--network', this.net, '--network-alias', 'platform', '-p', '127.0.0.1::8099',
      '-v', `${join(HERE, '..', 'platform')}:/fp:ro`, '-e', 'PORT=8099', '-e', `AUTH_TOKEN=${AUTH_TOKEN}`, '-e', `EMAIL_TOKEN=${EMAIL_TOKEN}`,
      'node:24-slim', 'node', '/fp/server.ts']);
    this.dbPort = await this.publishedPort(db, 5432);
    this.platformPort = await this.publishedPort(fp, 8099);
    const up = await until(60_000, async () => { await this.sql('SELECT 1'); return true; }, 500);
    if (!up) throw new Error('the fake database didn’t accept a verified TLS connection within 60 s');
    const fpUp = await until(30_000, async () => ((await fetch(`${this.platformBase()}/_fake/health`)).ok ? true : undefined), 500);
    if (!fpUp) throw new Error('the fake platform didn’t start within 30 s');
  }

  // As `agc migrate` does (packages/cli/src/commands/migrate.ts): each file once, in order, in its own transaction.
  async migrate(): Promise<string[]> {
    const c = this.db();
    await c.connect();
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const done = new Set((await c.query<{ name: string }>(`SELECT name FROM ${LEDGER}`)).rows.map((r) => r.name));
      const applied: string[] = [];
      for (const m of listMigrations(join(this.stack.dir, this.stack.app.db.migrations))) {
        if (done.has(m.stem)) continue;
        if (!m.noTransaction) await c.query('BEGIN');
        try {
          await c.query(m.sql);
          await c.query(`INSERT INTO ${LEDGER} (name, checksum) VALUES ($1, $2)`, [m.stem, m.checksum]);
          if (!m.noTransaction) await c.query('COMMIT');
        } catch (e) {
          if (!m.noTransaction) await c.query('ROLLBACK').catch(() => {});
          throw new Error(`migration ${m.stem} failed: ${(e as Error).message}`);
        }
        applied.push(m.stem);
      }
      return applied;
    } finally {
      await c.end();
    }
  }

  // The build context is exactly what agc ship would send, plus the default Dockerfile.
  async build(): Promise<{ seconds: number; bytes: number; log: string }> {
    const ctx = join(this.tmp, 'context');
    for (const f of this.stack.files) {
      mkdirSync(dirname(join(ctx, f)), { recursive: true });
      copyFileSync(join(this.stack.dir, f), join(ctx, f));
    }
    const hasUi = this.stack.files.includes('package.json');
    writeFileSync(join(ctx, 'Dockerfile'), dockerfileFor(this.stack.language, this.stack.app.web.command, hasUi));
    this.image = `agc-conf-${this.stack.language}-${this.id}`;
    const t0 = Date.now();
    const r = await run('docker', ['build', '-t', this.image, ctx], { timeoutMs: 1_200_000 });
    if (r.code !== 0) throw Object.assign(new Error('the image didn’t build'), { log: (r.stderr || r.stdout).split('\n').slice(-30).join('\n') });
    const bytes = Number((await this.docker(['image', 'inspect', '-f', '{{.Size}}', this.image])).trim());
    return { seconds: (Date.now() - t0) / 1000, bytes, log: r.stderr.slice(-2000) };
  }

  // Web as the platform runs it: the image's own CMD, 512 MiB, nothing writable but /tmp.
  async web(name: string, env: Record<string, string> = this.appEnv(), opts: { alias?: boolean; mounts?: string[] } = {}): Promise<Container> {
    const full = `${name}-${this.id}`;
    this.containers.push(full);
    const port = this.stack.app.web.port;
    await this.docker(['run', '-d', '--name', full, '--network', this.net, ...(opts.alias === false ? [] : ['--network-alias', 'app']),
      '--memory', '512m', '--memory-swap', '512m', '--read-only', '--tmpfs', '/tmp:rw,size=64m', '-v', `${this.certs}:/certs:ro`,
      ...(opts.mounts ?? []).flatMap((m) => ['-v', m]), '-p', `127.0.0.1::${port}`, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), this.image]);
    return { name: full, port: await this.publishedPort(full, port) };
  }

  // The worker as the platform runs it: the same image, its command under the signal wrapper.
  async worker(name: string, env: Record<string, string> = this.appEnv()): Promise<Container> {
    const full = `${name}-${this.id}`;
    this.containers.push(full);
    await this.docker(['run', '-d', '--name', full, '--network', this.net, '--memory', '512m', '--memory-swap', '512m', '--read-only',
      '--tmpfs', '/tmp:rw,size=64m', '-v', `${this.certs}:/certs:ro`, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      this.image, ...forwarding(this.stack.app.worker!.command)]);
    return { name: full };
  }

  async ready(c: Container, ms = 30_000): Promise<number | undefined> {
    const t0 = Date.now();
    const ok = await until(ms, async () => ((await fetch(`${this.base(c)}${this.stack.app.web.health ?? '/api/health'}`, { signal: AbortSignal.timeout(2000) })).status === 200 ? true : undefined), 250);
    return ok ? Date.now() - t0 : undefined;
  }

  async logs(c: Container): Promise<string[]> {
    const r = await run('docker', ['logs', c.name]);
    return `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.trim());
  }
  async inspect(c: Container): Promise<{ running: boolean; exitCode: number; oom: boolean }> {
    const out = await this.docker(['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', c.name]);
    const [running, code, oom] = out.trim().split(' ');
    return { running: running === 'true', exitCode: Number(code), oom: oom === 'true' };
  }
  async memoryMiB(c: Container): Promise<number> {
    const out = await this.docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', c.name]);
    const m = /([\d.]+)\s*([KMG]i?B)/.exec(out);
    if (!m) return 0;
    const n = Number(m[1]);
    return m[2]!.startsWith('G') ? n * 1024 : m[2]!.startsWith('K') ? n / 1024 : n;
  }
  // SIGTERM through `docker stop`, as Kubernetes sends it; seconds until the container exited.
  async stop(c: Container, graceSeconds: number): Promise<{ seconds: number; exitCode: number }> {
    const t0 = Date.now();
    await run('docker', ['stop', '-t', String(graceSeconds), c.name], { timeoutMs: (graceSeconds + 30) * 1000 });
    const s = await this.inspect(c);
    return { seconds: (Date.now() - t0) / 1000, exitCode: s.exitCode };
  }
  // Every statement the database ran, from its own log, timestamped.
  async statements(): Promise<{ at: number; text: string }[]> {
    const r = await run('docker', ['logs', `db-${this.id}`]);
    // A statement's later lines arrive as tab-indented continuation lines; simple and extended protocol both count.
    const statements: { at: number; text: string }[] = [];
    for (const l of `${r.stdout}${r.stderr}`.split('\n')) {
      if (/LOG:\s+(statement|execute [^:]*):/.test(l)) statements.push({ at: Date.parse(`${l.slice(0, 23).replace(' ', 'T')}Z`), text: l });
      else if (l.startsWith('\t') && statements.length) statements[statements.length - 1]!.text += l;
    }
    return statements;
  }
  // When the worker ran its claim (JOB-2's SKIP LOCKED query).
  async claims(since = 0): Promise<number[]> {
    return (await this.statements()).filter((st) => /SKIP LOCKED/i.test(st.text) && Number.isFinite(st.at) && st.at >= since).map((st) => st.at);
  }
  async ipOf(c: Container): Promise<string> {
    return (await run('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "${this.net}").IPAddress}}`, c.name])).stdout.trim();
  }
  async kill(c: Container) { await run('docker', ['kill', c.name]); }
  async start(c: Container) { await this.docker(['start', c.name]); }
  async pauseDb() { await this.docker(['pause', `db-${this.id}`]); }
  async unpauseDb() { await this.docker(['unpause', `db-${this.id}`]); }
  async inNetwork(cmd: string[]): Promise<{ code: number; out: string }> {
    const r = await run('docker', ['exec', `platform-${this.id}`, ...cmd], { timeoutMs: 30_000 });
    return { code: r.code, out: `${r.stdout}${r.stderr}` };
  }
  async mail(): Promise<{ key: string; to: string; subject: string; text: string; attempts: number }[]> {
    return ((await (await fetch(`${this.platformBase()}/_fake/mail`)).json()) as { messages: { key: string; to: string; subject: string; text: string; attempts: number }[] }).messages;
  }

  async cleanup() {
    for (const c of this.containers.reverse()) await run('docker', ['rm', '-f', '-v', c]);
    await run('docker', ['network', 'rm', this.net]);
    if (this.image) await run('docker', ['image', 'rm', '-f', this.image]);
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

export { sleep };
