"""BillingService — Lemon Squeezy subscriptions (checkout, webhook, entitlement).

Product tiers (mirrors the public landing page):
  * FREE          3 boards, 25 AI credits/month
  * PRO monthly   $10 — unlimited boards, 500 credits/month
  * PRO yearly    $96 — unlimited boards, 6000 credits granted per year
  * TEAM yearly   $12/user/mo (min 3 seats) — unlimited, 1000 credits/user/month

Transport is **stdlib urllib** (repo ethos — no ``lemonsqueezy``/``requests``
dependency) against ``https://api.lemonsqueezy.com/v1`` (JSON:API). Config is
resolved lazily from ``Settings``: a missing ``LEMONSQUEEZY_API_KEY`` (or store
id / variant id) degrades to ``BillingUnavailable`` → 503, mirroring
``AIService``/``oidc`` — never a boot crash.

Webhooks: HMAC-SHA256 of the RAW body with ``LEMONSQUEEZY_WEBHOOK_SECRET``
compared (constant-time) against the ``X-Signature`` header, then processed
idempotently: the event id is recorded FIRST and a duplicate delivery no-ops.
⚠️ Lemon Squeezy quirks handled here: the subscription resource id is at
``data.id`` (NOT ``data.attributes.id``) and the ``checkout_data.custom``
fields we send echo back at ``meta.custom_data``.

Entitlement (``effective_tier``) is where the money rules live:
  * a CANCELLED subscription keeps its tier until ``current_period_end``
    passes (the user paid for that period);
  * ``past_due`` keeps access for a 7-day grace window;
  * the effective tier is the max of the personal subscription and any
    entitled TEAM subscription of a team the user belongs to.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
import urllib.error
import urllib.request
from datetime import datetime

from app.config import Settings
from app.domain.models import Subscription
from app.domain.repository import BillingRepository
from app.services.auth import AuthService, Principal

logger = logging.getLogger("noddle")

LS_API = "https://api.lemonsqueezy.com/v1"
_HTTP_TIMEOUT = 30  # seconds per Lemon Squeezy API call

# Grace window for past_due subscriptions (dunning): access is kept while
# Lemon Squeezy retries the payment.
PAST_DUE_GRACE_S = 7 * 24 * 3600

TEAM_MIN_SEATS = 3

# Features per tier. boards_max -1 = unlimited.
TIER_FEATURES: dict[str, dict] = {
    "free": {"boards_max": 10, "ai_credits_month": 25},
    "pro": {"boards_max": -1, "ai_credits_month": 500},
    "team": {"boards_max": -1, "ai_credits_month": 1000},
}
_TIER_RANK = {"free": 0, "pro": 1, "team": 2}

# Credits granted on each successful payment, per variant.
CREDITS_PER_PAYMENT = {
    "pro_monthly": 500,
    "pro_yearly": 6000,
    "team_yearly": 1000,  # per team member
}

# Lemon Squeezy subscription status → our status. Unknown/new LS statuses fall
# back to "past_due" (7-day grace) — neither a free upgrade nor an instant cut.
_LS_STATUS_MAP = {
    "on_trial": "active",
    "active": "active",
    "cancelled": "cancelled",
    "expired": "cancelled",
    "past_due": "past_due",
    "unpaid": "past_due",
    "paused": "past_due",
}

_HANDLED_EVENTS = {
    "subscription_created",
    "subscription_updated",
    "subscription_resumed",
    "subscription_cancelled",
    "subscription_expired",
    "subscription_payment_failed",
    "subscription_payment_success",
}


class BillingUnavailable(Exception):
    """Billing is not configured / Lemon Squeezy unreachable. → 503."""


class BillingError(Exception):
    """Bad input (unknown variant, malformed payload). → 400."""


class QuotaExceeded(Exception):
    """The plan's board limit is reached — upgrade required. → 402."""


