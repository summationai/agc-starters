// The black-box rules (CONF:*): the stack's image, built as agent.cloud would build it, run against the fake platform
// and probed over HTTP, signals, logs and SQL. One scenario, in order, since later tests reuse what earlier ones made.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSignInState, invariantResult, readChecks, runFlow } from '../vendor/agc/checks.ts';
import { AUTH_TOKEN, type Container, Env } from '../lib/env.ts';
import { fail, pass, skip, verdict, type TestResult } from '../lib/report.ts';
import { run, sleep, until } from '../lib/sh.ts';
import type { Stack } from '../lib/stack.ts';
import { dev } from './dev.ts';
import { cookieAttrs, type Jar, req, type Res, signIn, UUID } from './http.ts';
import { storageTests } from './storage.ts';
import { welcomeApi, welcomeCopy } from './welcome.ts';

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const ENTITY = /^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_.-]{1,64}$/;
const LEVELS = new Set(['debug', 'info', 'warn', 'warning', 'error', 'fatal', 'critical']);
const parse = (l: string) => { try { const j = JSON.parse(l); return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null; } catch { return null; } };
const tag = () => randomBytes(4).toString('hex');

export const CONF_TESTS = [
  'CONF:build', 'CONF:bind', 'CONF:routes', 'CONF:health', 'CONF:sigterm-web', 'CONF:sigterm-worker', 'CONF:memory', 'CONF:readonly',
  'CONF:missing-env', 'CONF:dev-routes', 'CONF:reload-api', 'CONF:reload-ui', 'CONF:reload-worker', 'CONF:cookies', 'CONF:db-tls',
  'CONF:no-ddl', 'CONF:signin', 'CONF:signin-state', 'CONF:mail', 'CONF:mail-once', 'CONF:jobs-race', 'CONF:jobs-idle', 'CONF:logs-json', 'CONF:error-log',
  'CONF:debug-route-hidden', 'CONF:host-cookies', 'CONF:events', 'CONF:no-pii', 'CONF:smoke', 'CONF:invariants', 'CONF:csrf-json', 'CONF:csrf-origin', 'CONF:body-validation', 'CONF:headers', 'CONF:app', 'CONF:seed',
  'CONF:welcome-copy', 'CONF:welcome', 'CONF:welcome-run', 'CONF:signin-return', 'CONF:storage',
] as const;

async function schema(env: Env): Promise<string> {
  const cols = await env.sql(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`);
  const idx = await env.sql(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`);
  return JSON.stringify([cols, idx]);
}

