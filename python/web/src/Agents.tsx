// People's own agents over MCP (SPEC.md AMCP-6 to AMCP-10): /agents to connect, see and revoke them (and for owners,
// everyone's, and blocked tools); /agents/consent where a person says yes once; /agents/approve/<id> where they OK one
// destructive call. And the badge: a quiet chip that links here, with Point.
import { type ReactNode, useEffect, useState } from 'react';
import { agents, type AgentsView, type Approval, type Connection, type Consent } from './api.ts';

const HIDDEN = 'agc-agent-badge-hidden';
const hidden = () => { try { return localStorage.getItem(HIDDEN) === '1'; } catch { return false; } };

export function AgentsPage() {
  const path = location.pathname.replace(/\/+$/, '');
  const page = path === '/agents/consent' ? <ConsentPage /> : path.startsWith('/agents/approve/') ? <ApprovePage id={path.slice('/agents/approve/'.length)} /> : <Overview />;
  return <main className="wrap agents-page">{page}</main>;
}

function Overview() {
  const [view, setView] = useState<AgentsView | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const load = () => void agents.view().then((r) => setView(r.data));
  useEffect(load, []);
  if (view === undefined) return null;
  if (!view) return <section className="signin"><h1 className="title">Use this app with your agent</h1><p>Sign in to connect your agent and see what it does.</p><a className="btn btn-cream" href="/auth/sign-in?return_to=/agents">Sign in</a></section>;
  const act = (p: Promise<{ error?: string }>) => void p.then((r) => { setError(r.error ?? ''); load(); });
  const copy = () => void navigator.clipboard?.writeText(view.mcp_url).then(() => setCopied(true));
  return (
    <>
      <h1 className="title">Use {view.app} with your agent</h1>
      <p className="lede">Your agent (Claude, ChatGPT, Codex, Cursor) can do here what you can, as you, once you say yes. You choose whether it only reads, or reads and acts. Anything that can't be undone asks you first.</p>
      {!view.access.on && <p className="error" role="alert">{view.owner ? 'agent.cloud doesn’t let agents reach this app right now: your organization has it turned off. You can turn it on for this app in the console.' : 'Agents can’t reach this app right now: its owner has it turned off.'}</p>}
      {view.access.on && view.access.source === 'app' && view.owner && <p className="muted">Agents can reach this app because it’s turned on for this app, despite your organization’s setting. Change it in the console.</p>}
      <section className="card connect">
        <h2>Connect</h2>
        <p>Add this address to your agent as an MCP connector. It opens your browser once to ask you.</p>
        <div className="inline"><code className="mono">{view.mcp_url}</code><button type="button" className="btn btn-ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
        <ul>
          <li><b>Claude</b> (claude.ai or the desktop app): Settings, then Connectors, then Add custom connector, and paste the address.</li>
          <li><b>Claude Code</b>: <code>claude mcp add --transport http {slug(view.app)} {view.mcp_url}</code></li>
          <li><b>Codex, ChatGPT, Cursor</b>: add the address as a remote MCP server (streamable HTTP).</li>
        </ul>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      <section>
        <h2>Your agents</h2>
        <Connections list={view.connections} onRevoke={(id) => act(agents.revoke(id))} empty="No agent is connected yet." />
      </section>
      {view.owner && (
        <section>
          <h2>Everyone's agents</h2>
          <Connections list={view.everyone ?? []} onRevoke={(id) => act(agents.revoke(id))} empty="No one else has connected an agent." />
          {(view.everyone?.length ?? 0) + view.connections.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => act(agents.revokeAll())}>Revoke every agent</button>}
          <h2>Tools</h2>
          <p className="muted">Every route of this app’s API is a tool. A blocked tool is hidden from every agent, and refused if one calls it.</p>
          <ul className="card list">
            {(view.tools ?? []).map((t) => (
              <li key={t.name}><span><code>{t.name}</code> <span className="muted">{t.summary}</span></span>
                <button type="button" className="btn btn-ghost" onClick={() => act(agents.block(t.name, !t.blocked))}>{t.blocked ? 'Unblock' : 'Block'}</button></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
function Connections({ list, onRevoke, empty }: { list: Connection[]; onRevoke: (id: string) => void; empty: string }) {
  if (!list.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="card list">
      {list.map((g) => (
        <li key={g.id}>
          <span>
            <b>{g.client}</b>{!g.mine && g.person ? <span className="muted"> for {g.person}</span> : null} <span className="muted">{g.scope === 'act' ? 'reads and acts' : 'reads'}, since {new Date(g.connected_at).toLocaleDateString()}</span>
            {g.calls.length > 0 && <span className="muted"> · last: {g.calls.map((x) => `${x.tool} (${x.status})`).join(', ')}</span>}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => onRevoke(g.id)}>Revoke</button>
        </li>
      ))}
    </ul>
  );
}

function ConsentPage() {
  const request = new URLSearchParams(location.search).get('request') ?? '';
  const [ask, setAsk] = useState<Consent | null | undefined>(undefined);
  const [scope, setScope] = useState<'read' | 'act'>('read');
  const [error, setError] = useState('');
  useEffect(() => void agents.consent(request).then((r) => { setAsk(r.data); setError(r.error ?? ''); }), [request]);
  const decide = (allow: boolean) => void agents.decide(request, allow, scope).then((r) => { if (r.data) location.href = r.data.redirect; else setError(r.error ?? 'That didn’t work. Start again from your agent.'); });
  if (ask === undefined) return null;
  if (!ask) return <p className="error" role="alert">{error}</p>;
  return (
    <section className="card consent">
      <h1 className="title">Connect your agent to {ask.app}</h1>
      <p><b>{ask.client}</b> wants to use {ask.app} as you. "{ask.client}" is the name the agent gave itself: allow only if you just asked it to connect. Your browser returns to <b>{ask.callback}</b>.</p>
      <fieldset>
        <label><input type="radio" name="scope" checked={scope === 'read'} onChange={() => setScope('read')} /> Read: it sees what you see here</label>
        <label><input type="radio" name="scope" checked={scope === 'act'} onChange={() => setScope('act')} /> Read and act: it can also make changes, as you</label>
      </fieldset>
      <p className="muted">Anything that can’t be undone asks you first. It stays connected for up to 30 days; revoke it any time at <a href="/agents">your agents</a>. Signed in as {ask.signed_in_as ?? 'you'}.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="inline"><button type="button" className="btn btn-cream" onClick={() => decide(true)}>Allow</button><button type="button" className="btn btn-ghost" onClick={() => decide(false)}>Cancel</button></div>
    </section>
  );
}

function ApprovePage({ id }: { id: string }) {
  const [a, setA] = useState<Approval | null | undefined>(undefined);
  const [error, setError] = useState('');
  const load = () => void agents.approval(id).then((r) => { setA(r.data); setError(r.error ?? ''); });
  useEffect(load, [id]);
  if (a === undefined) return null;
  if (!a) return <section className="signin"><p className="error" role="alert">{error}</p><a className="btn btn-cream" href={`/auth/sign-in?return_to=/agents/approve/${id}`}>Sign in</a></section>;
  const answer = (approve: boolean) => void agents.answer(id, approve).then((r) => (r.error ? setError(r.error) : load()));
  return (
    <section className="card consent">
      <h1 className="title">{a.client} asks for your OK</h1>
      <p><b>{a.summary}</b>{a.route ? <span className="muted"> ({a.route})</span> : null}</p>
      <pre className="mono">{JSON.stringify(a.args, null, 2)}</pre>
      {a.status === 'pending'
        ? <><p className="muted">Nothing has happened yet. If you approve, your agent can run exactly this, once, in the next hour.</p>
          <div className="inline"><button type="button" className="btn btn-cream" onClick={() => answer(true)}>Approve</button><button type="button" className="btn btn-ghost" onClick={() => answer(false)}>Deny</button></div></>
        : <p>{{ approved: 'Approved: your agent can run it now.', denied: 'Denied: it won’t run.', used: 'Done: your agent ran it.', expired: 'This request expired.' }[a.status] ?? a.status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

// AMCP-10: the badge. Nothing renders until the server says agents can reach the app, so a page drawn on the server (and
// conformance) shows no badge. Point (AMCP-8): the person's next click is what they point at, sent as labels only.
export function AgentBadge(): ReactNode {
  const [show, setShow] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { if (!hidden()) void agents.badge().then((r) => setShow(Boolean(r.data?.show))); }, []);
  if (!show) return null;
  const hide = () => { try { localStorage.setItem(HIDDEN, '1'); } catch { /* still hides for now */ } setShow(false); };
  const point = () => {
    setNote('Click what you want to show your agent (Esc to stop).');
    const done = () => { document.removeEventListener('click', pick, true); document.removeEventListener('keydown', esc, true); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { done(); setNote(''); } };
    const pick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el.closest('.agent-badge')) return;
      e.preventDefault(); e.stopPropagation(); done();
      void agents.point({ route: location.pathname, selector: selectorOf(el), label: labelOf(el) }).then((r) => setNote(r.error ? r.error : `Pointed at “${labelOf(el)}”: ask your agent about it.`));
    };
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', esc, true);
  };
  return (
    <span className="chip agent-badge">
      <a href="/agents">Use with your agent</a>
      <button type="button" onClick={point} title="Point at something for your agent">Point</button>
      <button type="button" onClick={hide} title="Hide this">Hide</button>
      {note && <span className="muted" role="status">{note}</span>}
    </span>
  );
}

// What a person sees an element called: its label, never what's typed into it.
function labelOf(el: Element): string {
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const named = el.getAttribute('aria-label') ?? (field ? (el.getAttribute('placeholder') ?? el.getAttribute('name')) : el.textContent);
  return (named ?? el.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 200) || el.tagName.toLowerCase();
}
function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.body && parts.length < 6; e = e.parentElement) {
    if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
    const i = e.parentElement ? [...e.parentElement.children].indexOf(e) + 1 : 1;
    parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${i})`);
  }
  return parts.join(' > ').slice(0, 500);
}
