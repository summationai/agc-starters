// The welcome page at / (SPEC.md APP-7 to APP-13). Everything it claims comes from GET /api/welcome or the address the
// browser is on: where the app runs, what's running, whether it's released. Replace it with your app's own first page;
// the Notes example lives in Notes.tsx.
import { type ReactNode, useEffect, useState } from 'react';
import { api, type PartState, type Welcome as Facts } from './api.ts';

const STACKS = {
  typescript: { name: 'TypeScript starter', web: 'React 19 + Vite 8', api: 'Hono on Node 24', worker: 'a Node 24 worker' },
  python: { name: 'Python starter', web: 'React 19 + Vite 8', api: 'FastAPI on Python 3.12', worker: 'a Python 3.12 worker' },
} as const;
const PROMPT = 'Turn this into [WHAT YOUR APP DOES]. People should be able to [THE FIRST THING THEY DO].';

export function App() {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [moving] = useState(() => !matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    void api.welcome().then((r) => setFacts(r.data));
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);
  return <Welcome facts={facts} here={location.host} now={now} moving={moving} />;
}

const host = (url: string) => new URL(url).host;
const ago = (at: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// The page itself, from the facts alone, so it renders the same in the browser and in conformance (CONF:welcome-copy).
export function Welcome({ facts, here, now, moving }: { facts: Facts | null; here: string; now: number; moving: boolean }) {
  const stack = facts ? STACKS[facts.stack] : { name: '', web: '', api: '', worker: '' }; // nothing claimed before the facts
  const app = facts?.app || 'This app';
  const run = facts?.run;
  const prod = run === 'mirror' ? facts?.production ?? null : null;
  const unreleased = prod !== null && prod.version === null; // agent.cloud said: never released, as this copy started
  const where = run === 'live' ? here : prod ? host(prod.url) : null; // the app's address, only when it's known
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(PROMPT).then(() => setCopied(true));
  return (
    <div className={moving ? 'moving' : undefined}>
      <header className="wrap top">
        <a className="brand" href="https://agent.cloud" aria-label="agent.cloud"><Stripes size={32} />agent.cloud</a>
        <span className="stackname">{stack.name}</span>
      </header>
      <main className="wrap">
        <section className="hero" aria-labelledby="hero-h">
          <div className="mark" aria-hidden="true">
            {['teal', 'pink', 'orange', 'blue'].map((c, i) => <span className="slot" key={c}><span className="bar" style={{ background: `var(--${c})`, animationDelay: `${i * 0.08}s, ${1.3 + i * 0.2}s` }} /></span>)}
          </div>
          {facts && <div className="chips up d1">{chips(facts, here, prod)}</div>}
          <h1 id="hero-h" className="title up d2">{app} is ready to build.</h1>
          <p className="lede up d3">
            This is the agent.cloud starter: a web app, an API, a Postgres database and a background worker, wired together{run === 'mirror' ? ' and running on your machine' : ''}.
            {unreleased ? ' Nothing was public when this copy started.' : ''} Tell your agent what to build, and this page becomes your app.
          </p>
          <ol className="steps up d4" aria-label={`Where ${app} is`}>
            <li className="done"><Check size={17} />Started</li>
            <li className="rule" aria-hidden="true" />
            {run === 'live'
              ? <li className="done"><Check size={17} />Building</li>
              : <li className="now" aria-current="step"><span className="ring"><span /><span /></span>Building</li>}
            <li className="rule" aria-hidden="true" />
            {run === 'live'
              ? <li className="now" aria-current="step"><Check size={17} />Released at {here}</li>
              : <li className="later"><span className="pending" />{where ? `Released at ${where}` : 'Released'}</li>}
          </ol>
        </section>

        <section className="card next up d5" aria-labelledby="next-h">
          <p className="eyebrow">Next</p>
          <h2 id="next-h">Tell your agent what to build.</h2>
          <p className="say">Say what the app is for, in a sentence or two. Your agent edits this starter, runs its checks, and ships it here.</p>
          <div className="prompt">
            <p>“Turn this into <span className="ph1">[WHAT YOUR APP DOES]</span>. People should be able to <span className="ph2">[THE FIRST THING THEY DO]</span>.”<span className="caret" aria-hidden="true" /></p>
            <button type="button" className="btn btn-cream" onClick={copy}>{copied ? <Check size={16} /> : <Stripes size={22} light />}{copied ? 'Copied' : 'Copy prompt'}</button>
          </div>
          <p role="status" className="sr">{copied ? 'Prompt copied' : ''}</p>
        </section>

        <ol className="loop up d6" aria-label="The loop">
          <li className="card">
            <div className="head"><code>agc up</code>{run === 'mirror' ? <span className="when on"><span className="dot live" />running now</span> : <span className="when">local</span>}</div>
            <p>{run === 'mirror' ? 'This page, on your machine, reloading as you edit.' : 'A copy of this app on your machine, reloading as you edit.'}</p>
          </li>
          <li className="card">
            <div className="head"><code>agc check</code><span className="when">next</span></div>
            <p>Runs the checks in <code>agentcloud.toml</code>.</p>
          </li>
          <li className="card">
            <div className="head"><code>agc ship</code><span className="when">then</span></div>
            <p>{shipLine(run, prod, where)} A person approves what’s risky.</p>
          </li>
        </ol>

        <section className="running" aria-labelledby="run-h">
          <div className="head">
            <h2 id="run-h">What’s running</h2>
            <p>{run === 'mirror' ? 'Wired together on your machine.' : run === 'live' ? 'Wired together on agent.cloud.' : 'Wired together.'}</p>
          </div>
          <ul className="diagram" aria-label="Browser to web to API to Postgres; the worker also uses Postgres">
            <li className="node browser">
              <Icon d={['M3 9h18', 'M6.5 6.5h.01', 'M9 6.5h.01']} rect />
              <p className="name">Browser</p>
              <p className="where">you, at {here}</p>
            </li>
            <Wire n={1} />
            <Node name="Web" color="teal" state={facts?.parts.web} stackLine={stack.web}>Serves this page{run === 'mirror' ? ', reloading on save' : ''}.</Node>
            <Wire n={2} />
            <Node name="API" color="pink" state={facts?.parts.api} stackLine={stack.api}><code>GET /api/welcome</code> answered.</Node>
            <Wire n={3} />
            <Node name="Database" color="orange" state={facts?.parts.database} stackLine="Postgres 18">{facts ? databaseLine(facts, now) : null}</Node>
            <Wire n={4} rev />
            <Node name="Worker" color="blue" state={facts?.parts.worker} stackLine={stack.worker}>{facts?.parts.worker === 'not set up' ? 'No worker in agentcloud.toml.' : `Set up to run background jobs${facts?.parts.email === 'configured' ? ' and send email through agent.cloud' : ''}.`}</Node>
          </ul>
          <div className="extras">
            <div className="card extra">
              <Icon d={['M4 21a8 8 0 0 1 16 0']} circle />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row"><b>Sign-in</b><code>/auth/sign-in</code><Label state={facts?.parts.signin} /></div>
                <p className="detail">agent.cloud accounts. No keys or passwords to manage.</p>
              </div>
            </div>
            <div className="card extra">
              <Icon d={['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4']} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row"><b>Checks</b><code>agentcloud.toml</code><Label state={facts ? 'configured' : undefined} /></div>
                <p className="detail">{facts ? `${plural(facts.checks.smoke, 'smoke flow')} and ${plural(facts.checks.invariants, 'invariant')} run before every release.` : null}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="example" aria-labelledby="notes-h">
          <div>
            <p className="eyebrow">Example<span className="dots" aria-hidden="true">{['teal', 'pink', 'orange', 'blue'].map((c) => <span key={c} style={{ background: `var(--${c})` }} />)}</span></p>
            <h2 id="notes-h">See every piece working: the Notes example</h2>
            <p className="say">Sign in, add a note, and get an email for it. It touches the web app, the API, the database, the worker and sign-in. Your agent removes it once your app takes shape.</p>
          </div>
          <a href="/notes" className="btn btn-cream">Open Notes<Arrow /></a>
        </section>

        <footer className="foot">
          <div className="foot-row">
            <p>Edit <code className="chipcode">web/src/App.tsx</code> and save to see it here, or just ask your agent.</p>
            <nav aria-label="Starter links">
              <span className="flink" title="Your agent’s instructions, in this app’s folder">AGENTS.md</span>
              <a className="flink" href="https://agent.cloud/agents.md">agent.cloud</a>
            </nav>
          </div>
          <p className="foot-stack">{stack.name}</p>
        </footer>
      </main>
    </div>
  );
}

// APP-9: the status chips, each exactly the words its run allows.
function chips(facts: Facts, here: string, prod: Facts['production']): ReactNode {
  switch (facts.run) {
    case 'mirror': return <>
      <span className="chip"><span className="dot live" />Running on this machine<span className="mono">{here}</span></span>
      {prod === null
        ? <span className="chip dashed"><span className="dot hollow" /><span className="muted"><code>agc ship</code> releases it</span></span>
        : prod.version === null
          ? <span className="chip dashed"><span className="dot hollow" /><span className="mono">{host(prod.url)}</span><span className="muted">reserved, not released when this copy started</span></span>
          : <span className="chip dashed"><span className="dot" />live at<span className="mono">{host(prod.url)}</span><span className="muted">(v{prod.version}) when this copy started · this is your local copy</span></span>}
    </>;
    case 'live': return <span className="chip"><span className="dot live" />Live at<span className="mono">{here}</span></span>;
    case 'rehearsal': return <span className="chip dashed"><span className="dot hollow" />A rehearsal of a release, not live yet.</span>;
    case 'preview': return <span className="chip dashed"><span className="dot hollow" />A preview, not live{facts.preview_expires_at ? <span className="muted">, until {new Date(facts.preview_expires_at).toUTCString()}</span> : null}</span>;
    default: return <span className="chip dashed"><span className="dot hollow" />This page can’t tell where it’s running.</span>;
  }
}

// APP-13: what `agc ship` does next. On a mirror agc's word on production is from when this copy started, so it says so.
function shipLine(run: Facts['run'] | undefined, prod: Facts['production'], where: string | null): string {
  if (run === 'live') return 'Your next release replaces this one.';
  if (prod && prod.version === null) return `When this copy started, nothing was released at ${where}: agc ship releases it there.`;
  if (prod && prod.version !== null) return `When this copy started, ${where} ran v${prod.version}: agc ship releases a new version there.`;
  return 'agc ship releases it.';
}

function databaseLine(facts: Facts, now: number): string {
  const checked = `Checked ${ago(facts.database.checked_at, now)}.`;
  if (facts.parts.database === 'running') return `${facts.run === 'mirror' ? 'Your private copy. ' : ''}${plural(facts.database.migrations ?? 0, 'migration')} applied. ${checked}`;
  const why = { unreachable: 'No connection.', timeout: 'No answer within 2 seconds.', query_failed: 'Connected, but the check failed.' }[facts.database.reason ?? 'unreachable'];
  return `${why} ${checked}`;
}

function Node({ name, color, state, stackLine, children }: { name: string; color: string; state?: PartState; stackLine: string; children: ReactNode }) {
  return (
    <li className="card node">
      <div className="name"><span className="stripe" aria-hidden="true" style={{ background: `var(--${color})` }} />{name}<Label state={state} /></div>
      <p className="stackline">{stackLine}</p>
      <p className="detail">{children}</p>
    </li>
  );
}

// APP-10: "running" only for what was checked; the rest say what they are.
function Label({ state }: { state?: PartState }) {
  if (!state) return null;
  return <span className={`label${state === 'running' ? ' running' : state === 'configured' ? '' : ' warn'}`}>{state === 'running' ? <Check size={12} /> : null}{state}</span>;
}

const Wire = ({ n, rev }: { n: number; rev?: boolean }) => <li aria-hidden="true" className={`wire w${n}${rev ? ' rev' : ''}`}><span className="tip" /></li>;

function Stripes({ size, light }: { size: number; light?: boolean }) {
  const fills = light ? ['--mb1', '--mb2', '--mb3', '--mb4'] : ['--teal', '--pink', '--orange', '--blue'];
  return (
    <svg width={size} height={Math.round(size * 0.59)} viewBox="0 0 44 26" aria-hidden="true">
      {fills.map((f, i) => <polygon key={f} points={`${6 + i * 10},0 ${11 + i * 10},0 ${5 + i * 10},26 ${i * 10},26`} style={{ fill: `var(${f})` }} />)}
    </svg>
  );
}
const Check = ({ size }: { size: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size > 14 ? 2 : 3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>;
const Arrow = () => <svg className="nudge" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>;
function Icon({ d, rect, circle }: { d: string[]; rect?: boolean; circle?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--muted)' }}>
      {rect ? <rect x="3" y="4" width="18" height="16" rx="2.5" /> : null}{circle ? <circle cx="12" cy="8" r="4" /> : null}
      {d.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}
