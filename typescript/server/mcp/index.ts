// Agents over MCP (SPEC.md AMCP-1 to AMCP-10): a person's own agent does in this app what they can, after they say yes
// once. Register /api routes with api(), and each one is a tool too; mcp(app) mounts /mcp, its OAuth and the /agents API.
import type { Hono } from 'hono';
import type { Env } from '../auth.ts';
import { agentControls } from './agents.ts';
import { oauth } from './oauth.ts';
import { mcpServer } from './server.ts';

export { api, exclude } from './tools.ts';

// The paths an agent reaches with no cookie at all. Any origin may call them: they read no session.
export const COOKIE_FREE = ['/mcp', '/oauth/register', '/oauth/token', '/oauth/revoke'];

export function mcp(app: Hono<Env>) {
  oauth(app);
  mcpServer(app);
  agentControls(app);
}
