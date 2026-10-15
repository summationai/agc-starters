// DEV-1 to DEV-6: the stack as `agc up` runs it. `[service.web] dev` and `[service.worker] dev` run on a fresh copy of
// the source with the mirror's environment; then a server file, a UI file and a worker file are edited (each edit is
// made inside the container, as an editor on the laptop would) and each change must land within 5 s, with no restart.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Container, Env } from '../lib/env.ts';
import { fail, pass, skip, type TestResult } from '../lib/report.ts';
import { UV_IMAGE } from '../vendor/agc/runner-build.ts';
import { must, run, sleep, until } from '../lib/sh.ts';
import type { Reload } from '../lib/stack.ts';
import { cookieAttrs, type Jar, req, signIn } from './http.ts';

const BUDGET_MS = 5000;
const SETTLE_MS = 1500; // between the warm-up save and the timed one: watchers coalesce saves that land closer together

// Python's dev image carries Node too: the starter's UI runs under Vite next to uvicorn.
const PYTHON_DEV = [
  'FROM python:3.12-slim',
  `COPY --from=${UV_IMAGE} /uv /usr/local/bin/uv`,
  'COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node',
  'COPY --from=node:24-slim /usr/local/lib/node_modules /usr/local/lib/node_modules',
  'RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx',
  'ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy',
  '',
].join('\n');

export async function dev(env: Env, log: (m: string) => void): Promise<Map<string, TestResult>> {
  const out = new Map<string, TestResult>();
  const s = env.stack;
  const d = s.descriptor;
  const src = join(env.tmp, 'dev-src');
  for (const f of s.files) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    copyFileSync(join(s.dir, f), join(src, f));
  }
  let image = 'node:24';
  if (s.language === 'python') {
    image = `agc-conf-dev-python-${env.id}`;
    await must('docker', ['build', '-t', image, '-'], { input: PYTHON_DEV, timeoutMs: 900_000 });
  }
  const user = process.getuid ? ['--user', `${process.getuid()}:${process.getgid!()}`] : [];
  const base = ['--network', env.net, '-v', `${src}:/app`, '-w', '/app', ...user, '-e', 'HOME=/tmp/home', '-v', `${env.certs}:/certs:ro`];
  const mirrorEnv = env.appEnv({ AGENTCLOUD_MIRROR: 'conformance' });
  const envArgs = Object.entries(mirrorEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  if (d.setup) {
    log(`dev: ${d.setup}`);
    const r = await run('docker', ['run', '--rm', ...base, image, 'sh', '-c', `mkdir -p "$HOME" && ${d.setup}`], { timeoutMs: 900_000 });
    if (r.code !== 0) {
      for (const t of ['CONF:dev-routes', 'CONF:reload-api', 'CONF:reload-ui', 'CONF:reload-worker', 'CONF:cookies']) {
        out.set(t, fail(`[dev] setup failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`));
      }
      return out;
    }
  }

  const name = (n: string) => `${n}-${env.id}`;
  const port = s.app.web.port;
  const webName = name('devweb');
  env.containers.push(webName);
  await must('docker', ['run', '-d', '--name', webName, ...base, ...envArgs, '-p', `127.0.0.1::${port}`, image, 'sh', '-c', `mkdir -p "$HOME" && ${s.app.web.dev}`]);
  const published = Number(/:(\d+)\s*$/m.exec(await must('docker', ['port', webName, `${port}/tcp`]))?.[1] ?? 0);
  const web: Container = { name: webName, port: published };
  log('dev: waiting for the dev server (up to 3 minutes)…');
  const readyMs = await env.ready(web, 180_000);
  if (readyMs === undefined) {
    const last = (await env.logs(web)).slice(-8).join('\n');
    for (const t of ['CONF:dev-routes', 'CONF:reload-api', 'CONF:reload-ui', 'CONF:cookies']) out.set(t, fail(`dev never answered GET /api/health:\n${last}`));
  } else {
    // DEV-1, DEV-5
    const jar: Jar = new Map();
    const root = await req(env, web, jar, 'GET', '/');
    const health = await req(env, web, jar, 'GET', '/api/health');
    const nope = await req(env, web, jar, 'GET', '/api/no-such-route');
    // DEV-6: on a mirror the session cookie drops Secure, or http://localhost couldn't keep it.
    const got = await signIn(env, web, jar, 'mirror-cookie@example.test');
    const session = got.callback?.cookies.map(cookieAttrs).find((c) => c.value && c.httpOnly && !/state/i.test(c.name));
    out.set('CONF:cookies', session ? (!session.secure ? pass : fail)(`on a mirror the session cookie ${session.secure ? 'still has' : 'drops'} Secure`) : fail(got.problem ?? 'no session cookie on the mirror'));

    // DEV-1 / SEC-6: the browser's Host must reach the API unchanged through any dev proxy. Check /auth too.
    const own = { origin: env.base(web), 'sec-fetch-site': 'same-origin' };
    const other = { origin: 'https://other-app.agent.cloud', 'sec-fetch-site': 'same-site' };
    const note = await req(env, web, jar, 'POST', '/api/notes', { title: 'A note from the mirror page' }, own);
    const refused = await req(env, web, jar, 'POST', '/api/notes', { title: 'A note from another page' }, other);
    const signout = await req(env, web, new Map(), 'POST', '/auth/sign-out', {}, own);
    const refusedSignout = await req(env, web, new Map(), 'POST', '/auth/sign-out', {}, other);
    const crossOrigin = (r: typeof refused) => r.status === 403 && (r.json as { error?: { code?: string } } | null)?.error?.code === 'cross_origin';
    const ok = root.status === 200 && (root.headers.get('content-type') ?? '').includes('html') && health.status === 200 && nope.status === 404
      && note.status === 201 && signout.status === 200 && crossOrigin(refused) && crossOrigin(refusedSignout);
    out.set('CONF:dev-routes', (ok ? pass : fail)(`from a fresh copy after "${d.setup ?? 'no setup'}": / ${root.status}, health ${health.status}, unknown API ${nope.status}; own-origin POST notes ${note.status}, sign-out ${signout.status}; other-origin POST notes ${refused.status}, sign-out ${refusedSignout.status}`));

    // DEV-3, then DEV-2: a server save may restart the whole dev process, so the UI's turn comes first.
    out.set('CONF:reload-ui', await reloadHttp(env, web, d.reload.ui));
    out.set('CONF:reload-api', await reloadHttp(env, web, d.reload.api));
  }

  // DEV-4: the worker restarts on save.
  if (s.app.worker?.dev && d.reload.worker) {
    const wName = name('devworker');
    env.containers.push(wName);
    await must('docker', ['run', '-d', '--name', wName, ...base, ...envArgs, image, 'sh', '-c', `mkdir -p "$HOME" && ${s.app.worker.dev}`]);
    const w: Container = { name: wName };
    const r = d.reload.worker;
    const started = await until(120_000, async () => ((await env.logs(w)).some((l) => l.includes(r.find)) ? true : undefined), 500);
    if (!started) out.set('CONF:reload-worker', fail(`the dev worker never logged "${r.find}"`));
    else {
      // A warm-up save, untimed; then the timed one puts the file back, and the worker logs `find` again.
      await edit(w, r.file, r.find, r.replace);
      const warm = await until(60_000, async () => ((await env.logs(w)).some((l) => l.includes(r.expect)) ? true : undefined), 250);
      const count = async () => (await env.logs(w)).filter((l) => l.includes(r.find)).length;
      await sleep(SETTLE_MS);
      const n = await count();
      const t0 = await edit(w, r.file, r.replace, r.find);
      const seen = warm ? await until(15_000, async () => ((await count()) > n ? Date.now() : undefined), 200) : undefined;
      out.set('CONF:reload-worker', !warm ? fail(`no "${r.expect}" in the worker’s log within 60 s of the first save`)
        : seen && seen - t0 <= BUDGET_MS ? pass(`the worker restarted ${((seen - t0) / 1000).toFixed(1)} s after the save`)
          : fail(seen ? `the worker took ${((seen - t0) / 1000).toFixed(1)} s to restart (budget 5 s)` : 'the worker didn’t restart within 15 s of the second save'));
    }
  } else out.set('CONF:reload-worker', skip('no [service.worker] dev or [reload.worker]'));
  return out;
}

