"""OIDC client — generic OpenID Connect login, stdlib only (ADR-0003).

Authorization-code flow against ANY provider (Google / Entra ID / Keycloak /
Okta). No JWT verification locally: identity claims come from the provider's
``userinfo_endpoint`` over TLS, which makes the provider the trust anchor and
keeps the repo free of crypto dependencies. Unconfigured ⇒ ``enabled()`` is
False and the api layer answers 503 — same graceful degradation as AI.

Env: ``OIDC_ISSUER`` · ``OIDC_CLIENT_ID`` · ``OIDC_CLIENT_SECRET`` ·
optional ``OIDC_REDIRECT_URL`` (default ``{app}/api/auth/oidc/callback``).
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request


class OidcError(Exception):
    """Provider unreachable / bad response / exchange failed. → 502/503."""


def _env(key: str) -> str:
    return (os.environ.get(key) or "").strip()


def enabled() -> bool:
    return bool(_env("OIDC_ISSUER") and _env("OIDC_CLIENT_ID") and _env("OIDC_CLIENT_SECRET"))


_discovery_cache: dict[str, dict] = {}


def _get_json(url: str, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode())
    except Exception as e:  # noqa: BLE001 — network/JSON/HTTP all → OidcError
        raise OidcError(f"OIDC provider error at {url.split('?')[0]}: {e}") from e


def discover() -> dict:
    """The provider's metadata document (cached per issuer)."""
    issuer = _env("OIDC_ISSUER").rstrip("/")
    if issuer not in _discovery_cache:
        _discovery_cache[issuer] = _get_json(
            issuer + "/.well-known/openid-configuration"
        )
    return _discovery_cache[issuer]


def redirect_url(request_base: str) -> str:
    return _env("OIDC_REDIRECT_URL") or request_base.rstrip("/") + "/api/auth/oidc/callback"


def auth_url(state: str, request_base: str) -> str:
    """Where to send the browser to authenticate."""
    meta = discover()
    params = urllib.parse.urlencode(
        {
            "client_id": _env("OIDC_CLIENT_ID"),
            "response_type": "code",
            "scope": "openid email profile",
            "redirect_uri": redirect_url(request_base),
            "state": state,
        }
    )
    return f"{meta['authorization_endpoint']}?{params}"


def exchange_code(code: str, request_base: str) -> dict:
    """code → tokens (client_secret_post)."""
    meta = discover()
    body = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_url(request_base),
            "client_id": _env("OIDC_CLIENT_ID"),
            "client_secret": _env("OIDC_CLIENT_SECRET"),
        }
    ).encode()
    return _get_json(
        meta["token_endpoint"],
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )


def fetch_userinfo(access_token: str) -> dict:
    """Claims from the provider (the trust anchor — no local JWT checks)."""
    meta = discover()
    endpoint = meta.get("userinfo_endpoint")
    if not endpoint:
        raise OidcError("Provider has no userinfo_endpoint.")
    return _get_json(endpoint, headers={"Authorization": f"Bearer {access_token}"})