def _iso_to_epoch(value: object) -> float | None:
    """Lemon Squeezy ISO-8601 timestamp (``…Z``) → epoch float, or None."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _invoice_amount_usd(attrs: dict) -> float | None:
    """Invoice amount in USD from a Lemon Squeezy payload, or None.

    ``subscription_payment_success`` carries a subscription-invoice resource
    whose amounts are INTEGER CENTS: prefer ``total_usd`` (already converted),
    fall back to ``total`` only when the invoice currency IS USD. Subscription
    lifecycle payloads have no amount → None (the UI omits the column).
    """
    total_usd = attrs.get("total_usd")
    if isinstance(total_usd, (int, float)) and not isinstance(total_usd, bool):
        return round(total_usd / 100, 2)
    total = attrs.get("total")
    currency = str(attrs.get("currency") or "").upper()
    if currency == "USD" and isinstance(total, (int, float)) and not isinstance(total, bool):
        return round(total / 100, 2)
    return None


class BillingService:
    """Owns the Lemon Squeezy client (lazy) and the subscription use cases."""

    def __init__(
        self, repo: BillingRepository, auth: AuthService, settings: Settings
    ) -> None:
        self._repo = repo
        self._auth = auth
        self._settings = settings

    # ---- config (lazy — mirrors AIService/oidc graceful degradation) --------

    def _api_key(self) -> str:
        key = (self._settings.lemonsqueezy_api_key or "").strip()
        if not key:
            raise BillingUnavailable(
                "Billing is not configured (missing LEMONSQUEEZY_API_KEY)."
            )
        return key

    def _variant_id(self, variant_key: str) -> str:
        ids = {
            "pro_monthly": self._settings.lemonsqueezy_variant_pro_monthly,
            "pro_yearly": self._settings.lemonsqueezy_variant_pro_yearly,
            "team_yearly": self._settings.lemonsqueezy_variant_team_yearly,
        }
        if variant_key not in ids:
            raise BillingError(f"Unknown plan variant: {variant_key!r}.")
        vid = (ids[variant_key] or "").strip()
        if not vid:
            raise BillingUnavailable(
                f"Billing is not configured (missing variant id for {variant_key})."
            )
        return vid

    # ---- checkout -------------------------------------------------------------

    def create_checkout(
        self,
        principal: Principal,
        variant_key: str,
        seats: int | None = None,
        base_url: str = "",
    ) -> str:
        """Create a hosted checkout and return its URL.

        ``checkout_data.custom`` carries ``user_id`` + ``variant`` — Lemon
        Squeezy echoes them back at ``meta.custom_data`` on every webhook, which
        is how a payment finds its way to the right account.
        """
        api_key = self._api_key()
        store_id = (self._settings.lemonsqueezy_store_id or "").strip()
        if not store_id:
            raise BillingUnavailable(
                "Billing is not configured (missing LEMONSQUEEZY_STORE_ID)."
            )
        variant_id = self._variant_id(variant_key)
        if not principal.user_id:
            raise BillingError("You must be signed in to upgrade.")
        email = ""
        user = self._auth.user_public(principal.user_id)
        if user:
            email = user.get("email") or ""

        checkout_data: dict = {
            "email": email,
            "custom": {"user_id": principal.user_id, "variant": variant_key},
        }
        if variant_key == "team_yearly":
            quantity = max(TEAM_MIN_SEATS, int(seats or TEAM_MIN_SEATS))
            checkout_data["variant_quantities"] = [
                {"variant_id": int(variant_id), "quantity": quantity}
            ]

        body = {
            "data": {
                "type": "checkouts",
                "attributes": {
                    "checkout_data": checkout_data,
                    "product_options": {
                        "redirect_url": f"{base_url.rstrip('/')}/?upgraded=1",
                    },
                },
                "relationships": {
                    "store": {"data": {"type": "stores", "id": str(store_id)}},
                    "variant": {"data": {"type": "variants", "id": str(variant_id)}},
                },
            }
        }
        req = urllib.request.Request(
            f"{LS_API}/checkouts",
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/vnd.api+json",
                "Content-Type": "application/vnd.api+json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as r:
                data = json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            logger.warning("Lemon Squeezy checkout failed (HTTP %s): %s", e.code, detail)
            raise BillingUnavailable(
                f"Lemon Squeezy rejected the checkout (HTTP {e.code})."
            ) from e
        except (urllib.error.URLError, TimeoutError) as e:
            raise BillingUnavailable(f"Could not reach Lemon Squeezy: {e}") from e

        url = (((data.get("data") or {}).get("attributes")) or {}).get("url")
        if not url:
            raise BillingUnavailable("Lemon Squeezy did not return a checkout URL.")
        return str(url)

    # ---- webhook ---------------------------------------------------------------

    def verify_webhook(self, raw_body: bytes, signature: str) -> bool:
        """Constant-time HMAC-SHA256 check of the RAW body against X-Signature."""
        secret = (self._settings.lemonsqueezy_webhook_secret or "").strip()
        if not secret or not signature:
            return False
        digest = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(digest, signature.strip())

    def handle_webhook(self, payload: dict) -> str:
        """Process one (verified) webhook. Returns "ok" | "duplicate" | "ignored".

        The event id is recorded FIRST — Lemon Squeezy retries deliveries, and
        a replayed event must never double-apply (e.g. grant credits twice).
        """
        meta = payload.get("meta") or {}
        event_name = str(meta.get("event_name") or "")
        event_id = str(meta.get("event_id") or "")
        if not event_id:
            # Defensive: derive a stable id so retries of the same body still dedupe.
            event_id = hashlib.sha256(
                json.dumps(payload, sort_keys=True).encode()
            ).hexdigest()[:32]

        if not self._repo.record_webhook_event(event_id, event_name, payload):
            return "duplicate"

        if event_name not in _HANDLED_EVENTS:
            logger.info("Billing webhook ignored (event %r).", event_name)
            return "ignored"

        custom = meta.get("custom_data") or {}
        user_id = str(custom.get("user_id") or "")
        if not user_id:
            logger.warning(
                "Billing webhook %s has no user_id in custom_data — ignored.", event_name
            )
            return "ignored"
        variant_key = str(custom.get("variant") or "")

        # ⚠️ JSON:API — the subscription resource id lives at data.id, NOT
        # data.attributes.id (attributes.id would be some other numeric field).
        data = payload.get("data") or {}
        attrs = data.get("attributes") or {}
        ls_subscription_id = str(data.get("id") or "")
        ls_customer_id = str(attrs.get("customer_id") or "")

        now = time.time()
        sub = self._repo.get_subscription(user_id) or Subscription(
            user_id=user_id, created_at=now
        )
        if not sub.created_at:
            sub.created_at = now
        sub.updated_at = now
        if ls_subscription_id:
            sub.ls_subscription_id = ls_subscription_id
        if ls_customer_id:
            sub.ls_customer_id = ls_customer_id

        # Tier + interval come from the variant we sold (echoed in custom_data).
        if variant_key.startswith("team"):
            sub.tier = "team"
        elif variant_key.startswith("pro"):
            sub.tier = "pro"
        elif sub.tier == "free":
            sub.tier = "pro"  # paid event with no/odd variant → safest paid default
        if variant_key:
            sub.billing_interval = "year" if "yearly" in variant_key else "month"
        if sub.tier == "team" and not sub.team_id:
            sub.team_id = self._team_of(user_id)

        # Self-service links ride on subscription payloads at attributes.urls —
        # capture them whenever present (they power the "Manage billing" button).
        urls = attrs.get("urls") or {}
        if urls.get("customer_portal"):
            sub.customer_portal_url = str(urls["customer_portal"])
        if urls.get("update_payment_method"):
            sub.update_payment_method_url = str(urls["update_payment_method"])

        credits_granted = 0
        if event_name in ("subscription_created", "subscription_updated", "subscription_resumed"):
            # Honor the REAL LS status. `subscription_updated` fires on ANY
            # change — including alongside cancelled/expired, with no ordering
            # guarantee — so hardcoding "active" here would resurrect a
            # cancelled/expired sub and leak paid access indefinitely.
            ls_status = str(attrs.get("status") or "active")
            sub.status = _LS_STATUS_MAP.get(ls_status, "past_due")
            renews = _iso_to_epoch(attrs.get("renews_at"))
            if renews:
                sub.current_period_end = renews
            if sub.status == "cancelled":
                ends = _iso_to_epoch(attrs.get("ends_at"))
                if ends:
                    sub.current_period_end = ends
        elif event_name in ("subscription_cancelled", "subscription_expired"):
            sub.status = "cancelled"
            ends = _iso_to_epoch(attrs.get("ends_at"))
            if ends:
                sub.current_period_end = ends
        elif event_name == "subscription_payment_failed":
            sub.status = "past_due"
        elif event_name == "subscription_payment_success":
            sub.status = "active"
            renews = _iso_to_epoch(attrs.get("renews_at"))
            if renews:
                sub.current_period_end = renews
            credits_granted = self._grant_credits(sub, variant_key)

        self._repo.upsert_subscription(sub)

        # Billing history: one user-visible row per processed event. ``raw`` is
        # a compact summary (never the full webhook body — see BillingEvent).
        self._repo.add_event(
            user_id,
            event_name,
            _invoice_amount_usd(attrs),
            credits_granted,
            {
                "variant": variant_key,
                "status": sub.status,
                "tier": sub.tier,
                "ls_subscription_id": sub.ls_subscription_id,
            },
        )
        return "ok"

    def _team_of(self, user_id: str) -> str | None:
        """The buyer's first team — where a "team" purchase attaches."""
        teams = self._auth.my_teams(user_id)
        return teams[0].id if teams else None

    def _grant_credits(self, sub: Subscription, variant_key: str) -> int:
        """Top up AI credit balances on a successful payment.

        pro_monthly +500, pro_yearly +6000; team +1000 per team member (falls
        back to the buyer alone when no team is linked). Reuses the same
        ``ai_settings`` balance the AI endpoints spend from. Returns the TOTAL
        ✦ granted (across all members) for the billing-history row.
        """
        amount = CREDITS_PER_PAYMENT.get(variant_key)
        if amount is None:  # unknown variant → grant per stored tier
            amount = CREDITS_PER_PAYMENT["team_yearly" if sub.tier == "team" else "pro_monthly"]
        if sub.tier == "team":
            team = self._auth.team_by_id(sub.team_id)
            member_ids = list(team.members) if team else [sub.user_id]
            for uid in member_ids:
                self._auth.add_credits(uid, amount)
            return amount * len(member_ids)
        self._auth.add_credits(sub.user_id, amount)
        return amount

    # ---- entitlement -------------------------------------------------------------

    @staticmethod
    def _entitled(sub: Subscription | None, now: float) -> bool:
        """Does this subscription still grant its tier RIGHT NOW?

        * active → yes.
        * cancelled → yes UNTIL current_period_end passes (already paid for).
        * past_due → yes for a 7-day grace window while payment is retried.
        """
        if sub is None or sub.tier == "free":
            return False
        if sub.status == "active":
            return True
        if sub.status == "cancelled":
            return bool(sub.current_period_end and sub.current_period_end > now)
        if sub.status == "past_due":
            anchor = sub.current_period_end or sub.updated_at
            return bool(anchor and now < anchor + PAST_DUE_GRACE_S)
        return False

    def effective_tier(self, principal: Principal) -> dict:
        """The tier this principal's requests are entitled to (max of personal
        and team subscriptions). Guests are free-tier."""
        now = time.time()
        tier, source = "free", "free"
        personal: Subscription | None = None
        if principal.user_id:
            personal = self._repo.get_subscription(principal.user_id)
            if self._entitled(personal, now):
                tier, source = personal.tier, "personal"  # type: ignore[union-attr]
            for team in self._auth.my_teams(principal.user_id):
                team_sub = self._repo.get_team_subscription(team.id)
                if (
                    self._entitled(team_sub, now)
                    and _TIER_RANK.get(team_sub.tier, 0) > _TIER_RANK.get(tier, 0)  # type: ignore[union-attr]
                ):
                    tier, source = team_sub.tier, "team"  # type: ignore[union-attr]
        return {
            "tier": tier,
            "source": source,
            "status": personal.status if personal else None,
            "current_period_end": personal.current_period_end if personal else None,
            # Lemon Squeezy self-service portal (from the subscription webhook)
            # — None until the first subscription payload delivers it.
            "customer_portal_url": (personal.customer_portal_url or None)
            if personal
            else None,
            "features": dict(TIER_FEATURES.get(tier, TIER_FEATURES["free"])),
        }

    def list_events(self, principal: Principal, limit: int = 20) -> list[dict]:
        """The caller's billing history (newest first) as API-ready dicts.

        Guests/agents without a user identity simply get ``[]`` — same
        graceful posture as the rest of billing (no LS config required).
        """
        if not principal.user_id:
            return []
        return [
            {
                "event": e.event,
                "amount_usd": e.amount_usd,
                "credits_granted": e.credits_granted,
                "created_at": e.created_at,
            }
            for e in self._repo.list_events(principal.user_id, limit=limit)
        ]

    def check_board_quota(self, principal: Principal, owned_count: int) -> None:
        """Gate creating a NEW board. Raises ``QuotaExceeded`` (→ 402) when a
        FREE-tier owner is at their board limit. Guests / legacy ownerless
        boards (no ``user_id``) keep the old open behavior."""
        if not principal.user_id:
            return
        limit = self.effective_tier(principal)["features"]["boards_max"]
        if limit >= 0 and owned_count >= limit:
            raise QuotaExceeded(
                f"The free plan is limited to {limit} boards. "
                "Upgrade to Pro for unlimited boards."
            )
