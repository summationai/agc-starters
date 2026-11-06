// Agents over MCP (SPEC.md AMCP-1 to AMCP-8, AMCP-10): a person's own agent connects through the app's own OAuth, on its
// own sign-in, and uses the app's /api routes as tools, as that person. Probed over HTTP like a real client (Claude's
// steps: register, authorize, consent, trade the code), against the running web process and the fake platform.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_TOKEN, type Container, type Env, PLATFORM } from '../lib/env.ts';
import { fail, pass, type TestResult } from '../lib/report.ts';
import { run } from '../lib/sh.ts';
import type { Stack } from '../lib/stack.ts';
import { type Jar, req, type Res, signIn } from './http.ts';

const tag = () => randomBytes(4).toString('hex');
const CB = 'http://127.0.0.1:43210/callback';
const table = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
type Rpc = { result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string; annotations?: Record<string, unknown> }[]; protocolVersion?: string; instructions?: string }; error?: { code: number } };
interface Grant { client_id: string; access_token: string; refresh_token: string; scope: string }
interface Who { jar: Jar; id: string; headers: Record<string, string> }

const form = (f: Record<string, string>) => new URLSearchParams(f).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const texts = (r: Res) => ((r.json as Rpc | null)?.result?.content ?? []).map((c) => c.text ?? '').join('\n');
const isError = (r: Res) => (r.json as Rpc | null)?.result?.isError === true;
const BLOCK = /^<app-data id="([0-9a-f]+)">\n([\s\S]*)\n<\/app-data id="\1">$/;
const inside = (r: Res) => { const m = BLOCK.exec(texts(r)); try { return m ? JSON.parse(m[2]!) as unknown : null; } catch { return null; } };

