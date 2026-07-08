"""Model pricing — the ONE baseline every token→money→credit computation uses.

Design (per product decision, 2026-07):
  * The price table lives in a versioned SEED file (``pricing_seed.json`` next
    to this module): USD list price per 1M tokens, split by token type
    (input / output / cache_read / cache_write), one entry per model, plus the
    credit anchor. Changing prices or adding a model = edit the JSON + bump
    ``version`` — nothing else in the codebase hardcodes a rate.
  * At boot the seed is MATERIALIZED into storage (Postgres table or
    ``storage/pricing.json`` — see infrastructure/*pricing_repository.py and
    ``create_app``): a newer seed version overwrites the stored catalog, so
    "update the JSON file, redeploy, it reflects".
  * A credit is MONEY, nothing else: ``credit_usd`` anchors 1 ✦ in USD
    (0.02 = the Pro plan: $10/month buys 500 ✦). Token costs convert to USD
    via the table, then to credits via that anchor.
  * Aliases map serving/deployment names onto their catalog row (the
    Databricks endpoint fronts claude-opus-4-8 — same weights, same price).
  * An UNKNOWN model resolves to ``None`` — callers record "cost unknown",
    never a guessed rate.

List prices in the seed were verified 2026-07 against the providers' public
pricing pages. (gemini-2.0-flash was shut down by Google on 2026-06-01 and is
deliberately absent.)

Domain-pure: stdlib only, imports nothing outward; reading the package-local
seed file is the domain's own data, not an outward dependency.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

_SEED_PATH = Path(__file__).with_name("pricing_seed.json")


def load_seed() -> dict:
    """The version-controlled seed catalog, as a plain dict."""
    return json.loads(_SEED_PATH.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class ModelPrice:
    """USD list price per 1M tokens for one model, by token type.
    A 0.0 rate means "not metered" (e.g. OpenAI has no cache-write premium)."""

    model: str  # canonical model id (the catalog key)
    provider: str  # claude | openai | gemini
    usd_input_mtok: float  # uncached input tokens
    usd_output_mtok: float  # output (completion) tokens
    usd_cache_read_mtok: float  # tokens served from the provider's prompt cache
    usd_cache_write_mtok: float  # tokens written to the cache
    aliases: tuple[str, ...] = field(default=())
    label: str = ""  # human name for the UI (falls back to `model` when empty)
    description: str = ""  # one-line "what it's good for" shown in pickers/usage


class PriceCatalog:
    """Immutable in-memory view of the materialized price table.

    Built once at boot from the stored catalog dict (``from_dict``); all cost
    math everywhere goes through this object — no module-level rate constants.
    """

    def __init__(self, version: int, credit_usd: float, models: list[ModelPrice]) -> None:
        self.version = int(version)
        self.credit_usd = float(credit_usd)
        self._by_model = {p.model: p for p in models}
        self._aliases = {a: p.model for p in models for a in p.aliases}

    @classmethod
    def from_dict(cls, data: dict) -> "PriceCatalog":
        models = [
            ModelPrice(
                model=str(m["model"]),
                provider=str(m.get("provider") or ""),
                usd_input_mtok=float(m.get("usd_input_mtok") or 0),
                usd_output_mtok=float(m.get("usd_output_mtok") or 0),
                usd_cache_read_mtok=float(m.get("usd_cache_read_mtok") or 0),
                usd_cache_write_mtok=float(m.get("usd_cache_write_mtok") or 0),
                aliases=tuple(m.get("aliases") or ()),
                label=str(m.get("label") or ""),
                description=str(m.get("description") or ""),
            )
            for m in (data.get("models") or [])
        ]
        return cls(
            version=int(data.get("version") or 0),
            credit_usd=float(data.get("credit_usd") or 0.02),
            models=models,
        )

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "credit_usd": self.credit_usd,
            "models": [
                {**asdict(p), "aliases": list(p.aliases)} for p in self._by_model.values()
            ],
        }

    # ---- lookups -----------------------------------------------------------

    def resolve(self, model: str) -> ModelPrice | None:
        """Catalog row for a model id or serving alias; None when not priced."""
        m = (model or "").strip()
        return self._by_model.get(self._aliases.get(m, m))

    def models(self) -> list[ModelPrice]:
        return list(self._by_model.values())

    def catalog(self) -> list[dict]:
        """UI-facing model list: id, provider, human label + description (label
        falls back to the model id). Used by the Credits/AI-provider screens."""
        return [
            {
                "model": p.model,
                "provider": p.provider,
                "label": p.label or p.model,
                "description": p.description,
            }
            for p in self._by_model.values()
        ]

    # ---- money math ----------------------------------------------------------

    def usd_to_credits(self, usd: float) -> float:
        """USD → ✦, rounded to 3 decimals (ledger precision)."""
        return round(usd / self.credit_usd, 3)

    def usage_cost_usd(self, usage: dict) -> float | None:
        """True USD cost of one call from its normalized usage dict.

        Expects the shape produced by ``AIService._extract_usage``: ``prompt``
        counts ALL input tokens (cached included), ``cache_read``/``cache_write``
        are the cached subsets, ``model`` names the model/endpoint that served
        the call. Returns None for unpriced models.
        """
        price = self.resolve(str(usage.get("model") or ""))
        if price is None:
            return None
        prompt = int(usage.get("prompt") or 0)
        cache_read = int(usage.get("cache_read") or 0)
        cache_write = int(usage.get("cache_write") or 0)
        uncached = max(0, prompt - cache_read - cache_write)
        return (
            uncached * price.usd_input_mtok
            + int(usage.get("completion") or 0) * price.usd_output_mtok
            + cache_read * price.usd_cache_read_mtok
            + cache_write * price.usd_cache_write_mtok
        ) / 1_000_000

    def usage_cost_credits(self, usage: dict) -> float | None:
        """True ✦ cost of one call, or None when the model isn't priced."""
        usd = self.usage_cost_usd(usage)
        return None if usd is None else self.usd_to_credits(usd)

    def credits_per_token_table(self) -> dict[str, dict[str, float]]:
        """Reference view: how many TOKENS one ✦ buys, per model & token type.
        Derived entirely from the catalog — never hand-maintained. A 0.0 USD
        rate (not metered) maps to 0."""

        def tokens_per_credit(usd_per_mtok: float) -> float:
            if usd_per_mtok <= 0:
                return 0
            return round(self.credit_usd / usd_per_mtok * 1_000_000)

        return {
            p.model: {
                "input": tokens_per_credit(p.usd_input_mtok),
                "output": tokens_per_credit(p.usd_output_mtok),
                "cache_read": tokens_per_credit(p.usd_cache_read_mtok),
                "cache_write": tokens_per_credit(p.usd_cache_write_mtok),
            }
            for p in self._by_model.values()
        }
