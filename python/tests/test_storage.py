"""STO-2/3/6/11/12/15: real SDK signatures and synthetic S3/container endpoints, never live cloud access."""

import base64
import hashlib
import hmac
import json
import os
import threading
from collections.abc import Iterator
from contextlib import closing
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
from botocore.config import Config
from botocore.exceptions import ClientError

from app.storage import StorageKeyError, StorageNotFoundError, signDownload, signUpload

SECRET = "synthetic-secret"  # noqa: S105 - synthetic signing fixture


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"status": 200, "requests": [], "credentials": [], "short": False, "now": datetime.now(UTC)}

    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self) -> None:
            state["requests"].append(f"HEAD {self.path}")
            self.send_response(state["status"])
            self.end_headers()

        def do_GET(self) -> None:
            assert self.path == "/credentials", self.path
            state["credentials"].append(self.headers.get("Authorization"))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "AccessKeyId": "ASIAABCDEFGHIJKLMNOP",
                        "SecretAccessKey": SECRET,
                        "Token": f"token-{len(state['credentials'])}",
                        "Expiration": (state["now"] + timedelta(minutes=10 if state["short"] else 15)).isoformat(),
                    }
                ).encode()
            )

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    for name in list(os.environ):
        if name.startswith(("AGC_STORAGE_", "AWS_")):
            monkeypatch.delenv(name)
    for name, value in {
        "AGC_STORAGE_ENDPOINT": endpoint,
        "AGC_STORAGE_REGION": "auto",
        "AGC_STORAGE_BUCKET": "own-bucket",
        "AGC_STORAGE_PREFIX": "branch/task/",
        "AGC_STORAGE_MAX_OBJECT_MB": "25",
        "AGC_STORAGE_ACCESS_KEY_ID": "synthetic-hmac",
        "AGC_STORAGE_SECRET_ACCESS_KEY": SECRET,
        "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_SHARED_CREDENTIALS_FILE": str(tmp_path / "absent"),
        "AWS_CONFIG_FILE": str(tmp_path / "absent"),
    }.items():
        monkeypatch.setenv(name, value)
    state["endpoint"] = endpoint
    yield state
    server.shutdown()
    server.server_close()
    thread.join()


def _hmac(key: bytes, data: str) -> bytes:
    return hmac.new(key, data.encode(), hashlib.sha256).digest()


def _signing_key(credential: str) -> bytes:
    _, date, region, service, _ = credential.split("/")
    return _hmac(_hmac(_hmac(_hmac(("AWS4" + SECRET).encode(), date), region), service), "aws4_request")


def _verify_get(url: str) -> None:
    parsed = urlsplit(url)
    query = parse_qs(parsed.query)
    credential = query["X-Amz-Credential"][0]
    canonical_query = "&".join(sorted(p for p in parsed.query.split("&") if not p.startswith("X-Amz-Signature=")))
    canonical = f"GET\n{parsed.path}\n{canonical_query}\nhost:{parsed.netloc}\n\nhost\nUNSIGNED-PAYLOAD"
    scope = "/".join(credential.split("/")[1:])
    to_sign = f"AWS4-HMAC-SHA256\n{query['X-Amz-Date'][0]}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    assert query["X-Amz-Signature"][0] == _hmac(_signing_key(credential), to_sign).hex()
    assert query["X-Amz-Expires"] == ["300"]


def test_sto_3_11_12_exact_fresh_post_keys_size_cap_expiry_and_gcs_hmac(store: dict[str, Any]) -> None:
    start = datetime.now(UTC)
    post = signUpload("person/literal %2F+ café?#.txt")
    assert post["key"] != signUpload("person/literal %2F+ café?#.txt")["key"]
    assert post["url"] == store["endpoint"] + "/own-bucket"
    assert post["fields"]["key"] == "branch/task/" + post["key"]
    fields = {k.lower(): v for k, v in post["fields"].items()}
    assert fields["x-amz-signature"] == _hmac(_signing_key(fields["x-amz-credential"]), fields["policy"]).hex()
    fields = {k.lower(): v for k, v in post["fields"].items()}
    policy = json.loads(base64.b64decode(fields["policy"]))
    assert ["content-length-range", 0, 25 * 1_048_576] in policy["conditions"]
    assert {"key": post["fields"]["key"]} in policy["conditions"]
    assert {"bucket": "own-bucket"} in policy["conditions"]
    assert 599 <= (datetime.fromisoformat(policy["expiration"]) - start).total_seconds() <= 601
    assert fields["x-amz-signature"] == _hmac(_signing_key(fields["x-amz-credential"]), fields["policy"]).hex()
    assert "x-amz-security-token" not in fields


