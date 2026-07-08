"""Unit tests for the background image→board job queue (services/ai_jobs.py).

Real ``FileDocumentRepository`` + ``DocumentService`` on a tmp dir, fake AI
service — exercises the worker pool end-to-end: submit → converted → a real
document exists; failure → refund + error status; orphaned running jobs from
a dead process heal to error on read.
"""
from __future__ import annotations

import time

import pytest

from app.infrastructure.file_repository import FileDocumentRepository
from app.services.ai import AIRetryable, AIUnavailable
from app.services import ai_jobs as ai_jobs_mod
from app.services.ai_jobs import _RESTART_ERROR, AIJobService
from app.services.documents import DocumentService

DIAGRAM = {
    "nodes": [
        {"id": "a", "kind": "rounded", "x": 60, "y": 60, "w": 160, "h": 80,
         "text": "Start", "fill": "#eef4ff", "stroke": "#2563eb", "strokeWidth": 2},
    ],
    "edges": [],
}


class FakeAI:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.calls = 0

    def image_to_diagram(self, raw, media_type, prompt, settings=None):  # noqa: ANN001
        self.calls += 1
        if self.fail:
            raise AIUnavailable("provider says no")
        return {"nodes": [dict(n) for n in DIAGRAM["nodes"]], "edges": []}

    def last_call_usage(self) -> dict:
        return {"prompt": 5, "completion": 7}


def wait_done(svc: AIJobService, user: str, job_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = svc.get(user, job_id)
        assert job is not None
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.05)
    pytest.fail("job never finished")


def make(tmp_path, ai) -> tuple[AIJobService, DocumentService]:
    docs = DocumentService(FileDocumentRepository(tmp_path))
    return AIJobService(tmp_path, docs, ai), docs


def submit(svc: AIJobService, refunds: list, usages: list) -> dict:
    return svc.submit(
        user_id="u1",
        name="sketch.png",
        prompt="make it blue",
        raw=b"\x89PNG",
        media_type="image/png",
        backend=None,
        refund=lambda: refunds.append(1),
        record_usage=usages.append,
        now=time.time(),
    )


def test_submit_converts_and_creates_owned_board(tmp_path):
    svc, docs = make(tmp_path, FakeAI())
    refunds, usages = [], []
    job = submit(svc, refunds, usages)
    assert job["status"] == "queued"
    done = wait_done(svc, "u1", job["id"])
    assert done["status"] == "done" and done["doc_id"]
    doc = docs.get(done["doc_id"])
    assert doc.meta.owner_id == "u1"
    assert doc.meta.name == "sketch (AI redraw)"
    # the board is EDITABLE diagram JSON (predefined shapes), not freeform SVG
    assert doc.diagram is not None
    nodes = doc.diagram.get("nodes") or doc.diagram.get("pages", [{}])[0].get("nodes")
    assert nodes and nodes[0]["kind"] == "rounded" and nodes[0]["text"] == "Start"
    # plus a server-rendered preview svg wrapped as a bake (stripped on open)
    assert "noddle-diagram-baked" in doc.svg
    assert usages == [{"prompt": 5, "completion": 7}]  # ledger fed on success
    assert refunds == []  # success never refunds


def test_failure_refunds_and_records_error(tmp_path):
    svc, _ = make(tmp_path, FakeAI(fail=True))
    refunds, usages = [], []
    job = submit(svc, refunds, usages)
    done = wait_done(svc, "u1", job["id"])
    assert done["status"] == "error"
    assert "provider says no" in done["error"]
    assert refunds == [1]  # the up-front charge came back
    assert usages == []


def test_history_newest_first_and_delete(tmp_path):
    svc, _ = make(tmp_path, FakeAI())
    refunds, usages = [], []
    j1 = submit(svc, refunds, usages)
    j2 = submit(svc, refunds, usages)
    wait_done(svc, "u1", j1["id"])
    wait_done(svc, "u1", j2["id"])
    ids = [j["id"] for j in svc.list_for_user("u1")]
    assert set(ids) == {j1["id"], j2["id"]}
    assert svc.delete("u1", j1["id"]) is True
    assert [j["id"] for j in svc.list_for_user("u1")] == [j2["id"]]
    # someone else's job is invisible
    assert svc.get("u2", j2["id"]) is None
    assert svc.delete("u2", j2["id"]) is False


class FlakyAI(FakeAI):
    """Transient failures for the first N calls, then success."""

    def __init__(self, fail_times: int, forever: bool = False) -> None:
        super().__init__()
        self.fail_times = fail_times
        self.forever = forever

    def image_to_diagram(self, raw, media_type, prompt, settings=None):  # noqa: ANN001
        self.calls += 1
        if self.forever or self.calls <= self.fail_times:
            raise AIRetryable("model is overloaded")
        return {"nodes": [dict(n) for n in DIAGRAM["nodes"]], "edges": []}


def test_transient_provider_errors_are_retried(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_jobs_mod, "_BACKOFFS", (0.0, 0.0))
    ai = FlakyAI(fail_times=2)  # two overloads, third attempt succeeds
    svc, _ = make(tmp_path, ai)
    refunds, usages = [], []
    job = submit(svc, refunds, usages)
    done = wait_done(svc, "u1", job["id"])
    assert done["status"] == "done" and done["doc_id"]
    assert ai.calls == 3
    assert refunds == []  # user paid once, got a board


def test_persistent_transient_error_fails_after_all_attempts(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_jobs_mod, "_BACKOFFS", (0.0, 0.0))
    ai = FlakyAI(fail_times=0, forever=True)
    svc, _ = make(tmp_path, ai)
    refunds, usages = [], []
    job = submit(svc, refunds, usages)
    done = wait_done(svc, "u1", job["id"])
    assert done["status"] == "error"
    assert "overloaded" in done["error"]
    assert ai.calls == 3  # 1 + len(_BACKOFFS) attempts, then give up
    assert refunds == [1]  # charge came back


def test_orphaned_running_job_heals_to_error_on_read(tmp_path):
    svc, _ = make(tmp_path, FakeAI())
    # simulate a record left behind by a PREVIOUS process (not in _live)
    svc._save_record(  # noqa: SLF001 — arranging persisted state
        {
            "id": "deadbeef0000",
            "user_id": "u1",
            "name": "old.png",
            "prompt": "",
            "status": "processing",
            "error": "",
            "doc_id": "",
            "created_at": time.time() - 999,
            "updated_at": time.time() - 999,
        }
    )
    jobs = svc.list_for_user("u1")
    assert jobs[0]["status"] == "error"
    assert jobs[0]["error"] == _RESTART_ERROR
    # and the healing persisted
    again = svc.get("u1", "deadbeef0000")
    assert again is not None and again["status"] == "error"
