"""The lenient JSON pipeline that killed "Result was not valid JSON"."""
from __future__ import annotations

import pytest

from app.services.ai import AIService, AIBadOutput, _loads_lenient


GOOD = '{"message":"ok","diagram":{"nodes":[],"edges":[]}}'


def test_plain_json_passes():
    assert _loads_lenient(GOOD)["message"] == "ok"


def test_prose_and_fences_around_the_object():
    txt = "Sure! Here is the updated diagram:\n```json\n" + GOOD + "\n```\nHope it helps."
    assert _loads_lenient(txt)["diagram"] == {"nodes": [], "edges": []}


def test_trailing_commas_and_python_literals():
    txt = '{"message":"ok","flag":True,"empty":None,"diagram":{"nodes":[{"id":"a",},],"edges":[],},}'
    data = _loads_lenient(txt)
    assert data["flag"] is True and data["empty"] is None
    assert data["diagram"]["nodes"][0]["id"] == "a"


def test_truncated_reply_is_salvaged():
    # cut mid-way through the edges list AND inside a string
    txt = '{"message":"ok","diagram":{"nodes":[{"id":"a","text":"Us'
    data = _loads_lenient(txt)
    assert data["message"] == "ok"
    assert data["diagram"]["nodes"][0]["id"] == "a"


def test_garbage_still_raises():
    with pytest.raises(ValueError):
        _loads_lenient("I could not produce a diagram, sorry.")


def test_chat_json_corrective_retry(monkeypatch):
    calls: list[list[dict]] = []

    def fake_chat(self, messages, max_tokens, settings=None, endpoint=None, timeout=None):  # noqa: ANN001
        calls.append(messages)
        return "definitely not json" if len(calls) == 1 else GOOD

    monkeypatch.setattr(AIService, "_chat", fake_chat)
    svc = AIService()
    data, raw = svc._chat_json([{"role": "user", "content": "hi"}], max_tokens=10)
    assert data["message"] == "ok"
    assert len(calls) == 2
    # the retry shows the model its own broken output + the corrective ask
    assert calls[1][-2]["role"] == "assistant"
    assert "NOT valid JSON" in calls[1][-1]["content"]


def test_chat_json_gives_up_after_one_retry(monkeypatch):
    monkeypatch.setattr(
        AIService, "_chat",
        lambda self, *a, **k: "nope, still prose",
    )
    with pytest.raises(AIBadOutput):
        AIService()._chat_json([{"role": "user", "content": "hi"}], max_tokens=10)
