"""GET /api/welcome: what the welcome page shows (SPEC.md APP-8 to APP-10). Every claim is one the process can back:
where it runs comes from what agent.cloud sets, "running" only for what was just checked, and nothing else from the
manifest or the environment leaves the process. Remove this file, and its route in main.py, with the welcome page."""

import asyncio
import re
import time
import tomllib
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import psycopg

from .db import DATABASE_URL

# The manifest, read once at start: the app's name, whether it was started from Start, whether it has a worker, and how
# many checks it runs.
_manifest: dict[str, Any] = tomllib.loads(Path("agentcloud.toml").read_text())


def run_of(env: Mapping[str, str]) -> str:
    """APP-9: where this process runs, first match wins. AGENTCLOUD_MIRROR is agc's; agent.cloud reserves the name, so
    no release carries it. AGC_RUN is set by agent.cloud after the app's own env, so an app can't claim to be live."""
    if env.get("AGENTCLOUD_MIRROR"):
        return "mirror"
    if env.get("AGC_RUN") == "live":
        return "live"
    if env.get("AGC_RUN") == "rehearsal":
        return "rehearsal"
    if env.get("AGC_PREVIEW_EXPIRES_AT"):
        return "preview"
    return "unknown"


def _origin(raw: str) -> str | None:
    """The https origin raw names, only when raw is exactly that origin (no path, user, query or default port)."""
    try:
        url = urlsplit(raw)
        port = url.port
    except ValueError:
        return None
    if url.scheme != "https" or not url.hostname or url.username is not None or not raw.isascii():
        return None
    host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
    origin = f"https://{host}" + (f":{port}" if port not in (None, 443) else "")
    return origin if origin == raw else None


def production_of(env: Mapping[str, str]) -> dict[str, Any] | None:
    """APP-8: what agc said about production when this mirror started (MREL), or None: unknown, so the page claims nothing."""
    released, url = env.get("AGENTCLOUD_RELEASED"), env.get("AGENTCLOUD_APP_URL")
    if not env.get("AGENTCLOUD_MIRROR") or released is None or not url:
        return None
    origin = _origin(url)
    if origin is None:
        return None
    if released == "":
        return {"url": origin, "version": None}
    return {"url": origin, "version": int(released)} if re.fullmatch(r"[1-9]\d*", released) else None


def _iso(when: datetime) -> str:
    """ISO 8601 UTC with milliseconds and a Z, as JavaScript's toISOString writes it."""
    return when.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _expires(raw: str | None) -> str | None:
    # A timestamp with no offset is taken as UTC: agent.cloud always sends one with a Z.
    try:
        when = datetime.fromisoformat(raw or "")
        return _iso(when if when.tzinfo else when.replace(tzinfo=UTC))
    except (ValueError, OverflowError):
        return None


# APP-10: the database check. Its own connection, one probe at a time shared by every caller, and each result kept for
# 60 s, so a public page fetched by anyone wakes the database at most once a minute. /api/health never gets here.
_clock = time.monotonic
_last: tuple[float, dict[str, Any]] | None = None
_running: asyncio.Task[dict[str, Any]] | None = None
_SQLSTATE = re.compile(r"[0-9A-Z]{5}")


async def _probe() -> dict[str, Any]:
    def checked() -> str:
        return _iso(datetime.now(UTC))

    try:
        # 2 s for connecting and the query together; on timeout the connection is cancelled and closed.
        async with asyncio.timeout(2):
            async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True) as conn:
                row = await (await conn.execute("SELECT count(*) FROM agentcloud_migrations")).fetchone()
        assert row is not None
        return {"state": "running", "migrations": int(row[0]), "checked_at": checked()}
    except TimeoutError:
        return {"state": "not verified", "reason": "timeout", "checked_at": checked()}
    except Exception as e:  # noqa: BLE001 - every failure is a "not verified", never an error page
        # Postgres answered with an error (no ledger yet, say): the database is there, the check failed. Otherwise no connection.
        answered = isinstance(e, psycopg.Error) and bool(e.sqlstate and _SQLSTATE.fullmatch(e.sqlstate))
        slow = "timeout" in str(e).lower()
        reason = "query_failed" if answered else "timeout" if slow else "unreachable"
        return {"state": "not verified", "reason": reason, "checked_at": checked()}


async def _probe_and_keep() -> dict[str, Any]:
    global _last, _running
    try:
        result = await _probe()
        _last = (_clock(), result)
        return result
    finally:
        _running = None


async def database() -> dict[str, Any]:
    global _running
    if _last and _clock() - _last[0] < 60:
        return _last[1]
    if _running is None:
        _running = asyncio.create_task(_probe_and_keep())
    # Shielded: a caller that goes away doesn't cancel the probe the others are waiting on.
    return await asyncio.shield(_running)


def _pair(url: str | None, token: str | None) -> str:
    return "configured" if url and token else "not set up"


async def welcome(env: Mapping[str, str]) -> dict[str, Any]:
    db = await database()
    check = _manifest.get("check", {})
    name = _manifest.get("app", {}).get("name")
    return {
        "app": "" if name is None else str(name),
        "stack": "python",
        "run": run_of(env),
        # APP-8, APP-14: "live" only when agc init wrote exactly that (an app made through Start); never any other value.
        "started": "live" if _manifest.get("app", {}).get("started") == "live" else None,
        "parts": {
            "web": "running",
            "api": "running",
            "database": db["state"],
            "worker": "configured" if "worker" in _manifest.get("service", {}) else "not set up",
            "signin": _pair(env.get("AGC_AUTH_URL"), env.get("AGC_AUTH_TOKEN")),
            "email": _pair(env.get("AGC_EMAIL_URL"), env.get("AGC_EMAIL_TOKEN")),
        },
        "database": {"migrations": db["migrations"], "checked_at": db["checked_at"]}
        if db["state"] == "running"
        else {"migrations": None, "reason": db["reason"], "checked_at": db["checked_at"]},
        "checks": {"smoke": len(check.get("smoke", [])), "invariants": len(check.get("invariant", []))},
        "preview_expires_at": _expires(env.get("AGC_PREVIEW_EXPIRES_AT")),
        "production": production_of(env),
    }
