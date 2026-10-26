"""The storage helper against a fake S3 endpoint: what it signs, what it asks the bucket, and where it asks it from.
No real bucket or key is involved: the credentials below are fakes."""

import base64
import calendar
import hashlib
import hmac
import json
import socket
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from app import storage

SECRET = "fake-secret-for-tests"  # noqa: S105
seen: list[tuple[str, str, str]] = []  # (method, path, query)
held: set[str] = set()  # "/<bucket>/<key>" the fake bucket holds
# How the fake answers a DELETE of a key it doesn't hold: S3's 204, GCS's 404 NoSuchKey, or a 403 refusal.
delete_missing = {"as": "S3"}


class FakeS3(BaseHTTPRequestHandler):
    def _record(self) -> str:
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        seen.append((self.command, path, parts.query))
        return path

    def do_HEAD(self) -> None:
        self.send_response(200 if self._record() in held else 404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_DELETE(self) -> None:
        path = self._record()
        missing = path not in held
        held.discard(path)
        if missing and delete_missing["as"] == "GCS":
            return self._error(404, "NoSuchKey")
        if delete_missing["as"] == "refuse":
            return self._error(403, "AccessDenied")
        self.send_response(204)
        self.end_headers()

    def _error(self, status: int, code: str) -> None:
        body = f'<?xml version="1.0" encoding="UTF-8"?><Error><Code>{code}</Code><Message>{code}</Message></Error>'.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self._record()
        self.send_response(400)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture(scope="module")
def endpoint() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeS3)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


NAMES = [
    "AGC_STORAGE_ENDPOINT",
    "AGC_STORAGE_REGION",
    "AGC_STORAGE_BUCKET",
    "AGC_STORAGE_PREFIX",
    "AGC_STORAGE_MAX_OBJECT_MB",
    "AGC_STORAGE_ACCESS_KEY_ID",
    "AGC_STORAGE_SECRET_ACCESS_KEY",
    "AGC_STORAGE_FALLBACK_BUCKET",
    "AGC_STORAGE_FALLBACK_PREFIX",
    "AGC_STORAGE_GATEWAY_URL",
    "AGENTCLOUD_MIRROR",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
]
DEV = "agc-staging-0123456789abcdef-d"
REH = "agc-staging-0123456789abcdef-r"
PROD = "agc-staging-0123456789abcdef-p"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, endpoint: str):
    def set_env(**over: str) -> None:
        for n in NAMES:
            monkeypatch.delenv(n, raising=False)
        base = {
            "AGC_STORAGE_ENDPOINT": endpoint,
            "AGC_STORAGE_REGION": "auto",
            "AGC_STORAGE_BUCKET": DEV,
            "AGC_STORAGE_PREFIX": "mirror-one/",
            "AGC_STORAGE_MAX_OBJECT_MB": "25",
            "AGC_STORAGE_ACCESS_KEY_ID": "fake-key-id",
            "AGC_STORAGE_SECRET_ACCESS_KEY": SECRET,
        }
        for k, v in {**base, **over}.items():
            monkeypatch.setenv(k, v)

    seen.clear()
    held.clear()
    delete_missing["as"] = "S3"
    set_env()
    return set_env


def _hmac(key: bytes, data: str) -> bytes:
    return hmac.new(key, data.encode(), hashlib.sha256).digest()


