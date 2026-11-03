"""Sign-in through agent.cloud: Google or an email link, no passwords (AGENTS.md "Sign-in").
  GET  /auth/sign-in    a fresh state (and ?return_to, a path here) in short cookies, then off to $AGC_AUTH_URL/authorize
  GET  /auth/callback   check state FIRST, then trade the code (once, within a minute) for the person, and go back
  POST /auth/sign-out   end this session
Sessions are rows in the database (only a hash of the token is stored) and last a day. Each is rechecked with agent.cloud
at most once every 5 minutes (SPEC.md AUTH-8)."""

import hashlib
import os
import re
import secrets
from concurrent.futures import Future
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse, Response

from . import log
from .db import pool
from .env import ON_MIRROR, required

_env = required("AGC_AUTH_URL", "AGC_AUTH_TOKEN")
AUTH_URL, AUTH_TOKEN = _env["AGC_AUTH_URL"], _env["AGC_AUTH_TOKEN"]
# __Host- cookies outside a mirror: apps share the agent.cloud site, and only this app's own host can set one, so a
# neighbour app can't plant a session or a sign-in state here. On a mirror (plain http) the prefix isn't allowed.
STATE = "auth_state" if ON_MIRROR else "__Host-auth_state"
SESSION = "session" if ON_MIRROR else "__Host-session"
RETURN = "auth_return" if ON_MIRROR else "__Host-auth_return"
DAY = 86_400

router = APIRouter()


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _local(path: str | None) -> str:
    """AUTH-1: where to land after signing in: a path on this app only, never another site. `//evil.test` is a host, and
    a browser drops tabs and newlines from a URL, so `/<tab>/evil.test` is one too: refuse control characters and
    backslashes outright."""
    if not path or not re.match(r"/(?!/)", path) or re.search(r"[\x00-\x1f\x7f\\]", path):
        return "/"
    return path


def _cookie(response: Response, name: str, value: str, max_age: int) -> None:
    response.set_cookie(name, value, max_age=max_age, httponly=True, samesite="lax", secure=not ON_MIRROR, path="/")


# AUTH-5: on a target with its own sign-in ([auth] provider = "edge"), the target's gate signs people in before a request
# reaches this app and says who it is in two headers; the app trusts them (its pods are reachable only through the gate)
# and keeps no session of its own. A user's id is fixed by their email. AGC_EDGE_DEV_USER stands in on mirrors and in
# rehearsals, where no gate runs; production never has it.
EDGE = os.environ.get("AGC_AUTH_PROVIDER") == "edge"
DEV_USER = os.environ.get("AGC_EDGE_DEV_USER", "")


def _id_of(email: str) -> str:
    h = hashlib.sha256(f"agc-edge:{email}".encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-5{h[13:16]}-8{h[17:20]}-{h[20:32]}"


def _edge_user(request: Request) -> dict[str, Any] | None:
    email = (request.headers.get("x-agc-user-email") or DEV_USER).strip().lower()
    if not email:
        return None
    name = (request.headers.get("x-agc-user-name") or "").strip() or None
    user_id = _id_of(email)
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO users (id, email, name) VALUES (%s, %s, %s)"
            " ON CONFLICT (id) DO UPDATE SET name = coalesce(EXCLUDED.name, users.name), last_seen_at = now()",
            (user_id, email, name),
        )
    return {"id": user_id, "email": email, "name": name}


# AUTH-8: is this session still let in? Asked of agent.cloud at most once every 5 minutes per session, with when the
# session began (x-agc-session-start), so agent.cloud judges this session and not just the person: one from before a
# cutoff stays refused even after they sign in again. Only a 404 ends it. A timeout, a 5xx or a network error keeps it,
# since an outage of agent.cloud must never sign everyone out; the attempt still counts, so it's asked again in 5 minutes.
# The session row says when it was last asked about (checked_at; never, for a new one, counts as when it began), and one
# conditional update claims each recheck, so two requests or two processes never ask twice. A request that comes while
# this process is asking waits for the same answer.
_asking: dict[str, Future[bool]] = {}  # session token hash -> the recheck under way


