"""AMCP-6, AMCP-8: the person's own controls, behind the /agents pages: connect, see and revoke your agents, approve or
deny what an agent asked, point at something for it; and for owners, everyone's connections and blocked tools. Every
route here answers the person's session only: an agent's token never reaches it, and a tool call can't name it."""

import json
import os
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import anyio
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from psycopg.types.json import Jsonb

from .. import auth, log
from ..auth import current_user, via_of
from ..db import pool
from .app_name import APP_NAME
from .identity import Subject, identity_of
from .oauth import client_of, consent_of, decide, js_time, origin_of, resource_of
from .tools import catalog

# AMCP-13 (agent.cloud): whether agent.cloud lets agents reach this app, and whether that's the organization's setting
# or this app's override. Asked at most once a minute; unknown when agent.cloud doesn't say.
_access: dict[str, Any] = {"at": 0.0, "value": None}


def access_of() -> dict[str, Any]:
    if _access["value"] is not None and time.monotonic() - _access["at"] < 60:
        return _access["value"]
    value: dict[str, Any] = {"on": True, "source": "unknown"}
    try:
        r = httpx.get(
            f"{os.environ['AGC_AUTH_URL']}/mcp-access",
            headers={"authorization": f"Bearer {os.environ['AGC_AUTH_TOKEN']}"},
            timeout=2,
            follow_redirects=False,
        )
        j = r.json() if r.is_success else None
        if isinstance(j, dict) and isinstance(j.get("on"), bool):
            value = {"on": j["on"], "source": "app" if j.get("source") == "app" else "org"}
    except (httpx.HTTPError, ValueError):
        pass  # agent.cloud didn't say
    _access.update(at=time.monotonic(), value=value)
    return value


@dataclass(frozen=True)
class Person:
    user: dict[str, Any]
    subject: Subject | None
    refusal: str | None
    owner: bool


def person(request: Request) -> Person | None:
    """The signed-in person, never an agent's call (a Bearer token is never a session, and a tool call carries via). Their
    stable identity (AMCP-7) names their grants. AMCP-6: an owner is, on agent.cloud's sign-in, the role from the last
    sign-in or recheck; on edge sign-in, the gate's x-agc-user-role on this very request, which the edge empties from
    clients (ROLE-4). Only these session pages read it, never a tool call."""
    user = None if via_of(request) else current_user(request)
    if not user:
        return None
    who = identity_of(request, user)
    owner = request.headers.get("x-agc-user-role") == "owner" if auth.EDGE else user.get("role") == "owner"
    return Person(user, who.subject, who.message, owner)


def _mine(p: Person) -> tuple[str | None, str | None]:
    return (p.subject.iss, p.subject.id) if p.subject else (None, None)


def _not_here(p: Person) -> Response:
    return JSONResponse({"error": {"code": "not_available", "message": p.refusal}}, 403)


def _nope() -> Response:
    return JSONResponse({"error": {"code": "unauthorized", "message": "Sign in first."}}, 401)


def _bad(code: str, message: str, status: int = 400) -> Response:
    return JSONResponse({"error": {"code": code, "message": message}}, status)


_UUID = re.compile(r"^[0-9a-f-]{36}$")


async def _json_body(request: Request) -> Any:
    try:
        return json.loads(await request.body() or b"null")
    except ValueError:
        return None


