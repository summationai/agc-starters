"""AMCP-2: the app is its own OAuth server for its /mcp, on its own sign-in: the canvas's (SUB-1 to SUB-4), unchanged in
shape. A client's id is its own metadata, sealed; a consent request and a code are sealed too, and spent once.
  GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: /mcp, and who signs agents in for it
  GET  /.well-known/oauth-authorization-server        RFC 8414: the endpoints below
  POST /oauth/register     a public client (RFC 7591); at most 20 an hour from one address
  GET  /oauth/authorize    signed in to the app, the person goes to /agents/consent, which asks /mcp/agents/consent
  POST /oauth/token        code + S256 verifier -> ten-minute access and rotating refresh tokens
  POST /oauth/revoke       RFC 7009"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import parse_qs, quote, urlencode, urlsplit

import anyio
import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse, Response
from psycopg.rows import DictRow

from .. import log
from ..auth import current_user
from ..db import pool, tx
from .identity import Subject, identity_of

ACCESS_SECONDS = 600
GRANT_SECONDS = 30 * 86_400
Scope = Literal["read", "act"]
SCOPES: dict[str, str] = {"read": "mcp:read", "act": "mcp:read mcp:write"}

_KEY = hmac.new(os.environ["AGC_AUTH_TOKEN"].encode(), b"starter: agents over mcp", hashlib.sha256).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(kind: str, payload: str) -> str:
    return _b64(hmac.new(_KEY, f"{kind}.{payload}".encode(), hashlib.sha256).digest())


def seal(kind: str, value: dict[str, Any]) -> str:
    p = _b64(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())
    return f"{kind}.{p}.{_sign(kind, p)}"


_SEALED = re.compile(r"^([a-z0-9]{3})\.([A-Za-z0-9_-]{10,6000})\.([A-Za-z0-9_-]{43})$")


def unseal(kind: str, sealed: object) -> dict[str, Any] | None:
    m = _SEALED.match(sealed if isinstance(sealed, str) else "")
    if not m or m[1] != kind or not hmac.compare_digest(m[3].encode(), _sign(kind, m[2]).encode()):
        return None
    try:
        value = json.loads(_unb64(m[2]).decode())
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def now_ms() -> int:
    return int(time.time() * 1000)


def js_time(at: datetime) -> str:
    """A time as JavaScript's JSON writes one, so both stacks answer alike: 2026-11-04T07:00:00.123Z."""
    return at.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def origin_of(request: Request) -> str:
    host = request.headers.get("host") or request.url.netloc
    return f"{'http' if re.match(r'^(localhost|127\.)', host) else 'https'}://{host}"


def resource_of(request: Request) -> str:
    return f"{origin_of(request)}/mcp"


def challenge(request: Request) -> str:
    return f'Bearer resource_metadata="{origin_of(request)}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"'


# Callbacks: native loopback clients, and the exact hosted callbacks proven on agent.cloud's staging. Names confer no trust.
CALLBACKS = ["https://claude.ai/api/mcp/auth_callback"]
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def redirect_ok(uri: object) -> bool:
    if not isinstance(uri, str) or len(uri) > 500 or re.search(r"[\s#]", uri):
        return False
    try:
        u = urlsplit(uri)
        u.port  # noqa: B018 - a port that doesn't parse is no callback
    except ValueError:
        return False
    if not u.scheme or not u.netloc or u.username is not None or u.password is not None or u.fragment:
        return False
    return uri in CALLBACKS or (u.scheme == "http" and (u.hostname or "") in _LOOPBACK)


def same_redirect(registered: str, actual: str) -> bool:
    if not redirect_ok(registered) or not redirect_ok(actual):
        return False
    a, b = urlsplit(registered), urlsplit(actual)
    if a.scheme == "http" and b.scheme == "http":  # a loopback callback may come back on any port
        return (a.hostname, a.path or "/", a.query) == (b.hostname, b.path or "/", b.query)
    return registered == actual


_INVISIBLE = re.compile("[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]")


def named(n: object) -> str:
    return (_INVISIBLE.sub("", n).strip()[:100] if isinstance(n, str) else "") or "An unnamed client"


def _where_to(u: object) -> str:
    try:
        x = urlsplit(str(u))
        return f"{x.scheme}://{x.hostname}" if x.scheme and x.hostname else "unparseable"
    except ValueError:
        return "unparseable"


