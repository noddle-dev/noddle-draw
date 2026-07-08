"""AIUsageLedger — append-only per-call token/cost accounting.

One JSONL line per SUCCESSFUL AI call (failed calls are refunded and carry no
usable output; providers may still bill them, but the ledger tracks delivered
value): who, which action, which mode/model, the normalized token counts
(prompt / completion / cache_read / cache_write — see AIService._extract_usage)
and both sides of the money:

  * ``credits_charged`` — the flat, user-facing price actually debited
    (AI_CREDIT_COSTS; 0 for BYOK/guests).
  * ``credits_cost`` — the TRUE cost derived from the pricing catalog
    (domain/pricing.py); ``null`` when the model isn't in the catalog —
    recorded as unknown, never guessed.

File-based like ``storage/audit.log`` (stays file-based even under Postgres).
Reads are month-scoped full scans — fine at this scale; revisit if the file
grows past a few hundred thousand lines.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

from app.domain.pricing import PriceCatalog
from app.services.log_rotation import rotate_if_needed
from app.services.object_storage import ObjectStorage

logger = logging.getLogger("noddle")

LEDGER_FILENAME = "ai_usage.jsonl"


class AIUsageLedger:
    """Owns the append-only usage file + the month-summary read model.
    Cost math goes through the injected ``PriceCatalog`` (the materialized
    baseline price table) — no rates live here."""

    def __init__(
        self,
        storage_dir: Path,
        pricing: PriceCatalog,
        storage: ObjectStorage | None = None,
        store: object | None = None,
    ) -> None:
        # ``store`` (a PgUsageStore) is the production DB backend; the JSONL
        # file below is the local-dev fallback (2026-07-06 "no local files"
        # rule). Aggregation (usage_report/month_summary) is backend-agnostic —
        # it consumes entries from whichever source _iter_entries yields.
        self._path = Path(storage_dir) / LEDGER_FILENAME
        self._pricing = pricing
        self._storage = storage
        self._store = store
        self._lock = threading.Lock()

    def record(
        self,
        user_id: str,
        action: str,  # image_to_svg | text_to_diagram | edit_diagram
        mode: str,  # subscription | byok | pool (guests/agents)
        usage: dict,  # normalized — AIService._extract_usage shape
        credits_charged: int,
    ) -> dict:
        """Append one call. Never raises — accounting must not fail the call."""
        entry = {
            "ts": time.time(),
            "user_id": user_id,
            "action": action,
            "mode": mode,
            "model": str(usage.get("model") or ""),
            "prompt": int(usage.get("prompt") or 0),
            "completion": int(usage.get("completion") or 0),
            "cache_read": int(usage.get("cache_read") or 0),
            "cache_write": int(usage.get("cache_write") or 0),
            "credits_charged": int(credits_charged),
            "credits_cost": self._pricing.usage_cost_credits(usage),
            "usd_cost": self._pricing.usage_cost_usd(usage),
        }
        try:
            if self._store is not None:
                self._store.append(entry)
                return entry
            with self._lock:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                rotate_if_needed(self._path, self._storage, remote_prefix="logs/ai_usage")
                with self._path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, separators=(",", ":")) + "\n")
        except Exception as e:  # noqa: BLE001 — accounting must not fail the call
            logger.warning("AI usage ledger write failed: %s", e)
        return entry

    def _iter_entries(self, user_id: str, since_ts: float | None = None):
        """Yield this user's ledger entries (oldest→newest). DB backend when a
        store is wired; otherwise across rotated segments + the live file.
        Corrupt lines are skipped; missing files ignored."""
        if self._store is not None:
            try:
                yield from self._store.iter_entries(user_id, since_ts)
            except Exception as e:  # noqa: BLE001
                logger.warning("AI usage ledger read failed: %s", e)
            return
        paths = sorted(self._path.parent.glob(f"{self._path.name}.2*")) + [self._path]
        for path in paths:
            try:
                with path.open("r", encoding="utf-8") as f:
                    for line in f:
                        try:
                            e = json.loads(line)
                        except ValueError:
                            continue
                        if e.get("user_id") == user_id:
                            yield e
            except FileNotFoundError:
                pass
            except OSError as e:
                logger.warning("AI usage ledger read failed: %s", e)

    def usage_report(self, user_id: str, days: int = 30, recent: int = 20) -> dict:
        """Provider-dashboard-style report over the last ``days`` UTC days:
        per-day series, per-action + per-model breakdowns, window totals, and
        the most recent ``recent`` calls. Powers the Settings → Usage screen."""
        now = time.time()
        window = max(1, int(days))
        start = now - window * 86400
        # Seed every day in the window so the chart has no gaps.
        day_keys = [
            time.strftime("%Y-%m-%d", time.gmtime(now - i * 86400))
            for i in range(window - 1, -1, -1)
        ]
        per_day = {d: {"date": d, "calls": 0, "credits": 0, "tokens": 0, "usd": 0.0} for d in day_keys}
        by_action: dict[str, dict] = {}
        by_model: dict[str, dict] = {}
        by_mode: dict[str, dict] = {}  # subscription | byok | pool — BYOK spends 0 ✦
        total = {"calls": 0, "credits": 0, "tokens": 0, "usd": 0.0}
        recent_calls: list[dict] = []

        for e in self._iter_entries(user_id, since_ts=start):
            ts = float(e.get("ts") or 0)
            if ts < start:
                continue
            tokens = int(e.get("prompt") or 0) + int(e.get("completion") or 0)
            credits = int(e.get("credits_charged") or 0)
            usd = float(e.get("usd_cost") or 0.0)
            d = time.strftime("%Y-%m-%d", time.gmtime(ts))
            if d in per_day:
                per_day[d]["calls"] += 1
                per_day[d]["credits"] += credits
                per_day[d]["tokens"] += tokens
                per_day[d]["usd"] += usd
            action = str(e.get("action") or "?")
            a = by_action.setdefault(action, {"calls": 0, "credits": 0, "tokens": 0})
            a["calls"] += 1; a["credits"] += credits; a["tokens"] += tokens
            model = str(e.get("model") or "?")
            m = by_model.setdefault(model, {"calls": 0, "tokens": 0})
            m["calls"] += 1; m["tokens"] += tokens
            mode = str(e.get("mode") or "pool")
            md = by_mode.setdefault(mode, {"calls": 0, "credits": 0, "tokens": 0})
            md["calls"] += 1; md["credits"] += credits; md["tokens"] += tokens
            total["calls"] += 1; total["credits"] += credits
            total["tokens"] += tokens; total["usd"] += usd
            recent_calls.append({
                "ts": ts, "action": action, "model": model, "mode": mode,
                "prompt": int(e.get("prompt") or 0), "completion": int(e.get("completion") or 0),
                "credits_charged": credits, "usd_cost": round(usd, 6),
            })

        recent_calls.sort(key=lambda r: r["ts"], reverse=True)
        total["usd"] = round(total["usd"], 4)
        for v in per_day.values():
            v["usd"] = round(v["usd"], 4)
        return {
            "days": list(per_day.values()),
            "by_action": by_action,
            "by_model": by_model,
            "by_mode": by_mode,
            "total": total,
            "recent": recent_calls[:recent],
            "window_days": window,
        }

    def month_summary(self, user_id: str) -> dict:
        """Aggregate of this user's calls in the current UTC month (UI meter)."""
        month = time.strftime("%Y-%m", time.gmtime())
        out = {
            "calls": 0,
            "prompt": 0,
            "completion": 0,
            "cache_read": 0,
            "cache_write": 0,
            "credits_charged": 0,
        }
        # Bound the scan to the start of the UTC month, then filter exactly by
        # month string. Backend-agnostic: _iter_entries reads the DB store when
        # wired, else the rotated segments + live file (the retained segments
        # cover far more than one month at the 10MB rotation cap).
        month_start = time.mktime(time.strptime(month + "-01", "%Y-%m-%d"))
        for e in self._iter_entries(user_id, since_ts=month_start - 86400):
            if time.strftime("%Y-%m", time.gmtime(float(e.get("ts") or 0))) != month:
                continue
            out["calls"] += 1
            for k in ("prompt", "completion", "cache_read", "cache_write", "credits_charged"):
                out[k] += int(e.get(k) or 0)
        return out
