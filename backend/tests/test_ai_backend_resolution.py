"""Per-request BYOK resolution (api/ai.py::_resolve_backend).

The client sends its provider/key/model in X-AI-* headers; the server proxies
and never stores the key. No key → the shared Databricks pool when configured
→ else 503. Provider validation errors are 400s.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.ai import AIService, ProviderSettings


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    captured: dict = {}

    def fake_text_to_diagram(self, text, format="diagram", settings=None):  # noqa: ANN001, A002
        captured["settings"] = settings
        return {"nodes": [], "edges": []}

    monkeypatch.setattr(AIService, "text_to_diagram", fake_text_to_diagram)
    c = TestClient(create_app(Settings(storage_dir=tmp_path)))
    c.captured = captured  # type: ignore[attr-defined]
    return c


def _call(client: TestClient, headers: dict | None = None):
    return client.post(
        "/api/ai/text-to-diagram", json={"text": "a flowchart"}, headers=headers or {}
    )


def test_byok_headers_resolve_to_provider_settings(client):
    r = _call(
        client,
        {
            "X-AI-Provider": "claude",
            "X-AI-Key": "sk-ant-test",
            "X-AI-Model": "claude-sonnet-5",
        },
    )
    assert r.status_code == 200
    s = client.captured["settings"]
    assert isinstance(s, ProviderSettings)
    assert s.provider == "claude" and s.api_key == "sk-ant-test"
    assert s.model == "claude-sonnet-5" and s.api_base == ""


def test_custom_provider_requires_base_url(client):
    r = _call(client, {"X-AI-Provider": "custom", "X-AI-Key": "k"})
    assert r.status_code == 400
    assert "X-AI-Base" in r.json()["detail"]
    ok = _call(
        client,
        {"X-AI-Provider": "custom", "X-AI-Key": "k", "X-AI-Base": "https://llm.local/v1"},
    )
    assert ok.status_code == 200
    assert client.captured["settings"].api_base == "https://llm.local/v1"


def test_unknown_provider_is_rejected(client):
    r = _call(client, {"X-AI-Provider": "skynet", "X-AI-Key": "k"})
    assert r.status_code == 400


def test_no_key_with_pool_uses_the_pool(client, monkeypatch):
    monkeypatch.setattr(AIService, "pool_available", staticmethod(lambda: True))
    r = _call(client)
    assert r.status_code == 200
    assert client.captured["settings"] is None  # None ⇒ shared Databricks pool


def test_no_key_and_no_pool_is_503(client, monkeypatch):
    monkeypatch.setattr(AIService, "pool_available", staticmethod(lambda: False))
    client.captured.clear()
    r = _call(client)
    assert r.status_code == 503
    assert "AI settings" in r.json()["detail"]
    assert "settings" not in client.captured  # the provider was never called


def test_key_endpoint_round_trips(client, monkeypatch):
    monkeypatch.setattr(
        AIService, "test_key", lambda self, settings: settings.model or "default-model"
    )
    r = client.post(
        "/api/ai/test-key",
        headers={"X-AI-Provider": "openai", "X-AI-Key": "sk-x", "X-AI-Model": "gpt-5"},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "message": "Key works — model: gpt-5."}


def test_key_endpoint_reports_bad_key_as_ok_false(client, monkeypatch):
    from app.services.ai import AIUnavailable

    def boom(self, settings):
        raise AIUnavailable("provider rejected the key")

    monkeypatch.setattr(AIService, "test_key", boom)
    r = client.post(
        "/api/ai/test-key", headers={"X-AI-Provider": "claude", "X-AI-Key": "bad"}
    )
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "rejected" in r.json()["message"]


def test_key_endpoint_requires_a_key(client):
    assert client.post("/api/ai/test-key").status_code == 400


def test_config_reports_pool_flag(client, monkeypatch):
    client.app.state.free_pool._key = ""  # free pool off for this check
    monkeypatch.setattr(AIService, "pool_available", staticmethod(lambda: True))
    assert client.get("/api/config").json()["pool_ai"] is True
    monkeypatch.setattr(AIService, "pool_available", staticmethod(lambda: False))
    assert client.get("/api/config").json()["pool_ai"] is False
