// AMCP-3: every /api/* route is a tool. A route registers through api(), which mounts it on Hono with zValidator, as
// before, and records its tool from the same zod schemas, so the route and its tool can't drift apart. The catalog is
// read from Hono's own route table: a route that's neither a tool nor left out (with a reason) is listed as missing.
import { zValidator } from '@hono/zod-validator';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../auth.ts';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Shape = z.ZodObject;
export interface ApiOptions<J extends Shape | undefined, Q extends Shape | undefined> {
  summary: string; // the tool's description: what the route does, for an agent deciding whether to call it
  json?: J; // the JSON body's schema
  query?: Q; // the query string's schema
  destructive?: boolean; // DELETE is destructive anyway; mark any other route that destroys or can't be undone
  name?: string; // the tool's name, when the method and path don't say it well
}
type Input<J, Q> = { json: J extends Shape ? z.infer<J> : undefined; query: Q extends Shape ? z.infer<Q> : undefined };

export interface Tool {
  name: string; method: string; path: string; summary: string; readOnly: boolean; destructive: boolean;
  params: string[]; query: string[]; body: string[]; inputSchema: Record<string, unknown>;
}
interface Declared { method: string; path: string; summary: string; json?: Shape; query?: Shape; destructive: boolean; name?: string }
const declared = new Map<string, Declared>(); // "POST /api/notes" → what api() was told
const excluded = new Map<string, string>(); // "GET /api/health" → why it isn't a tool
const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

// A body or query that doesn't fit its schema answers 400 in this app's error shape, naming the first problem.
const check = <T extends z.ZodType>(target: 'json' | 'query', schema: T) => zValidator(target, schema, (result, c) => {
  if (!result.success) {
    const issue = result.error.issues[0];
    return c.json({ error: { code: 'bad_request', message: issue ? `${issue.path.join('.') || target}: ${issue.message}` : 'The request isn’t valid.' } }, 400);
  }
});

// Mounts one /api route and records its tool. The handler gets the parsed body and query, typed.
export function api<J extends Shape | undefined = undefined, Q extends Shape | undefined = undefined>(
  app: Hono<Env>, method: Method, path: string, opts: ApiOptions<J, Q>,
  handler: (c: Context<Env>, input: Input<J, Q>) => Response | Promise<Response>,
) {
  const checks = [...(opts.query ? [check('query', opts.query)] : []), ...(opts.json ? [check('json', opts.json)] : [])];
  declared.set(key(method, path), { method: method.toUpperCase(), path, summary: opts.summary, json: opts.json, query: opts.query, destructive: Boolean(opts.destructive), name: opts.name });
  app.on(method.toUpperCase(), path, ...(checks as []), (c: Context<Env>) =>
    handler(c, { json: (opts.json ? c.req.valid('json' as never) : undefined), query: (opts.query ? c.req.valid('query' as never) : undefined) } as Input<J, Q>));
}

// A route that isn't a tool, and why. The reason is shown on the release's receipt.
export function exclude(method: Method, path: string, reason: string) {
  if (!reason.trim()) throw new Error(`${key(method, path)}: leaving a route out of the tools takes a reason`);
  excluded.set(key(method, path), reason);
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const nameOf = (method: string, path: string) => `${method.toLowerCase()}_${path.replace(/^\/api\//, '').split('/').filter(Boolean)
  .map((seg) => (seg.startsWith(':') ? `by_${seg.slice(1)}` : seg)).join('_')}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64);
const schemaOf = (s: Shape | undefined) => (s ? z.toJSONSchema(s, { io: 'input' }) as { properties?: Record<string, unknown>; required?: string[] } : {});

export interface Catalog {
  tools: Tool[];
  excluded: { method: string; path: string; reason: string }[];
  missing: { method: string; path: string; why: string }[];
}

// The tools, from Hono's route table: each /api route once, by method and path.
export function catalog(app: Hono<Env>): Catalog {
  const out: Catalog = { tools: [], excluded: [], missing: [] };
  const seen = new Set<string>();
  for (const r of app.routes) {
    const method = r.method.toUpperCase();
    if (!r.path.startsWith('/api/') || !METHODS.has(method) || seen.has(key(method, r.path))) continue;
    seen.add(key(method, r.path));
    const why = excluded.get(key(method, r.path));
    if (why) { out.excluded.push({ method, path: r.path, reason: why }); continue; }
    const d = declared.get(key(method, r.path));
    if (!d) { out.missing.push({ method, path: r.path, why: 'register it with api() in server/app.ts' }); continue; }
    const problem = (why: string) => out.missing.push({ method, path: r.path, why });
    if (!d.summary.trim()) { problem('give it a summary'); continue; }
    const params = [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
    let query, body;
    try { query = schemaOf(d.query); body = schemaOf(d.json); } catch { problem('its schema can’t be described as JSON Schema'); continue; }
    const names = [...params, ...Object.keys(query.properties ?? {}), ...Object.keys(body.properties ?? {})];
    if (new Set(names).size !== names.length) { problem('a name is used twice in its path, query and body'); continue; }
    const name = d.name ?? nameOf(method, r.path);
    if (out.tools.some((t) => t.name === name)) { problem(`the tool name ${name} is taken; give it a name`); continue; }
    out.tools.push({
      name, method, path: r.path, summary: d.summary, readOnly: method === 'GET', destructive: method === 'DELETE' || d.destructive,
      params, query: Object.keys(query.properties ?? {}), body: Object.keys(body.properties ?? {}),
      inputSchema: {
        type: 'object',
        properties: { ...Object.fromEntries(params.map((p) => [p, { type: 'string' }])), ...query.properties, ...body.properties },
        required: [...params, ...(query.required ?? []), ...(body.required ?? [])],
        additionalProperties: false,
      },
    });
  }
  return out;
}
