// The app's API, from the browser. Changes send JSON: the server refuses anything else (a form post from another site).
export interface User { id: string; email: string | null; name: string | null }
export interface Note { id: string; title: string; created_at: string; via?: string | null }
// GET /api/welcome (SPEC.md APP-8): what the welcome page may say, and nothing more.
export type Run = 'mirror' | 'private' | 'live' | 'rehearsal' | 'preview' | 'unknown';
export type PartState = 'running' | 'configured' | 'not set up' | 'not verified';
export interface Welcome {
  app: string;
  stack: 'typescript' | 'python';
  run: Run;
  started: 'live' | null; // "live": made through agent.cloud's Start page, its builder already at work (APP-15)
  parts: { web: PartState; api: PartState; database: PartState; worker: PartState; signin: PartState; email: PartState };
  database: { migrations: number | null; checked_at: string; reason?: 'unreachable' | 'timeout' | 'query_failed' };
  checks: { smoke: number; invariants: number };
  preview_expires_at: string | null;
  production: { url: string; version: number | null } | null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null; error?: string }> {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  return { status: res.status, data: res.ok ? json : null, error: res.ok ? undefined : json?.error?.message ?? `Request failed (${res.status})` };
}

export const api = {
  welcome: () => call<Welcome>('GET', '/api/welcome'),
  me: () => call<{ user: User }>('GET', '/api/me'),
  notes: () => call<Note[]>('GET', '/api/notes'),
  add: (title: string) => call<Note>('POST', '/api/notes', { title }),
  remove: (id: string) => call<{ deleted: string }>('DELETE', `/api/notes/${encodeURIComponent(id)}`, {}),
  signOut: () => call<{ ok: true }>('POST', '/auth/sign-out', {}),
};

// People's own agents over MCP (SPEC.md AMCP-6 to AMCP-10): the person's controls, never an agent's.
export interface AgentCall { tool: string; status: string; at: string }
export interface Connection { id: string; client: string; scope: 'read' | 'act'; connected_at: string; person: string | null; mine: boolean; calls: AgentCall[] }
export interface AgentsView {
  app: string; mcp_url: string; owner: boolean; access: { on: boolean; source: 'org' | 'app' | 'unknown' };
  connections: Connection[]; everyone?: Connection[]; tools?: { name: string; summary: string; method: string; path: string; blocked: boolean }[];
}
export interface Consent { app: string; client: string; callback: string; signed_in_as: string | null; expires_at: string }
export interface Approval { id: string; client: string; tool: string; summary: string; route: string | null; args: unknown; status: string; expires_at: string }
export const agents = {
  badge: () => call<{ show: boolean }>('GET', '/mcp/agents/badge'),
  view: () => call<AgentsView>('GET', '/mcp/agents'),
  revoke: (id: string) => call<{ revoked: number }>('POST', '/mcp/agents/revoke', { id }),
  revokeAll: () => call<{ revoked: number }>('POST', '/mcp/agents/revoke', { all: true }),
  block: (tool: string, blocked: boolean) => call<{ blocked: boolean }>('POST', '/mcp/agents/block', { tool, blocked }),
  consent: (request: string) => call<Consent>('GET', `/mcp/agents/consent?request=${encodeURIComponent(request)}`),
  decide: (request: string, allow: boolean, scope: 'read' | 'act') => call<{ redirect: string }>('POST', '/mcp/agents/consent', { request, allow, scope }),
  approval: (id: string) => call<Approval>('GET', `/mcp/agents/approvals/${encodeURIComponent(id)}`),
  answer: (id: string, approve: boolean) => call<{ status: string }>('POST', `/mcp/agents/approvals/${encodeURIComponent(id)}`, { approve }),
  point: (pick: { route: string; selector: string; label: string }) => call<{ ok: true }>('POST', '/mcp/agents/point', pick),
};
