// AMCP-6, AMCP-8: the person's own controls, behind the /agents pages: connect, see and revoke your agents, approve or
// deny what an agent asked, point at something for it; and for owners, everyone's connections and blocked tools. Every
// route here answers the person's session only: an agent's token never reaches it, and a tool call can't name it.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env, User } from '../auth.ts';
import { pool } from '../db.ts';
import { log } from '../log.ts';
import { clientOf, consentOf, decide, originOf, resourceOf } from './oauth.ts';
import { APP_NAME } from './server.ts';
import { catalog } from './tools.ts';

// AMCP-13 (agent.cloud): whether agent.cloud lets agents reach this app, and whether that's the organization's setting
// or this app's override. Asked at most once a minute; unknown when agent.cloud doesn't say.
let access: { at: number; value: { on: boolean; source: 'org' | 'app' | 'unknown' } } | null = null;
async function accessOf() {
  if (access && Date.now() - access.at < 60_000) return access.value;
  let value: { on: boolean; source: 'org' | 'app' | 'unknown' } = { on: true, source: 'unknown' };
  try {
    const res = await fetch(`${process.env.AGC_AUTH_URL}/mcp-access`, { redirect: 'manual', signal: AbortSignal.timeout(2_000), headers: { authorization: `Bearer ${process.env.AGC_AUTH_TOKEN}` } });
    const j = res.ok ? await res.json() as { on?: unknown; source?: unknown } : null;
    if (j && typeof j.on === 'boolean') value = { on: j.on, source: j.source === 'app' ? 'app' : 'org' };
  } catch { /* agent.cloud didn't say */ }
  access = { at: Date.now(), value };
  return value;
}

const person = (c: Context<Env>): User | null => (c.get('via') ? null : c.get('user')); // never an agent's call
const owner = (u: User) => u.role === 'owner';
const nope = (c: Context<Env>) => c.json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, 401);
const recent = (grants: string[]) => pool.query<{ grant_id: string; tool: string; status: string; at: Date }>(
  `SELECT grant_id, tool, status, at FROM (SELECT *, row_number() OVER (PARTITION BY grant_id ORDER BY at DESC) AS n FROM mcp_calls WHERE grant_id = ANY($1)) x WHERE n <= 5 ORDER BY at DESC`, [grants]);

