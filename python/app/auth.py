"""Sign-in through agent.cloud: Google or an email link, no passwords (AGENTS.md "Sign-in").
  GET  /auth/sign-in    a fresh state (and ?return_to, a path here) in short cookies, then off to $AGC_AUTH_URL/authorize
  GET  /auth/callback   check state FIRST, then trade the code (once, within a minute) for the person, and go back
  POST /auth/sign-out   end this session
Sessions are rows in the database (only a hash of the token is stored) and last a day."""

import hashlib
import os
import re
import secrets
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
    """AUTH-1: where to land after signing in: a path on this app only, never another site (`//evil.test` is a host)."""
    return path if path and re.match(r"/(?![/\\])", path) else "/"


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


def current_user(request: Request) -> dict[str, Any] | None:
    if EDGE:
        return _edge_user(request)
    token = request.cookies.get(SESSION)
    if not token:
        return None
    with pool.connection() as conn:
        return conn.execute(
            "SELECT u.id::text AS id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash = %s AND s.expires_at > now()",
            (_hash(token),),
        ).fetchone()


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