def test_sto2_sign_upload_signs_one_new_key_under_the_prefix_capped_for_10_minutes(env, endpoint: str) -> None:
    before = time.time()
    up = storage.sign_upload("receipts/scan.pdf")
    key, fields = up["key"], up["fields"]
    assert len(key.split("/")[0]) == 36 and key.endswith("/receipts/scan.pdf"), "a fresh uuid, then the name"
    assert fields["key"] == f"mirror-one/{key}", "the object lands under this place's prefix"
    assert up["url"] == f"{endpoint}/{DEV}", "path-style, on the endpoint's own host"
    policy = json.loads(base64.b64decode(fields["policy"]))
    assert ["content-length-range", 0, 25 * 1024 * 1024] in policy["conditions"]
    assert {"key": f"mirror-one/{key}"} in policy["conditions"], "exactly one key, no starts-with"
    assert {"bucket": DEV} in policy["conditions"]
    expires = calendar.timegm(time.strptime(policy["expiration"], "%Y-%m-%dT%H:%M:%SZ"))
    assert 9.9 * 60 < expires - before <= 10 * 60 + 2
    # The policy is signed with this place's key (SigV4: the signing key signs the base64 policy itself).
    _, date, region, service, _ = fields["x-amz-credential"].split("/")
    signing = _hmac(_hmac(_hmac(_hmac(f"AWS4{SECRET}".encode(), date), region), service), "aws4_request")
    assert fields["x-amz-signature"] == hmac.new(signing, fields["policy"].encode(), hashlib.sha256).hexdigest()
    assert seen == [], "signing asks the bucket nothing"


def test_sto2_the_cap_follows_max_object_mb(env) -> None:
    env(AGC_STORAGE_MAX_OBJECT_MB="100")
    policy = json.loads(base64.b64decode(storage.sign_upload("big.bin")["fields"]["policy"]))
    assert ["content-length-range", 0, 100 * 1024 * 1024] in policy["conditions"]


def test_sto2_sign_upload_never_reuses_a_key(env) -> None:
    assert len({storage.sign_upload("photo.jpg")["key"] for _ in range(20)}) == 20


@pytest.mark.parametrize("bad", ["", "/etc/hosts", "../other-mirror/x", "a/../../b", "a//b", "a/", "line\nbreak", "${filename}"])
def test_sto2_a_key_that_would_leave_the_prefix_is_refused(env, bad: str) -> None:
    with pytest.raises(ValueError, match="storage key"):
        storage.sign_upload(bad)
    with pytest.raises(ValueError, match="storage key"):
        storage.sign_download(bad, lambda: True)
    with pytest.raises(ValueError, match="storage key"):
        storage.delete(bad)


def test_sto3_sign_download_signs_a_get_for_5_minutes_only_after_the_check(env, endpoint: str) -> None:
    held.add(f"/{DEV}/mirror-one/k1/scan.pdf")
    order: list[str] = []

    def may_read() -> bool:
        order.append(f"check, {len(seen)} requests so far")
        return True

    r = storage.sign_download("k1/scan.pdf", may_read)
    assert order == ["check, 0 requests so far"], "the check runs before the bucket is asked anything"
    assert r.url and r.status == 200
    url = urlsplit(r.url)
    assert f"{url.scheme}://{url.netloc}" == endpoint
    assert unquote(url.path) == f"/{DEV}/mirror-one/k1/scan.pdf"
    assert parse_qs(url.query)["X-Amz-Expires"] == ["300"]
    assert [s[0] for s in seen] == ["HEAD"]


def test_sto3_a_person_the_check_refuses_gets_403_and_nothing_is_asked(env) -> None:
    held.add(f"/{DEV}/mirror-one/k1/scan.pdf")
    r = storage.sign_download("k1/scan.pdf", lambda: False)
    assert r == storage.Download(status=403, error={"code": "forbidden", "message": "You can\u2019t see this file."})
    assert seen == []


def test_sto3_in_production_a_missing_key_answers_404_with_one_head(env) -> None:
    env(AGC_STORAGE_BUCKET=PROD, AGC_STORAGE_PREFIX="")
    r = storage.sign_download("gone.pdf", lambda: True)
    assert r.url is None and r.status == 404 and r.error and r.error["code"] == "not_found"
    assert [(m, p) for m, p, _ in seen] == [("HEAD", f"/{PROD}/gone.pdf")]


