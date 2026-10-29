"""The parts of the app that need no database: the platform's rules about health, JSON bodies and the API's 404s.
The whole app, with a database and agent.cloud's sign-in, is tested by the starters' conformance suite and by the
checks in agentcloud.toml."""

import asyncio
import os
import re
import socket
import time
import tomllib
from collections.abc import Iterator
from contextlib import contextmanager
from http.cookies import SimpleCookie
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://test@localhost/test")
os.environ.setdefault("AGC_AUTH_URL", "http://auth.invalid")
os.environ.setdefault("AGC_AUTH_TOKEN", "agca_test")

from fastapi.testclient import TestClient  # noqa: E402

from app import auth, welcome  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def test_health_answers_without_the_database() -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
    assert r.headers["x-content-type-options"] == "nosniff"


def test_changes_need_a_json_body() -> None:
    r = client.post("/api/notes", content="title=x", headers={"content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 415


def test_unknown_api_paths_answer_json_404() -> None:
    r = client.get("/api/no-such-route")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/json")


def test_signed_out_is_401() -> None:
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/notes").status_code == 401


def test_sign_in_starts_at_agent_cloud_with_a_state_cookie() -> None:
    r = client.get("/auth/sign-in", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].startswith("http://auth.invalid/authorize?state=")
    assert r.headers["set-cookie"].startswith("__Host-auth_state=")
    assert "httponly" in r.headers["set-cookie"].lower()


def test_a_callback_with_the_wrong_state_is_refused_before_any_trade() -> None:
    client.cookies.set("__Host-auth_state", "expected-state-value")
    r = client.get("/auth/callback?code=c&state=another-state-value", follow_redirects=False)
    assert r.status_code == 400


def test_a_body_that_does_not_fit_answers_400_in_the_error_shape() -> None:
    for body in ('{"title": "Broken', '{"title": 42}', "{}", '{"title": "   "}', '{"title": "' + "x" * 201 + '"}', "[]"):
        r = client.post("/api/notes", content=body, headers={"content-type": "application/json"})
        assert r.status_code == 400, body
        assert set(r.json()) == {"error"} and set(r.json()["error"]) == {"code", "message"}, r.text


# The welcome page's facts (SPEC.md APP-8 to APP-10) and sign-in's way back (AUTH-1).

RUN_VARS = ("AGENTCLOUD_MIRROR", "AGC_RUN", "AGC_PREVIEW_EXPIRES_AT", "AGENTCLOUD_RELEASED", "AGENTCLOUD_APP_URL")
PAIRS = ("AGC_AUTH_URL", "AGC_AUTH_TOKEN", "AGC_EMAIL_URL", "AGC_EMAIL_TOKEN")


@pytest.fixture
def fresh(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """No cached probe, no run variables from the shell, and a database nothing listens on (port 1 refuses at once)."""
    monkeypatch.setattr(welcome, "_last", None)
    monkeypatch.setattr(welcome, "DATABASE_URL", "postgresql://test@127.0.0.1:1/test")
    for name in RUN_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_app_8_welcome_has_exactly_the_fields_and_no_secret(fresh: pytest.MonkeyPatch) -> None:
    sentinel = "sentinel-" + "x9q" * 4
    manifest = {**welcome._manifest, "service": {**welcome._manifest["service"], "worker": {"command": f"run {sentinel}"}}}
    fresh.setattr(welcome, "_manifest", manifest)
    fresh.setenv("SOME_SECRET", sentinel)
    fresh.setenv("AGC_AUTH_URL", f"https://{sentinel}.test")
    r = client.get("/api/welcome")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"app", "stack", "run", "started", "parts", "database", "checks", "preview_expires_at", "production"}
    assert set(body["parts"]) == {"web", "api", "database", "worker", "signin", "email"}
    with open("agentcloud.toml", "rb") as f:
        assert body["app"] == tomllib.load(f)["app"]["name"]
    assert body["stack"] == "python" and body["checks"] == {"smoke": 1, "invariants": 1}
    assert body["parts"]["worker"] == "configured"
    assert sentinel not in r.text


@pytest.mark.parametrize(
    ("app", "started"),
    [
        ({"name": "folio", "started": "live"}, "live"),
        ({"name": "folio"}, None),
        ({"name": "folio", "started": "sentinel-started-x9q"}, None),  # any other value is null, never echoed
        ({"name": "folio", "started": True}, None),
    ],
)
def test_app_8_app_14_started_is_live_or_null(fresh: pytest.MonkeyPatch, app: dict[str, Any], started: str | None) -> None:
    fresh.setattr(welcome, "_manifest", {"app": app})
    r = client.get("/api/welcome")
    assert r.json()["started"] == started
    assert "sentinel-started" not in r.text


def test_app_8_app_is_the_manifests_name_not_a_literal(fresh: pytest.MonkeyPatch) -> None:
    fresh.setattr(welcome, "_manifest", {"app": {"name": "folio"}})
    body = client.get("/api/welcome").json()
    assert body["app"] == "folio"
    assert body["parts"]["worker"] == "not set up" and body["checks"] == {"smoke": 0, "invariants": 0}


@pytest.mark.parametrize(
    ("env", "run"),
    [
        ({"AGENTCLOUD_MIRROR": "1"}, "mirror"),
        ({"AGENTCLOUD_MIRROR": "1", "AGC_RUN": "live"}, "mirror"),  # a mirror is a mirror, whatever its shell carries
        ({"AGC_RUN": "live"}, "live"),
        ({"AGC_RUN": "rehearsal"}, "rehearsal"),
        ({"AGC_PREVIEW_EXPIRES_AT": "2026-10-21T04:00:00Z"}, "preview"),
        ({}, "unknown"),
    ],
)
def test_app_9_run_first_match_wins(fresh: pytest.MonkeyPatch, env: dict[str, str], run: str) -> None:
    for name, value in env.items():
        fresh.setenv(name, value)
    body = client.get("/api/welcome").json()
    assert body["run"] == run
    if run == "preview":
        assert body["preview_expires_at"] == "2026-10-21T04:00:00.000Z"
    else:
        assert body["preview_expires_at"] is None


def test_app_8_preview_expiry_is_null_unless_it_parses() -> None:
    assert welcome._expires("2026-10-21T06:00:00+02:00") == "2026-10-21T04:00:00.000Z"
    assert welcome._expires("next tuesday") is None
    assert welcome._expires(None) is None


@pytest.mark.parametrize(
    ("released", "url", "production"),
    [
        ("", "https://folio.agent.cloud", {"url": "https://folio.agent.cloud", "version": None}),
        ("3", "https://folio.agent.cloud", {"url": "https://folio.agent.cloud", "version": 3}),
        (None, "https://folio.agent.cloud", None),
        ("03", "https://folio.agent.cloud", None),
        ("3", "http://folio.agent.cloud", None),
        ("3", "https://folio.agent.cloud/", None),
        ("3", "https://user@folio.agent.cloud", None),
    ],
)
def test_app_9_production_on_a_mirror(fresh: pytest.MonkeyPatch, released: str | None, url: str, production: object) -> None:
    fresh.setenv("AGENTCLOUD_MIRROR", "1")
    fresh.setenv("AGENTCLOUD_APP_URL", url)
    if released is not None:
        fresh.setenv("AGENTCLOUD_RELEASED", released)
    assert client.get("/api/welcome").json()["production"] == production


def test_app_9_production_is_null_off_a_mirror(fresh: pytest.MonkeyPatch) -> None:
    fresh.setenv("AGENTCLOUD_RELEASED", "3")
    fresh.setenv("AGENTCLOUD_APP_URL", "https://folio.agent.cloud")
    assert client.get("/api/welcome").json()["production"] is None


@pytest.mark.parametrize("prefix", ["AGC_AUTH", "AGC_EMAIL"])
def test_app_10_signin_and_email_need_both_of_their_pair(fresh: pytest.MonkeyPatch, prefix: str) -> None:
    part = "signin" if prefix == "AGC_AUTH" else "email"
    for set_, unset in ((f"{prefix}_URL", f"{prefix}_TOKEN"), (f"{prefix}_TOKEN", f"{prefix}_URL")):
        fresh.setenv(set_, "set")
        fresh.delenv(unset, raising=False)
        assert client.get("/api/welcome").json()["parts"][part] == "not set up", set_
    fresh.setenv(f"{prefix}_URL", "set")
    fresh.setenv(f"{prefix}_TOKEN", "set")
    assert client.get("/api/welcome").json()["parts"][part] == "configured"


def test_app_10_database_unreachable_is_not_verified_and_still_200(fresh: pytest.MonkeyPatch) -> None:
    r = client.get("/api/welcome")
    assert r.status_code == 200
    assert r.json()["parts"]["database"] == "not verified"
    db = r.json()["database"]
    assert db["migrations"] is None and db["reason"] == "unreachable"
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", db["checked_at"])
    assert client.get("/api/welcome").json()["database"] == db  # reused within 60 s: the same checked_at


def test_app_10_a_database_that_never_answers_times_out_in_2_s(fresh: pytest.MonkeyPatch) -> None:
    with socket.socket() as silent:  # accepts the connection, then says nothing
        silent.bind(("127.0.0.1", 0))
        silent.listen()
        fresh.setattr(welcome, "DATABASE_URL", f"postgresql://test@127.0.0.1:{silent.getsockname()[1]}/test?sslmode=disable")
        started = time.monotonic()
        r = client.get("/api/welcome")
        assert r.status_code == 200 and r.json()["database"]["reason"] == "timeout"
        assert time.monotonic() - started < 3
    assert client.get("/api/health").status_code == 200  # PROC-3: health never touches the database


def test_app_10_one_probe_shared_and_kept_for_60_s(fresh: pytest.MonkeyPatch) -> None:
    probes = 0
    now = [1000.0]

    async def probe() -> dict[str, object]:
        nonlocal probes
        probes += 1
        await asyncio.sleep(0.05)
        return {"state": "running", "migrations": 4, "checked_at": f"probe {probes}"}

    fresh.setattr(welcome, "_probe", probe)
    fresh.setattr(welcome, "_clock", lambda: now[0])

    async def calls(n: int) -> list[dict[str, object]]:
        return await asyncio.gather(*(welcome.database() for _ in range(n)))

    assert {r["checked_at"] for r in asyncio.run(calls(50))} == {"probe 1"} and probes == 1  # single-flight
    now[0] += 59
    assert asyncio.run(calls(1))[0]["checked_at"] == "probe 1" and probes == 1  # cached
    now[0] += 2
    assert asyncio.run(calls(1))[0]["checked_at"] == "probe 2" and probes == 2  # 60 s on, a new probe
    body = client.get("/api/welcome").json()
    assert body["parts"]["database"] == "running" and body["database"] == {"migrations": 4, "checked_at": "probe 2"}


def _set_cookies(r: httpx.Response) -> SimpleCookie:
    jar = SimpleCookie()
    for header in r.headers.get_list("set-cookie"):
        jar.load(header)
    return jar


@pytest.mark.parametrize(
    ("return_to", "kept"),
    [
        ("/notes", "/notes"),
        ("//evil.test", "/"),
        ("/\\evil.test", "/"),
        ("/\t/evil.test", "/"),
        ("/\n/evil.test", "/"),
        ("https://evil.test/notes", "/"),
        ("", "/"),
    ],
)
def test_auth_1_sign_in_keeps_only_a_path_on_this_app(return_to: str, kept: str) -> None:
    r = TestClient(app).get("/auth/sign-in", params={"return_to": return_to} if return_to else None, follow_redirects=False)
    assert r.status_code == 302
    cookie = _set_cookies(r)["__Host-auth_return"]
    assert cookie.value == kept and cookie["max-age"] == "600" and cookie["httponly"] and cookie["path"] == "/"


@pytest.mark.parametrize(("planted", "lands"), [("/notes", "/notes"), ("//evil.test", "/"), ("https://evil.test", "/")])
def test_auth_1_callback_goes_back_to_the_kept_path(monkeypatch: pytest.MonkeyPatch, planted: str, lands: str) -> None:
    class Conn:
        def execute(self, *_: object) -> None:
            return None

    @contextmanager
    def connection() -> Iterator[Conn]:
        yield Conn()

    monkeypatch.setattr(auth, "pool", SimpleNamespace(connection=connection))
    trade = SimpleNamespace(status_code=200, json=lambda: {"user": {"id": "u1"}})
    monkeypatch.setattr(auth, "httpx", SimpleNamespace(post=lambda *_, **__: trade))
    c = TestClient(app)
    c.cookies.set("__Host-auth_state", "the-state")
    c.cookies.set("__Host-auth_return", planted)
    r = c.get("/auth/callback?code=c&state=the-state", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == lands
    assert _set_cookies(r)["__Host-auth_return"]["max-age"] == "0"  # deleted with the state
