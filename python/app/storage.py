"""STO-3/11/12: browser signing. Backend S3 clients keep their own SDK credential chain."""

import os
import re
from contextlib import closing
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit
from uuid import uuid4

import boto3
from botocore.config import Config
from botocore.credentials import RefreshableCredentials
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


class StorageKeyError(ValueError):
    """A key cannot stay within the configured prefix."""


class StorageNotFoundError(FileNotFoundError):
    def __init__(self) -> None:
        super().__init__("This file isn't on this mirror or was deleted.")


def _key_path(key: str) -> str:
    if not key or re.search(r"[\x00-\x1f\x7f\\]", key) or "${" in key or any(p in ("", ".", "..") for p in key.split("/")):
        raise StorageKeyError("Use a relative file key without empty or dot path segments.")
    return key


def _base(value: str) -> str:
    url = urlsplit(value)
    if (
        not url.netloc
        or (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")))
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("Storage URLs require HTTPS without credentials, a query, or a fragment.")
    return value.rstrip("/")


def _prefix(value: str) -> str:
    if value:
        if not value.endswith("/"):
            raise ValueError("Storage prefixes must end with /.")
        _key_path(value[:-1])
    return value


@dataclass(frozen=True)
class _Storage:
    endpoint: str
    region: str
    bucket: str
    prefix: str
    max_bytes: int
    fallback_bucket: str | None
    fallback_prefix: str
    gateway: str | None

    @classmethod
    def read(cls) -> "_Storage":
        def required(name: str) -> str:
            value = os.environ.get(name)
            if not value:
                raise ValueError(f"{name} is not set. Add [storage] uploads = true to agentcloud.toml.")
            return value

        endpoint = _base(required("AGC_STORAGE_ENDPOINT"))
        if urlsplit(endpoint).path:
            raise ValueError("AGC_STORAGE_ENDPOINT must be an origin.")
        max_mb = int(required("AGC_STORAGE_MAX_OBJECT_MB"))
        if not 1 <= max_mb <= 100:
            raise ValueError("AGC_STORAGE_MAX_OBJECT_MB must be an integer from 1 to 100.")
        return cls(
            endpoint,
            required("AGC_STORAGE_REGION"),
            required("AGC_STORAGE_BUCKET"),
            _prefix(os.environ["AGC_STORAGE_PREFIX"]),
            max_mb * 1_048_576,
            os.environ.get("AGC_STORAGE_FALLBACK_BUCKET"),
            _prefix(os.environ.get("AGC_STORAGE_FALLBACK_PREFIX", "")),
            _base(os.environ["AGC_STORAGE_GATEWAY_URL"]) if os.environ.get("AGC_STORAGE_GATEWAY_URL") else None,
        )

    def scoped(self, prefix: str, key: str) -> str:
        full = prefix + _key_path(key)
        if len(full.encode("utf-8")) > 1024:
            raise StorageKeyError("The file key exceeds 1024 UTF-8 bytes.")
        return full

    def client(self) -> "S3Client":
        key_id = os.environ.get("AGC_STORAGE_ACCESS_KEY_ID")
        secret = os.environ.get("AGC_STORAGE_SECRET_ACCESS_KEY")
        if bool(key_id) != bool(secret):
            raise ValueError("Set both AGC_STORAGE HMAC keys or neither.")
        # A private session per signing operation reloads the default chain (including the container token file).
        # No cached short-lived session, global boto3 session, or backend client's refresh behavior is changed.
        session = boto3.Session(aws_access_key_id=key_id, aws_secret_access_key=secret)
        credentials = session.get_credentials()
        if credentials is None:
            raise RuntimeError("Storage credentials are not available.")
        frozen = credentials.get_frozen_credentials()
        if isinstance(credentials, RefreshableCredentials) and credentials.refresh_needed(11 * 60):
            raise RuntimeError("Storage credentials have fewer than 11 minutes left after refresh.")
        return session.client(
            "s3",
            endpoint_url=self.endpoint,
            region_name=self.region,
            aws_access_key_id=frozen.access_key,
            aws_secret_access_key=frozen.secret_key,
            aws_session_token=frozen.token,
            config=Config(
                signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 1}, connect_timeout=10, read_timeout=10
            ),
        )

    def browser_url(self, url: str) -> str:
        if not url.startswith(self.endpoint + "/"):
            raise ValueError("The signed storage URL does not match AGC_STORAGE_ENDPOINT.")
        # Preserve the encoded bucket/key path and signed query byte for byte.
        return self.gateway + url[len(self.endpoint) :] if self.gateway else url


def signUpload(key: str) -> dict[str, Any]:  # noqa: N802 - same starter API in both languages
    """Sign a fresh key. Store the returned relative key in the app row, not fields.key or the expiring URL."""
    parts = _key_path(key).split("/")
    parts.insert(len(parts) - 1, str(uuid4()))
    fresh_key = "/".join(parts)
    storage = _Storage.read()
    full_key = storage.scoped(storage.prefix, fresh_key)
    with closing(storage.client()) as s3:
        post = s3.generate_presigned_post(
            Bucket=storage.bucket,
            Key=full_key,
            ExpiresIn=600,
            Conditions=[["content-length-range", 0, storage.max_bytes]],
        )
    return {"key": fresh_key, "url": storage.browser_url(post["url"]), "fields": post["fields"]}


def signDownload(key: str) -> str:  # noqa: N802 - same starter API in both languages
    """Call only after the app authorizes this person's access to the stored relative key."""
    storage = _Storage.read()
    bucket = storage.bucket
    full_key = storage.scoped(storage.prefix, key)
    with closing(storage.client()) as s3:
        try:
            s3.head_object(Bucket=bucket, Key=full_key)
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 404:
                raise  # AccessDenied and network errors must not select production.
            if not storage.fallback_bucket:
                raise StorageNotFoundError() from error
            bucket = storage.fallback_bucket
            full_key = storage.scoped(storage.fallback_prefix, key)
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": full_key, "ResponseContentDisposition": "attachment"},
            ExpiresIn=300,
        )
    return storage.browser_url(url)
