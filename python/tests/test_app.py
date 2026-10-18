"""The parts of the app that need no database: the platform's rules about health, JSON bodies and the API's 404s.
The whole app, with a database and agent.cloud's sign-in, is tested by the starters' conformance suite and by the
checks in agentcloud.toml."""

import os

os.environ.setdefault("DATABASE_URL", "postgresql://test@localhost/test")
os.environ.setdefault("AGC_AUTH_URL", "http://auth.invalid")
os.environ.setdefault("AGC_AUTH_TOKEN", "agca_test")

from fastapi.testclient import TestClient  # noqa: E402

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
