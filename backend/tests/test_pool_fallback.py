"""The free pool tries its model chain in groups of 3 (OpenRouter's `models`
limit): a 429 / dead slug on one group moves on to the next."""

from __future__ import annotations

import pytest

from app.services.ai import AIService, AIUnavailable, ProviderSettings
from app.services.pool import DEFAULT_POOL_MODEL


def _svc_calls(monkeypatch, fail_first: str | None):
    calls: list[list[str]] = []

    def fake(self, url, headers, model, messages, max_tokens, timeout=None, extra_body=None, **kw):
        calls.append((extra_body or {}).get("models") or [model])
        if fail_first and len(calls) == 1:
            raise AIUnavailable(fail_first)
        return "ok"

    monkeypatch.setattr(AIService, "_chat_openai_compatible", fake)
    return calls


def test_rate_limited_group_falls_through_to_next(monkeypatch):
    calls = _svc_calls(monkeypatch, "AI provider is temporarily unavailable (HTTP 429): rate-limited upstream")
    s = ProviderSettings(provider="openrouter", api_key="k", model=DEFAULT_POOL_MODEL)
    assert AIService()._chat([{"role": "user", "content": "hi"}], 10, settings=s) == "ok"
    chain = [m.strip() for m in DEFAULT_POOL_MODEL.split(",")]
    assert calls == [chain[:3], chain[3:6]]


def test_other_errors_are_not_masked(monkeypatch):
    calls = _svc_calls(monkeypatch, "AI provider returned HTTP 400: bad request")
    s = ProviderSettings(provider="openrouter", api_key="k", model=DEFAULT_POOL_MODEL)
    with pytest.raises(AIUnavailable):
        AIService()._chat([{"role": "user", "content": "hi"}], 10, settings=s)
    assert len(calls) == 1


def test_default_chain_has_no_retired_slugs():
    assert "gpt-oss-120b:free" not in DEFAULT_POOL_MODEL
    assert "llama-3.3-70b-instruct:free" not in DEFAULT_POOL_MODEL
    assert len([m for m in DEFAULT_POOL_MODEL.split(",") if m.strip()]) >= 4