def test_sto_3_gateway_changes_only_endpoint_preserves_post_and_get_signatures(
    store: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    gateway = "https://files.example.test/__agc/storage/files/app/r/attempt"
    monkeypatch.setenv("AGC_STORAGE_GATEWAY_URL", gateway + "/")
    post = signUpload("person/a.txt")
    assert post["url"] == gateway + "/own-bucket"
    assert post["fields"]["key"] == "branch/task/" + post["key"]
    url = signDownload("person/literal %2F+ café?#.txt")
    assert url.startswith(gateway + "/own-bucket/branch/task/person/")
    _verify_get(store["endpoint"] + url[len(gateway) :])
    assert store["requests"] == ["HEAD /own-bucket/branch/task/person/literal%20%252F%2B%20caf%C3%A9%3F%23.txt"]
    monkeypatch.delenv("AGC_STORAGE_GATEWAY_URL")
    direct = signDownload("person/a.txt")
    assert direct.startswith(store["endpoint"] + "/own-bucket/")
    _verify_get(direct)


def test_sto_12_own_head_then_404_only_fallback_without_listing(store: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGC_STORAGE_FALLBACK_BUCKET", "production-bucket")
    monkeypatch.setenv("AGC_STORAGE_FALLBACK_PREFIX", "apps/app/p/")
    assert "/own-bucket/branch/task/person/a.txt?" in signDownload("person/a.txt")
    store["status"] = 404
    fallback = signDownload("person/a.txt")
    assert "/production-bucket/apps/app/p/person/a.txt?" in fallback
    _verify_get(fallback)
    assert store["requests"] == ["HEAD /own-bucket/branch/task/person/a.txt"] * 2
    monkeypatch.setenv("AGC_STORAGE_GATEWAY_URL", "https://files.example.test/route")
    routed = signDownload("person/a.txt")
    assert routed.startswith("https://files.example.test/route/production-bucket/apps/app/p/")
    _verify_get(store["endpoint"] + routed[len("https://files.example.test/route") :])
    monkeypatch.delenv("AGC_STORAGE_GATEWAY_URL")
    monkeypatch.delenv("AGC_STORAGE_FALLBACK_PREFIX")  # GCS production prefix is empty.
    assert "/production-bucket/person/a.txt?" in signDownload("person/a.txt")
    store["status"] = 403
    with pytest.raises(ClientError):
        signDownload("person/a.txt")
    monkeypatch.delenv("AGC_STORAGE_FALLBACK_BUCKET")
    store["status"] = 404
    with pytest.raises(StorageNotFoundError, match="This file isn't on this mirror"):
        signDownload("person/a.txt")


def test_sto_3_12_bad_keys_and_limits_fail_before_requests(store: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("", "/abs", "../outside", "a/../b", "a//b", "a\\b", "a/${filename}", "a\x00b", "é" * 513):
        with pytest.raises(StorageKeyError):
            signUpload(key)
        with pytest.raises(StorageKeyError):
            signDownload(key)
    for cap in ("0", "101", "NaN", "1.5"):
        monkeypatch.setenv("AGC_STORAGE_MAX_OBJECT_MB", cap)
        with pytest.raises(ValueError):
            signUpload("person/a.txt")
    assert store["requests"] == []


def test_sto_2_15_default_container_chain_rereads_token_and_refreshes_beyond_an_hour(
    store: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from botocore import credentials

    monkeypatch.delenv("AGC_STORAGE_ACCESS_KEY_ID")
    monkeypatch.delenv("AGC_STORAGE_SECRET_ACCESS_KEY")
    monkeypatch.setenv("AGC_STORAGE_REGION", "us-west-2")
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", store["endpoint"] + "/credentials")
    token = tmp_path / "token"
    token.write_text("projected-token-1")
    monkeypatch.setenv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", str(token))
    first = signUpload("person/a.txt")
    assert f"token-{len(store['credentials'])}" in first["fields"].values()
    assert set(store["credentials"]) == {"projected-token-1"}
    token.write_text("projected-token-2")
    store["now"] += timedelta(minutes=61)
    # Botocore captures its clock as a default argument. Advance the credential lifetime check, not just module time.
    monkeypatch.setattr(
        credentials.RefreshableCredentials, "_seconds_remaining", lambda self: (self._expiry_time - store["now"]).total_seconds()
    )
    later = signUpload("person/a.txt")
    assert f"token-{len(store['credentials'])}" in later["fields"].values()
    assert store["credentials"][-1] == "projected-token-2"
    # The app's separate backend S3 client still uses its own default provider and can refresh normally.
    with closing(
        boto3.Session().client(
            "s3", endpoint_url=store["endpoint"], region_name="us-west-2", config=Config(s3={"addressing_style": "path"})
        )
    ) as backend:
        backend.head_object(Bucket="own-bucket", Key="branch/task/backend")
        store["now"] += timedelta(minutes=61)
        token.write_text("projected-token-3")
        backend.head_object(Bucket="own-bucket", Key="branch/task/backend")
    assert store["credentials"][-1] == "projected-token-3"
    store["short"] = True
    with pytest.raises(RuntimeError, match="fewer than 11 minutes"):
        signUpload("person/a.txt")