def mount_agents(app: FastAPI) -> None:
    @app.get("/mcp/agents/badge", include_in_schema=False)
    def badge() -> Response:
        """The badge (AMCP-10): shown while agents can reach the app. Public, like the page it sits on."""
        return JSONResponse({"show": access_of()["on"]})

    @app.get("/mcp/agents", include_in_schema=False)
    def agents(request: Request) -> Response:
        me = person(request)
        if not me:
            return _nope()
        everyone = me.owner
        si, sp = _mine(me)
        with pool.connection() as conn:
            grants = conn.execute(
                "SELECT g.id::text AS id, (g.subject_iss = %s AND g.subject_id = %s) IS TRUE AS mine, g.client_name, g.scope, g.created_at,"
                " u.email, u.name FROM mcp_grants g JOIN users u ON u.id = g.user_id"
                " WHERE g.revoked_at IS NULL AND g.expires_at > now() AND (%s OR (g.subject_iss = %s AND g.subject_id = %s))"
                " ORDER BY g.created_at DESC LIMIT 200",
                (si, sp, everyone, si, sp),
            ).fetchall()
            calls = conn.execute(
                "SELECT grant_id::text AS grant_id, tool, status, at FROM"
                " (SELECT *, row_number() OVER (PARTITION BY grant_id ORDER BY at DESC) AS n"
                " FROM mcp_calls WHERE grant_id = ANY(%s::uuid[])) x WHERE n <= 5 ORDER BY at DESC",
                ([g["id"] for g in grants],),
            ).fetchall()
            off = {r["tool"] for r in conn.execute("SELECT tool FROM mcp_blocked").fetchall()} if everyone else set()

        def view(g: dict[str, Any]) -> dict[str, Any]:
            return {
                "id": g["id"],
                "client": g["client_name"],
                "scope": g["scope"],
                "connected_at": js_time(g["created_at"]),
                "person": g["email"] if g["email"] is not None else g["name"],
                "mine": g["mine"],
                "calls": [{"tool": c["tool"], "status": c["status"], "at": js_time(c["at"])} for c in calls if c["grant_id"] == g["id"]],
            }

        out: dict[str, Any] = {"app": APP_NAME, "mcp_url": resource_of(request), "owner": everyone, "access": access_of()}
        if me.refusal:
            out["refusal"] = me.refusal
        out["connections"] = [view(g) for g in grants if g["mine"]]
        if everyone:
            out["everyone"] = [view(g) for g in grants if not g["mine"]]
            out["tools"] = [
                {"name": t["name"], "summary": t["summary"], "method": t["method"], "path": t["path"], "blocked": t["name"] in off}
                for t in catalog(app)["tools"]
            ]
        return JSONResponse(out)

    @app.post("/mcp/agents/revoke", include_in_schema=False)
    async def revoke(request: Request) -> Response:
        """Revoke one connection (your own, or anyone's for an owner), or every connection (owners)."""
        m = await _json_body(request)
        return await anyio.to_thread.run_sync(_revoke, request, m if isinstance(m, dict) else {})

    def _revoke(request: Request, m: dict[str, Any]) -> Response:
        me = person(request)
        if not me:
            return _nope()
        if m.get("all") is True:
            if not me.owner:
                return _bad("forbidden", "Only an owner can revoke everyone\u2019s agents.", 403)
            with pool.connection() as conn:
                n = conn.execute("UPDATE mcp_grants SET revoked_at = now() WHERE revoked_at IS NULL").rowcount
            log.info("every agent connection revoked", by=me.user["id"], connections=n)
            return JSONResponse({"revoked": n})
        grant = m.get("id")
        if not isinstance(grant, str) or not _UUID.match(grant):
            return _bad("bad_request", "Name the connection.")
        with pool.connection() as conn:
            n = conn.execute(
                "UPDATE mcp_grants SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL"
                " AND (%s OR (subject_iss = %s AND subject_id = %s))",
                (grant, me.owner, *_mine(me)),
            ).rowcount
        log.info("agent connection revoked", by=me.user["id"], connection=grant, revoked=n)
        return JSONResponse({"revoked": n})

    @app.post("/mcp/agents/block", include_in_schema=False)
    async def block(request: Request) -> Response:
        """Owners block a tool from every agent, or unblock it."""
        m = await _json_body(request)
        return await anyio.to_thread.run_sync(_block, request, m if isinstance(m, dict) else {})

    def _block(request: Request, m: dict[str, Any]) -> Response:
        me = person(request)
        if not me:
            return _nope()
        if not me.owner:
            return _bad("forbidden", "Only an owner can block tools.", 403)
        tool, blocked = m.get("tool"), m.get("blocked")
        if not isinstance(tool, str) or not any(t["name"] == tool for t in catalog(app)["tools"]) or not isinstance(blocked, bool):
            return _bad("bad_request", "Name a tool, and whether it\u2019s blocked.")
        with pool.connection() as conn:
            if blocked:
                conn.execute(
                    "INSERT INTO mcp_blocked (tool, blocked_by) VALUES (%s, %s) ON CONFLICT (tool) DO NOTHING", (tool, me.user["id"])
                )
            else:
                conn.execute("DELETE FROM mcp_blocked WHERE tool = %s", (tool,))
        log.info("tool blocked for agents" if blocked else "tool unblocked for agents", by=me.user["id"], tool=tool)
        return JSONResponse({"tool": tool, "blocked": blocked})

    @app.get("/mcp/agents/consent", include_in_schema=False)
    def consent_get(request: Request) -> Response:
        """The consent page (AMCP-2): what's asking."""
        me = person(request)
        if not me:
            return _nope()
        if not me.subject:
            return _not_here(me)
        q = consent_of(request.query_params.get("request"), me.user, me.subject, resource_of(request))
        if not q:
            return _bad("expired", "This request has expired. Start again from your agent.")
        client = client_of(q["cl"])
        return JSONResponse(
            {
                "app": APP_NAME,
                "client": client["n"] if client else "An unnamed client",
                "callback": urlsplit(q["r"]).netloc,
                "signed_in_as": me.user.get("email") if me.user.get("email") is not None else me.user.get("name"),
                "expires_at": js_time(datetime.fromtimestamp(q["e"] / 1000, UTC)),
            }
        )

    @app.post("/mcp/agents/consent", include_in_schema=False)
    async def consent_post(request: Request) -> Response:
        """The person's answer."""
        m = await _json_body(request)
        return await anyio.to_thread.run_sync(_consent, request, m if isinstance(m, dict) else {})

    def _consent(request: Request, m: dict[str, Any]) -> Response:
        me = person(request)
        if not me:
            return _nope()
        if not me.subject:
            return _not_here(me)
        q = consent_of(m.get("request"), me.user, me.subject, resource_of(request))
        scope = m.get("scope")
        redirect = decide(q, m.get("allow") is True, scope, origin_of(request)) if q and scope in ("read", "act") else None
        if not redirect or not q:
            return _bad("expired", "This request has expired or was already answered. Start again from your agent.")
        client = client_of(q["cl"])
        log.info(
            "agent consent given" if m.get("allow") is True else "agent consent refused",
            user=me.user["id"],
            client=client["n"] if client else None,
            scope=scope,
        )
        return JSONResponse({"redirect": redirect})

    def _approval(approval: str, me: Person) -> dict[str, Any] | None:
        with pool.connection() as conn:
            return conn.execute(
                "SELECT a.id::text AS id, a.tool, a.args, a.status, a.expires_at, g.client_name"
                " FROM mcp_approvals a JOIN mcp_grants g ON g.id = a.grant_id"
                " WHERE a.id = %s AND g.subject_iss = %s AND g.subject_id = %s AND g.revoked_at IS NULL",
                (approval, *_mine(me)),
            ).fetchone()

    @app.get("/mcp/agents/approvals/{approval}", include_in_schema=False)
    def approval_get(request: Request, approval: str) -> Response:
        """An agent's destructive call, waiting for its person (AMCP-5)."""
        me = person(request)
        if not me:
            return _nope()
        a = _approval(approval, me) if _UUID.match(approval) else None
        if not a:
            return _bad("not_found", "No such request.", 404)
        tool = next((t for t in catalog(app)["tools"] if t["name"] == a["tool"]), None)
        status = "expired" if a["expires_at"] < datetime.now(UTC) and a["status"] == "pending" else a["status"]
        return JSONResponse(
            {
                "id": a["id"],
                "client": a["client_name"],
                "tool": a["tool"],
                "summary": tool["summary"] if tool else a["tool"],
                "route": f"{tool['method']} {tool['path']}" if tool else None,
                "args": a["args"],
                "status": status,
                "expires_at": js_time(a["expires_at"]),
            }
        )

    @app.post("/mcp/agents/approvals/{approval}", include_in_schema=False)
    async def approval_post(request: Request, approval: str) -> Response:
        m = await _json_body(request)
        return await anyio.to_thread.run_sync(_decide_approval, request, approval, m if isinstance(m, dict) else {})

    def _decide_approval(request: Request, approval: str, m: dict[str, Any]) -> Response:
        me = person(request)
        if not me:
            return _nope()
        approve = m.get("approve")
        if not isinstance(approve, bool) or not _UUID.match(approval):
            return _bad("bad_request", "Approve or deny.")
        with pool.connection() as conn:
            row = conn.execute(
                "UPDATE mcp_approvals a SET status = %s FROM mcp_grants g WHERE a.id = %s AND g.id = a.grant_id"
                " AND g.subject_iss = %s AND g.subject_id = %s"
                " AND g.revoked_at IS NULL AND a.status = 'pending' AND a.expires_at > now() RETURNING a.tool",
                ("approved" if approve else "denied", approval, *_mine(me)),
            ).fetchone()
        if not row:
            return _bad("expired", "This request was already answered, or has expired.")
        log.info("agent call approved" if approve else "agent call denied", user=me.user["id"], tool=row["tool"])
        return JSONResponse({"status": "approved" if approve else "denied"})

    @app.post("/mcp/agents/point", include_in_schema=False)
    async def point(request: Request) -> Response:
        """Point (AMCP-8): what the person clicked, for their agent. Labels only; a value is refused."""
        m = await _json_body(request)
        return await anyio.to_thread.run_sync(_point, request, m)

    def _point(request: Request, m: Any) -> Response:
        me = person(request)
        if not me:
            return _nope()
        if not me.subject:
            return _not_here(me)
        ok = (
            isinstance(m, dict)
            and set(m) == {"route", "selector", "label"}
            and all(isinstance(m[k], str) for k in m)
            and len(m["route"]) <= 300
            and m["route"].startswith("/")
            and len(m["selector"]) <= 500
            and len(m["label"]) <= 200
        )
        if not ok:
            return _bad("bad_request", "A pick is a route, a selector and a label: never a value.")
        pick = {"route": m["route"], "selector": m["selector"], "label": m["label"]}
        with pool.connection() as conn:
            conn.execute(
                "INSERT INTO mcp_points (subject_iss, subject_id, pick, at) VALUES (%s, %s, %s, now())"
                " ON CONFLICT (subject_iss, subject_id) DO UPDATE SET pick = EXCLUDED.pick, at = now()",
                (me.subject.iss, me.subject.id, Jsonb(pick)),
            )
        return JSONResponse({"ok": True})