export async function mcpTests(env: Env, web: Container, stack: Stack, log: (m: string) => void): Promise<Map<string, TestResult>> {
  const out = new Map<string, TestResult>();
  const fake = (path: string, body: unknown) => fetch(`${env.platformBase()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const asked = async () => ((await (await fetch(`${env.platformBase()}/_fake/people`)).json()) as { asked: { iss: string | null; provider_id: string | null; email: string | null }[] }).asked;

  const person = async (app: Container, what: string, role?: string): Promise<Who> => {
    const email = `${what}-${tag()}@example.test`;
    if (role) await fake('/_fake/roles', { as: email, role });
    const jar: Jar = new Map();
    await signIn(env, app, jar, email);
    const me = await req(env, app, jar, 'GET', '/api/me');
    return { jar, id: String((me.json as { user?: { id?: string } } | null)?.user?.id ?? ''), headers: {} };
  };
  const meta = await req(env, web, new Map(), 'GET', '/.well-known/oauth-protected-resource/mcp');
  const resourceOf = async (app: Container) => app === web ? String((meta.json as { resource?: string } | null)?.resource ?? '')
    : String(((await req(env, app, new Map(), 'GET', '/.well-known/oauth-protected-resource/mcp')).json as { resource?: string } | null)?.resource ?? '');

  // Claude's steps up to a code: register, authorize as the signed-in person, consent through /mcp/agents/consent.
  const code = async (app: Container, who: Who, scope: 'read' | 'act', opts: { method?: string } = {}) => {
    const reg = await req(env, app, new Map(), 'POST', '/oauth/register', { redirect_uris: [CB], client_name: 'Claude', token_endpoint_auth_method: 'none' }, { 'x-forwarded-for': `192.0.2.${Math.floor(Math.random() * 250) + 1}` });
    const client_id = String((reg.json as { client_id?: string } | null)?.client_id ?? '');
    const verifier = randomBytes(32).toString('base64url');
    const resource = await resourceOf(app);
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CB, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: opts.method ?? 'S256', resource, state: 's1' });
    const auth = await req(env, app, who.jar, 'GET', `/oauth/authorize?${q}`, undefined, who.headers);
    const loc = auth.headers.get('location') ?? '';
    const request = loc.startsWith('/agents/consent?') ? new URL(loc, 'http://x').searchParams.get('request') ?? '' : '';
    if (!request) return { reg, auth, client_id, verifier, resource, code: '', shown: null as Res | null };
    const shown = await req(env, app, who.jar, 'GET', `/mcp/agents/consent?request=${encodeURIComponent(request)}`, undefined, who.headers);
    const decided = await req(env, app, who.jar, 'POST', '/mcp/agents/consent', { request, allow: true, scope }, who.headers);
    const back = new URL(String((decided.json as { redirect?: string } | null)?.redirect ?? 'http://x/'));
    return { reg, auth, client_id, verifier, resource, code: back.searchParams.get('code') ?? '', shown };
  };
  const trade = (app: Container, c: { code: string; client_id: string; verifier: string; resource: string }) =>
    req(env, app, new Map(), 'POST', '/oauth/token', form({ grant_type: 'authorization_code', code: c.code, client_id: c.client_id, redirect_uri: CB, code_verifier: c.verifier, resource: c.resource }), FORM);
  const connect = async (app: Container, who: Who, scope: 'read' | 'act' = 'act'): Promise<Grant | null> => {
    const c = await code(app, who, scope);
    if (!c.code) return null;
    const t = await trade(app, c);
    return t.status === 200 ? { client_id: c.client_id, ...(t.json as { access_token: string; refresh_token: string; scope: string }) } : null;
  };
  const rpc = (app: Container, token: string, method: string, params?: unknown, extra: Record<string, string> = {}, jar: Jar = new Map()) =>
    req(env, app, jar, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, { authorization: `Bearer ${token}`, ...extra });
  const call = (app: Container, g: Grant, name: string, args: Record<string, unknown> = {}, extra: Record<string, string> = {}, jar: Jar = new Map()) =>
    rpc(app, g.access_token, 'tools/call', { name, arguments: args }, extra, jar);
  const names = async (app: Container, g: Grant) => ((await rpc(app, g.access_token, 'tools/list')).json as Rpc | null)?.result?.tools ?? [];

  const a = await person(web, 'mcp-a');
  const b = await person(web, 'mcp-b');
  const ga = await connect(web, a);
  if (!ga) {
    for (const t of ['CONF:mcp', 'CONF:mcp-oauth', 'CONF:mcp-tools', 'CONF:agents', 'CONF:mcp-safety', 'CONF:point', 'CONF:badge']) out.set(t, fail('an agent couldn’t connect: register, authorize, consent and the token exchange didn’t complete'));
    return out;
  }

  // AMCP-1: the protocol.
  {
    const get = await req(env, web, new Map(), 'GET', '/mcp');
    const anon = await req(env, web, new Map(), 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' });
    const challenge = anon.headers.get('www-authenticate') ?? '';
    const versions = await Promise.all(['2025-06-18', '2025-11-25'].map(async (v) => ((await rpc(web, ga.access_token, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'conformance', version: '1' } })).json as Rpc | null)?.result?.protocolVersion === v));
    const ping = await rpc(web, ga.access_token, 'ping');
    const note = await req(env, web, new Map(), 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${ga.access_token}` });
    const listed = (await names(web, ga)).map((t) => t.name);
    const manifest = table(table(stack.raw).mcp).server === 'app';
    const ok = get.status === 405 && anon.status === 401 && challenge.includes('resource_metadata=') && versions.every(Boolean) && ping.status === 200
      && note.status === 202 && ['get_notes', 'post_notes', 'delete_notes_by_id', 'point_get'].every((n) => listed.includes(n)) && manifest;
    out.set('CONF:mcp', (ok ? pass : fail)(`GET /mcp ${get.status}; POST without a token ${anon.status}${challenge.includes('resource_metadata=') ? ' with a resource_metadata challenge' : ', no challenge'}; `
      + `both protocol versions ${versions.every(Boolean) ? 'echoed' : 'not echoed'}; ping ${ping.status}; a notification ${note.status}; tools: ${listed.join(', ')}; [mcp] server = "app" ${manifest ? 'declared' : 'missing'}`));
    log(`${out.get('CONF:mcp')!.outcome.toUpperCase().padEnd(4)} CONF:mcp: ${out.get('CONF:mcp')!.evidence}`);
  }

  // AMCP-2: OAuth on the app's own sign-in.
  {
    const m = meta.json as { resource?: string; authorization_servers?: string[] } | null;
    const as = (await req(env, web, new Map(), 'GET', '/.well-known/oauth-authorization-server')).json as Record<string, unknown> | null;
    const origin = m?.resource ? new URL(m.resource).origin : '';
    const metaOk = !!m?.resource?.endsWith('/mcp') && m.authorization_servers?.[0] === origin && Array.isArray(as?.code_challenge_methods_supported)
      && (as!.code_challenge_methods_supported as string[]).includes('S256') && ['token_endpoint', 'registration_endpoint', 'revocation_endpoint'].every((k) => typeof as?.[k] === 'string');
    const regAs = (uris: string[], extra: Record<string, unknown> = {}, ip = '192.0.2.1') => req(env, web, new Map(), 'POST', '/oauth/register', { redirect_uris: uris, client_name: 'Claude', ...extra }, { 'x-forwarded-for': ip });
    const evil = await regAs(['https://claude.ai.evil.example/api/mcp/auth_callback']);
    const claude = await regAs(['https://claude.ai/api/mcp/auth_callback']);
    const secret = await regAs([CB], { token_endpoint_auth_method: 'client_secret_basic' });
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
    const burst: number[] = [];
    for (let i = 0; i < 21; i++) burst.push((await regAs([CB], {}, ip)).status);
    const signedOut = await (async () => {
      const c = await code(web, { jar: new Map(), id: '', headers: {} }, 'act');
      return (c.auth.headers.get('location') ?? '').startsWith('/auth/sign-in') ? c.auth.status : 0;
    })();
    const plain = await code(web, a, 'act', { method: 'plain' });
    const plainBack = new URL(plain.auth.headers.get('location') ?? 'http://x/').searchParams.get('error');
    const consentOut = await req(env, web, new Map(), 'GET', '/mcp/agents/consent?request=x');
    const once = await code(web, a, 'read');
    const first = await trade(web, once);
    const again = await trade(web, once);
    const wrong = await code(web, a, 'act');
    const badVerifier = await trade(web, { ...wrong, verifier: randomBytes(32).toString('base64url') });
    const readScope = (first.json as { scope?: string } | null)?.scope;
    const g = await connect(web, a);
    const refreshed = g ? await req(env, web, new Map(), 'POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: g.refresh_token, client_id: g.client_id }), FORM) : null;
    const replay = g ? await req(env, web, new Map(), 'POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: g.refresh_token, client_id: g.client_id }), FORM) : null;
    const newAccess = String((refreshed?.json as { access_token?: string } | null)?.access_token ?? '');
    const killed = newAccess ? (await rpc(web, newAccess, 'ping')).status : 0;
    const r = await connect(web, a);
    const revoked = r ? await req(env, web, new Map(), 'POST', '/oauth/revoke', form({ token: r.refresh_token, client_id: r.client_id }), FORM) : null;
    const afterRevoke = r ? (await rpc(web, r.access_token, 'ping')).status : 0;
    const shown = (once.shown?.json as { client?: string } | null)?.client;
    const ok = metaOk && evil.status === 400 && claude.status === 201 && secret.status === 400 && burst.slice(0, 20).every((s) => s === 201) && burst[20] === 429
      && signedOut === 302 && plainBack === 'invalid_request' && consentOut.status === 401 && shown === 'Claude' && first.status === 200 && readScope === 'mcp:read'
      && again.status === 400 && badVerifier.status === 400 && refreshed?.status === 200 && replay?.status === 400 && killed === 401 && revoked?.status === 200 && afterRevoke === 401;
    out.set('CONF:mcp-oauth', (ok ? pass : fail)(`metadata ${metaOk ? 'names the app’s origin and S256' : 'incomplete'}; register: a lookalike callback ${evil.status}, Claude’s ${claude.status}, a secret client ${secret.status}, 21 from one address ${burst.slice(0, 20).every((s) => s === 201) ? '20 × 201' : burst.slice(0, 20).join(',')} then ${burst[20]}; `
      + `authorize signed out ${signedOut || 'not to sign-in'}, with plain PKCE ${plainBack ?? 'no error'}; consent signed out ${consentOut.status}, showing the client as "${shown}"; `
      + `a Read code ${first.status} (${readScope}), again ${again.status}, a wrong verifier ${badVerifier.status}; refresh ${refreshed?.status}, replayed ${replay?.status}, then its access token ${killed}; revoke ${revoked?.status}, then ${afterRevoke}`));
  }

  // AMCP-3, AMCP-4, AMCP-5: the routes are the tools, a call is the route as the person, and destructive calls ask first.
  {
    const noAuth = await req(env, web, new Map(), 'GET', '/mcp/manifest');
    const man = await req(env, web, new Map(), 'GET', '/mcp/manifest', undefined, { authorization: `Bearer ${AUTH_TOKEN}` });
    const mj = man.json as { tools?: { name: string }[]; excluded?: { path: string; reason: string }[]; missing?: unknown[] } | null;
    const tools = (mj?.tools ?? []).map((t) => t.name);
    const excluded = mj?.excluded ?? [];
    const manOk = noAuth.status === 401 && man.status === 200 && ['get_me', 'get_notes', 'post_notes', 'delete_notes_by_id'].every((n) => tools.includes(n))
      && ['/api/health', '/api/welcome'].every((p) => excluded.some((e) => e.path === p && e.reason.trim())) && Array.isArray(mj?.missing) && mj!.missing.length === 0;
    const list = await names(web, ga);
    const hint = (n: string, k: string) => list.find((t) => t.name === n)?.annotations?.[k];
    const hints = hint('get_notes', 'readOnlyHint') === true && hint('post_notes', 'readOnlyHint') === false && hint('post_notes', 'destructiveHint') === false && hint('delete_notes_by_id', 'destructiveHint') === true;
    const title = `Agent ${tag()}`;
    const made = await call(web, ga, 'post_notes', { title }, {}, b.jar); // B's own cookie rides along: the call is still A's
    const noteId = String((inside(made) as { id?: string } | null)?.id ?? '');
    const [row] = await env.sql<{ user_id: string; via: string | null }>('SELECT user_id::text AS user_id, via FROM notes WHERE id::text = $1', [noteId]);
    const seen = await req(env, web, a.jar, 'GET', '/api/notes');
    const asA = row?.user_id === a.id && row?.via === 'Claude' && Array.isArray(seen.json) && (seen.json as { title?: string }[]).some((n) => n.title === title);
    const forgedArg = await call(web, ga, 'post_notes', { title: `Forged ${tag()}`, user_id: b.id });
    const forgedHeaders = await req(env, web, new Map(), 'POST', '/api/notes', { title: `Forged ${tag()}` }, { 'x-agc-user-email': 'victim@example.test', 'x-agc-identity': 'forged', mcp: JSON.stringify({ user: { id: b.id } }), via: 'Claude' });
    const forgedCookie = await req(env, web, new Map(), 'POST', '/api/notes', { title: `Forged ${tag()}` }, { cookie: '__Host-session=forged' });
    const gr = await connect(web, a, 'read');
    const readList = gr ? (await names(web, gr)).map((t) => t.name) : [];
    const readWrite = gr ? await call(web, gr, 'post_notes', { title: `Read ${tag()}` }) : null;
    const asks = await call(web, ga, 'delete_notes_by_id', { id: noteId });
    const approvalId = /\/agents\/approve\/([0-9a-f-]{36})/.exec(texts(asks))?.[1] ?? '';
    const confirmFlag = await call(web, ga, 'delete_notes_by_id', { id: noteId, confirm: true });
    const stillThere = (await env.sql('SELECT 1 FROM notes WHERE id::text = $1', [noteId])).length === 1;
    const shown = await req(env, web, a.jar, 'GET', `/mcp/agents/approvals/${approvalId}`);
    const approved = await req(env, web, a.jar, 'POST', `/mcp/agents/approvals/${approvalId}`, { approve: true });
    const ran = await call(web, ga, 'delete_notes_by_id', { id: noteId });
    const gone = (await env.sql('SELECT 1 FROM notes WHERE id::text = $1', [noteId])).length === 0;
    const theirs = await req(env, web, b.jar, 'POST', '/api/notes', { title: `B's ${tag()}` });
    const theirId = String((theirs.json as { id?: string } | null)?.id ?? '');
    const askB = await call(web, ga, 'delete_notes_by_id', { id: theirId });
    const bApproval = /\/agents\/approve\/([0-9a-f-]{36})/.exec(texts(askB))?.[1] ?? '';
    await req(env, web, a.jar, 'POST', `/mcp/agents/approvals/${bApproval}`, { approve: true });
    const triedB = await call(web, ga, 'delete_notes_by_id', { id: theirId });
    const bKept = (await env.sql('SELECT 1 FROM notes WHERE id::text = $1', [theirId])).length === 1;
    const ok = manOk && hints && made.status === 200 && !isError(made) && asA && isError(forgedArg) && forgedHeaders.status === 401 && forgedCookie.status === 401
      && !readList.includes('post_notes') && readList.includes('get_notes') && !!readWrite && isError(readWrite)
      && isError(asks) && !!approvalId && isError(confirmFlag) && stillThere && shown.status === 200 && approved.status === 200 && !isError(ran) && gone
      && isError(triedB) && bKept;
    out.set('CONF:mcp-tools', (ok ? pass : fail)(`manifest: ${noAuth.status} without the app’s token, ${man.status} with it, tools ${tools.join(', ')}, ${excluded.length} left out with reasons, ${mj?.missing?.length ?? '?'} missing; hints ${hints ? 'right' : 'wrong'}; `
      + `post_notes as A with B’s cookie riding along: ${asA ? 'A’s note, via Claude' : `not A’s (${row?.user_id ?? 'none'}, via ${row?.via ?? 'none'})`}; a user_id argument ${isError(forgedArg) ? 'refused' : 'accepted'}; forged identity headers ${forgedHeaders.status}, a forged cookie ${forgedCookie.status}; `
      + `a Read grant lists ${readList.join(', ')} and post_notes ${readWrite && isError(readWrite) ? 'is refused' : 'ran'}; DELETE ${isError(asks) ? 'asked first' : 'ran at once'}, confirm: true ${isError(confirmFlag) ? 'refused' : 'accepted'}, note ${stillThere ? 'kept' : 'gone'}; `
      + `after approval (${approved.status}) it ${!isError(ran) && gone ? 'ran once' : 'didn’t run'}; deleting B’s note as A, approved: ${isError(triedB) && bKept ? 'the route refused' : 'deleted'}`));
  }

  // AMCP-6: the person's controls answer their session only; owners get everyone's, and a recheck can take that away.
  {
    const g = await connect(web, a);
    await call(web, g!, 'get_notes');
    const out1 = await req(env, web, new Map(), 'GET', '/mcp/agents');
    const bearerView = await req(env, web, new Map(), 'GET', '/mcp/agents', undefined, { authorization: `Bearer ${g!.access_token}` });
    const bearerRevoke = await req(env, web, new Map(), 'POST', '/mcp/agents/revoke', { all: true }, { authorization: `Bearer ${g!.access_token}` });
    const bearerBlock = await req(env, web, new Map(), 'POST', '/mcp/agents/block', { tool: 'get_notes', blocked: true }, { authorization: `Bearer ${g!.access_token}` });
    const bearerApprove = await req(env, web, new Map(), 'POST', `/mcp/agents/approvals/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, { approve: true }, { authorization: `Bearer ${g!.access_token}` });
    const mine = await req(env, web, a.jar, 'GET', '/mcp/agents');
    const view = mine.json as { owner?: boolean; connections?: { id: string; calls?: unknown[] }[] } | null;
    const listed = view?.connections?.length ?? 0;
    const memberBlock = await req(env, web, a.jar, 'POST', '/mcp/agents/block', { tool: 'get_notes', blocked: true });
    const target = view?.connections?.[0]?.id ?? '';
    const revoke = await req(env, web, a.jar, 'POST', '/mcp/agents/revoke', { id: target });
    const revokedGrant = (await env.sql<{ id: string }>('SELECT id::text AS id FROM mcp_grants WHERE id::text = $1 AND revoked_at IS NOT NULL', [target])).length === 1;
    const o = await person(web, 'mcp-owner', 'owner');
    const ov = (await req(env, web, o.jar, 'GET', '/mcp/agents')).json as { owner?: boolean; everyone?: unknown[]; tools?: unknown[] } | null;
    const block = await req(env, web, o.jar, 'POST', '/mcp/agents/block', { tool: 'get_notes', blocked: true });
    const g2 = await connect(web, a);
    const hidden = g2 ? !(await names(web, g2)).some((t) => t.name === 'get_notes') : false;
    const refused = g2 ? isError(await call(web, g2, 'get_notes')) : false;
    await req(env, web, o.jar, 'POST', '/mcp/agents/block', { tool: 'get_notes', blocked: false });
    // A recheck that says member takes the owner's controls away (agent.cloud's role, within 5 minutes).
    await fake('/_fake/roles', { as: o.id, role: 'member' });
    // Time moves as AUTH-8's own checks move it: the session's start (a day before it expires) and its last check, 6 minutes back.
    await env.sql("UPDATE sessions SET expires_at = expires_at - interval '6 minutes', checked_at = checked_at - interval '6 minutes' WHERE user_id::text = $1", [o.id]);
    const after = (await req(env, web, o.jar, 'GET', '/mcp/agents')).json as { owner?: boolean } | null;
    const ok = out1.status === 401 && bearerView.status === 401 && [bearerRevoke, bearerBlock, bearerApprove].every((r) => r.status === 401) && mine.status === 200 && view?.owner === false && listed >= 1
      && memberBlock.status === 403 && revoke.status === 200 && revokedGrant && ov?.owner === true && Array.isArray(ov.everyone) && Array.isArray(ov.tools) && block.status === 200 && hidden && refused && after?.owner === false;
    out.set('CONF:agents', (ok ? pass : fail)(`/mcp/agents signed out ${out1.status}, with only a Bearer ${bearerView.status}; a Bearer revoking, blocking and approving: ${[bearerRevoke, bearerBlock, bearerApprove].map((r) => r.status).join(', ')}; `
      + `a member sees ${listed} connections, owner ${view?.owner}, blocking ${memberBlock.status}, revoking their own ${revoke.status}${revokedGrant ? ' (revoked)' : ' (not revoked)'}; `
      + `an owner sees owner ${ov?.owner} with everyone’s and the tools, blocks get_notes (${block.status}): ${hidden ? 'hidden' : 'still listed'} and ${refused ? 'refused' : 'still runs'}; after a recheck saying member, owner ${after?.owner}`));
  }

  // AMCP-7: budgets, data marking, secrets withheld, via, and grants rechecked by a stable identity.
  {
    const g = await connect(web, a);
    const reads: number[] = [];
    for (let i = 0; i < 61; i++) reads.push((await call(web, g!, 'get_notes')).status);
    const over = await call(web, g!, 'get_notes');
    const gw = await connect(web, a);
    const writes: number[] = [];
    for (let i = 0; i < 11; i++) writes.push((await call(web, gw!, 'post_notes', { title: `Burst ${tag()} ${i}` })).status);
    const lastWrite = await call(web, gw!, 'post_notes', { title: `Burst ${tag()} over` });
    const gm = await connect(web, a);
    const init = await rpc(web, gm!.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'conformance', version: '1' } });
    const instructions = String((init.json as Rpc | null)?.result?.instructions ?? '');
    const markedOk = BLOCK.test(texts(await call(web, gm!, 'get_notes'))) && instructions.includes('app-data');
    const [via] = await env.sql<{ n: number }>("SELECT count(*)::int AS n FROM notes WHERE user_id::text = $1 AND via = 'Claude'", [a.id]);
    // The grant's person loses access at agent.cloud: the next recheck ends it.
    const p = await person(web, 'mcp-recheck');
    const gp = await connect(web, p);
    await env.sql("UPDATE mcp_grants SET checked_at = now() - interval '6 minutes' WHERE user_id::text = $1", [p.id]);
    await env.answerRechecks(p.id, 404);
    const gone = gp ? (await rpc(web, gp.access_token, 'ping')).status : 0;
    const [ended] = await env.sql<{ n: number }>('SELECT count(*)::int AS n FROM mcp_grants WHERE user_id::text = $1 AND revoked_at IS NOT NULL', [p.id]);
    // Last, since it leaves a note no answer may carry: a secret's value in a tool's answer is withheld.
    const secret = await req(env, web, a.jar, 'POST', '/api/notes', { title: `Holds ${AUTH_TOKEN}` });
    const withheld = await call(web, gm!, 'get_notes');
    await env.sql('DELETE FROM notes WHERE id::text = $1', [String((secret.json as { id?: string } | null)?.id ?? '')]);
    const edge = await edgeProbes();
    const ok = reads.slice(0, 60).every((s) => s === 200) && (reads[60] === 429 || over.status === 429) && writes.slice(0, 10).every((s) => s === 200) && (writes[10] === 429 || lastWrite.status === 429)
      && (over.headers.get('retry-after') ?? lastWrite.headers.get('retry-after')) !== null && markedOk && (via?.n ?? 0) > 0 && gone === 401 && (ended?.n ?? 0) === 1
      && secret.status === 201 && isError(withheld) && /withheld/i.test(texts(withheld)) && !texts(withheld).includes(AUTH_TOKEN) && edge.ok;
    out.set('CONF:mcp-safety', (ok ? pass : fail)(`61 reads in a minute: the 61st ${reads[60]}; 11 writes: the 11th ${writes[10]}${over.headers.get('retry-after') || lastWrite.headers.get('retry-after') ? ', with Retry-After' : ''}; answers ${markedOk ? 'inside a nonce’d app-data block, and the instructions say so' : 'not marked'}; `
      + `${via?.n ?? 0} of A’s notes carry via Claude; a person agent.cloud refuses at the recheck: ${gone}, ${ended?.n ?? 0} grant ended; a note holding AGC_AUTH_TOKEN’s value: ${isError(withheld) && !texts(withheld).includes(AUTH_TOKEN) ? 'withheld' : 'leaked'}; edge sign-in: ${edge.evidence}`));
  }

  // AMCP-8: Point, labels only, for this person's agent.
  {
    const value = await req(env, web, a.jar, 'POST', '/mcp/agents/point', { route: '/notes', selector: '#title', label: 'Title', value: 'what they typed' });
    const label = `Add note ${tag()}`;
    const ok1 = await req(env, web, a.jar, 'POST', '/mcp/agents/point', { route: '/notes', selector: 'form button', label });
    const g = await connect(web, a);
    const bearer = await req(env, web, new Map(), 'POST', '/mcp/agents/point', { route: '/', selector: 'x', label: 'x' }, { authorization: `Bearer ${g!.access_token}` });
    const got = await call(web, g!, 'point_get');
    const gb = await connect(web, b);
    const theirs = await call(web, gb!, 'point_get');
    const ok = value.status === 400 && ok1.status === 200 && bearer.status === 401 && BLOCK.test(texts(got)) && texts(got).includes(label) && !texts(theirs).includes(label);
    out.set('CONF:point', (ok ? pass : fail)(`a pick carrying a value ${value.status}; a label pick ${ok1.status}; with only a Bearer ${bearer.status}; point_get ${texts(got).includes(label) ? 'returns it in the data block' : 'doesn’t return it'}; another person’s agent ${texts(theirs).includes(label) ? 'sees it' : 'doesn’t'}`));
  }

  // AMCP-10: the badge shows while agents can reach the app, in the welcome page's chip row, linking to /agents.
  {
    const on = (await req(env, web, new Map(), 'GET', '/mcp/agents/badge')).json as { show?: boolean } | null;
    await fake('/_fake/mcp-access', { on: false, source: 'org' });
    const offApp = await env.web('badge-off', env.appEnv(), { alias: false });
    const ready = await env.ready(offApp, 60_000);
    const off = ready === undefined ? null : (await req(env, offApp, new Map(), 'GET', '/mcp/agents/badge')).json as { show?: boolean } | null;
    await run('docker', ['rm', '-f', offApp.name]);
    await fake('/_fake/mcp-access', { on: true, source: 'org' });
    const html = (await req(env, web, new Map(), 'GET', '/')).text;
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
    let bundle = '';
    for (const src of scripts) bundle += (await req(env, web, new Map(), 'GET', src)).text;
    const appTsx = readFileSync(join(stack.dir, 'web/src/App.tsx'), 'utf8');
    const agentsTsx = readFileSync(join(stack.dir, 'web/src/Agents.tsx'), 'utf8');
    const inRow = /className="chips[^"]*">\{chips\([^)]*\)\}<AgentBadge \/>/.test(appTsx);
    const hides = /try\s*\{\s*localStorage\.setItem\(/.test(agentsTsx) && /hidden\(\)/.test(agentsTsx);
    const ok = on?.show === true && off?.show === false && bundle.includes('Use with your agent') && bundle.includes('/mcp/agents/badge') && bundle.includes('/agents') && inRow && hides;
    out.set('CONF:badge', (ok ? pass : fail)(`badge answer ${on?.show} while agent.cloud lets agents in, ${off?.show ?? 'no answer'} once it doesn’t; the served bundle ${bundle.includes('Use with your agent') ? 'carries' : 'lacks'} the chip; `
      + `App.tsx renders it ${inRow ? 'in the chip row' : 'outside the chip row'}; Hide ${hides ? 'is remembered in localStorage, inside try' : 'isn’t remembered safely'}`));
  }
  return out;

  // AMCP-7 on edge sign-in: a grant names the gate's issuer and provider_id, rechecked by them, never by the email.
  async function edgeProbes(): Promise<{ ok: boolean; evidence: string }> {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const kid = `conf-${tag()}`;
    await fake('/_fake/jwks', { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }] });
    const appName = String(table(stack.raw.app).name ?? '');
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const assertion = (claims: Record<string, unknown>, key = privateKey) => {
      const h = b64({ alg: 'ES256', kid, typ: 'JWT' }), p = b64(claims);
      return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const as = (email: string, claims: Record<string, unknown> = {}, key = privateKey): Who => ({ jar: new Map(), id: '', headers: {
      'x-agc-user-email': email, 'x-agc-user-name': 'Edge Person', 'x-agc-user-role': 'member',
      'x-agc-identity': assertion({ iss: PLATFORM, sub: email, name: 'Edge Person', aud: appName, presence: 'session', provider_id: `pid-${tag()}`, iat: now, exp: now + 300, ...claims }, key),
    } });
    const edgeApp = await env.web('edge', env.appEnv({ AGC_AUTH_PROVIDER: 'edge', AGC_IDENTITY_ISSUER: PLATFORM }), { alias: false });
    try {
      if (await env.ready(edgeApp, 60_000) === undefined) return { ok: false, evidence: 'the app in edge mode never became ready' };
      const email = `edge-${tag()}@example.test`;
      const pid = `pid-${tag()}`;
      const sam = as(email, { provider_id: pid });
      const g = await connect(edgeApp, sam);
      const connected = !!g && (await rpc(edgeApp, g.access_token, 'ping')).status === 200;
      const noPid = (await code(edgeApp, as(email, { provider_id: undefined }), 'act')).auth;
      const customer = (await code(edgeApp, as(email, { iss: 'https://login.customer.example' }), 'act')).auth;
      const forged = (await code(edgeApp, as(email, {}, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey), 'act')).auth;
      const twin = as(email, { provider_id: `pid-${tag()}` }); // the same address, another provider id: another person
      const twinView = (await req(env, edgeApp, new Map(), 'GET', '/mcp/agents', undefined, twin.headers)).json as { connections?: unknown[] } | null;
      const samView = (await req(env, edgeApp, new Map(), 'GET', '/mcp/agents', undefined, sam.headers)).json as { connections?: unknown[] } | null;
      await fake('/_fake/people', { iss: PLATFORM, provider_id: pid, status: 404 });
      await env.sql("UPDATE mcp_grants SET checked_at = now() - interval '6 minutes' WHERE subject_id = $1", [pid]);
      const after = g ? (await rpc(edgeApp, g.access_token, 'ping')).status : 0;
      const heard = (await asked()).filter((x) => x.provider_id === pid);
      const keyed = heard.length >= 1 && heard.every((x) => x.iss === PLATFORM && !x.email);
      const ok = connected && noPid.status === 403 && customer.status === 403 && /aren’t available|aren't available/.test(customer.text) && forged.status === 403
        && (twinView?.connections?.length ?? -1) === 0 && (samView?.connections?.length ?? 0) >= 1 && after === 401 && keyed;
      return { ok, evidence: `connects with iss and provider_id ${connected ? 'yes' : 'no'}; without provider_id ${noPid.status}; a customer’s issuer ${customer.status}; a forged signature ${forged.status}; `
        + `the same email under another provider_id sees ${twinView?.connections?.length ?? '?'} connections (the first sees ${samView?.connections?.length ?? '?'}); /people asked ${heard.length}× by issuer and provider_id${keyed ? '' : ' (or with the email)'}, and its 404 ends the grant: ${after}` };
    } finally {
      await run('docker', ['rm', '-f', edgeApp.name]);
    }
  }
}
