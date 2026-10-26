"""Files people upload, for an app whose agentcloud.toml declares [storage] (agent.cloud's app-storage spec). Nothing
imports this until the app does: without [storage] there are no AGC_STORAGE_* variables, and nothing here runs.

    up = storage.sign_upload("receipt.pdf")      # STOR-2: {"url", "fields", "key"}; the browser posts the file there,
                                                 # and the app records up["key"] in its own table
    down = storage.sign_download(row.key, lambda: row.user_id == user.id)   # STOR-3: the app's own check comes first
    storage.delete(row.key)                      # STOR-4

Keys are relative to this place's prefix (AGC_STORAGE_PREFIX), so a row names the same file in every environment.
Each call talks to the bucket over the network, so call them from plain `def` endpoints (FastAPI runs those in a thread)."""

import os
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import Any
from urllib.parse import urlsplit

import boto3
from botocore.config import Config
from botocore.credentials import RefreshableCredentials
from botocore.exceptions import ClientError

UPLOAD_SECONDS = 10 * 60  # STOR-2: an upload policy is valid for 10 minutes
DOWNLOAD_SECONDS = 5 * 60  # STOR-3: a download link for at most 5 minutes
NOT_ON_MIRROR = "This file isn't on this mirror"


def _browser_url(url: str) -> str:
    """STOR-6: change only the browser endpoint; retain the signed path and query byte for byte."""
    gateway = os.environ.get("AGC_STORAGE_GATEWAY_URL")
    if not gateway:
        return url
    endpoint = os.environ.get("AGC_STORAGE_ENDPOINT")
    base = endpoint.rstrip("/") if endpoint else ""
    if not base or not url.startswith(base + "/"):
        raise ValueError("The signed storage URL does not match AGC_STORAGE_ENDPOINT.")
    target = urlsplit(gateway)
    if target.scheme != "https" or not target.netloc or target.username or target.password or target.query or target.fragment:
        raise ValueError("AGC_STORAGE_GATEWAY_URL must be an HTTPS base without credentials, a query, or a fragment.")
    return gateway.rstrip("/") + url[len(base) :]


@dataclass(frozen=True)
class Download:
    """A signed GET (`url`), or why there's none: `status` 403 or 404 with an `error` in the app's error shape."""

    url: str | None = None
    status: int = 200
    error: dict[str, str] | None = None


@dataclass(frozen=True)
class _Place:
    bucket: str
    prefix: str
    fallback: str | None
    max_bytes: int


def _place() -> _Place:
    bucket = os.environ.get("AGC_STORAGE_BUCKET")
    if not bucket:
        raise RuntimeError("AGC_STORAGE_BUCKET is not set: storage needs [storage] in agentcloud.toml (and `agc up` again on a mirror)")
    return _Place(
        bucket=bucket,
        prefix=os.environ.get("AGC_STORAGE_PREFIX", ""),  # production's prefix is empty
        fallback=os.environ.get("AGC_STORAGE_FALLBACK_BUCKET") or None,  # a rehearsal's or a preview's read-only view of production
        max_bytes=int(float(os.environ.get("AGC_STORAGE_MAX_OBJECT_MB") or 25) * 1024 * 1024),
    )


# What a client is made from: a change in any of them makes a new one.
_CLIENT_CONFIG = (
    "AGC_STORAGE_ENDPOINT",
    "AGC_STORAGE_REGION",
    "AGC_STORAGE_ACCESS_KEY_ID",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
)


def _client() -> Any:  # boto3's clients are generated at runtime, so they carry no static type
    return _client_for(tuple(os.environ.get(n, "") for n in _CLIENT_CONFIG))