def test_sto3_a_rehearsal_reads_a_missing_key_from_production_with_one_head_and_no_list(env) -> None:
    env(AGC_STORAGE_BUCKET=REH, AGC_STORAGE_PREFIX="op_1/task_2/", AGC_STORAGE_FALLBACK_BUCKET=PROD)
    r = storage.sign_download("k9/receipt.png", lambda: True)
    assert r.url
    assert unquote(urlsplit(r.url).path) == f"/{PROD}/k9/receipt.png", "production's bucket, at production's (empty) prefix"
    assert parse_qs(urlsplit(r.url).query)["X-Amz-Expires"] == ["300"]
    assert [(m, p) for m, p, _ in seen] == [("HEAD", f"/{REH}/op_1/task_2/k9/receipt.png")]
    assert not any("list-type" in q or m == "GET" for m, _, q in seen), "never a list"


def test_stor3_customer_fallback_prefix_uses_one_head(env) -> None:
    env(AGC_STORAGE_FALLBACK_BUCKET="customer-bucket", AGC_STORAGE_FALLBACK_PREFIX="apps/one/prod/")
    r = storage.sign_download("k1/receipt.pdf", lambda: True)
    assert r.url and unquote(urlsplit(r.url).path) == "/customer-bucket/apps/one/prod/k1/receipt.pdf"
    assert [method for method, _, _ in seen] == ["HEAD"]


def test_stor6_gateway_preserves_signed_path_query_and_post_fields(env) -> None:
    gateway = "https://files.example.test/app/place/attempt"
    env(AGC_STORAGE_GATEWAY_URL=gateway + "/")
    up = storage.sign_upload("person/literal %2F+ café?#.txt")
    assert up["url"] == gateway + f"/{DEV}"
    assert up["fields"]["key"] == "mirror-one/" + up["key"]
    held.add(f"/{DEV}/mirror-one/person/literal %2F+ café?#.txt")
    down = storage.sign_download("person/literal %2F+ café?#.txt", lambda: True)
    assert down.url and down.url.startswith(gateway + f"/{DEV}/")
    assert "%252F%2B%20caf%C3%A9%3F%23.txt?" in down.url
    assert [method for method, _, _ in seen] == ["HEAD"]


