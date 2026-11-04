// The only file that talks to the server (SPEC.md AMCP-9).
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json() as Promise<T>;
}
export const api = {
  health: () => call<{ status: string }>('GET', '/api/health'),
  signOut: () => call<{ ok: true }>('POST', '/auth/sign-out', {}),
  agents: () => call<unknown>('GET', '/mcp/agents'),
};
