// The app's API, from the browser. Changes send JSON: the server refuses anything else (a form post from another site).
export interface User { id: string; email: string | null; name: string | null }
export interface Note { id: string; title: string; created_at: string }
// GET /api/welcome (SPEC.md APP-8): what the welcome page may say, and nothing more.
export type Run = 'mirror' | 'live' | 'rehearsal' | 'preview' | 'unknown';
export type PartState = 'running' | 'configured' | 'not set up' | 'not verified';
export interface Welcome {
  app: string;
  stack: 'typescript' | 'python';
  run: Run;
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
  signOut: () => call<{ ok: true }>('POST', '/auth/sign-out', {}),
};
