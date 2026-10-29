// The welcome page and the Notes example (SPEC.md APP-7 to APP-14).
//   CONF:welcome-copy   the stack's own UI modules, rendered with react-dom/server for every run and production state,
//                       each as an app set up by hand and as one started from Start
//   CONF:welcome        GET /api/welcome on the built app: its fields, no secrets, the database probe and its bounds
//   CONF:welcome-run    where the process says it runs, and what it says about production, from the environment alone
//   CONF:signin-return  signing in from /notes comes back to /notes
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse, stringify } from 'smol-toml';
import ts from 'typescript';
import { LEDGER } from '../vendor/agc/migrations.ts';
import { readChecks } from '../vendor/agc/checks.ts';
import { type Container, type Env, PLATFORM } from '../lib/env.ts';
import { fail, pass, verdict, type TestResult } from '../lib/report.ts';
import { must, run as sh, sleep, until } from '../lib/sh.ts';
import type { Stack } from '../lib/stack.ts';
import { pageRoutes } from '../lint/index.ts';
import { type Jar, req, signIn } from './http.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const tag = () => randomBytes(4).toString('hex');
const stackName = (s: Stack) => (s.language === 'python' ? 'python' : 'typescript');
const starter = (s: Stack) => (s.language === 'python' ? 'Python starter' : 'TypeScript starter');

// ---- CONF:welcome-copy ------------------------------------------------------------------------------------------------

type Production = { url: string; version: number | null } | null;
type Facts = Record<string, unknown> & { run: string; started: 'live' | null; production: Production };
type Ui = { Welcome: FunctionComponent<Record<string, unknown>>; NotesView: FunctionComponent<Record<string, unknown>> };

// The stack's web/src, transpiled (types stripped, JSX to react/jsx-runtime) into a scratch folder that resolves react
// from this suite's own node_modules, then imported. Stylesheet imports are dropped: there's no bundler here.
async function loadUi(s: Stack): Promise<{ ui: Ui; done: () => void }> {
  const src = join(s.dir, 'web', 'src');
  const out = mkdtempSync(join(tmpdir(), 'agc-welcome-'));
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const file of walk(src).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))) {
    const js = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true },
    }).outputText.replace(/^\s*import\s+['"][^'"]+\.css['"];?\s*$/gm, '');
    const to = join(out, relative(src, file)).replace(/\.tsx?$/, '.js');
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, js);
  }
  writeFileSync(join(out, 'package.json'), '{ "type": "module" }\n');
  symlinkSync(join(HERE, '..', 'node_modules'), join(out, 'node_modules'), 'dir');
  const app = await import(pathToFileURL(join(out, 'App.js')).href) as Record<string, unknown>;
  const notes = await import(pathToFileURL(join(out, 'Notes.js')).href) as Record<string, unknown>;
  if (typeof app.Welcome !== 'function') throw new Error('web/src/App.tsx doesn\u2019t export Welcome({facts, here, now, moving})');
  if (typeof notes.NotesView !== 'function') throw new Error('web/src/Notes.tsx doesn\u2019t export NotesView({app, user, notes, error, onAdd, onSignOut})');
  return { ui: { Welcome: app.Welcome as Ui['Welcome'], NotesView: notes.NotesView as Ui['NotesView'] }, done: () => rmSync(out, { recursive: true, force: true }) };
}

// What a person reads: tags become spaces, entities and curly quotes are plain, whitespace collapses.
export const textOf = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();

// The progress line's "released" step is done when its <li> carries a done (or current) class or a check mark (an svg).
function releasedDone(html: string): boolean {
  const li = [...html.matchAll(/<li\b([^>]*)>((?:(?!<\/li>)[\s\S])*)<\/li>/g)].find((m) => /\bReleased\b/.test(textOf(m[2]!)));
  if (!li) return false;
  return /class="[^"]*\b(done|now)\b/.test(li[1]!) || /<svg\b/.test(li[2]!);
}

const CHIP: Record<string, string> = {
  mirror: 'Running on this machine', live: 'Live at', rehearsal: 'A rehearsal of a release, not live yet.',
  preview: 'A preview, not live', unknown: "This page can't tell where it's running.",
};
const NOT_RELEASED = ['reserved, not released', 'Nothing was public when this copy started', 'nothing was released at'];
const RELEASED = ['agc ship releases a new version there'];
// APP-14: the words of an app set up by hand, and of one started from Start, whose agent is already building it.
const BY_HAND = ['is ready to build', 'Tell your agent what to build, and this page becomes your app', 'Tell your agent what to build.'];
const STARTED = ['is about to be built', "Your agent's first change replaces this page", 'Your agent is on it', 'Work page', "agent.cloud's console"];
const CHECKED = '2026-10-21T04:00:00.000Z';
const URL_ = 'https://folio.agent.cloud';
const HOST = 'folio.agent.cloud';

