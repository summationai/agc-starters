"""AMCP-7: who a grant is, by a stable identity, never by an email alone.
On agent.cloud's sign-in, the app user's id: ("agent.cloud", <users.id>).
On edge sign-in, the iss and provider_id claims of the gate's signed x-agc-identity (agent.cloud's EDGE-15): an ES256
JWT whose sub is the email, so sub never names a grant. Only agent.cloud's own issuer is trusted, verified against its
published keys; a customer's own provider can't grant yet, and neither can an assertion without provider_id."""

import base64
import json
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from fastapi import Request

from .. import auth
from .app_name import APP_NAME

AGENT_CLOUD = "agent.cloud"
NOT_YET = "Agents aren’t available on this sign-in yet."
UNCONFIRMED = "We couldn’t confirm who you are from your sign-in, so no agent can connect for you. Reload the page and try again."
NO_ID = "Your sign-in doesn’t give agent.cloud a stable id for you, so agents can’t connect here yet."


@dataclass(frozen=True)
class Subject:
    iss: str
    id: str


@dataclass(frozen=True)
class Identity:
    subject: Subject | None
    message: str | None = None


def own_issuer() -> str:
    """agent.cloud's own broker issuer, https://auth.<control host> (EDGE-15), or the one agent.cloud names for this app."""
    return os.environ.get("AGC_IDENTITY_ISSUER") or f"https://auth.{urlsplit(os.environ['AGC_AUTH_URL']).netloc}"


_keys: dict[str, tuple[float, list[dict[str, Any]]]] = {}  # issuer -> its published keys, for at most a minute


def _keys_of(iss: str) -> list[dict[str, Any]]:
    hit = _keys.get(iss)
    if hit and time.monotonic() - hit[0] < 60:
        return hit[1]
    r = httpx.get(f"{iss}/.well-known/jwks.json", timeout=3, follow_redirects=False)
    j = r.json() if r.is_success else None
    found = [k for k in j.get("keys", []) if isinstance(k, dict)] if isinstance(j, dict) and isinstance(j.get("keys"), list) else []
    _keys[iss] = (time.monotonic(), found)
    return found


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _part(text: str) -> dict[str, Any] | None:
    try:
        value = json.loads(_unb64(text))
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _verified(signed: bytes, signature: bytes, jwk: dict[str, Any]) -> bool:
    if len(signature) != 64:
        return False
    key = ec.EllipticCurvePublicNumbers(
        int.from_bytes(_unb64(jwk["x"]), "big"), int.from_bytes(_unb64(jwk["y"]), "big"), ec.SECP256R1()
    ).public_key()
    der = encode_dss_signature(int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big"))
    try:
        key.verify(der, signed, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        return False
    return True


def edge_identity(request: Request) -> Identity:
    """The person behind this request, by the gate's signed assertion: who signed them in, and that provider's id for them."""
    parts = request.headers.get("x-agc-identity", "").split(".")
    if len(parts) != 3:
        return Identity(None, UNCONFIRMED)
    header, claims = _part(parts[0]), _part(parts[1])
    if not header or not claims or header.get("alg") != "ES256" or not isinstance(header.get("kid"), str):
        return Identity(None, UNCONFIRMED)
    if claims.get("iss") != own_issuer():
        return Identity(None, NOT_YET)  # a customer's own provider (agent.cloud's AMCP-12)
    try:
        jwk = next(
            (k for k in _keys_of(own_issuer()) if k.get("kid") == header["kid"] and k.get("kty") == "EC" and k.get("crv") == "P-256"),
            None,
        )
        valid = bool(jwk and _verified(f"{parts[0]}.{parts[1]}".encode(), _unb64(parts[2]), jwk))
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        valid = False
    now = time.time()
    email = request.headers.get("x-agc-user-email", "").strip().lower()
    if (
        not valid
        or claims.get("aud") != APP_NAME
        or not isinstance(claims.get("exp"), int | float)
        or claims["exp"] <= now
        or not isinstance(claims.get("iat"), int | float)
        or claims["iat"] > now + 60
        or claims.get("presence") != "session"
        or claims.get("sub") != email
    ):
        return Identity(None, UNCONFIRMED)
    provider_id = claims.get("provider_id")
    if not isinstance(provider_id, str) or not provider_id:
        return Identity(None, NO_ID)
    return Identity(Subject(claims["iss"], provider_id))


def identity_of(request: Request, user: dict[str, Any]) -> Identity:
    """Who a signed-in person is, for a grant: on agent.cloud's sign-in, their app user id; on edge sign-in, the assertion."""
    return edge_identity(request) if auth.EDGE else Identity(Subject(AGENT_CLOUD, user["id"]))
