"""Unit tests for Workstream 2 — billing history + customer portal
(services/billing.py + the BillingRepository file adapter).

Service-level tests over the REAL ``FileBillingRepository`` /
``FileAuthRepository`` on a tmp dir (the same adapters the app uses without
``DATABASE_URL``), no network: webhooks are fed straight to
``BillingService.handle_webhook``. FastAPI's ``TestClient`` needs ``httpx``
(not in this venv) — the HTTP layer is a thin mapping tested at the service
boundary, mirroring ``test_profile.py``.
"""
from __future__ import annotations

import pytest

from app.config import Settings
from app.infrastructure.auth_repository import FileAuthRepository
from app.infrastructure.billing_repository import FileBillingRepository
from app.services.auth import AuthService, Principal
from app.services.billing import BillingService, BillingUnavailable

PORTAL = "https://my-store.lemonsqueezy.com/subscription/1/customer-portal"
UPDATE_PM = "https://my-store.lemonsqueezy.com/subscription/1/payment-method"


@pytest.fixture
def auth(tmp_path) -> AuthService:
    return AuthService(FileAuthRepository(tmp_path / "auth"))


@pytest.fixture
def repo(tmp_path) -> FileBillingRepository:
    return FileBillingRepository(tmp_path / "billing")


@pytest.fixture
def billing(repo, auth) -> BillingService:
    # No LEMONSQUEEZY_* config on purpose — webhook processing and the
    # history ledger must work regardless (graceful-degradation invariant).
    settings = Settings(
        lemonsqueezy_api_key=None,
        lemonsqueezy_store_id=None,
        lemonsqueezy_webhook_secret=None,
        lemonsqueezy_variant_pro_monthly=None,
        lemonsqueezy_variant_pro_yearly=None,
        lemonsqueezy_variant_team_yearly=None,
    )
    return BillingService(repo, auth, settings)


@pytest.fixture
def user(auth):
    u, _token = auth.register("ada@example.com", "Ada", "correct-horse-9")
    return u


def principal_of(user) -> Principal:
    return Principal(kind="user", user_id=user.id, name=user.name)


def payment_webhook(
    event_id: str,
    user_id: str,
    variant: str = "pro_monthly",
    total_usd: int = 1000,  # integer CENTS, per Lemon Squeezy
) -> dict:
    """A subscription_payment_success delivery (subscription-invoice shape).

    ⚠️ JSON:API — ``data.id`` is the resource id (here the INVOICE id);
    amounts are integer cents (``total_usd`` already USD-converted).
    """
    return {
        "meta": {
            "event_name": "subscription_payment_success",
            "event_id": event_id,
            "custom_data": {"user_id": user_id, "variant": variant},
        },
        "data": {
            "id": "12345",
            "attributes": {
                "status": "paid",
                "currency": "USD",
                "total": total_usd,
                "total_usd": total_usd,
                "renews_at": "2026-08-05T00:00:00Z",
            },
        },
    }


def subscription_webhook(
    event_id: str,
    user_id: str,
    event_name: str = "subscription_created",
    status: str = "active",
    variant: str = "pro_monthly",
) -> dict:
    """A subscription lifecycle delivery — carries ``attributes.urls``."""
    return {
        "meta": {
            "event_name": event_name,
            "event_id": event_id,
            "custom_data": {"user_id": user_id, "variant": variant},
        },
        "data": {
            "id": "777",
            "attributes": {
                "status": status,
                "customer_id": 42,
                "renews_at": "2026-08-05T00:00:00Z",
                "ends_at": "2026-08-05T00:00:00Z" if status == "cancelled" else None,
                "urls": {
                    "customer_portal": PORTAL,
                    "update_payment_method": UPDATE_PM,
                },
            },
        },
    }


# ---- history recording --------------------------------------------------------


def test_payment_success_records_amount_and_credits(billing, auth, user):
    before = auth.get_ai_settings(user.id).credits
    assert billing.handle_webhook(payment_webhook("evt-1", user.id)) == "ok"

    rows = billing.list_events(principal_of(user))
    assert len(rows) == 1
    row = rows[0]
    assert row["event"] == "subscription_payment_success"
    assert row["amount_usd"] == 10.0  # 1000 cents
    assert row["credits_granted"] == 500  # pro_monthly grant
    assert row["created_at"] > 0
    # ...and the wallet really was topped up exactly once.
    assert auth.get_ai_settings(user.id).credits == before + 500