def _recheck(key: str, user_id: str, started: float) -> bool:
    with pool.connection() as conn:
        claim = conn.execute(
            "UPDATE sessions SET checked_at = CASE WHEN coalesce(checked_at, expires_at - interval '1 day')"
            " <= now() - interval '5 minutes' THEN now() ELSE checked_at END"
            " WHERE token_hash = %s RETURNING checked_at = now() AS claimed",
            (key,),
        ).fetchone()
    if not claim:
        return False  # another request's recheck ended it meanwhile
    if not claim["claimed"]:
        return True  # another process just asked
    try:
        r = httpx.get(
            f"{AUTH_URL}/users/{user_id}",
            headers={"authorization": f"Bearer {AUTH_TOKEN}", "x-agc-session-start": str(int(started * 1000))},
            timeout=5,
        )
    except httpx.HTTPError as e:
        log.warn("session recheck unanswered, keeping the session", user=user_id, error=type(e).__name__)
        return True
    if r.status_code == 404:  # ended before anyone waiting hears it, so no request after this one finds the session
        with pool.connection() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = %s", (key,))
        log.info("session ended: agent.cloud no longer lets this person in", user=user_id)
        return False
    if not r.is_success:
        log.warn("session recheck unanswered, keeping the session", user=user_id, status=r.status_code)
    return True


def _still_let_in(key: str, user_id: str, started: float) -> bool:
    mine: Future[bool] = Future()
    pending = _asking.setdefault(key, mine)
    if pending is not mine:
        return pending.result()
    try:
        verdict = _recheck(key, user_id, started)
        mine.set_result(verdict)
        return verdict
    except BaseException as e:
        mine.set_exception(e)
        raise
    finally:
        _asking.pop(key, None)


def current_user(request: Request) -> dict[str, Any] | None:
    if EDGE:
        return _edge_user(request)
    token = request.cookies.get(SESSION)
    if not token:
        return None
    key = _hash(token)
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT u.id::text AS id, u.email, u.name, s.expires_at,"
            " coalesce(s.checked_at, s.expires_at - interval '1 day') <= now() - interval '5 minutes' AS due"
            " FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = %s AND s.expires_at > now()",
            (key,),
        ).fetchone()
    if not row:
        return None
    due, started = row.pop("due"), row.pop("expires_at").timestamp() - DAY  # a session began a day before it expires
    if (due or key in _asking) and not _still_let_in(key, row["id"], started):
        return None
    return row


def signed_in(request: Request) -> dict[str, Any]:
    user = current_user(request)
    if not user:
        raise HTTPException(401, "Sign in first.")
    return user


@router.get("/auth/sign-in")
def sign_in(return_to: str = "") -> Response:
    if EDGE:
        return RedirectResponse("/", status_code=302)  # AUTH-5: the target's gate already signed them in
    state = secrets.token_urlsafe(24)
    response = RedirectResponse(f"{AUTH_URL}/authorize?state={state}", status_code=302)
    _cookie(response, STATE, state, 600)
    _cookie(response, RETURN, _local(return_to), 600)
    return response


@router.get("/auth/callback")
def callback(request: Request, code: str = "", state: str = "") -> Response:
    # State first: it's what stops someone else's code from signing this person in to the wrong account.
    expected = request.cookies.get(STATE, "")
    back = _local(request.cookies.get(RETURN))
    # Bytes, not str: compare_digest refuses non-ASCII strings, and a crafted state would otherwise be a 500.
    if not expected or not secrets.compare_digest(state.encode(), expected.encode()):
        response: Response = PlainTextResponse("Sign-in expired. Try again.", status_code=400)
        response.delete_cookie(STATE, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
        response.delete_cookie(RETURN, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
        return response
    r = httpx.post(f"{AUTH_URL}/token", json={"code": code}, headers={"authorization": f"Bearer {AUTH_TOKEN}"}, timeout=10)
    if r.status_code != 200:
        log.warn("sign-in code refused", status=r.status_code)
        return PlainTextResponse("Sign-in failed. Try again.", status_code=400)
    user = r.json()["user"]
    token = secrets.token_urlsafe(32)
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO users (id, email, name) VALUES (%s, %s, %s) ON CONFLICT (id) DO UPDATE"
            " SET email = coalesce(EXCLUDED.email, users.email), name = coalesce(EXCLUDED.name, users.name), last_seen_at = now()",
            (user["id"], user.get("email"), user.get("name")),
        )
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, now() + interval '1 day')",
            (_hash(token), user["id"]),
        )
    log.info("signed in", user=user["id"])
    response = RedirectResponse(back, status_code=302)
    response.delete_cookie(STATE, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
    response.delete_cookie(RETURN, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
    _cookie(response, SESSION, token, DAY)
    return response


@router.post("/auth/sign-out")
def sign_out(request: Request) -> Response:
    if EDGE:
        return JSONResponse({"ok": True})  # AUTH-5: signing out is the target's sign-in's, not this app's
    token = request.cookies.get(SESSION)
    if token:
        with pool.connection() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = %s", (_hash(token),))
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION, path="/", secure=not ON_MIRROR, httponly=True, samesite="lax")
    return response
