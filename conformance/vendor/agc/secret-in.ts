// The secret shapes agent.cloud refuses in app repos, on its own with no imports, so code outside control (the RAGC
// foreman's scrub) can use exactly these patterns without pulling in control.
// Content that is almost certainly a secret. Each pattern is linear: no two adjacent quantifiers can share characters.
export const SECRETS: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, 'a private key'],
  // REPO-14: AWS's documented example key IDs end in EXAMPLE (AKIAIOSFODNN7EXAMPLE): public, so not a secret.
  [/\bAKIA(?![0-9A-Z]{9}EXAMPLE\b)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})/, 'a GitHub token'],
  [/\b(?:sk-(?:live|proj|ant)-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,})/, 'an API secret key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  // REPO-14: every credential agent.cloud mints with an agc prefix. A bare agc_ (an agent token) is 32 base64url characters, so
  // a run of 32 or more is one, whatever follows; agent.cloud's own shorter snake_case names (agc_runtime_api_binding) aren't.
  // Any other agc<letters>_ (deploy key agcd_, task token agct_, report token agcrep_, OAuth agcoa_, a signed
  // agcp_<app>.<exp>.<mac>, and any prefix minted later) is a run of 16 or more. Each is matched as its first 32 or 16, so
  // a megabytes-long run never has to be held whole. No word boundary before it: a token right after an escape (\x20, %20,
  // \t) or any other word character is still one, so an identifier such as ragc_<32 or more> counts too.
  [/agc(?:_[A-Za-z0-9_-]{32}|[a-z]{1,6}_[A-Za-z0-9_.-]{16})/, 'an agent.cloud token'],
];
// A local or docker-compose database's whole host, with its port; empty, libpq's default (a local socket).
const LOCAL_DB = /^(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|postgres|db|database)(?::\d*)?)?$/i;
// A database URL's user and password at any length. The password's run and the @ after it are taken whole (the @
// optional), so a run with no @ is consumed in one pass and the scan resumes after it: linear, with no caps. A
// postgres:// that starts inside the user or password ends at the same @ and host (or at none), so skipping it misses
// nothing. The host is only looked at, never consumed: a URL that starts in it (postgres://a:b@postgres://app:pw@prod)
// is scanned next. A host run stops at the next /, so it never reaches past the next URL's ://: still linear.
export const DB_URL = /\bpostgres(?:ql)?:\/\/[^:\s/@'"]+:([^@\s'"]+)(?:@(?=([^\s'"`/?]{0,256})))?/g;
// REPO-14: a password that holds no value (a template or a mask) is no secret, whatever the hosts. No password is a sample
// for what it spells, nor any host for what it is: postgres:postgres@plausible_db is a real credential too.
export const NO_VALUE = /^(?:<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|#\{[^}]*\}|\*{3,}|x{3,})$/i;
// REPO-14: libpq takes the host from the query too: host, hostaddr, and service or servicefile (pg_service.conf names any
// host), each name possibly percent-encoded. A URL naming one isn't a local database's, whatever its authority says.
const HOST_PARAM = new RegExp(`[?&](?:${['hostaddr', 'host', 'servicefile', 'service'].map((k) => [...k].map((c) => `(?:${c}|%${c.charCodeAt(0).toString(16)})`).join('')).join('|')})=`, 'gi');
const URL_END = /[\s'"`]/g;
// `skip` names a kind not to look for (the foreman's scrub cuts agent.cloud tokens out itself, and asks only for the rest).
export function secretIn(data: Buffer, skip?: string): string | null {
  const text = data.toString('latin1');
  for (const [re, what] of SECRETS) if (what !== skip && re.test(text)) return what;
  // A database URL with a password, unless the password holds no value, or the URL points at a local or docker-compose
  // database (that's dev config): one whole host, a local one, and no query parameter naming another (REPO-14). Host-naming
  // parameters are found once for the whole text, and each URL's end is searched from where the last one's search ended,
  // so the check stays linear.
  let params: number[] | null = null, next = 0, end = -1;
  const queryNamesHost = (from: number) => {
    params ??= [...text.matchAll(HOST_PARAM)].map((p) => p.index);
    if (end < from) { URL_END.lastIndex = from; end = URL_END.exec(text)?.index ?? text.length; }
    while (next < params.length && params[next]! < from) next++;
    return next < params.length && params[next]! < end;
  };
  for (const m of text.matchAll(DB_URL)) {
    const host = m[2];
    if (host === undefined || NO_VALUE.test(m[1]!)) continue;
    if (host.length <= 255 && LOCAL_DB.test(host) && !queryNamesHost(m.index + m[0].length)) continue;
    return 'a database URL with a password';
  }
  return null;
}