@cache
def _client_for(_config: tuple[str, ...]) -> Any:
    """One client per configuration. STOR-5: on a mirror, agc up sets HTTPS_PROXY to its egress proxy, the only way out;
    botocore's HTTP session reads HTTPS_PROXY and NO_PROXY from the environment, so the client goes through it."""
    e = os.environ
    keys = e.get("AGC_STORAGE_ACCESS_KEY_ID"), e.get("AGC_STORAGE_SECRET_ACCESS_KEY")
    return boto3.client(
        "s3",
        region_name=e.get("AGC_STORAGE_REGION") or "auto",
        endpoint_url=e.get("AGC_STORAGE_ENDPOINT") or None,
        # Keys on a GCP target and on a mirror; on an AWS target, none: boto3's container credentials find them.
        **({"aws_access_key_id": keys[0], "aws_secret_access_key": keys[1]} if all(keys) else {}),
        config=Config(
            signature_version="s3v4",
            # Path-style URLs: the endpoint's own host is the one the mirror's proxy lets through, never <bucket>.<host>.
            s3={"addressing_style": "path"},
            # GCS's S3 API refuses the checksums newer SDKs add by default; send them only where S3 requires one.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def _signing_client() -> Any:
    """STOR-7: a private credential chain per browser signature, separate from backend clients."""
    key_id, secret = os.environ.get("AGC_STORAGE_ACCESS_KEY_ID"), os.environ.get("AGC_STORAGE_SECRET_ACCESS_KEY")
    if bool(key_id) != bool(secret):
        raise ValueError("Set both AGC_STORAGE HMAC keys or neither.")
    for attempt in range(2):
        session = boto3.Session(aws_access_key_id=key_id, aws_secret_access_key=secret)
        credentials = session.get_credentials()
        if credentials is None:
            raise RuntimeError("Storage credentials are not available.")
        frozen = credentials.get_frozen_credentials()
        if not isinstance(credentials, RefreshableCredentials) or not credentials.refresh_needed(11 * 60):
            return session.client(
                "s3",
                region_name=os.environ.get("AGC_STORAGE_REGION") or "auto",
                endpoint_url=os.environ.get("AGC_STORAGE_ENDPOINT") or None,
                aws_access_key_id=frozen.access_key,
                aws_secret_access_key=frozen.secret_key,
                aws_session_token=frozen.token,
                config=Config(
                    signature_version="s3v4",
                    s3={"addressing_style": "path"},
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                ),
            )
        if attempt:
            break
    raise RuntimeError("Storage credentials have fewer than 11 minutes left after refresh.")


_BAD = re.compile(r"[\x00-\x1f\x7f\\]")


def _checked(key: str) -> str:
    """A key is the app's own relative name: no leading slash, no empty, `.` or `..` part, no control characters."""
    if (
        not isinstance(key, str)
        or not key
        or len(key) > 512
        or "${" in key
        or _BAD.search(key)
        or any(p in ("", ".", "..") for p in key.split("/"))
    ):
        raise ValueError(
            'A storage key is a relative name like "receipts/scan.pdf": '
            'no leading slash, no empty, "." or ".." part, at most 512 characters.'
        )
    return key


def sign_upload(key: str) -> dict[str, Any]:
    """STOR-2: a POST policy for one new key under this place's prefix. A fresh uuid goes in front of the name, so no
    upload ever overwrites a file a row already names. The policy caps the size at AGC_STORAGE_MAX_OBJECT_MB and lasts
    10 minutes. Returns {"url", "fields", "key"}: the browser posts the fields and the file to url; the app records key."""
    name = f"{uuid.uuid4()}/{_checked(key)}"
    place = _place()
    post = _signing_client().generate_presigned_post(
        Bucket=place.bucket,
        Key=place.prefix + name,
        Conditions=[["content-length-range", 0, place.max_bytes]],
        ExpiresIn=UPLOAD_SECONDS,
    )
    return {"url": _browser_url(post["url"]), "fields": post["fields"], "key": name}


def sign_download(key: str, may_read: Callable[[], bool]) -> Download:
    """STOR-3: a GET link for at most 5 minutes, signed only once the app's own check says this person may see the file.
    One HEAD asks this place's prefix; a rehearsal or a preview that doesn't hold the key reads production's bucket
    instead, with no second request and never a list. A mirror never does: a key its masked rows name but its own empty
    prefix lacks answers 404 with NOT_ON_MIRROR."""
    _checked(key)
    if not may_read():
        return Download(status=403, error={"code": "forbidden", "message": "You can\u2019t see this file."})
    place = _place()
    s3 = _client()
    bucket, object_key = place.bucket, place.prefix + key
    if not _exists(s3, bucket, object_key):
        if os.environ.get("AGENTCLOUD_MIRROR"):
            return Download(status=404, error={"code": "not_on_mirror", "message": NOT_ON_MIRROR})
        if not place.fallback:
            return Download(status=404, error={"code": "not_found", "message": "There\u2019s no such file."})
        bucket, object_key = place.fallback, os.environ.get("AGC_STORAGE_FALLBACK_PREFIX", "") + key
    signer = _signing_client()  # HEAD may have consumed part of the credential lifetime.
    url = signer.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": object_key}, ExpiresIn=DOWNLOAD_SECONDS)
    return Download(url=_browser_url(url))


def _exists(s3: Any, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        if e.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
            return False
        raise


def delete(key: str) -> None:
    """STOR-4: removes one key under this place's prefix, never anything in production's bucket from a rehearsal or a
    preview. A key that isn't there is already deleted: S3 answers 204, GCS's S3 API answers 404 NoSuchKey, and both
    succeed here. Only NoSuchKey: a bare 404 isn't enough, since a missing bucket answers 404 NoSuchBucket, and that
    still raises."""
    place = _place()
    try:
        _client().delete_object(Bucket=place.bucket, Key=place.prefix + _checked(key))
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "NoSuchKey":
            raise