export async function conform(stack: Stack, opts: { dev: boolean; log: (m: string) => void }): Promise<Map<string, TestResult>> {
  const out = new Map<string, TestResult>();
  const set = (name: string, r: TestResult) => { out.set(name, r); opts.log(`${r.outcome.toUpperCase().padEnd(4)} ${name}: ${r.evidence}`); };
  const env = new Env(stack);
  const allLogs: Container[] = [];
  try {
    // APP-7, APP-9, APP-13: the stack's own welcome page and Notes, rendered from their facts; no image needed.
    set('CONF:welcome-copy', await welcomeCopy(stack));
    // STOR-1 to STOR-5: the storage helper, by the stack's own tests against a fake S3 endpoint; no image needed.
    set('CONF:storage', await storageTests(stack));

    // BLD-1, BLD-2, BLD-4, BLD-5: the default image, from exactly what agc ship sends, with the fake platform not yet up.
    opts.log('building the image with agent.cloud\u2019s default Dockerfile…');
    let built: Awaited<ReturnType<Env['build']>>;
    try {
      built = await env.build();
    } catch (e) {
      set('CONF:build', fail(`${(e as Error).message}\n${(e as { log?: string }).log ?? ''}`));
      for (const t of CONF_TESTS) if (!out.has(t)) out.set(t, skip('the image didn\u2019t build'));
      return out;
    }
    const mib = Math.round(built.bytes / 1048576);
    set('CONF:build', pass(`built in ${Math.round(built.seconds)} s from ${stack.files.length} shipped files, ${mib} MB`, {
      'BLD-5': verdict(mib < 400, `${mib} MB (under 400 MB is the target)`),
    }));

    opts.log('starting the fake platform…');
    await env.startPlatform();
    const applied = await env.migrate();
    opts.log(`applied ${applied.length} migrations`);
    // APP-6: the seed, after the migrations, as agc up runs it on a mirror that starts empty.
    const seedPath = join(stack.dir, 'seed.sql');
    const seedSql = existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : null;
    const applySeed = async () => { const d = env.db(); await d.connect(); try { await d.query(`BEGIN;\n${seedSql}\nCOMMIT;`); } finally { await d.end(); } };
    let seedError: string | null = null;
    if (seedSql) await applySeed().catch((e) => { seedError = (e as Error).message; });
    const demoId = seedSql?.match(/'([0-9a-f-]{36})'/i)?.[1] ?? null;
    const schemaBefore = await schema(env);

    // PROC-9: a missing variable stops the process quickly, and says which.
    {
      const verdicts: string[] = [];
      let ok = true;
      for (const name of ['DATABASE_URL', 'PORT']) {
        const e = env.appEnv();
        delete e[name];
        const c = await env.web(`noenv-${name.toLowerCase()}`, e, { alias: false });
        const stopped = await until(10_000, async () => ((await env.inspect(c)).running ? undefined : true), 250);
        const st = await env.inspect(c);
        const last = (await env.logs(c)).at(-1) ?? '';
        const good = !!stopped && st.exitCode !== 0 && last.includes(name);
        ok &&= good;
        verdicts.push(`without ${name}: ${stopped ? `exited ${st.exitCode}` : 'still running after 10 s'}, last line ${last.includes(name) ? 'names it' : `"${last.slice(0, 120)}"`}`);
        await run('docker', ['rm', '-f', c.name]);
      }
      set('CONF:missing-env', (ok ? pass : fail)(verdicts.join('; ')));
    }

    // OBS-6: the conformance-only routes don't exist in a normal run.
    {
      const e = env.appEnv();
      delete e.AGENTCLOUD_CONFORMANCE;
      const c = await env.web('nodebug', e, { alias: false });
      const ready = await env.ready(c, 60_000);
      const jar: Jar = new Map();
      const a = ready ? await req(env, c, jar, 'GET', '/api/debug/error') : null;
      const b = ready ? await req(env, c, jar, 'GET', '/api/debug/slow?ms=10') : null;
      set('CONF:debug-route-hidden', !ready ? fail('the app didn\u2019t become ready without AGENTCLOUD_CONFORMANCE') : (a!.status === 404 && b!.status === 404 ? pass : fail)(`without AGENTCLOUD_CONFORMANCE: /api/debug/error ${a!.status}, /api/debug/slow ${b!.status}`));
      await run('docker', ['rm', '-f', c.name]);
    }

    // The app proper: web and one worker, as the platform runs them.
    const web = await env.web('web');
    const worker = await env.worker('worker');
    allLogs.push(web, worker);
    const readyMs = await env.ready(web, 60_000);
    if (readyMs === undefined) {
      const logs = (await env.logs(web)).slice(-10).join('\n');
      set('CONF:health', fail(`GET /api/health never answered 200 within 60 s. Last log lines:\n${logs}`));
      for (const t of CONF_TESTS) if (!out.has(t)) out.set(t, skip('the app never became ready'));
      return out;
    }
    await sleep(2000);
    const restWeb = await env.memoryMiB(web);
    const restWorker = await env.memoryMiB(worker);

    // PROC-3: ready soon, and health never waits on the database.
    {
      await env.pauseDb();
      const checks: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${env.base(web)}/api/health`, { signal: AbortSignal.timeout(2000) }).then((x) => x.status, () => 0);
        checks.push(r);
        await sleep(500);
      }
      await env.unpauseDb();
      const ok = readyMs <= 30_000 && checks.every((s) => s === 200);
      set('CONF:health', (ok ? pass : fail)(`ready in ${(readyMs / 1000).toFixed(1)} s; with the database frozen, health answered ${checks.join(', ')}`));
    }

    // PROC-1: reached from another container, by its network name.
    {
      const r = await env.inNetwork(['node', '-e', `fetch('http://app:${stack.app.web.port}/api/health').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(2))`]);
      set('CONF:bind', (r.code === 0 ? pass : fail)(r.code === 0 ? `another container reached http://app:${stack.app.web.port}/api/health` : `another container couldn\u2019t reach the app on 0.0.0.0:$PORT (${r.out.trim().slice(0, 200) || `exit ${r.code}`})`));
    }

    // PROC-2: one port, the UI at /, the API under /api, client routes survive a reload.
    {
      const jar: Jar = new Map();
      const root = await req(env, web, jar, 'GET', '/');
      const api404 = await req(env, web, jar, 'GET', `/api/no-such-route-${tag()}`);
      const deep = await req(env, web, jar, 'GET', `/notes/${tag()}/deep`);
      const html = (r: typeof root) => r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/html');
      const ok = html(root) && api404.status === 404 && (api404.headers.get('content-type') ?? '').includes('json') && html(deep) && deep.text === root.text;
      set('CONF:routes', (ok ? pass : fail)(`/ ${root.status} ${root.headers.get('content-type')}; unknown /api path ${api404.status} ${api404.headers.get('content-type')}; a client route ${deep.status}${deep.text === root.text ? ' (the UI)' : ' (not the UI)'}`));

      // SEC-3 (SHOULD): nosniff everywhere, frame-ancestors on HTML.
      const health = await req(env, web, jar, 'GET', '/api/health');
      const nosniff = [root, health].every((r) => r.headers.get('x-content-type-options') === 'nosniff');
      const frames = /frame-ancestors/.test(root.headers.get('content-security-policy') ?? '');
      set('CONF:headers', (nosniff && frames ? pass : fail)(`nosniff on HTML and API: ${nosniff}; a frame-ancestors CSP on HTML: ${frames}`));
    }

    // AUTH-1, AUTH-3, AUTH-5, AUTH-4: sign-in through the app's routes, sessions, sign-out.
    const who = `conf-${tag()}@example.test`;
    const jar: Jar = new Map();
    {
      const before = await req(env, web, jar, 'GET', '/api/me');
      const got = await signIn(env, web, jar, who);
      const stateCookie = got.start.cookies.map(cookieAttrs).find((c) => c.httpOnly && c.value.length >= 22);
      const loc = got.start.headers.get('location') ?? '';
      const state = new URL(loc || 'http://x/').searchParams.get('state') ?? '';
      const auth1 = !got.problem && !!stateCookie && stateCookie.sameSite === 'lax' && (stateCookie.lifetime ?? 0) > 0 && (stateCookie.lifetime ?? 9999) <= 600 && state.length >= 22;
      const me = await req(env, web, jar, 'GET', '/api/me');
      const user = (me.json as { user?: { id?: string }; id?: string } | null);
      const id = user?.user?.id ?? user?.id ?? '';
      const auth3 = me.status === 200 && UUID.test(id);
      // A cookie the callback deletes (Max-Age=0: the sign-in state, where to return to) is never the session.
      const sessionLine = got.callback?.cookies.map(cookieAttrs).find((c) => c.value && c.name !== stateCookie?.name && c.lifetime !== 0) ?? null;
      // Sign-out on a session of its own, so the one signed in above stays live for the tests after this.
      const outJar: Jar = new Map();
      await signIn(env, web, outJar, `signout-${tag()}@example.test`);
      const out1 = await req(env, web, outJar, 'POST', '/auth/sign-out', {});
      const after = await req(env, web, outJar, 'GET', '/api/me');
      const auth5 = before.status === 401 && me.status === 200 && after.status === 401 && out1.status < 400;
      set('CONF:signin', (auth1 && auth3 && auth5 ? pass : fail)(got.problem ?? `signed in as ${who}: /api/me ${me.status}`, {
        'AUTH-1': verdict(auth1, got.problem ?? `redirect to $AGC_AUTH_URL/authorize with a ${state.length}-character state; state cookie ${stateCookie ? `HttpOnly, SameSite=${stateCookie.sameSite || 'unset'}, ${stateCookie.lifetime ?? 'session'} s` : 'missing or not HttpOnly'}`),
        'AUTH-3': verdict(auth3, `after the callback (${got.callback?.status ?? 'none'}), /api/me ${me.status} with user id ${id || 'none'}`),
        'AUTH-5': verdict(auth5, `/api/me signed out ${before.status}, signed in ${me.status}, after POST /auth/sign-out (${out1.status}) ${after.status}`),
      }));
      const s = sessionLine;
      const cookiesOk = !!s && s.httpOnly && s.sameSite === 'lax' && s.secure && s.lifetime !== null && s.lifetime > 0 && s.lifetime <= 86_400 + 60;
      // SEC-5: every cookie set outside a mirror is a __Host- cookie (Secure, Path=/, no Domain).
      const lines = [...got.start.cookies, ...(got.callback?.cookies ?? []), ...out1.cookies].map(cookieAttrs);
      const loose = lines.filter((c) => !c.name.startsWith('__Host-') || !c.secure || c.path !== '/' || c.domain !== null);
      set('CONF:host-cookies', (lines.length && !loose.length ? pass : fail)(!lines.length ? 'no cookies were set during sign-in'
        : loose.length ? `not __Host- cookies (prefix, Secure, Path=/, no Domain): ${[...new Set(loose.map((c) => c.name))].join(', ')}` : `${new Set(lines.map((c) => c.name)).size} cookies, all __Host-`));
      const prodCookie = (cookiesOk ? pass : fail)(s ? `session cookie ${s.name}: HttpOnly ${s.httpOnly}, SameSite ${s.sameSite || 'unset'}, Secure ${s.secure}, lasts ${s.lifetime ?? 'the browser session'} s` : 'the callback set no session cookie');
      out.set('CONF:cookies', { ...prodCookie, perRule: { 'DEV-6': skip('dev mode not run') } });
    }

    // AUTH-2: the platform's own state probe.
    {
      const r = await checkSignInState(env.base(web), { url: env.authUrl, token: AUTH_TOKEN }, env.fetchFor(web));
      // A crafted state (non-ASCII, a different byte length) is a mismatch like any other: 400, never a 500.
      const sj: Jar = new Map();
      await req(env, web, sj, 'GET', '/auth/sign-in');
      const odd = await req(env, web, sj, 'GET', `/auth/callback?code=x&state=${encodeURIComponent('\u00e9')}`);
      const ok = r !== null && r.ok && odd.status === 400;
      set('CONF:signin-state', r === null ? fail('the probe couldn\u2019t start a sign-in at /auth/sign-in')
        : (ok ? pass : fail)(`${r.detail}; a non-ASCII state answered ${odd.status}`));
    }

    // APP-2, APP-3: the notes API.
    const created: string[] = [];
    {
      const anon: Jar = new Map();
      const a = await req(env, web, anon, 'GET', '/api/notes');
      const b = await req(env, web, anon, 'POST', '/api/notes', { title: 'nope' });
      const t1 = `First ${tag()}`;
      const t2 = `Second ${tag()}`;
      const c1 = await req(env, web, jar, 'POST', '/api/notes', { title: t1 });
      const c2 = await req(env, web, jar, 'POST', '/api/notes', { title: t2 });
      const dup = await req(env, web, jar, 'POST', '/api/notes', { title: t1 });
      const empty = await req(env, web, jar, 'POST', '/api/notes', {});
      const long = await req(env, web, jar, 'POST', '/api/notes', { title: 'x'.repeat(201) });
      const list = await req(env, web, jar, 'GET', '/api/notes');
      const n1 = c1.json as { id?: string; title?: string } | null;
      const n2 = c2.json as { id?: string } | null;
      if (n1?.id) created.push(n1.id);
      if (n2?.id) created.push(n2.id);
      const items = Array.isArray(list.json) ? list.json as { id?: string; title?: string }[] : [];
      const newestFirst = items[0]?.id === n2?.id && items[1]?.id === n1?.id;
      const app2 = a.status === 401 && list.status === 200 && newestFirst;
      const app3 = b.status === 401 && c1.status === 201 && UUID.test(n1?.id ?? '') && n1?.title === t1 && dup.status === 409 && empty.status === 400 && long.status === 400;
      set('CONF:app', (app2 && app3 ? pass : fail)('the notes API', {
        'APP-2': verdict(app2, `signed out ${a.status}; signed in ${list.status} with ${items.length} notes${newestFirst ? ', newest first' : ', not newest first'}`),
        'APP-3': verdict(app3, `signed out ${b.status}; create ${c1.status} (id ${n1?.id ?? 'none'}); same title ${dup.status}; no title ${empty.status}; 201 characters ${long.status}`),
      }));

      // SEC-4: a form post is refused and creates nothing.
      const title = `Form ${tag()}`;
      const form = await req(env, web, jar, 'POST', '/api/notes', `title=${encodeURIComponent(title)}`, { 'content-type': 'application/x-www-form-urlencoded' });
      const after = await req(env, web, jar, 'GET', '/api/notes');
      const madeIt = Array.isArray(after.json) && (after.json as { title?: string }[]).some((n) => n.title === title);
      set('CONF:csrf-json', (form.status === 415 && !madeIt ? pass : fail)(`a form post answered ${form.status}${madeIt ? ' and created a note' : ', nothing created'}`));

      // SEC-6: a sibling app's page can't change anything, even with a JSON body and this app's cookies.
      const own = new URL(env.base(web)).origin;
      const tried = async (headers: Record<string, string>) => {
        const t = `Origin ${tag()}`;
        const r = await req(env, web, jar, 'POST', '/api/notes', { title: t }, headers);
        const listed = await req(env, web, jar, 'GET', '/api/notes');
        return { status: r.status, code: (r.json as { error?: { code?: string } } | null)?.error?.code, made: Array.isArray(listed.json) && (listed.json as { title?: string }[]).some((n) => n.title === t), id: (r.json as { id?: string } | null)?.id };
      };
      const sibling = await tried({ origin: 'https://other-app.agent.cloud' });
      const marked = await tried({ 'sec-fetch-site': 'same-site' });
      const ours = await tried({ origin: own, 'sec-fetch-site': 'same-origin' });
      if (ours.id) created.push(ours.id);
      const ok = sibling.status === 403 && sibling.code === 'cross_origin' && !sibling.made && marked.status === 403 && !marked.made && ours.status === 201;
      set('CONF:csrf-origin', (ok ? pass : fail)(`another origin ${sibling.status}${sibling.made ? ' and created a note' : ''}; same-site with no Origin ${marked.status}${marked.made ? ' and created a note' : ''}; its own origin ${ours.status}`));

      // SEC-7: a body that isn't JSON, and one whose title isn't a string, answer 400 in the app's error shape and create nothing.
      const count = async () => { const r = await req(env, web, jar, 'GET', '/api/notes'); return Array.isArray(r.json) ? r.json.length : -1; };
      const shaped = (r: Res) => { const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error; return typeof e?.code === 'string' && typeof e?.message === 'string'; };
      const told = (what: string, r: Res) => `${what} ${r.status}${shaped(r) ? '' : ` without the error shape (${r.text.slice(0, 80)})`}`;
      const before = await count();
      const broken = await req(env, web, jar, 'POST', '/api/notes', '{"title": "Broken', { 'content-type': 'application/json' });
      const numeric = await req(env, web, jar, 'POST', '/api/notes', { title: 42 });
      const same = (await count()) === before;
      const valid = broken.status === 400 && shaped(broken) && numeric.status === 400 && shaped(numeric) && same;
      set('CONF:body-validation', (valid ? pass : fail)(`${told('a body that isn\u2019t JSON', broken)}; ${told('a numeric title', numeric)}; ${same ? 'nothing created' : 'a note was created'}`));
    }

    // APP-6: the demo person sees exactly the seeded notes, and the seed is idempotent.
    {
      if (!seedSql) set('CONF:seed', fail('no seed.sql'));
      else if (seedError) set('CONF:seed', fail(`seed.sql failed after the migrations: ${seedError}`));
      else if (!demoId) set('CONF:seed', fail('seed.sql names no uuid for the demo person'));
      else {
        const expected = (await env.sql<{ title: string }>('SELECT title FROM notes WHERE user_id = $1 ORDER BY title', [demoId])).map((r) => r.title);
        const demo: Jar = new Map();
        const s = await signIn(env, web, demo, demoId);
        const list = await req(env, web, demo, 'GET', '/api/notes');
        const got = (Array.isArray(list.json) ? list.json as { title?: string }[] : []).map((n) => n.title ?? '').sort();
        const [{ n: before }] = await env.sql<{ n: string }>('SELECT count(*) AS n FROM notes');
        await applySeed().catch((e) => { seedError = (e as Error).message; });
        const [{ n: again }] = await env.sql<{ n: string }>('SELECT count(*) AS n FROM notes');
        const ok = !s.problem && list.status === 200 && expected.length === 3 && JSON.stringify(got) === JSON.stringify(expected) && !seedError && before === again;
        set('CONF:seed', (ok ? pass : fail)(s.problem ?? `signed in as the demo id: GET /api/notes ${list.status} with ${got.length} notes (${expected.length} seeded)${JSON.stringify(got) === JSON.stringify(expected) ? ', the seeded ones' : ', not the seeded ones'}; applied twice: ${before} then ${again} notes${seedError ? `; second apply failed: ${seedError}` : ''}`));
      }
    }

    // MAIL-1, APP-4: the worker emails the person, keyed by the note.
    {
      const got = await until(20_000, async () => {
        const m = await env.mail();
        return created.every((id) => m.some((x) => x.key === `note-${id}/created`)) ? m : undefined;
      }, 500);
      const mine = (got ?? await env.mail()).filter((m) => created.some((id) => m.key.startsWith(`note-${id}`)));
      const ok = created.length > 0 && !!got && mine.length === created.length && mine.every((m) => m.to === who && m.subject.trim() && m.text.trim());
      set('CONF:mail', (ok ? pass : fail)(!created.length ? 'no notes were created to email about (see CONF:app)' : got ? `${mine.length} emails to the person, keyed note-<id>/created` : `after 20 s the fake platform had ${mine.length} of ${created.length} emails (keys seen: ${(await env.mail()).map((m) => m.key).slice(0, 5).join(', ') || 'none'})`));
    }

    // OBS-2: an error is one JSON line at level error, and the response hides the stack.
    {
      const before = (await env.logs(web)).length;
      const r = await req(env, web, jar, 'GET', '/api/debug/error');
      await sleep(1000);
      const lines = (await env.logs(web)).slice(before);
      const errors = lines.map(parse).filter((j) => j && /^(error|fatal|critical)$/i.test(String(j.level ?? j.severity ?? '')));
      const stackInLine = errors.some((j) => JSON.stringify(j).match(/(\\n\s+at |Traceback|File \\")/));
      const raw = lines.filter((l) => !parse(l) && /^\s+at |^Traceback|^\s+File "/.test(l));
      const leaks = /\n\s+at |Traceback/.test(r.text);
      const ok = r.status === 500 && (r.headers.get('content-type') ?? '').includes('json') && !leaks && errors.length >= 1 && stackInLine && !raw.length;
      set('CONF:error-log', (ok ? pass : fail)(`response ${r.status}${leaks ? ' with a stack in it' : ''}; ${errors.length} error lines${stackInLine ? ' with the stack in a field' : ', none carrying the stack'}; ${raw.length} raw stack lines`));
    }

    // CHK-2, CHK-4, APP-5: every smoke flow, twice, with agc's own runner.
    const checks = readChecks(stack.raw);
    {
      const results: string[] = [];
      let ok = checks.smoke.length > 0;
      for (const flow of checks.smoke) {
        for (const round of [1, 2]) {
          const r = await runFlow(env.base(web), flow, env.fetchFor(web), { auth: { url: env.authUrl, token: AUTH_TOKEN } });
          ok &&= r.ok;
          results.push(`"${flow.name}" run ${round}: ${r.ok ? 'passed' : r.detail}`);
        }
      }
      set('CONF:smoke', (ok ? pass : fail)(results.join('; ') || 'no smoke flows'));
    }
    // CHK-3
    {
      const results: string[] = [];
      let ok = checks.invariant.length > 0;
      for (const inv of checks.invariant) {
        const r = invariantResult(inv.name, await env.sql(inv.sql));
        ok &&= r.ok;
        results.push(`"${inv.name}": ${r.ok ? 'holds' : r.detail}`);
      }
      set('CONF:invariants', (ok ? pass : fail)(results.join('; ') || 'no invariants'));
    }

    // JOB-2: two workers, a batch of notes, each job run exactly once.
    {
      const second = await env.worker('worker2');
      allLogs.push(second);
      await sleep(3000);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const r = await req(env, web, jar, 'POST', '/api/notes', { title: `Race ${tag()} ${i}` });
        const id = (r.json as { id?: string } | null)?.id;
        if (r.status === 201 && id) ids.push(id);
      }
      const all = await until(45_000, async () => {
        const m = await env.mail();
        return ids.every((id) => m.some((x) => x.key === `note-${id}/created`)) ? m : undefined;
      }, 500);
      const mine = (all ?? await env.mail()).filter((m) => ids.some((id) => m.key === `note-${id}/created`));
      const twice = mine.filter((m) => m.attempts > 1);
      set('CONF:jobs-race', (!!all && ids.length === 20 && mine.length === 20 && !twice.length ? pass : fail)(`${ids.length} notes, ${mine.length} emails, ${twice.length} sent more than once, with two workers`));
      await env.stop(second, 60);
    }

    // MAIL-2, JOB-3: a worker killed mid-batch; after its leases lapse, each note is emailed once, under its own key.
    {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await req(env, web, jar, 'POST', '/api/notes', { title: `Crash ${tag()} ${i}` });
        const id = (r.json as { id?: string } | null)?.id;
        if (r.status === 201 && id) ids.push(id);
      }
      await sleep(150);
      await env.kill(worker);
      await sleep(1000);
      await env.start(worker);
      opts.log('waiting for leases to lapse after killing the worker (up to 90 s)…');
      const all = await until(90_000, async () => {
        const m = await env.mail();
        return ids.every((id) => m.some((x) => x.key === `note-${id}/created`)) ? m : undefined;
      }, 1000);
      const m = all ?? await env.mail();
      const perNote = ids.map((id) => m.filter((x) => x.key.startsWith(`note-${id}`)).length);
      const ok = ids.length === 5 && !!all && perNote.every((n) => n === 1);
      set('CONF:mail-once', (ok ? pass : fail)(`${ids.length} notes; emails per note after the crash: ${perNote.join(', ')}${all ? '' : ' (not all arrived within 90 s)'}`));
    }

    // JOB-4: an idle worker backs off and holds no connection between polls; a new job brings it back.
    {
      await sleep(8000); // quiet: the gaps should have grown to the 4 s ceiling
      const ip = await env.ipOf(worker);
      const held: number[] = [];
      for (let i = 0; i < 12; i++) {
        held.push(Number((await env.sql<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE client_addr = $1::inet', [ip]))[0]!.n));
        await sleep(500);
      }
      const idleFrom = Date.now() - 14_000;
      const idle = await env.claims(idleFrom);
      const gaps = idle.slice(1).map((t, i) => (t - idle[i]!) / 1000);
      const r = await req(env, web, jar, 'POST', '/api/notes', { title: `Idle ${tag()}` });
      const id = (r.json as { id?: string } | null)?.id ?? '';
      const t0 = Date.now();
      const got = await until(15_000, async () => ((await env.mail()).some((m) => m.key === `note-${id}/created`) ? Date.now() : undefined), 200);
      await sleep(2000);
      const after = await env.claims(t0);
      const fast = after.slice(1).map((t, i) => (t - after[i]!) / 1000).filter((g) => g < 1.5).length;
      const grew = gaps.length >= 2 && Math.max(...gaps) >= 3 && Math.max(...gaps) <= 6;
      const quiet = held.filter((n) => n === 0).length >= 11; // one sample may land on a poll's own connection
      const ok = grew && quiet && !!got && fast >= 1;
      set('CONF:jobs-idle', (ok ? pass : fail)(`idle gaps between claims: ${gaps.map((g) => g.toFixed(1)).join(', ') || 'none seen'} s (should grow to about 4); worker connections in ${held.filter((n) => n === 0).length} of 12 idle samples: none; a new job emailed ${got ? `${((got - t0) / 1000).toFixed(1)} s` : 'never'} after it was created, then ${fast} quick polls`));
    }

    // OBS-3: workflow events for each note, well-formed.
    {
      const lines = (await Promise.all(allLogs.map((c) => env.logs(c)))).flat().map(parse).filter((j) => j?.agc === 'event') as Record<string, unknown>[];
      const bad = lines.filter((e) => !NAME.test(String(e.name ?? '')) || !ENTITY.test(String(e.entity ?? '')) || (e.related !== undefined && (!Array.isArray(e.related) || e.related.some((r) => !ENTITY.test(String(r))))));
      const has = (name: string, id: string) => lines.some((e) => e.name === name && e.entity === `note:${id}`);
      const createdOk = created.length > 0 && created.every((id) => has('note.created', id));
      const emailedOk = created.every((id) => has('note.emailed', id));
      set('CONF:events', (createdOk && emailedOk && !bad.length ? pass : fail)(`${lines.length} events; note.created for each note: ${createdOk}; note.emailed: ${emailedOk}; malformed: ${bad.length}`));
    }

    // OBS-4: a distinctive person leaves no trace in any log.
    {
      const pii = `pii-${tag()}@example.test`;
      const pj: Jar = new Map();
      await signIn(env, web, pj, pii);
      const r = await req(env, web, pj, 'POST', '/api/notes', { title: `Private ${tag()}` });
      const id = (r.json as { id?: string } | null)?.id ?? '';
      await until(20_000, async () => ((await env.mail()).some((m) => m.key === `note-${id}/created`) ? true : undefined), 500);
      const logs = (await Promise.all(allLogs.map((c) => env.logs(c)))).flat();
      const local = pii.split('@')[0]!;
      const hits = logs.filter((l) => l.includes(local));
      set('CONF:no-pii', (r.status === 201 && !hits.length ? pass : fail)(r.status !== 201 ? `couldn\u2019t create a note as ${pii} (${r.status})` : hits.length ? `the address appears in ${hits.length} log lines` : 'the address appears in no log line'));
    }

    // DATA-1: a hostname that isn't on the certificate must not reach the data.
    {
      const ip = (await run('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "${env.net}").IPAddress}}`, `db-${env.id}`])).stdout.trim();
      const c = await env.web('tlsweb', env.appEnv({ DATABASE_URL: env.databaseUrl.replace('@db:', `@${ip}:`) }), { alias: false });
      const ready = await env.ready(c, 60_000);
      const tj: Jar = new Map();
      if (ready !== undefined) await signIn(env, c, tj, `tls-${tag()}@example.test`).catch(() => null);
      const r = ready !== undefined ? await req(env, c, tj, 'POST', '/api/notes', { title: `TLS ${tag()}` }) : null;
      set('CONF:db-tls', ready === undefined ? fail('the app didn\u2019t start with a different database host') : (r!.status !== 201 ? pass : fail)(
        r!.status !== 201 ? `with DATABASE_URL pointing at ${ip}, which isn\u2019t on the certificate, writes failed (${r!.status}): verify-full is honored` : `with DATABASE_URL pointing at ${ip}, a write succeeded: the app doesn\u2019t verify the database\u2019s certificate`));
      await run('docker', ['rm', '-f', c.name]);
    }

    // PROC-7: memory at rest and under the checks.
    {
      const busyWeb = await env.memoryMiB(web);
      const states = await Promise.all([env.inspect(web), env.inspect(worker)]);
      const oom = states.some((s) => s.oom);
      const ok = restWeb < 256 && restWorker < 256 && busyWeb < 512 && !oom;
      set('CONF:memory', (ok ? pass : fail)(`at rest: web ${Math.round(restWeb)} MiB, worker ${Math.round(restWorker)} MiB; after the checks: web ${Math.round(busyWeb)} MiB${oom ? '; killed for memory' : ''}`));
    }

    // PROC-8: nothing tried to write outside /tmp.
    {
      const logs = (await Promise.all(allLogs.map((c) => env.logs(c)))).flat();
      const writes = logs.filter((l) => /EROFS|read-only file system|Read-only file system/i.test(l));
      const states = await Promise.all([env.inspect(web), env.inspect(worker)]);
      set('CONF:readonly', (!writes.length && states.every((s) => s.running) ? pass : fail)(writes.length ? `tried to write to a read-only filesystem: ${writes[0]!.slice(0, 200)}` : 'ran the whole suite with only /tmp writable'));
    }

    // DATA-3: the schema is what the migrations made.
    set('CONF:no-ddl', ((await schema(env)) === schemaBefore ? pass : fail)((await schema(env)) === schemaBefore ? 'the schema after the run equals the one the migrations made' : 'the app changed the schema at runtime'));

    // OBS-1, OBS-5: JSON lines with a level.
    {
      // Workflow events go to observability's events, not its logs, so they aren't counted here.
      const logs = (await Promise.all(allLogs.map((c) => env.logs(c)))).flat().filter((l) => parse(l)?.agc !== 'event');
      const parsed = logs.map(parse);
      const good = parsed.filter((j) => j && typeof (j.level ?? j.severity ?? j.lvl) === 'string' && LEVELS.has(String(j.level ?? j.severity ?? j.lvl).toLowerCase()) && (typeof j.msg === 'string' || typeof j.message === 'string'));
      const share = logs.length ? good.length / logs.length : 1;
      const access = logs.filter((l) => /\b(GET|POST|PUT|PATCH|DELETE) \/\S*.{0,40}\b[1-5]\d\d\b/.test(l));
      const odd = logs.filter((l, i) => !good.includes(parsed[i]!)).slice(0, 3).map((l) => l.slice(0, 100));
      set('CONF:logs-json', (share >= 0.95 ? pass : fail)(`${good.length} of ${logs.length} lines are JSON with a level (${Math.round(share * 100)}%)${odd.length ? `; e.g. ${odd.join(' | ')}` : ''}`, {
        'OBS-5': verdict(!access.length, access.length ? `${access.length} lines look like access logs, which Traefik already keeps` : 'no per-request access log'),
      }));
    }

    // PROC-4, PROC-6: SIGTERM with a request in flight.
    {
      const before = (await env.logs(web)).length;
      const slow = fetch(`${env.base(web)}/api/debug/slow?ms=3000`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.status, () => 0);
      // SIGTERM only once the request is really in flight: the route logs as it begins (OBS-6).
      await until(10_000, async () => ((await env.logs(web)).slice(before).some((l) => l.includes('slow request started')) ? true : undefined), 100);
      const stopped = await env.stop(web, 30);
      const status = await slow;
      const ok = status === 200 && stopped.seconds <= 25 && (stopped.exitCode === 0 || stopped.exitCode === 143);
      set('CONF:sigterm-web', (ok ? pass : fail)(`the request in flight got ${status || 'no answer'}; web exited ${stopped.exitCode} after ${stopped.seconds.toFixed(1)} s`));
    }
    // PROC-5
    {
      const stopped = await env.stop(worker, 60);
      set('CONF:sigterm-worker', (stopped.seconds <= 50 && (stopped.exitCode === 0 || stopped.exitCode === 143) ? pass : fail)(`the worker exited ${stopped.exitCode} after ${stopped.seconds.toFixed(1)} s`));
    }

    // APP-8, APP-9, APP-10, APP-7: GET /api/welcome on fresh processes, once web and worker are stopped, since it freezes
    // the database for a minute.
    for (const [k, v] of await welcomeApi(env, opts.log)) set(k, v);

    // DEV-*: auto-reload on a copy of the source.
    if (opts.dev) {
      for (const [k, v] of await dev(env, opts.log)) {
        if (k === 'CONF:cookies' && out.has(k)) {
          const prod = out.get(k)!;
          out.set(k, { outcome: prod.outcome === 'fail' || v.outcome === 'fail' ? 'fail' : prod.outcome, evidence: `${prod.evidence}; ${v.evidence}`,
            perRule: { 'AUTH-4': { outcome: prod.outcome, evidence: prod.evidence }, 'DEV-6': { outcome: v.outcome, evidence: v.evidence } } });
          opts.log(`${out.get(k)!.outcome.toUpperCase().padEnd(4)} ${k}: ${out.get(k)!.evidence}`);
        } else set(k, v);
      }
    } else {
      for (const t of ['CONF:dev-routes', 'CONF:reload-api', 'CONF:reload-ui', 'CONF:reload-worker']) out.set(t, skip('dev mode not run (--no-dev)'));
    }
    return out;
  } finally {
    if (!process.env.CONFORMANCE_KEEP) await env.cleanup();
    else opts.log(`kept containers on network ${env.net}`);
  }
}