export async function welcomeCopy(s: Stack): Promise<TestResult> {
  const routes = pageRoutes(s);
  if (!existsSync(join(s.dir, 'web', 'src', 'App.tsx'))) return fail(routes.join('; ') || 'no web/src/App.tsx');
  let loaded: Awaited<ReturnType<typeof loadUi>>;
  try { loaded = await loadUi(s); } catch (e) { return fail(`couldn\u2019t load the UI modules: ${(e as Error).message}`); }
  const { Welcome, NotesView } = loaded.ui;
  try {
    const facts = (over: Partial<Facts>): Facts => ({
      app: 'folio', stack: stackName(s), run: 'mirror',
      parts: { web: 'running', api: 'running', database: 'running', worker: 'configured', signin: 'configured', email: 'configured' },
      database: { migrations: 1, checked_at: CHECKED }, checks: { smoke: 1, invariants: 1 },
      preview_expires_at: null, production: null, started: null, ...over,
    });
    const now = Date.parse(CHECKED) + 40_000;
    const hereOf = (run: string) => (run === 'mirror' ? 'localhost:8080' : run === 'live' ? HOST : `${run}.example.test`);
    const page = (f: Facts) => renderToStaticMarkup(createElement(Welcome, { facts: f, here: hereOf(f.run), now, moving: false }));
    const p7: string[] = [...routes];
    const p9: string[] = [];
    const p13: string[] = [];
    const p14: string[] = [];
    const want = (list: string[], label: string, t: string, phrase: string | RegExp) => {
      if (!(typeof phrase === 'string' ? t.includes(phrase) : phrase.test(t))) list.push(`${label}: no "${phrase}"`);
    };
    const never = (list: string[], label: string, t: string, phrase: string | RegExp) => {
      if (typeof phrase === 'string' ? t.includes(phrase) : phrase.test(t)) list.push(`${label}: says "${typeof phrase === 'string' ? phrase : t.match(phrase)![0]}"`);
    };

    // Every row of APP-9's table, and the mirror once per production state; each set up by hand and started from Start.
    const rows: [string, Partial<Facts>][] = [
      ['mirror, production unknown', { run: 'mirror', production: null }],
      ['mirror, reserved', { run: 'mirror', production: { url: URL_, version: null } }],
      ['mirror, released v3', { run: 'mirror', production: { url: URL_, version: 3 } }],
      ['live', { run: 'live' }],
      ['rehearsal', { run: 'rehearsal' }],
      ['preview', { run: 'preview', preview_expires_at: '2026-10-28T04:00:00.000Z' }],
      ['unknown', { run: 'unknown' }],
    ];
    const cases: [string, Facts][] = rows.flatMap(([label, over]) => [
      [label, facts(over)] as [string, Facts],
      [`${label}, started from Start`, facts({ ...over, started: 'live' })] as [string, Facts],
    ]);
    for (const [label, f] of cases) {
      const html = page(f);
      const t = textOf(html);
      // APP-9: the chip's exact words, and no other row's; "Live at" and a done "released" only when live.
      want(p9, label, t, CHIP[f.run]!);
      for (const [other, words] of Object.entries(CHIP)) if (other !== f.run) never(p9, label, t, words);
      if (f.run === 'live') {
        want(p9, label, t, new RegExp(`Live at\\s+${HOST.replace(/\./g, '\\.')}`));
        if (!releasedDone(html)) p9.push(`${label}: the "released" step isn\u2019t marked done`);
      } else {
        if (releasedDone(html)) p9.push(`${label}: the "released" step is marked done`);
        const released = f.run === 'mirror' && f.production?.version != null;
        if (!released) never(p9, label, t.replace(/not live/gi, ''), /\blive\b/i);
      }
      if (f.run === 'mirror') {
        want(p9, label, t, hereOf('mirror'));
        if (f.production === null) {
          want(p9, label, t, 'agc ship releases it');
          never(p9, label, t, /\(v\d/);
        } else if (f.production.version === null) {
          want(p9, label, t, 'reserved, not released');
          want(p9, label, t, HOST);
        } else {
          want(p9, label, t, /live at\s+folio\.agent\.cloud/i);
          want(p9, label, t, `(v${f.production.version})`);
        }
      }
      // APP-13: not-released copy only on a reserved mirror, released copy only on a mirror with a version.
      const reserved = f.run === 'mirror' && f.production !== null && f.production.version === null;
      const versioned = f.run === 'mirror' && f.production !== null && f.production.version !== null;
      for (const phrase of NOT_RELEASED) (reserved ? want : never)(p13, label, t, phrase);
      if (versioned) want(p13, label, t, `ran v${f.production!.version}: agc ship releases a new version`);
      else for (const phrase of RELEASED) never(p13, label, t, phrase);
      if (f.run === 'live') want(p13, label, t, 'Your next release replaces this one');
      // APP-13: the worker is only configured, so nothing says it runs jobs; release lines on a mirror say they're from its start.
      never(p13, label, t, /\bRuns background jobs\b/);
      // Each sentence that states production on a mirror carries the qualifier itself, not somewhere else on the page.
      if (reserved || versioned) for (const sentence of t.split(/(?<=[.!?:])\s+|\s·\s/)) {
        if (/nothing was released at|not released|ran v\d+|was public/i.test(sentence) && !/when this copy started/i.test(sentence)) p13.push(`${label}: "${sentence.trim().slice(0, 80)}" without "when this copy started"`);
      }
      // The app's address only from production.url, or the browser's when live: otherwise no <name>.agent.cloud at all.
      if (f.run !== 'live' && f.production === null) {
        never(p13, label, t, /\b[a-z0-9-]+\.agent\.cloud\b/);
        never(p13, label, html, /https?:\/\/[a-z0-9-]+\.agent\.cloud/);
      }
      // Reduced motion: no element in an animating context, nothing animated inline.
      never(p13, `${label} (reduced motion)`, html, /class="[^"]*\bmoving\b/);
      never(p13, `${label} (reduced motion)`, html, /style="[^"]*\banimation(-name)?\s*:/);
      // No console link; the footer names the stack and no version. Only an app started from Start names the console,
      // in words, as where its build shows (APP-14).
      never(p13, label, html, /href="[^"]*console/i);
      if (f.started === null) never(p13, label, t, /\bconsole\b/i);
      const footer = /<footer\b[\s\S]*?<\/footer>/.exec(html)?.[0];
      if (!footer) p13.push(`${label}: no <footer>`);
      else {
        const ft = textOf(footer);
        want(p13, `${label} footer`, ft, starter(s));
        never(p13, `${label} footer`, ft, /\bv?\d+\.\d+(\.\d+)?\b|\bv\d+\b/);
      }
      // APP-14: the hand-set-up words, or the started-from-Start ones, never a mix.
      for (const phrase of BY_HAND) (f.started === 'live' ? never : want)(p14, label, t, phrase);
      for (const phrase of STARTED) (f.started === 'live' ? want : never)(p14, label, t, phrase);
      want(p7, label, t, f.started === 'live' ? 'is about to be built' : 'is ready to build');
      never(p7, label, t, 'Your notes');
    }

    // APP-13: the Worker claims email only when email is set up.
    {
      const noMail = textOf(page(facts({ run: 'mirror', parts: { web: 'running', api: 'running', database: 'running', worker: 'configured', signin: 'configured', email: 'not set up' } })));
      never(p13, 'worker configured, email not set up', noMail, /send email/i);
      want(p13, 'worker and email configured', textOf(page(facts({ run: 'mirror' }))), 'send email through agent.cloud');
    }

    // APP-13: the Worker and Sign-in labels are what /api/welcome says, never "running".
    for (const state of ['configured', 'not set up']) {
      const f = facts({ run: 'mirror', parts: { web: 'running', api: 'running', database: 'running', worker: state, signin: state, email: state } });
      const t = textOf(page(f));
      const after = t.indexOf("What's running");
      const body = after >= 0 ? t.slice(after) : t;
      const w = body.search(/\bWorker\b/);
      const si = body.indexOf('Sign-in', Math.max(0, w));
      const ch = body.indexOf('Checks', Math.max(0, si));
      const worker = w >= 0 && si > w ? body.slice(w, si) : '';
      const signin = si >= 0 ? body.slice(si, ch > si ? ch : si + 160) : '';
      for (const [name, part] of [['Worker', worker], ['Sign-in', signin]] as const) {
        if (!part) p13.push(`parts ${state}: couldn\u2019t find the ${name} part`);
        else if (/\brunning\b/i.test(part)) p13.push(`parts ${state}: ${name} says running ("${part.slice(0, 80)}")`);
        else if (!part.includes(state)) p13.push(`parts ${state}: ${name} doesn\u2019t say "${state}" ("${part.slice(0, 80)}")`);
      }
    }

    // Notes: its own page, its sign-in returns to /notes, and no email status per note.
    const note = (i: number) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, title: `Note ${i}`, created_at: CHECKED });
    const notesPage = (user: unknown, notes: unknown[]) => renderToStaticMarkup(createElement(NotesView, {
      app: 'folio', user, notes, error: '', onAdd: async () => true, onSignOut: () => {},
    }));
    const user = { id: '00000000-0000-4000-8000-0000000000aa', email: 'pat@example.test', name: null };
    const out = notesPage(null, []);
    const none = notesPage(user, []);
    const three = notesPage(user, [note(1), note(2), note(3)]);
    for (const [label, html] of [['Notes signed out', out], ['Notes signed in', three]] as const) {
      const t = textOf(html);
      want(p7, label, t, 'Your notes');
      never(p7, label, t, 'is ready to build');
      want(p7, label, t, /\bexample\b/i);
      want(p7, label, t, /\bremoves?\b/i);
    }
    if (!/href="\/auth\/sign-in\?return_to=(\/|%2F)notes"/i.test(out)) p7.push('Notes signed out: no sign-in link to /auth/sign-in?return_to=/notes');
    const t3 = textOf(three);
    if (!['Note 1', 'Note 2', 'Note 3'].every((n) => t3.includes(n))) p13.push('Notes signed in: the notes it was given don\u2019t show');
    never(p13, 'Notes signed in', t3, /email queued/i);
    never(p13, 'Notes signed in', t3, /(?<!note\.)\bemailed\b/i);
    const emails = (h: string) => (textOf(h).match(/e-?mail/gi) ?? []).length;
    if (emails(three) !== emails(none)) p13.push(`Notes signed in: "email" appears ${emails(none)} times with no notes and ${emails(three)} with three: a per-note email status`);
    const once = (t3.match(/each new note sends/gi) ?? []).length;
    if (once !== 1) p13.push(`Notes signed in: says "each new note sends" ${once} times (once)`);

    const all = [...p7, ...p9, ...p13, ...p14];
    const summary = `${cases.length} welcome renders (every run, the mirror in each production state, each set up by hand and started from Start) and 3 Notes renders`;
    return (all.length ? fail : pass)(all.length ? all.slice(0, 6).join('; ') : summary, {
      'APP-7': verdict(!p7.length, p7.length ? p7.join('; ') : '/ renders the welcome page and /notes renders Notes, each with its own text; main.tsx routes both; Notes signs in with return_to=/notes'),
      'APP-9': verdict(!p9.length, p9.length ? p9.join('; ') : 'each run shows exactly its own status words; "Live at" and a done "released" step only when live; the mirror\u2019s line follows production'),
      'APP-13': verdict(!p13.length, p13.length ? p13.join('; ') : 'not-released copy only on a reserved mirror, released copy only with a version; nothing animates under reduced motion; no console link; the footer names the stack and no version; Worker and Sign-in say what the facts say; no per-note email status'),
      'APP-14': verdict(!p14.length, p14.length ? p14.join('; ') : 'started from Start: "about to be built", the agent\u2019s first change replaces the page, "Your agent is on it" and the Work page in agent.cloud\u2019s console, in every run; set up by hand: today\u2019s words and none of those'),
    });
  } catch (e) {
    return fail(`rendering the UI failed: ${(e as Error).message}`);
  } finally {
    loaded.done();
  }
}