// Rewrites the file from inside the dev container, so its file watcher sees an ordinary save.
async function edit(c: Container, file: string, from: string, to: string): Promise<number> {
  const script = `const fs=require('fs');const f=${JSON.stringify(`/app/${file}`)};fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(${JSON.stringify(from)},${JSON.stringify(to)}))`;
  const t0 = Date.now();
  await must('docker', ['exec', c.name, 'node', '-e', script]);
  return t0;
}

async function reloadHttp(env: Env, web: Container, r: Reload | undefined): Promise<TestResult> {
  if (!r?.url) return skip('no reload probe in conformance.toml');
  const jar: Jar = new Map();
  const before = await req(env, web, jar, 'GET', r.url);
  if (before.text.includes(r.expect)) return fail(`${r.url} already contains "${r.expect}" before the edit`);
  const body = async () => (await req(env, web, new Map(), 'GET', r.url!)).text;
  // A warm-up save, untimed (a first compile can be slow on a cold runner); then the timed one puts the file back.
  await edit(web, r.file, r.find, r.replace);
  const warm = await until(60_000, async () => ((await body()).includes(r.expect) ? true : undefined), 250);
  if (!warm) return fail(`${r.url} didn’t change within 60 s of saving ${r.file}`);
  await sleep(SETTLE_MS);
  const t0 = await edit(web, r.file, r.replace, r.find);
  const seen = await until(15_000, async () => (!(await body()).includes(r.expect) ? Date.now() : undefined), 200);
  await sleep(0);
  return seen && seen - t0 <= BUDGET_MS ? pass(`${r.url} changed ${((seen - t0) / 1000).toFixed(1)} s after saving ${r.file}`)
    : fail(seen ? `${r.url} took ${((seen - t0) / 1000).toFixed(1)} s to change (budget 5 s)` : `${r.url} didn’t change within 15 s of the second save`);
}

export { run };
