"""ObjectStorage — S3-compatible object storage (Cloudflare R2) over stdlib.

Design rule: durable
artifacts belong in Postgres or S3-compatible object storage, never only on
the container filesystem. R2 is the recommended provider (no egress fees).

Deviation from the canon's boto3: this repo's ethos is stdlib-only HTTP
(AIService/Databricks and BillingService/Lemon Squeezy both use ``urllib``),
so this client signs requests itself with AWS Signature V4 — PUT/GET only,
which is all the app needs (log-segment shipping; restore is operator-driven).

Config (env, all optional — any missing ⇒ ``enabled`` is False and every call
is a silent no-op, mirroring the AI/billing graceful degradation):

    S3_ENDPOINT_URL       https://<account_id>.r2.cloudflarestorage.com  (R2)
                          https://s3.<region>.backblazeb2.com            (B2)
    S3_BUCKET             bucket name
    S3_ACCESS_KEY_ID      R2 API-token key id / B2 application keyID
    S3_SECRET_ACCESS_KEY  R2 API-token secret / B2 applicationKey
    S3_REGION             default "auto" (correct for R2); for Backblaze B2
                          the region is auto-derived from the endpoint host
                          (SigV4 scope must name the real region).
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger("noddle")

_ALGO = "AWS4-HMAC-SHA256"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


class ObjectStorage:
    """Minimal SigV4 S3 client. Never raises out of ``put_object`` — object
    storage is a durability enhancement, not a request dependency."""

    def __init__(self, settings) -> None:  # app.config.Settings (duck-typed)
        self._endpoint = (getattr(settings, "s3_endpoint_url", None) or "").rstrip("/")
        self._bucket = getattr(settings, "s3_bucket", None) or ""
        self._key_id = getattr(settings, "s3_access_key_id", None) or ""
        self._secret = getattr(settings, "s3_secret_access_key", None) or ""
        self._region = getattr(settings, "s3_region", None) or "auto"
        # Backblaze B2 rejects the R2-style "auto" region: SigV4 scope must
        # carry the bucket's real region, which B2 embeds in the endpoint host
        # (s3.<region>.backblazeb2.com) — derive it unless explicitly set.
        host = urllib.parse.urlparse(self._endpoint).netloc
        if self._region == "auto" and host.endswith(".backblazeb2.com"):
            parts = host.split(".")
            if len(parts) == 4 and parts[0] == "s3":
                self._region = parts[1]

    @property
    def enabled(self) -> bool:
        return bool(self._endpoint and self._bucket and self._key_id and self._secret)

    # ---- SigV4 ----------------------------------------------------------------
    def _signed_request(
        self, method: str, key: str, body: bytes, content_type: str | None
    ) -> urllib.request.Request:
        host = urllib.parse.urlparse(self._endpoint).netloc
        # Path-style addressing: /{bucket}/{key} — R2 supports it and it keeps
        # the endpoint a single opaque config value.
        path = "/" + urllib.parse.quote(f"{self._bucket}/{key}", safe="/-_.~")
        now = time.gmtime()
        amz_date = time.strftime("%Y%m%dT%H%M%SZ", now)
        datestamp = time.strftime("%Y%m%d", now)
        payload_hash = _sha256(body)

        headers = {
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if content_type:
            headers["content-type"] = content_type
        signed_names = ";".join(sorted(headers))
        canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
        canonical_request = "\n".join(
            [method, path, "", canonical_headers, signed_names, payload_hash]
        )

        scope = f"{datestamp}/{self._region}/s3/aws4_request"
        string_to_sign = "\n".join(
            [_ALGO, amz_date, scope, _sha256(canonical_request.encode("utf-8"))]
        )
        k = _hmac(("AWS4" + self._secret).encode("utf-8"), datestamp)
        k = _hmac(k, self._region)
        k = _hmac(k, "s3")
        k = _hmac(k, "aws4_request")
        signature = hmac.new(k, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

        headers["Authorization"] = (
            f"{_ALGO} Credential={self._key_id}/{scope}, "
            f"SignedHeaders={signed_names}, Signature={signature}"
        )
        headers.pop("host")  # urllib sets Host itself; it must not be duplicated
        return urllib.request.Request(
            self._endpoint + path, data=body or None, headers=headers, method=method
        )

    # ---- operations -------------------------------------------------------------
    def put_object(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> bool:
        """Upload one object. Returns True on success; logs and returns False
        on any failure (network, auth, config) — callers keep the local copy."""
        if not self.enabled:
            return False
        try:
            req = self._signed_request("PUT", key, data, content_type)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return 200 <= resp.status < 300
        except (urllib.error.URLError, OSError, ValueError) as e:
            logger.warning("Object storage PUT %s failed: %s", key, e)
            return False

    def get_object(self, key: str) -> bytes | None:
        """Fetch one object (operator tooling / future restore paths)."""
        if not self.enabled:
            return None
        try:
            req = self._signed_request("GET", key, b"", None)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except (urllib.error.URLError, OSError, ValueError) as e:
            logger.warning("Object storage GET %s failed: %s", key, e)
            return None