// ---- CONF:welcome, CONF:welcome-run, CONF:signin-return ---------------------------------------------------------------

type Answer = { status: number; json: Record<string, unknown> | null; text: string; ms: number };
const TOP = ['app', 'checks', 'database', 'parts', 'preview_expires_at', 'production', 'run', 'stack', 'started'];
const PARTS = ['api', 'database', 'email', 'signin', 'web', 'worker'];
const STATES = new Set(['running', 'configured', 'not set up', 'not verified']);
const keys = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : String(o));
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

// The answer has exactly APP-8's fields, each of the right kind.
function shapeProblems(j: Record<string, unknown> | null): string[] {
  if (!j) return ['not JSON'];
  const p: string[] = [];
  if (keys(j) !== TOP.join(',')) p.push(`fields ${keys(j)}`);
  const parts = j.parts as Record<string, unknown> | undefined;
  if (keys(parts) !== PARTS.join(',')) p.push(`parts ${keys(parts)}`);
  else for (const k of PARTS) if (!STATES.has(String(parts![k]))) p.push(`parts.${k} = ${JSON.stringify(parts![k])}`);
  const db = j.database as Record<string, unknown> | undefined;
  const verified = parts?.database === 'running';
  if (keys(db) !== (verified ? 'checked_at,migrations' : 'checked_at,migrations,reason')) p.push(`database ${keys(db)} while ${String(parts?.database)}`);
  if (db && !ISO.test(String(db.checked_at))) p.push(`database.checked_at ${JSON.stringify(db.checked_at)}`);
  if (keys(j.checks) !== 'invariants,smoke') p.push(`checks ${keys(j.checks)}`);
  if (j.production !== null && keys(j.production) !== 'url,version') p.push(`production ${keys(j.production)}`);
  if (j.preview_expires_at !== null && !ISO.test(String(j.preview_expires_at))) p.push(`preview_expires_at ${JSON.stringify(j.preview_expires_at)}`);
  if (j.started !== null && j.started !== 'live') p.push(`started ${JSON.stringify(j.started)}`);
  return p;
}