def test_stor7_signer_reloads_and_rejects_short_container_credentials(env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGC_STORAGE_ACCESS_KEY_ID")
    monkeypatch.delenv("AGC_STORAGE_SECRET_ACCESS_KEY")
    attempts = 0
    short = False

    class Credentials:
        def get_frozen_credentials(self):
            return type("Frozen", (), {"access_key": "temporary", "secret_key": SECRET, "token": "session"})()

        def refresh_needed(self, threshold: int) -> bool:
            assert threshold == 11 * 60
            return short or attempts == 1

    class Client:
        def generate_presigned_post(self, **_: object) -> dict[str, object]:
            return {"url": f"http://127.0.0.1:1/{DEV}", "fields": {"session": "session"}}

    class Session:
        def __init__(self, **_: object) -> None:
            nonlocal attempts
            attempts += 1

        def get_credentials(self) -> Credentials:
            return Credentials()

        def client(self, *_: object, **__: object) -> Client:
            return Client()

    monkeypatch.setattr(storage, "RefreshableCredentials", Credentials)
    monkeypatch.setattr(storage.boto3, "Session", Session)
    up = storage.sign_upload("person/a.txt")
    assert attempts == 2 and up["fields"] == {"session": "session"}
    short = True
    with pytest.raises(RuntimeError, match="fewer than 11 minutes"):
        storage.sign_upload("person/b.txt")
    assert attempts == 4


def test_sto3_a_rehearsal_reads_a_key_its_own_prefix_holds_from_there(env) -> None:
    env(AGC_STORAGE_BUCKET=REH, AGC_STORAGE_PREFIX="op_1/task_2/", AGC_STORAGE_FALLBACK_BUCKET=PROD)
    held.add(f"/{REH}/op_1/task_2/k9/receipt.png")
    r = storage.sign_download("k9/receipt.png", lambda: True)
    assert r.url and unquote(urlsplit(r.url).path) == f"/{REH}/op_1/task_2/k9/receipt.png"
    assert len(seen) == 1


def test_sto3_on_a_mirror_a_missing_key_shows_this_file_isnt_on_this_mirror(env) -> None:
    env(AGENTCLOUD_MIRROR="mirror-one")
    r = storage.sign_download("k1/from-production.pdf", lambda: True)
    assert r == storage.Download(status=404, error={"code": "not_on_mirror", "message": "This file isn't on this mirror"})
    assert [s[0] for s in seen] == ["HEAD"]


def test_sto3_a_mirror_never_falls_back_to_production(env) -> None:
    env(AGENTCLOUD_MIRROR="mirror-one", AGC_STORAGE_FALLBACK_BUCKET=PROD)
    r = storage.sign_download("k1/from-production.pdf", lambda: True)
    assert r.error and r.error["code"] == "not_on_mirror"


def test_sto4_delete_removes_one_key_under_the_prefix(env) -> None:
    held.add(f"/{DEV}/mirror-one/k1/scan.pdf")
    storage.delete("k1/scan.pdf")
    assert [(m, p) for m, p, _ in seen] == [("DELETE", f"/{DEV}/mirror-one/k1/scan.pdf")]
    assert held == set()


def test_sto4_a_rehearsal_deletes_only_in_its_own_prefix(env) -> None:
    env(AGC_STORAGE_BUCKET=REH, AGC_STORAGE_PREFIX="op_1/task_2/", AGC_STORAGE_FALLBACK_BUCKET=PROD)
    storage.delete("k9/receipt.png")
    assert [(m, p) for m, p, _ in seen] == [("DELETE", f"/{REH}/op_1/task_2/k9/receipt.png")]


@pytest.mark.parametrize("target", ["S3", "GCS"])
def test_sto4_delete_of_a_key_that_isnt_there_succeeds_on_every_target_s3_204_and_gcs_404_nosuchkey(env, target: str) -> None:
    delete_missing["as"] = target
    storage.delete("k1/never-uploaded.pdf")  # a delete before an upload
    held.add(f"/{DEV}/mirror-one/k1/scan.pdf")
    storage.delete("k1/scan.pdf")
    storage.delete("k1/scan.pdf")  # a second delete of the same key
    assert [m for m, _, _ in seen] == ["DELETE"] * 3
    assert held == set()


def test_sto4_any_other_error_from_a_delete_still_raises(env) -> None:
    delete_missing["as"] = "refuse"
    with pytest.raises(ClientError) as raised:
        storage.delete("k1/scan.pdf")
    assert raised.value.response["ResponseMetadata"]["HTTPStatusCode"] == 403


def test_sto1_without_storage_the_helper_says_what_to_declare(env, monkeypatch: pytest.MonkeyPatch) -> None:
    for n in NAMES:
        monkeypatch.delenv(n, raising=False)
    with pytest.raises(RuntimeError, match=r"AGC_STORAGE_BUCKET is not set: storage needs \[storage\] in agentcloud\.toml"):
        storage.sign_upload("x.pdf")


def test_sto5_on_a_mirror_the_s3_client_goes_through_agcs_egress_proxy(env, monkeypatch: pytest.MonkeyPatch) -> None:
    connects: list[str] = []
    proxy = socket.socket()
    proxy.bind(("127.0.0.1", 0))
    proxy.listen()

    def serve() -> None:
        while True:
            try:
                conn, _ = proxy.accept()
            except OSError:
                return
            with conn:
                head = conn.recv(4096).decode("latin1")
                connects.append(head.split("\r\n", 1)[0])
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")  # as agc's proxy answers a host it doesn't grant

    threading.Thread(target=serve, daemon=True).start()
    try:
        env(
            AGENTCLOUD_MIRROR="mirror-one",
            AGC_STORAGE_ENDPOINT="https://storage.googleapis.com",
            HTTPS_PROXY=f"http://127.0.0.1:{proxy.getsockname()[1]}",
        )
        monkeypatch.setenv("AWS_MAX_ATTEMPTS", "1")
        with pytest.raises(BotoCoreError):  # the proxy refused the tunnel
            storage.sign_download("k1/scan.pdf", lambda: True)
        assert connects, "the request went to the proxy"
        assert all(c.startswith("CONNECT storage.googleapis.com:443 ") for c in connects), connects
    finally:
        proxy.close()