// PENV-3: a plain env value ships as written into production's pods, so no host is presumed dev config there: a URL
// with a credential in it, any scheme and any host (db, localhost included), at any length, is a secret too. A
// credential is a password; a user or token before the @ with no password (a bearer URL, https://<token>@hooks.example.com);
// or a query parameter with a value whose name is like a token, signature, key or password (a signed S3, CloudFront or
// Azure URL's X-Amz-Signature, Signature or sig, an access_token, an api_key). The repo scan's database URL pattern
// isn't used for a value: its password may run past a / or ?, where a URL's authority ends.
// Each is what a URL parser (WHATWG, new URL()) reads, from each scheme in the value. When the rest of the value parses
// as a URL, its own username, password and searchParams are the answer. When it doesn't (text after the host), it's
// read the parser's way: tabs and newlines dropped; http, https, ws, wss and ftp skip any run of / and \ and end the
// authority at / \ ? #; any other scheme needs // and ends it at / ? #; userinfo runs to the authority's last @, its
// username is what comes before its first : and its password whatever follows, spaces included; the query runs from
// the first ? to the first #. Either way URLSearchParams reads the query's names, so a percent-encoded or +-spaced name
// (%74oken, api_%6bey) is judged decoded. Only a URL with an authority (a scheme above, or // after another) has its
// query judged, and a fragment is never judged. A value is at most 4096 characters, so the scan stays small.
const URL_IGNORED = /[\t\n\r]/g;
const URL_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*:/g;
const URL_SPECIAL = new Set(['http', 'https', 'ws', 'wss', 'ftp']);
// A name holding token, signature, secret, credential, password, passwd or pwd, any case, or named sig or pass; or
// holding key or keys that no lowercase letter follows (api_key, apiKey, AWSAccessKeyId, Key-Pair-Id, but not keyword).
const CREDENTIAL_NAME = /token|signature|secret|credential|passw(?:or)?d|pwd|^(?:sig|pass)$/i;
const KEY_NAME = /[Kk][Ee][Yy][Ss]?(?![a-z])/;
function urlCredential(value: string): string | null {
  const v = value.replace(URL_IGNORED, '');
  for (const m of v.matchAll(URL_SCHEME)) {
    const rest = v.slice(m.index);
    if (!/[@?]/.test(rest)) return null; // no userinfo or query from here on
    const scheme = m[0].slice(0, -1).toLowerCase(), after = rest.slice(m[0].length);
    const special = URL_SPECIAL.has(scheme), authority = special || after.startsWith('//');
    let url: URL | undefined;
    try { url = new URL(rest); } catch { url = undefined; }
    const found = url ? credentialOf(url.username, url.password, authority ? url.searchParams : undefined) : authority ? unparsedCredential(special, after) : null;
    if (found) return found;
  }
  return null;
}
function unparsedCredential(special: boolean, after: string): string | null {
  const from = special ? after.replace(/^[/\\]*/, '') : after.slice(2);
  const end = from.search(special ? /[/\\?#]/ : /[/?#]/);
  const authority = end >= 0 ? from.slice(0, end) : from, at = authority.lastIndexOf('@');
  const userinfo = at >= 0 && at < authority.length - 1 ? authority.slice(0, at) : '', colon = userinfo.indexOf(':');
  const q = from.indexOf('?'), hash = from.indexOf('#');
  const query = q >= 0 && (hash < 0 || q < hash) ? new URLSearchParams(from.slice(q + 1, hash < 0 ? undefined : hash)) : undefined;
  return credentialOf(colon >= 0 ? userinfo.slice(0, colon) : userinfo, colon >= 0 ? userinfo.slice(colon + 1) : '', query);
}
function credentialOf(username: string, password: string, query: URLSearchParams | undefined): string | null {
  if (password) return 'a URL with a password';
  if (username) return 'a URL with a user or token before its @';
  for (const [name, value] of query ?? []) if (value && (CREDENTIAL_NAME.test(name) || KEY_NAME.test(name))) return 'a URL with a credential in its query';
  return null;
}
export function secretInValue(value: string): string | null {
  for (const [re, what] of SECRETS) if (re.test(value)) return what;
  return urlCredential(value);
}
