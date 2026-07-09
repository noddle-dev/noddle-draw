"""The zero-cost shared AI tier (services/pool.py) + its API wiring."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.ai import AIService, ProviderSettings
from app.services.pool import FreePool, PoolLimited


@pytest.fixture()
def pool(monkeypatch) -> FreePool:
    monkeypatch.setenv("OPENROUTER_POOL_KEY", "sk-or-pool")
    monkeypatch.setenv("POOL_RPM_PER_IP", "2")
    monkeypatch.setenv("POOL_RPD_PER_IP", "3")
    monkeypatch.setenv("POOL_DAILY_BUDGET", "5")
    return FreePool()


def test_pool_settings_use_openrouter_free_model(pool):
    assert pool.available()
    s = pool.settings()
    assert s.provider == "openrouter" and s.api_key == "sk-or-pool"
    assert s.model.endswith(":free")


def test_per_minute_limit(pool):
    pool.check("1.2.3.4", None)
    pool.check("1.2.3.4", None)
    with pytest.raises(PoolLimited) as e:
        pool.check("1.2.3.4", None)
    assert e.value.status == 429 and "per minute" in str(e.value)
    # another IP is unaffected
    pool.check("5.6.7.8", None)


def test_per_day_limit(pool, monkeypatch):
    # widen the minute window so we hit the DAY cap
    pool.rpm_per_ip = 100
    for _ in range(3):
        pool.check("1.2.3.4", None)
    with pytest.raises(PoolLimited) as e:
        pool.check("1.2.3.4", None)
    assert e.value.status == 429 and "free AI requests" in str(e.value)


def test_global_daily_budget_fails_closed(pool):
    pool.rpm_per_ip = 100
    pool.rpd_per_ip = 100
    for i in range(5):
        pool.check(f"10.0.0.{i}", None)
    with pytest.raises(PoolLimited) as e:
        pool.check("10.0.0.99", None)
    assert e.value.status == 503 and "used up for today" in str(e.value)


def test_turnstile_required_when_configured(monkeypatch):
    monkeypatch.setenv("OPENROUTER_POOL_KEY", "sk-or-pool")
    monkeypatch.setenv("TURNSTILE_SECRET", "s3cr3t")
    pool = FreePool()
    with pytest.raises(PoolLimited) as e:
        pool.check("1.2.3.4", None)  # no token at all → fail closed
    assert e.value.status == 403
    monkeypatch.setattr(FreePool, "_verify_turnstile", lambda self, t: t == "good")
    pool.check("1.2.3.4", "good")  # verified token passes


def test_unconfigured_pool_is_off(monkeypatch):
    monkeypatch.delenv("OPENROUTER_POOL_KEY", raising=False)
    assert FreePool().available() is False


# ---- API wiring -----------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("OPENROUTER_POOL_KEY", "sk-or-pool")
    monkeypatch.delenv("DATABRICKS_HOST", raising=False)
    monkeypatch.delenv("DATABRICKS_TOKEN", raising=False)
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    captured: dict = {}

    def fake_text_to_diagram(self, text, format="diagram", settings=None):  # noqa: ANN001, A002
        captured["settings"] = settings
        return {"nodes": [], "edges": []}

    monkeypatch.setattr(AIService, "text_to_diagram", fake_text_to_diagram)
    c = TestClient(create_app(Settings(storage_dir=tmp_path)))
    c.captured = captured  # type: ignore[attr-defined]
    return c


def test_keyless_request_rides_the_free_pool(client):
    r = client.post("/api/ai/text-to-diagram", json={"text": "a flow"})
    assert r.status_code == 200
    s = client.captured["settings"]
    assert isinstance(s, ProviderSettings)
    assert s.provider == "openrouter" and s.api_key == "sk-or-pool"


def test_byok_still_wins_over_the_pool(client):
    r = client.post(
        "/api/ai/text-to-diagram",
        json={"text": "a flow"},
        headers={"X-AI-Provider": "claude", "X-AI-Key": "sk-ant-mine"},
    )
    assert r.status_code == 200
    assert client.captured["settings"].api_key == "sk-ant-mine"


def test_pool_limit_surfaces_as_429(client):
    client.app.state.free_pool.rpm_per_ip = 1
    assert client.post("/api/ai/text-to-diagram", json={"text": "a"}).status_code == 200
    r = client.post("/api/ai/text-to-diagram", json={"text": "b"})
    assert r.status_code == 429
    assert "free tier" in r.json()["detail"]


def test_config_reports_pool_and_turnstile(client):
    cfg = client.get("/api/config").json()
    assert cfg["pool_ai"] is True
    assert cfg["turnstile_site_key"] is None