def test_lifecycle_event_records_without_amount(billing, user):
    assert (
        billing.handle_webhook(
            subscription_webhook("evt-c1", user.id, "subscription_cancelled", "cancelled")
        )
        == "ok"
    )
    rows = billing.list_events(principal_of(user))
    assert [r["event"] for r in rows] == ["subscription_cancelled"]
    assert rows[0]["amount_usd"] is None
    assert rows[0]["credits_granted"] == 0


def test_duplicate_event_id_never_double_records(billing, auth, user):
    payload = payment_webhook("evt-dup", user.id)
    before = auth.get_ai_settings(user.id).credits
    assert billing.handle_webhook(payload) == "ok"
    assert billing.handle_webhook(payload) == "duplicate"  # LS retry
    assert billing.handle_webhook(payment_webhook("evt-dup", user.id)) == "duplicate"

    assert len(billing.list_events(principal_of(user))) == 1  # one history row
    assert auth.get_ai_settings(user.id).credits == before + 500  # one grant


def test_unhandled_or_anonymous_events_record_nothing(billing, user):
    # Unknown event name → ignored, no history.
    payload = payment_webhook("evt-x1", user.id)
    payload["meta"]["event_name"] = "order_created"
    assert billing.handle_webhook(payload) == "ignored"
    # Missing custom_data.user_id → ignored, no history.
    orphan = payment_webhook("evt-x2", "")
    orphan["meta"]["custom_data"] = {}
    assert billing.handle_webhook(orphan) == "ignored"
    assert billing.list_events(principal_of(user)) == []


# ---- customer portal ------------------------------------------------------------


def test_portal_urls_captured_on_subscription_webhook(billing, repo, user):
    billing.handle_webhook(subscription_webhook("evt-p1", user.id))
    sub = repo.get_subscription(user.id)
    assert sub.customer_portal_url == PORTAL
    assert sub.update_payment_method_url == UPDATE_PM
    # Exposed through GET /api/me/subscription's payload.
    info = billing.effective_tier(principal_of(user))
    assert info["customer_portal_url"] == PORTAL
    assert info["tier"] == "pro"


def test_portal_url_absent_until_delivered(billing, user):
    billing.handle_webhook(payment_webhook("evt-p2", user.id))  # invoice: no urls
    info = billing.effective_tier(principal_of(user))
    assert info["customer_portal_url"] is None


def test_portal_url_survives_url_less_followup(billing, repo, user):
    billing.handle_webhook(subscription_webhook("evt-p3", user.id))
    billing.handle_webhook(payment_webhook("evt-p4", user.id))  # no urls
    assert repo.get_subscription(user.id).customer_portal_url == PORTAL


# ---- listing: ordering, scoping, limits ------------------------------------------


def test_list_events_newest_first_scoped_and_limited(billing, auth, user):
    other, _ = auth.register("bob@example.com", "Bob", "correct-horse-9")
    billing.handle_webhook(subscription_webhook("evt-o1", user.id))
    billing.handle_webhook(payment_webhook("evt-o2", user.id))
    billing.handle_webhook(payment_webhook("evt-o3", other.id))  # someone else's

    rows = billing.list_events(principal_of(user))
    assert [r["event"] for r in rows] == [
        "subscription_payment_success",  # newest first
        "subscription_created",
    ]
    assert billing.list_events(principal_of(user), limit=1)[0]["event"] == (
        "subscription_payment_success"
    )
    # Bob only sees his own row.
    assert [r["event"] for r in billing.list_events(principal_of(other))] == [
        "subscription_payment_success"
    ]


def test_repo_list_events_returns_newest_first(repo):
    repo.add_event("u1", "subscription_created", None, 0, {})
    repo.add_event("u1", "subscription_payment_success", 10.0, 500, {"variant": "pro_monthly"})
    events = repo.list_events("u1")
    assert [e.event for e in events] == [
        "subscription_payment_success",
        "subscription_created",
    ]
    assert events[0].amount_usd == 10.0
    assert events[0].credits_granted == 500
    assert events[0].raw == {"variant": "pro_monthly"}


# ---- graceful degradation (no LEMONSQUEEZY_* config) -----------------------------


def test_history_empty_without_config_and_for_guests(billing, user):
    assert billing.list_events(principal_of(user)) == []  # no payments yet
    assert billing.list_events(Principal(kind="guest")) == []  # no identity


def test_checkout_still_503_without_config(billing, user):
    with pytest.raises(BillingUnavailable):
        billing.create_checkout(principal_of(user), "pro_monthly")