export function agentControls(app: Hono<Env>) {
  // The badge (AMCP-10): shown while agents can reach the app. Public, like the page it sits on.
  app.get('/mcp/agents/badge', async (c) => c.json({ show: (await accessOf()).on }));

  app.get('/mcp/agents', async (c) => {
    const user = person(c);
    if (!user) return nope(c);
    const everyone = owner(user);
    const { rows: grants } = await pool.query<{ id: string; user_id: string; client_name: string; scope: string; created_at: Date; email: string | null; name: string | null }>(
      `SELECT g.id, g.user_id, g.client_name, g.scope, g.created_at, u.email, u.name FROM mcp_grants g JOIN users u ON u.id = g.user_id
       WHERE g.revoked_at IS NULL AND g.expires_at > now() AND ($1 OR g.user_id = $2) ORDER BY g.created_at DESC LIMIT 200`, [everyone, user.id]);
    const { rows: calls } = await recent(grants.map((g) => g.id));
    const view = (g: (typeof grants)[number]) => ({ id: g.id, client: g.client_name, scope: g.scope, connected_at: g.created_at, person: g.email ?? g.name, mine: g.user_id === user.id,
      calls: calls.filter((x) => x.grant_id === g.id).map((x) => ({ tool: x.tool, status: x.status, at: x.at })) });
    const off = everyone ? new Set((await pool.query<{ tool: string }>('SELECT tool FROM mcp_blocked')).rows.map((r) => r.tool)) : null;
    return c.json({
      app: APP_NAME, mcp_url: resourceOf(c), owner: everyone, access: await accessOf(),
      connections: grants.filter((g) => g.user_id === user.id).map(view),
      ...(everyone ? { everyone: grants.filter((g) => g.user_id !== user.id).map(view), tools: catalog(app).tools.map((t) => ({ name: t.name, summary: t.summary, method: t.method, path: t.path, blocked: off!.has(t.name) })) } : {}),
    });
  });

  // Revoke one connection (your own, or anyone's for an owner), or every connection (owners).
  app.post('/mcp/agents/revoke', async (c) => {
    const user = person(c);
    if (!user) return nope(c);
    const { id, all } = await c.req.json().catch(() => ({})) as { id?: unknown; all?: unknown };
    if (all === true) {
      if (!owner(user)) return c.json({ error: { code: 'forbidden', message: 'Only an owner can revoke everyone’s agents.' } }, 403);
      const r = await pool.query('UPDATE mcp_grants SET revoked_at = now() WHERE revoked_at IS NULL');
      log.info('every agent connection revoked', { by: user.id, connections: r.rowCount });
      return c.json({ revoked: r.rowCount });
    }
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: { code: 'bad_request', message: 'Name the connection.' } }, 400);
    const r = await pool.query('UPDATE mcp_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND ($2 OR user_id = $3)', [id, owner(user), user.id]);
    log.info('agent connection revoked', { by: user.id, connection: id, revoked: r.rowCount });
    return c.json({ revoked: r.rowCount });
  });

  // Owners block a tool from every agent, or unblock it.
  app.post('/mcp/agents/block', async (c) => {
    const user = person(c);
    if (!user) return nope(c);
    if (!owner(user)) return c.json({ error: { code: 'forbidden', message: 'Only an owner can block tools.' } }, 403);
    const { tool, blocked } = await c.req.json().catch(() => ({})) as { tool?: unknown; blocked?: unknown };
    if (typeof tool !== 'string' || !catalog(app).tools.some((t) => t.name === tool) || typeof blocked !== 'boolean') return c.json({ error: { code: 'bad_request', message: 'Name a tool, and whether it’s blocked.' } }, 400);
    if (blocked) await pool.query('INSERT INTO mcp_blocked (tool, blocked_by) VALUES ($1, $2) ON CONFLICT (tool) DO NOTHING', [tool, user.id]);
    else await pool.query('DELETE FROM mcp_blocked WHERE tool = $1', [tool]);
    log.info(blocked ? 'tool blocked for agents' : 'tool unblocked for agents', { by: user.id, tool });
    return c.json({ tool, blocked });
  });

  // The consent page (AMCP-2): what's asking, and the person's answer.
  app.get('/mcp/agents/consent', (c) => {
    const user = person(c);
    if (!user) return nope(c);
    const q = consentOf(c.req.query('request'), user, resourceOf(c));
    if (!q) return c.json({ error: { code: 'expired', message: 'This request has expired. Start again from your agent.' } }, 400);
    return c.json({ app: APP_NAME, client: clientOf(q.cl)?.n ?? 'An unnamed client', callback: new URL(q.r).host, signed_in_as: user.email ?? user.name, expires_at: new Date(q.e) });
  });
  app.post('/mcp/agents/consent', async (c) => {
    const user = person(c);
    if (!user) return nope(c);
    const m = await c.req.json().catch(() => ({})) as { request?: unknown; allow?: unknown; scope?: unknown };
    const q = consentOf(m.request, user, resourceOf(c));
    const redirect = q && (m.scope === 'read' || m.scope === 'act') ? await decide(q, m.allow === true, m.scope, originOf(c)) : null;
    if (!redirect) return c.json({ error: { code: 'expired', message: 'This request has expired or was already answered. Start again from your agent.' } }, 400);
    log.info(m.allow === true ? 'agent consent given' : 'agent consent refused', { user: user.id, client: clientOf(q!.cl)?.n, scope: m.scope });
    return c.json({ redirect });
  });

  // An agent's destructive call, waiting for its person (AMCP-5).
  const approval = (id: string, userId: string) => pool.query<{ id: string; tool: string; args: unknown; status: string; expires_at: Date; client_name: string }>(
    `SELECT a.id, a.tool, a.args, a.status, a.expires_at, g.client_name FROM mcp_approvals a JOIN mcp_grants g ON g.id = a.grant_id
     WHERE a.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL`, [id, userId]);
  app.get('/mcp/agents/approvals/:id', async (c) => {
    const user = person(c);
    if (!user) return nope(c);
    if (!/^[0-9a-f-]{36}$/.test(c.req.param('id'))) return c.json({ error: { code: 'not_found', message: 'No such request.' } }, 404);
    const { rows: [a] } = await approval(c.req.param('id'), user.id);
    if (!a) return c.json({ error: { code: 'not_found', message: 'No such request.' } }, 404);
    const tool = catalog(app).tools.find((t) => t.name === a.tool);
    return c.json({ id: a.id, client: a.client_name, tool: a.tool, summary: tool?.summary ?? a.tool, route: tool ? `${tool.method} ${tool.path}` : null, args: a.args, status: a.expires_at < new Date() && a.status === 'pending' ? 'expired' : a.status, expires_at: a.expires_at });
  });
  app.post('/mcp/agents/approvals/:id', async (c) => {
    const user = person(c);
    if (!user) return nope(c);
    const { approve } = await c.req.json().catch(() => ({})) as { approve?: unknown };
    if (typeof approve !== 'boolean' || !/^[0-9a-f-]{36}$/.test(c.req.param('id'))) return c.json({ error: { code: 'bad_request', message: 'Approve or deny.' } }, 400);
    const r = await pool.query(`UPDATE mcp_approvals a SET status = $3 FROM mcp_grants g WHERE a.id = $1 AND g.id = a.grant_id AND g.user_id = $2
      AND g.revoked_at IS NULL AND a.status = 'pending' AND a.expires_at > now() RETURNING a.tool`, [c.req.param('id'), user.id, approve ? 'approved' : 'denied']);
    if (!r.rowCount) return c.json({ error: { code: 'expired', message: 'This request was already answered, or has expired.' } }, 400);
    log.info(approve ? 'agent call approved' : 'agent call denied', { user: user.id, tool: r.rows[0]?.tool });
    return c.json({ status: approve ? 'approved' : 'denied' });
  });

  // Point (AMCP-8): what the person clicked, for their agent. Labels only; a value is refused.
  const Pick = z.strictObject({ route: z.string().max(300).startsWith('/'), selector: z.string().max(500), label: z.string().max(200) });
  app.post('/mcp/agents/point', async (c) => {
    const user = person(c);
    if (!user) return nope(c);
    const pick = Pick.safeParse(await c.req.json().catch(() => null));
    if (!pick.success) return c.json({ error: { code: 'bad_request', message: 'A pick is a route, a selector and a label: never a value.' } }, 400);
    await pool.query('INSERT INTO mcp_points (user_id, pick, at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET pick = EXCLUDED.pick, at = now()', [user.id, pick.data]);
    return c.json({ ok: true });
  });
}