def client_of(client_id: object) -> dict[str, Any] | None:
    return unseal("mc1", client_id)


def _address_of(request: Request) -> str:
    """The proxy nearest the app appends the caller's address last; anything before it, the caller wrote."""
    hops = [s.strip() for s in request.headers.get("x-forwarded-for", "").split(",") if s.strip()]
    return hops[-1] if hops else "unknown"


def claim_nonce(nonce: str, expires: int, conn: psycopg.Connection[DictRow] | None = None) -> bool:
    sql = "INSERT INTO mcp_nonces (nonce, expires_at) VALUES (%s, %s) ON CONFLICT DO NOTHING RETURNING nonce"
    at = datetime.fromtimestamp(expires / 1000, UTC)
    if conn is not None:
        return conn.execute(sql, (nonce, at)).fetchone() is not None
    with pool.connection() as c:
        return c.execute(sql, (nonce, at)).fetchone() is not None


def _mint(value: dict[str, Any]) -> str:
    p = _b64(json.dumps(value, separators=(",", ":")).encode())
    return f"ma1.{p}.{_sign('ma1', p)}"


def _pair(conn: psycopg.Connection[DictRow], g: dict[str, Any]) -> dict[str, Any]:
    refresh = f"mr1.{secrets.token_urlsafe(32)}"
    conn.execute("INSERT INTO mcp_refresh (token_hash, grant_id) VALUES (%s, %s)", (_hash(refresh), g["id"]))
    ttl = min(ACCESS_SECONDS, max(0, int((g["expires_at"].timestamp() * 1000 - now_ms()) // 1000)))
    access = _mint({"g": str(g["id"]), "u": str(g["user_id"]), "a": g["resource"], "e": now_ms() + ttl * 1000})
    return {"access_token": access, "token_type": "Bearer", "expires_in": ttl, "refresh_token": refresh, "scope": SCOPES[g["scope"]]}


_ACCESS = re.compile(r"^ma1\.([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{43})$")


def grant_of(bearer: str, resource: str) -> dict[str, Any] | None:
    """The grant behind a bearer token, while it's live, with its person."""
    t = unseal("ma1", bearer) if _ACCESS.match(bearer) else None
    if not t or not isinstance(t.get("e"), int) or t["e"] <= now_ms() or t.get("a") != resource:
        return None
    try:
        for key in ("g", "u"):
            uuid.UUID(str(t.get(key)))
    except ValueError:
        return None
    with pool.connection() as conn:
        g = conn.execute(
            "SELECT g.id::text AS id, g.user_id::text AS user_id, g.subject_iss, g.subject_id, g.client_id, g.client_name,"
            " g.scope, g.resource, g.created_at, g.expires_at, g.revoked_at, u.email, u.name, u.role FROM mcp_grants g"
            " JOIN users u ON u.id = g.user_id"
            " WHERE g.id = %s AND g.user_id = %s AND g.resource = %s AND g.revoked_at IS NULL AND g.expires_at > now()",
            (t["g"], t["u"], resource),
        ).fetchone()
    if not g:
        return None
    return {**g, "user": {"id": g["user_id"], "email": g["email"], "name": g["name"], "role": g["role"]}}


def _json(value: Any, status: int = 200, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(value, status, headers=headers)


async def _small_body(request: Request) -> bytes | None:
    """OAuth's bodies are small: anything over 16 KB is refused unread."""
    if int(request.headers.get("content-length") or 0) > 16 * 1024:
        return None
    raw = await request.body()
    return raw if len(raw) <= 16 * 1024 else None


def _form(raw: bytes) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True).items()}


def mount_oauth(app: FastAPI) -> None:
    def resource(request: Request) -> Response:
        return _json(
            {
                "resource": resource_of(request),
                "authorization_servers": [origin_of(request)],
                "scopes_supported": ["mcp:read", "mcp:write"],
                "bearer_methods_supported": ["header"],
            }
        )

    app.add_api_route("/.well-known/oauth-protected-resource", resource, methods=["GET"], include_in_schema=False)
    app.add_api_route("/.well-known/oauth-protected-resource/mcp", resource, methods=["GET"], include_in_schema=False)

    @app.get("/.well-known/oauth-authorization-server", include_in_schema=False)
    def metadata(request: Request) -> Response:
        o = origin_of(request)
        return _json(
            {
                "issuer": o,
                "authorization_endpoint": f"{o}/oauth/authorize",
                "token_endpoint": f"{o}/oauth/token",
                "registration_endpoint": f"{o}/oauth/register",
                "revocation_endpoint": f"{o}/oauth/revoke",
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["none"],
                "scopes_supported": ["mcp:read", "mcp:write"],
                "authorization_response_iss_parameter_supported": True,
            }
        )

    @app.post("/oauth/register", include_in_schema=False)
    async def register(request: Request) -> Response:
        raw = await _small_body(request)
        if raw is None:
            return _json({"error": "invalid_request", "error_description": "The body is too large."}, 413)
        return await anyio.to_thread.run_sync(_register, request, raw)

    def _register(request: Request, raw: bytes) -> Response:
        address = _hash(f"register:{_address_of(request)}")
        with pool.connection() as conn:
            row = conn.execute(
                "SELECT count(*)::int AS n FROM mcp_registrations WHERE address = %s AND at > now() - interval '1 hour'", (address,)
            ).fetchone()
        if row and row["n"] >= 20:
            return _json(
                {"error": "too_many_requests", "error_description": "Too many registrations from this address. Try again in an hour."},
                429,
                {"retry-after": "3600"},
            )
        try:
            m = json.loads(raw) if raw else None
        except ValueError:
            m = None
        m = m if isinstance(m, dict) else None
        uris = m.get("redirect_uris") if m else None
        if not isinstance(uris, list) or not 1 <= len(uris) <= 5 or not all(redirect_ok(u) for u in uris):
            log.warn(
                "oauth register refused",
                reason="redirect",
                redirects=[_where_to(u) for u in uris[:5]] if isinstance(uris, list) else type(uris).__name__,
                client=named(m.get("client_name") if m else None),
            )
            return _json(
                {
                    "error": "invalid_redirect_uri",
                    "error_description": f"Use 1 to 5 loopback HTTP callbacks, or exactly one of: {', '.join(CALLBACKS)}.",
                },
                400,
            )
        assert m is not None
        if "token_endpoint_auth_method" in m and m["token_endpoint_auth_method"] != "none":  # noqa: S105 - a metadata field, not a password
            return _json(
                {"error": "invalid_client_metadata", "error_description": "Only public clients (token_endpoint_auth_method none)."}, 400
            )
        grants, responses = m.get("grant_types"), m.get("response_types")
        if (
            "grant_types" in m
            and (not isinstance(grants, list) or not all(str(x) in ("authorization_code", "refresh_token") for x in grants))
        ) or ("response_types" in m and (not isinstance(responses, list) or not all(x == "code" for x in responses))):
            return _json(
                {
                    "error": "invalid_client_metadata",
                    "error_description": "Use authorization_code/refresh_token grants and the code response type.",
                },
                400,
            )
        with pool.connection() as conn:
            conn.execute("INSERT INTO mcp_registrations (address) VALUES (%s)", (address,))
            conn.execute("DELETE FROM mcp_registrations WHERE at < now() - interval '1 day'")
        client = {"r": uris, "n": named(m.get("client_name"))}
        log.info("agent client registered", client=client["n"], redirects=[_where_to(u) for u in uris])
        return _json(
            {
                "client_id": seal("mc1", client),
                "client_id_issued_at": int(time.time()),
                "redirect_uris": client["r"],
                "client_name": client["n"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": "mcp:read mcp:write",
            },
            201,
        )

    @app.get("/oauth/authorize", include_in_schema=False)
    def authorize(request: Request) -> Response:
        q = request.query_params
        client = client_of(q.get("client_id"))

        def refuse(message: str) -> Response:
            return PlainTextResponse(f"{message} Start again from your agent.", 400)

        # Until the client and its callback match, nothing goes back to a URI anyone could have written.
        if not client:
            return refuse("The agent that sent you here isn’t registered with this app.")
        redirect = q.get("redirect_uri") or ""
        if not any(same_redirect(u, redirect) for u in client.get("r", [])) or not redirect_ok(redirect):
            return refuse("The agent asked to come back to an address it didn’t register.")

        def back(error: str) -> Response:
            params = {"error": error, **({"state": q["state"]} if q.get("state") else {}), "iss": origin_of(request)}
            return RedirectResponse(f"{redirect}{'&' if '?' in redirect else '?'}{urlencode(params)}", 302)

        if q.get("response_type") != "code":
            return back("unsupported_response_type")
        if (
            q.get("code_challenge_method") != "S256"
            or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", q.get("code_challenge") or "")
            or len(q.get("state") or "") > 500
        ):
            return back("invalid_request")
        if q.get("resource") and q["resource"].rstrip("/") != resource_of(request):
            return back("invalid_target")
        if q.get("scope") and any(s and s not in ("mcp:read", "mcp:write") for s in q["scope"].split(" ")):
            return back("invalid_scope")
        user = current_user(request)
        if not user:
            here = request.url.path + (f"?{request.url.query}" if request.url.query else "")
            return RedirectResponse(f"/auth/sign-in?return_to={quote(here, safe='')}", 302)
        # AMCP-7: a grant names its person by a stable identity; a sign-in that can't give one can't grant.
        who = identity_of(request, user)
        if not who.subject:
            return PlainTextResponse(who.message or "", 403)
        consent = seal(
            "mq1",
            {
                "n": str(uuid.uuid4()),
                "a": resource_of(request),
                "u": user["id"],
                "si": who.subject.iss,
                "sp": who.subject.id,
                "cl": q["client_id"],
                "r": redirect,
                "ch": q["code_challenge"],
                "st": q.get("state"),
                "e": now_ms() + 10 * 60_000,
            },
        )
        return RedirectResponse(f"/agents/consent?request={quote(consent, safe='')}", 302)

    @app.post("/oauth/token", include_in_schema=False)
    async def token(request: Request) -> Response:
        raw = await _small_body(request)
        if raw is None:
            return _json({"error": "invalid_request", "error_description": "The body is too large."}, 413)
        f: dict[str, Any]
        if request.headers.get("content-type", "").startswith("application/json"):
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = None
            f = parsed if isinstance(parsed, dict) else {}
        else:
            f = _form(raw)
        return await anyio.to_thread.run_sync(_token, request, f)

    def _token(request: Request, f: dict[str, Any]) -> Response:
        def fail(error: str, description: str) -> Response:
            return _json({"error": error, "error_description": description}, 400, {"cache-control": "no-store"})

        res = resource_of(request)
        if "resource" in f and f["resource"] != res:
            return fail("invalid_target", "The resource must be this app’s MCP URL.")
        if f.get("grant_type") == "refresh_token":
            result = _refresh_grant(str(f.get("refresh_token") or ""), str(f.get("client_id") or ""), res)
            if result:
                return _json(result, 200, {"cache-control": "no-store"})
            return fail("invalid_grant", "This connection expired, was revoked, or its refresh token was already used. Connect again.")
        if f.get("grant_type") != "authorization_code":
            return fail("unsupported_grant_type", "Use authorization_code or refresh_token.")
        code = unseal("mo1", f.get("code"))
        if not code or code.get("e", 0) < now_ms():
            return fail("invalid_grant", "The code is wrong, used or expired. Connect again.")
        verifier = f.get("code_verifier") if isinstance(f.get("code_verifier"), str) else ""
        client = client_of(code.get("cl"))
        valid = bool(
            client
            and f.get("client_id") == code.get("cl")
            and f.get("redirect_uri") == code.get("r")
            and code.get("a") == res
            and re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier or "")
            and _b64(hashlib.sha256((verifier or "").encode()).digest()) == code.get("ch")
        )
        with tx() as conn:
            if not claim_nonce(str(code.get("n")), int(code.get("e", 0)), conn) or not valid:
                result = None
            else:
                assert client is not None
                g = conn.execute(
                    "INSERT INTO mcp_grants (id, user_id, subject_iss, subject_id, client_id, client_name, scope, resource, expires_at)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
                    (
                        str(uuid.uuid4()),
                        code["u"],
                        code["si"],
                        code["sp"],
                        code["cl"],
                        client["n"],
                        code["s"],
                        res,
                        datetime.now(UTC) + timedelta(seconds=GRANT_SECONDS),
                    ),
                ).fetchone()
                assert g is not None
                conn.execute("DELETE FROM mcp_nonces WHERE expires_at < now() - interval '1 day'")
                conn.execute("DELETE FROM mcp_grants WHERE expires_at < now() - interval '30 days'")
                # DATA-10: each table that records what happens is deleted from by name, never only by a cascade, which the
                # review never counts. A grant ends within 30 days, so a call or used refresh token older than that is an
                # ended grant's.
                conn.execute("DELETE FROM mcp_calls WHERE at < now() - interval '30 days'")
                conn.execute("DELETE FROM mcp_refresh WHERE used_at < now() - interval '30 days'")
                conn.execute("DELETE FROM mcp_approvals WHERE expires_at < now() - interval '1 day'")
                conn.execute("DELETE FROM mcp_points WHERE at < now() - interval '1 day'")
                log.info("agent connected", user=code["u"], client=client["n"], scope=code["s"])
                result = _pair(conn, g)
        if result:
            return _json(result, 200, {"cache-control": "no-store"})
        return fail("invalid_grant", "The code was used or doesn’t match this client, resource, callback or verifier. Connect again.")

    @app.post("/oauth/revoke", include_in_schema=False)
    async def revoke(request: Request) -> Response:
        raw = await _small_body(request)
        is_form = request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded")
        f = _form(raw) if raw is not None and is_form else {}
        await anyio.to_thread.run_sync(_revoke, request, f)
        return Response(status_code=200, headers={"cache-control": "no-store"})

    def _revoke(request: Request, f: dict[str, str]) -> None:
        token, client, res = f.get("token", ""), f.get("client_id", ""), resource_of(request)
        t = unseal("ma1", token)
        with pool.connection() as conn:
            if t:
                try:
                    uuid.UUID(str(t.get("g")))
                except ValueError:
                    return
                conn.execute(
                    "UPDATE mcp_grants SET revoked_at = coalesce(revoked_at, now()) WHERE id = %s AND resource = %s AND client_id = %s",
                    (t["g"], res, client),
                )
            else:
                conn.execute(
                    "UPDATE mcp_grants SET revoked_at = coalesce(revoked_at, now()) WHERE id IN"
                    " (SELECT grant_id FROM mcp_refresh WHERE token_hash = %s) AND client_id = %s AND resource = %s",
                    (_hash(token), client, res),
                )


def consent_of(sealed: object, user: dict[str, Any], subject: Subject, res: str) -> dict[str, Any] | None:
    """The consent page's question (/agents/consent, through /mcp/agents/consent), for this person only."""
    q = unseal("mq1", sealed)
    mine = q and q.get("u") == user["id"] and q.get("si") == subject.iss and q.get("sp") == subject.id
    return q if q and mine and q.get("e", 0) >= now_ms() and q.get("a") == res else None


def decide(q: dict[str, Any], allow: bool, scope: str, origin: str) -> str | None:
    if not claim_nonce(str(q["n"]), int(q["e"])):
        return None
    if allow:
        code = {
            "a": q["a"],
            "u": q["u"],
            "si": q["si"],
            "sp": q["sp"],
            "cl": q["cl"],
            "r": q["r"],
            "ch": q["ch"],
            "e": now_ms() + 60_000,
            "n": str(uuid.uuid4()),
            "s": scope,
        }
        params = {"code": seal("mo1", code)}
    else:
        params = {"error": "access_denied"}
    if q.get("st"):
        params["state"] = q["st"]
    params["iss"] = origin
    return f"{q['r']}{'&' if '?' in q['r'] else '?'}{urlencode(params)}"


def _refresh_grant(token: str, client: str, res: str) -> dict[str, Any] | None:
    with tx() as conn:
        g = conn.execute(
            "SELECT g.id, g.user_id, g.subject_iss, g.subject_id, g.client_id, g.client_name, g.scope, g.resource,"
            " g.created_at, g.expires_at, g.revoked_at, r.used_at FROM mcp_refresh r JOIN mcp_grants g ON g.id = r.grant_id"
            " WHERE r.token_hash = %s FOR UPDATE OF g, r",
            (_hash(token),),
        ).fetchone()
        if not g or g["client_id"] != client or g["resource"] != res or g["revoked_at"] or g["expires_at"].timestamp() * 1000 <= now_ms():
            return None
        if g["used_at"]:  # a refresh token used twice: someone else has it, so the whole connection ends
            conn.execute("UPDATE mcp_grants SET revoked_at = now() WHERE id = %s", (g["id"],))
            return None
        conn.execute("UPDATE mcp_refresh SET used_at = now() WHERE token_hash = %s", (_hash(token),))
        return _pair(conn, g)