export async function welcomeApi(env: Env, log: (m: string) => void): Promise<Map<string, TestResult>> {
  const out = new Map<string, TestResult>();
  const s = env.stack;
  const SENTINEL = `agcsentinel${randomBytes(8).toString('hex')}`;
  const name = `conf-${tag()}`;
  const call = async (c: Container, path = '/api/welcome', ms = 10_000): Promise<Answer> => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${env.base(c)}${path}`, { signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      let json: Record<string, unknown> | null = null;
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
      return { status: r.status, json, text, ms: Date.now() - t0 };
    } catch (e) {
      return { status: 0, json: null, text: (e as Error).message, ms: Date.now() - t0 };
    }
  };
  // Ready, or exited (a missing variable stops it at once, PROC-9), or neither within 60 s.
  const up = async (c: Container) => (await until(60_000, async () => {
    if (!(await env.inspect(c)).running) return 'exited' as const;
    return (await fetch(`${env.base(c)}/api/health`, { signal: AbortSignal.timeout(2000) })).status === 200 ? 'ready' as const : undefined;
  }, 250)) ?? 'timeout' as const;
  const probes = async () => (await env.statements()).filter((st) => st.text.includes(LEDGER)).length;

  // APP-8: a manifest with its own name and a secret in the worker's command and in `[app] started`, mounted over the
  // image's own; and APP-14's, the starter's own with `started = "live"`, as agc init writes it for an app made through Start.
  const manifestDir = join(env.tmp, 'welcome');
  mkdirSync(manifestDir, { recursive: true });
  chmodSync(manifestDir, 0o755);
  const own = () => parse(readFileSync(join(s.dir, 'agentcloud.toml'), 'utf8')) as Record<string, Record<string, unknown>>;
  const writeManifest = (file: string, raw: Record<string, Record<string, unknown>>) => {
    writeFileSync(join(manifestDir, file), stringify(raw));
    chmodSync(join(manifestDir, file), 0o644);
    return join(manifestDir, file);
  };
  const raw = own();
  raw.app = { ...raw.app, name, started: SENTINEL };
  const service = (raw.service ?? {}) as Record<string, Record<string, unknown>>;
  service.worker = { ...service.worker, command: `${String(service.worker?.command ?? 'true')} --conformance-secret ${SENTINEL}` };
  raw.service = service;
  const secretManifest = writeManifest('agentcloud.toml', raw);
  const startedRaw = own();
  startedRaw.app = { ...startedRaw.app, started: 'live' };
  const startedManifest = writeManifest('started.toml', startedRaw);
  const workdir = (await must('docker', ['image', 'inspect', '-f', '{{.Config.WorkingDir}}', env.image])).trim() || '/app';

  const without = (e: Record<string, string>, ...names: string[]) => { for (const n of names) delete e[n]; return e; };
  const mirror = { AGENTCLOUD_MIRROR: 'conformance' };
  const cases: { key: string; env: Record<string, string>; run: string; production: Production; preview?: string | null; signin?: string; email?: string }[] = [
    { key: 'mirror+live, released empty', env: env.appEnv({ ...mirror, AGC_RUN: 'live', AGENTCLOUD_APP_URL: URL_, AGENTCLOUD_RELEASED: '' }), run: 'mirror', production: { url: URL_, version: null } },
    { key: 'mirror, released 3, email URL only', env: without(env.appEnv({ ...mirror, AGENTCLOUD_APP_URL: URL_, AGENTCLOUD_RELEASED: '3' }), 'AGC_EMAIL_TOKEN'), run: 'mirror', production: { url: URL_, version: 3 }, email: 'not set up' },
    { key: 'mirror, released absent, email token only', env: without(env.appEnv({ ...mirror, AGENTCLOUD_APP_URL: URL_ }), 'AGC_EMAIL_URL'), run: 'mirror', production: null, email: 'not set up' },
    { key: 'mirror, an http:// URL', env: env.appEnv({ ...mirror, AGENTCLOUD_APP_URL: 'http://folio.agent.cloud', AGENTCLOUD_RELEASED: '3' }), run: 'mirror', production: null },
    { key: 'live (production off a mirror)', env: env.appEnv({ AGC_RUN: 'live', AGENTCLOUD_APP_URL: URL_, AGENTCLOUD_RELEASED: '3' }), run: 'live', production: null },
    { key: 'rehearsal', env: env.appEnv({ AGC_RUN: 'rehearsal' }), run: 'rehearsal', production: null },
    { key: 'preview', env: env.appEnv({ AGC_PREVIEW_EXPIRES_AT: '2026-10-21T06:00:00+02:00' }), run: 'preview', production: null, preview: '2026-10-21T04:00:00.000Z' },
    { key: 'unknown', env: env.appEnv(), run: 'unknown', production: null, preview: null, signin: 'configured', email: 'configured' },
  ];
  const signinCases = [
    { key: 'sign-in URL only', env: without(env.appEnv(), 'AGC_AUTH_TOKEN'), missing: 'AGC_AUTH_TOKEN' },
    { key: 'sign-in token only', env: without(env.appEnv(), 'AGC_AUTH_URL'), missing: 'AGC_AUTH_URL' },
  ];

  log('welcome: starting the app once per run, production and secrets case…');
  const started: Container[] = [];
  const start = async (n: string, e: Record<string, string>, mounts: string[] = []) => { const c = await env.web(n, e, { alias: false, mounts }); started.push(c); return c; };
  const secret = await start('wsecret', env.appEnv({ CONFORMANCE_WELCOME_SECRET: SENTINEL, AGC_AUTH_URL: `${PLATFORM}/auth/test/${SENTINEL}` }), [`${secretManifest}:${workdir}/agentcloud.toml:ro`]);
  const burst = await start('wburst', env.appEnv());
  const paused = await start('wpaused', env.appEnv());
  const fromStart = await start('wstarted', env.appEnv(), [`${startedManifest}:${workdir}/agentcloud.toml:ro`]);
  const runs = await Promise.all(cases.map((c, i) => start(`wrun${i}`, c.env)));
  const signins = await Promise.all(signinCases.map((c, i) => start(`wsignin${i}`, c.env)));
  const states = await Promise.all([secret, burst, paused, fromStart, ...runs, ...signins].map(up));
  const [sUp, bUp, pUp, fUp] = states;
  const runUp = states.slice(4, 4 + runs.length);
  const signinUp = states.slice(4 + runs.length);
  let dbPaused = false;
  try {
    if (sUp !== 'ready' || bUp !== 'ready' || pUp !== 'ready' || fUp !== 'ready') {
      const logs = (await env.logs(sUp !== 'ready' ? secret : bUp !== 'ready' ? burst : pUp !== 'ready' ? paused : fromStart)).slice(-5).join(' | ');
      const r = fail(`the app didn\u2019t become ready for the welcome checks: ${logs}`);
      for (const t of ['CONF:welcome', 'CONF:welcome-run', 'CONF:signin-return']) out.set(t, r);
      return out;
    }
    const [{ n: ledger }] = await env.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${LEDGER}`);
    const p8: string[] = [];
    const p10: string[] = [];
    const p14: string[] = [];

    // APP-10: 50 callers at once on a fresh process share one probe on at most one connection; more calls within 60 s
    // run no new query.
    const ip = await env.ipOf(burst);
    await sleep(500);
    const before = await probes();
    let busy = true;
    let maxConns = 0;
    const sampler = (async () => {
      while (busy) {
        const [{ n }] = await env.sql<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE client_addr = $1::inet', [ip]).catch(() => [{ n: 0 }]);
        maxConns = Math.max(maxConns, n);
        await sleep(20);
      }
    })();
    const answers = await Promise.all(Array.from({ length: 50 }, () => call(burst)));
    const firstAt = Date.now();
    await sleep(300);
    busy = false;
    await sampler;
    await sleep(500);
    const afterBurst = await probes();
    for (let i = 0; i < 10; i++) await call(burst);
    await sleep(500);
    const afterRepeat = await probes();
    const burstChecked = new Set(answers.map((a) => (a.json?.database as { checked_at?: string } | undefined)?.checked_at));
    const allOk = answers.every((a) => a.status === 200 && (a.json?.parts as Record<string, string> | undefined)?.database === 'running');
    if (!allOk) p10.push(`50 concurrent calls: ${answers.filter((a) => a.status !== 200).length} not 200, database ${[...new Set(answers.map((a) => String((a.json?.parts as Record<string, string> | undefined)?.database)))].join('/')}`);
    if (maxConns > 1) p10.push(`50 concurrent calls opened ${maxConns} connections`);
    if (afterBurst - before !== 1) p10.push(`50 concurrent calls ran ${afterBurst - before} probe queries (one)`);
    if (afterRepeat !== afterBurst) p10.push(`10 more calls within 60 s ran ${afterRepeat - afterBurst} more`);
    if (burstChecked.size !== 1) p10.push(`50 concurrent calls saw ${burstChecked.size} different checked_at`);
    const burstEvidence = `50 concurrent calls: ${afterBurst - before} probe, at most ${maxConns} connection; 10 more within 60 s: ${afterRepeat - afterBurst} more`;

    // APP-8, APP-10: with its own manifest and a secret in the environment, AGC_AUTH_URL and the worker's command.
    const sec = await call(secret);
    const shape = shapeProblems(sec.json);
    if (sec.status !== 200) p8.push(`answered ${sec.status}`);
    if (shape.length) p8.push(shape.join(', '));
    if (sec.json?.app !== name) p8.push(`app ${JSON.stringify(sec.json?.app)}, not the manifest\u2019s ${name}`);
    if (sec.json?.stack !== stackName(s)) p8.push(`stack ${JSON.stringify(sec.json?.stack)}`);
    const leaks = [[SENTINEL, 'the sentinel'], [env.password, 'the database password'], [env.authUrl, 'AGC_AUTH_URL'], ['agca_conformance', 'AGC_AUTH_TOKEN'], ['agce_conformance', 'AGC_EMAIL_TOKEN'], ['platform:8099', 'a platform URL']]
      .filter(([v]) => sec.text.includes(v!)).map(([, w]) => w);
    if (leaks.length) p8.push(`the answer carries ${leaks.join(', ')}`);
    const parts = (sec.json?.parts ?? {}) as Record<string, string>;
    const db = (sec.json?.database ?? {}) as Record<string, unknown>;
    if (parts.web !== 'running' || parts.api !== 'running') p10.push(`web ${parts.web}, api ${parts.api}`);
    if (parts.database !== 'running' || db.migrations !== ledger) p10.push(`database ${parts.database} with ${String(db.migrations)} migrations; the ledger has ${ledger}`);
    if (parts.worker !== 'configured') p10.push(`worker ${parts.worker} with [service.worker] in the manifest`);
    // APP-8, APP-14: `started` is "live" only for exactly that; the sentinel in `[app] started` is null and never echoed
    // (the leak check above), and the starter's own manifest, which has none, is null.
    const startedProblems: string[] = [];
    if (sec.json?.started !== null) startedProblems.push(`started ${JSON.stringify(sec.json?.started)} with a sentinel in [app] started (null)`);
    const own0 = answers[0]?.json?.started;
    if (own0 !== null || answers.some((a) => a.json?.started !== own0)) startedProblems.push(`started ${JSON.stringify(own0)} with the starter\u2019s own manifest (null)`);
    const fromStartAnswer = await call(fromStart);
    if (fromStartAnswer.json?.started !== 'live') startedProblems.push(`started ${JSON.stringify(fromStartAnswer.json?.started)} with started = "live" (live)`);
    const fromStartShape = shapeProblems(fromStartAnswer.json);
    if (fromStartShape.length) startedProblems.push(`started = "live": ${fromStartShape.join(', ')}`);
    p8.push(...startedProblems);
    p14.push(...startedProblems);
    const { smoke, invariant } = readChecks(s.raw);
    const checks = (sec.json?.checks ?? {}) as Record<string, unknown>;
    if (checks.smoke !== smoke.length || checks.invariants !== invariant.length) p10.push(`checks ${JSON.stringify(checks)}; the manifest has ${smoke.length} smoke and ${invariant.length} invariants`);

    // APP-9: each row's variables, the mirror winning over AGC_RUN=live; production only on a mirror.
    const p9: string[] = [];
    const seen: string[] = [];
    await Promise.all(cases.map(async (c, i) => {
      if (runUp[i] !== 'ready') { p9.push(`${c.key}: the app ${runUp[i] === 'exited' ? 'exited' : 'never became ready'}`); return; }
      const a = await call(runs[i]!);
      const bad = shapeProblems(a.json);
      if (bad.length) p8.push(`${c.key}: ${bad.join(', ')}`);
      for (const [v, w] of [[env.password, 'the database password'], ['agca_conformance', 'AGC_AUTH_TOKEN'], ['agce_conformance', 'AGC_EMAIL_TOKEN']] as const) if (a.text.includes(v)) p8.push(`${c.key}: carries ${w}`);
      seen.push(`${c.key} \u2192 ${String(a.json?.run)}`);
      if (a.json?.run !== c.run) p9.push(`${c.key}: run ${JSON.stringify(a.json?.run)}, not ${c.run}`);
      if (JSON.stringify(a.json?.production) !== JSON.stringify(c.production)) p9.push(`${c.key}: production ${JSON.stringify(a.json?.production)}, not ${JSON.stringify(c.production)}`);
      if (c.preview !== undefined) {
        const got = a.json?.preview_expires_at;
        if (c.preview === null ? got !== null : !(typeof got === 'string' && ISO.test(got) && Date.parse(got) === Date.parse(c.preview))) p8.push(`${c.key}: preview_expires_at ${JSON.stringify(got)}, not ${JSON.stringify(c.preview)}`);
      }
      const ps = (a.json?.parts ?? {}) as Record<string, string>;
      if (c.signin && ps.signin !== c.signin) p10.push(`${c.key}: signin ${ps.signin}, not ${c.signin}`);
      if (c.email && ps.email !== c.email) p10.push(`${c.key}: email ${ps.email}, not ${c.email}`);
    }));
    // APP-10: sign-in is configured only with both halves. A starter that refuses to start without both (PROC-9) never
    // shows it at all, which can't overclaim either.
    const signinSeen: string[] = [];
    await Promise.all(signinCases.map(async (c, i) => {
      if (signinUp[i] === 'exited') {
        const last = (await env.logs(signins[i]!)).at(-1) ?? '';
        if (!last.includes(c.missing)) p10.push(`${c.key}: exited without naming ${c.missing}`);
        signinSeen.push(`${c.key}: the app stops at start, naming ${c.missing}`);
        return;
      }
      if (signinUp[i] !== 'ready') { p10.push(`${c.key}: neither ready nor stopped in 60 s`); return; }
      const a = await call(signins[i]!);
      const got = (a.json?.parts as Record<string, string> | undefined)?.signin;
      if (got !== 'not set up') p10.push(`${c.key}: signin ${got}`);
      signinSeen.push(`${c.key}: ${got}`);
    }));

    // CONF:signin-return: from /notes, signed in through the fake platform, back at /notes; and never to another site.
    {
      const via = runs[cases.findIndex((c) => c.key === 'unknown')]!;
      const jar: Jar = new Map();
      const who = `return-${tag()}@example.test`;
      const got = await signIn(env, via, jar, who, undefined, '/auth/sign-in?return_to=/notes');
      const loc = got.callback?.headers.get('location') ?? '';
      const landed = loc ? new URL(loc, env.base(via)) : null;
      const page = landed ? await req(env, via, jar, 'GET', `${landed.pathname}${landed.search}`) : null;
      const me = await req(env, via, jar, 'GET', '/api/me');
      const evil: Jar = new Map();
      const away = await signIn(env, via, evil, `away-${tag()}@example.test`, undefined, `/auth/sign-in?return_to=${encodeURIComponent('//evil.test/x')}`);
      const awayLoc = away.callback?.headers.get('location') ?? '';
      // A browser drops a tab from a URL, so `/<tab>/evil.test` would be `//evil.test`: it must stay on this app too.
      const tabbed = await signIn(env, via, new Map(), `tab-${tag()}@example.test`, undefined, `/auth/sign-in?return_to=${encodeURIComponent('/\t/evil.test')}`);
      const tabLoc = tabbed.callback?.headers.get('location') ?? '';
      const stays = (l: string) => !!l && !/[\u0000-\u001f]/.test(l) && new URL(l, env.base(via)).origin === new URL(env.base(via)).origin;
      const awayOk = stays(awayLoc) && stays(tabLoc);
      const ok = !got.problem && !!landed && landed.origin === new URL(env.base(via)).origin && landed.pathname === '/notes' && page?.status === 200 && me.status === 200 && awayOk;
      out.set('CONF:signin-return', (ok ? pass : fail)(got.problem ?? `the callback answered ${got.callback?.status} to ${loc || 'nowhere'}; /notes then ${page?.status ?? 'not fetched'}, /api/me ${me.status}; return_to=//evil.test landed at ${awayLoc || 'nowhere'}, /<tab>/evil.test at ${JSON.stringify(tabLoc) || 'nowhere'}${awayOk ? ' (both this app)' : ' (off this app)'}`));
    }

    // APP-10: with the database frozen, a fresh process says not verified (timeout) within 3 s, and health still answers.
    await env.pauseDb();
    dbPaused = true;
    const frozenAt = Date.now();
    const frozen = await call(paused, '/api/welcome', 10_000);
    const health = await call(paused, '/api/health', 2_000);
    const fdb = (frozen.json?.database ?? {}) as Record<string, unknown>;
    const fparts = (frozen.json?.parts ?? {}) as Record<string, string>;
    const frozenOk = frozen.status === 200 && frozen.ms <= 3000 && fparts.database === 'not verified' && fdb.reason === 'timeout' && fdb.migrations === null && health.status === 200;
    if (!frozenOk) p10.push(`database frozen: /api/welcome ${frozen.status} in ${frozen.ms} ms, ${fparts.database ?? 'no state'} (${String(fdb.reason)}, migrations ${String(fdb.migrations)}); /api/health ${health.status}`);
    const frozenShape = shapeProblems(frozen.json);
    if (frozenShape.length) p8.push(`database frozen: ${frozenShape.join(', ')}`);

    // APP-10: the cached "running" expires: after 60 s, still frozen, the next probe says not verified, checked later.
    const wait = firstAt + 61_000 - Date.now();
    log(`welcome: waiting ${Math.round(wait / 1000)} s for the cached probe to expire…`);
    if (wait > 0) await sleep(wait);
    const expired = await call(burst, '/api/welcome', 10_000);
    const edb = (expired.json?.database ?? {}) as Record<string, unknown>;
    const wasChecked = [...burstChecked][0] ?? '';
    const later = typeof edb.checked_at === 'string' && Date.parse(edb.checked_at) > Date.parse(String(wasChecked));
    const expiredOk = expired.status === 200 && expired.ms <= 3000 && (expired.json?.parts as Record<string, string> | undefined)?.database === 'not verified' && later;
    if (!expiredOk) p10.push(`after 60 s with the database frozen: ${expired.status} in ${expired.ms} ms, ${String((expired.json?.parts as Record<string, string> | undefined)?.database)}, checked_at ${String(edb.checked_at)} (was ${wasChecked})`);
    await env.unpauseDb();
    dbPaused = false;

    // APP-10: a probe torn down at its timeout leaves nothing behind: once the frozen result expires, the database back,
    // the next probe answers running at once, not queued behind the frozen one.
    const frozenDone = typeof fdb.checked_at === 'string' ? Date.parse(fdb.checked_at) : frozenAt + 3_000; // cached from when it finished
    const recoverWait = frozenDone + 61_000 - Date.now();
    if (recoverWait > 0) await sleep(recoverWait);
    const recovered = await call(paused, '/api/welcome', 10_000);
    const rparts = (recovered.json?.parts ?? {}) as Record<string, string>;
    if (!(recovered.status === 200 && recovered.ms <= 3000 && rparts.database === 'running')) p10.push(`after the frozen probe expired, database back: ${recovered.status} in ${recovered.ms} ms, ${rparts.database ?? 'no state'}`);

    out.set('CONF:welcome', (p8.length || p10.length ? fail : pass)([...p8, ...p10].slice(0, 4).join('; ') || 'the answer, its secrets and its database probe', {
      'APP-14': verdict(!p14.length, p14.length ? p14.join('; ') : 'started is "live" with started = "live" in the manifest, null with the starter\u2019s own manifest and with a sentinel in [app] started'),
      'APP-8': verdict(!p8.length, p8.length ? p8.join('; ') : `exactly APP-8\u2019s fields in every case; app is the mounted manifest\u2019s ${name}; a sentinel in an env var, AGC_AUTH_URL, the worker\u2019s command and [app] started, and the app\u2019s tokens and database password, appear in no answer`),
      'APP-10': verdict(!p10.length, p10.length ? p10.join('; ') : `database running with ${ledger} migrations (the ledger\u2019s count); frozen: not verified (timeout) in ${frozen.ms} ms, health ${health.status}; ${burstEvidence}; after 60 s frozen: not verified, checked later; frozen probe expired, database back: running in ${recovered.ms} ms; email with one half: not set up; ${signinSeen.join('; ')}`),
    }));
    out.set('CONF:welcome-run', (p9.length ? fail : pass)(p9.length ? p9.join('; ') : `${seen.sort().join('; ')}; production as expected in each`));
    return out;
  } finally {
    if (dbPaused) await env.unpauseDb().catch(() => {});
    for (const c of started) await sh('docker', ['rm', '-f', c.name]);
  }
}

