"""STO-3/11: signing routes authorize the person before any storage operation."""

import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_URL", "postgresql://test@127.0.0.1:1/test")
os.environ.setdefault("AGC_AUTH_URL", "https://auth.invalid")
os.environ.setdefault("AGC_AUTH_TOKEN", "synthetic-auth")

from app import main  # noqa: E402

client = TestClient(main.app)


def test_sto_3_11_signed_out_never_signs(monkeypatch: pytest.MonkeyPatch) -> None:
    def signed_out(_: object) -> None:
        raise HTTPException(401, "Sign in first.")

    def must_not_sign(_: str) -> None:
        pytest.fail("The route reached storage before authorization.")

    monkeypatch.setattr(main, "signed_in", signed_out)
    monkeypatch.setattr(main, "signUpload", must_not_sign)
    monkeypatch.setattr(main, "signDownload", must_not_sign)
    assert client.post("/api/uploads", json={"name": "a.txt"}).status_code == 401
    assert client.get("/api/uploads/download?key=other/a.txt").status_code == 401


def test_sto_3_11_owner_check_schema_and_person_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "signed_in", lambda _: {"id": "person"})

    def must_not_sign(_: str) -> None:
        pytest.fail("Another person's key reached storage.")

    monkeypatch.setattr(main, "signDownload", must_not_sign)
    statements: list[tuple[str, object]] = []

    class Connection:
        def execute(self, sql: str, values: object) -> "Connection":
            statements.append((sql, values))
            return self

        def fetchone(self) -> None:
            return None

    @contextmanager
    def connection() -> Iterator[Any]:
        yield Connection()

    monkeypatch.setattr(main.pool, "connection", connection)
    assert client.get("/api/uploads/download?key=other/a.txt").status_code == 404
    for body in ({}, {"name": 42}, {"name": "../a.txt"}):
        assert client.post("/api/uploads", json=body).status_code == 400
    for name, value in {
        "AGC_STORAGE_ENDPOINT": "https://storage.googleapis.com",
        "AGC_STORAGE_REGION": "auto",
        "AGC_STORAGE_BUCKET": "own-bucket",
        "AGC_STORAGE_PREFIX": "mirror/",
        "AGC_STORAGE_MAX_OBJECT_MB": "25",
        "AGC_STORAGE_ACCESS_KEY_ID": "synthetic-hmac",
        "AGC_STORAGE_SECRET_ACCESS_KEY": "synthetic-secret",
    }.items():
        monkeypatch.setenv(name, value)
    response = client.post("/api/uploads", json={"name": "a.txt"})
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    post = response.json()
    assert post["key"].startswith("person/")
    assert post["fields"]["key"] == "mirror/" + post["key"]
    assert any(sql.startswith("INSERT INTO uploads") and values == ("person", post["key"]) for sql, values in statements)
    assert any("FROM uploads" in sql and "user_id = %s" in sql and values == ("other/a.txt", "person") for sql, values in statements)
