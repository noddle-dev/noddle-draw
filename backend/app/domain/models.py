"""Domain models — plain dataclasses, decoupled from HTTP/storage shapes."""
from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass, field


@dataclass
class Folder:
    """A folder grouping documents (flat, one level — like Lucid's My Documents).

    ``owner_id`` (DB v2, 2026-07-05): folders are per-user. ``None`` marks a
    LEGACY folder created before ownership existed — legacy folders stay
    visible to everyone (so nothing disappears after the migration) and keep
    the old open rename/delete behavior, mirroring legacy ownerless boards.
    """

    id: str
    name: str
    color: str
    created_at: float
    owner_id: str | None = None


# ---------------------------------------------------------------------------
# identity & access (ADR-0002)
# ---------------------------------------------------------------------------


@dataclass
class User:
    """A human account. Passwords: PBKDF2-HMAC-SHA256, salted per user."""

    id: str
    email: str
    name: str
    color: str
    password_hash: str  # "pbkdf2$<iters>$<salt-hex>$<hash-hex>"
    created_at: float
    # Profile completeness (WS1 2026-07-05) — defaults keep old records loading.
    avatar: str | None = None  # data:image/(png|jpeg|webp);base64,… or None
    title: str = ""  # job title / role shown on user cards (≤ 80 chars)


@dataclass
class Session:
    """A browser session (cookie holds the raw token; we store its sha256)."""

    token_hash: str
    user_id: str
    created_at: float
    expires_at: float


@dataclass
class ApiToken:
    """A programmatic principal — how AI AGENTS collaborate natively.

    The raw ``noddle_…`` secret is shown exactly once; only its sha256 lives at
    rest. A token is a first-class AGENT identity (own name/color, appears in
    presence and audit as itself), owned by a user, restricted by scopes.
    """

    id: str
    user_id: str
    name: str  # agent display name, e.g. "Claude release bot"
    token_hash: str
    scopes: list[str] = field(default_factory=lambda: ["boards:read"])
    created_at: float = 0.0
    last_used_at: float | None = None


@dataclass
class Team:
    """A flat team: members map user_id → role ("admin" | "member")."""

    id: str
    name: str
    created_at: float
    members: dict[str, str] = field(default_factory=dict)


@dataclass
class AISettings:
    """Per-user AI provider preferences (ADR: per-user AI routing).

    Two modes:
      * ``subscription`` — the user draws from a credit balance and calls run
        against the shared Databricks pool (the "subscription" backend).
      * ``byok`` — the user brings their own key for ``claude`` | ``openai`` |
        ``gemini``; calls run against that provider and never touch credits.

    ``api_key_enc`` holds the BYOK key OBFUSCATED at rest (base64 + XOR with a
    settings-derived key — a mockup stand-in). PROD MUST replace this with a
    real KMS / envelope-encryption scheme; XOR is reversible by anyone who
    reads the source + env and is NOT real encryption.
    """

    user_id: str
    mode: str = "subscription"  # subscription | byok
    provider: str = "claude"  # claude | openai | gemini | custom (OpenAI-compatible)
    api_key_enc: str = ""  # obfuscated at rest — never the raw key
    credits: int = 50
    model: str = ""  # BYOK model override; "" ⇒ the provider's default model
    # LiteLLM-style: for provider "custom", the OpenAI-compatible base URL
    # (OpenRouter / Together / Groq / vLLM / Ollama / a LiteLLM proxy / Azure).
    # Ignored by the built-in providers, which have fixed endpoints.
    api_base: str = ""
    credits_month: str = ""  # "YYYY-MM" stamp of the last monthly rollover
    month_spent: int = 0  # credits spent since the month stamp (UI meter)
    # NAMED BYOK profiles (2026-07): a user can save several key configs and
    # pick one per chat. Each dict is
    # ``{id, name, provider, api_key_enc, model, api_base}`` — same obfuscation
    # for ``api_key_enc`` as the single-config field above. ``byok_active_id``
    # names the profile a byok-mode call resolves against.
    # BACK-COMPAT: the single fields (provider/api_key_enc/model/api_base) stay
    # authoritative until the first named profile is added; when no profiles
    # exist AuthService surfaces the legacy config as a synthetic "Default"
    # profile (read-only view + resolve) rather than rewriting the record.
    byok_profiles: list[dict] = field(default_factory=list)
    byok_active_id: str = ""


@dataclass
class Subscription:
    """A user's paid plan (Lemon Squeezy-backed billing).

    One row per user (``user_id`` is unique). ``tier`` is what the user PAYS
    for; the effective tier a request sees also considers team subscriptions
    and the cancelled-but-paid-until grace window (see ``services.billing``).
    ``current_period_end`` is an epoch float (``renews_at``/``ends_at`` from
    Lemon Squeezy); ``team_id`` links a "team" tier purchase to one team.
    """

    user_id: str
    tier: str = "free"  # free | pro | team
    status: str = "active"  # active | past_due | cancelled
    billing_interval: str | None = None  # month | year | None
    current_period_end: float | None = None
    ls_customer_id: str = ""
    ls_subscription_id: str = ""
    team_id: str | None = None
    created_at: float = 0.0
    updated_at: float = 0.0
    # Lemon Squeezy self-service links (captured from subscription webhook
    # payloads at ``attributes.urls``) — power the "Manage billing" button.
    customer_portal_url: str = ""
    update_payment_method_url: str = ""


@dataclass
class BillingEvent:
    """One row of a user's billing history (webhook-driven, append-only).

    Written by ``BillingService.handle_webhook`` for every processed event
    that touches an account: payments (with the invoice amount + ✦ granted)
    and subscription lifecycle changes. ``raw`` holds a COMPACT summary of
    the Lemon Squeezy payload (variant/status/ids) — never the full webhook
    body (that would duplicate LS's own event history and its PII).
    """

    user_id: str
    event: str  # LS event name, e.g. "subscription_payment_success"
    created_at: float
    amount_usd: float | None = None  # invoice total in USD, when known
    credits_granted: int = 0  # ✦ granted by this event (payments only)
    raw: dict = field(default_factory=dict)


@dataclass
class DocumentMeta:
    """Metadata about a stored document (what lives in the index).

    Access model (checked by ``services.authz.can``):
      owner → per-user ``shares`` role (editor|viewer) → team role →
      ``link_policy`` for everyone else (edit | view | private).
    New boards are PRIVATE by default (amendment 2026-07-05) — the owner must
    explicitly turn link sharing on. Existing stored metas keep whatever
    ``link_policy`` was persisted (owners may have shared intentionally);
    legacy ownerless boards (owner_id None) stay reachable per their stored
    policy by direct link only, and nobody can manage them.
    """

    id: str
    name: str
    created_at: float
    updated_at: float
    folder_id: str | None = None
    owner_id: str | None = None
    team_id: str | None = None
    link_policy: str = "private"  # edit | view | private
    shares: dict[str, str] = field(default_factory=dict)  # user_id → role


def listed_for(
    meta: DocumentMeta, user_id: str | None, team_ids: Collection[str]
) -> bool:
    """Whether a board belongs in this user's DASHBOARD LIST.

    Stricter than ``can(view)``: link-accessible boards are reachable by URL
    only — they never leak into a stranger's file list (Lucid/Figma
    semantics). Ownerless (legacy) boards are listed to NOBODY (ADR-0002
    amendment #2). This is the ONE Python copy of the rule —
    ``services.auth.is_listed`` and the file adapter's ``list_for_user``
    both delegate here, and the Pg adapter mirrors it in SQL (keep in sync).
    """
    if meta.owner_id is None or not user_id:
        return False
    return (
        user_id == meta.owner_id
        or user_id in meta.shares
        or (meta.team_id is not None and meta.team_id in team_ids)
    )


@dataclass
class Document:
    """A document: metadata + the (sanitized) SVG payload + optional diagram.

    ``diagram`` is the editable node/edge JSON produced by the frontend's
    diagram layer (noddle's own model). The SVG remains the render/export shape
    while the diagram JSON is what makes a board round-trip editable.
    """

    meta: DocumentMeta
    svg: str
    diagram: dict | None = field(default=None)


@dataclass
class DocumentVersion:
    """A point-in-time snapshot of a document's payload (svg + diagram).

    Written on every save (coalesced — rapid autosaves overwrite the newest
    snapshot instead of stacking), capped per document. Restore is CLIENT-driven:
    the frontend fetches a version and PUTs it back as a normal save, so the
    restore itself becomes the newest version and flows through the usual
    sanitize/validate path.
    """

    id: str
    doc_id: str
    created_at: float
    author_name: str = ""
    svg: str = ""
    diagram: dict | None = None


@dataclass
class Comment:
    """A comment pinned to a board.

    A thread ROOT carries an ``anchor`` — ``{"kind": "node"|"edge", "ref": id}``
    (follows the object) or ``{"kind": "point", "x": f, "y": f}`` (fixed content
    coords). Replies carry ``parent_id`` (one level deep — replies to a root
    only) and no anchor. ``author_id`` is ``None`` for link guests; the display
    name/color are captured at write time so threads survive account changes.
    """

    id: str
    doc_id: str
    body: str
    author_name: str
    created_at: float
    updated_at: float
    author_id: str | None = None
    author_color: str = "#9aa1ad"
    page_id: str | None = None
    parent_id: str | None = None
    anchor: dict | None = None
    mentions: list[str] = field(default_factory=list)  # mentioned user ids
    resolved: bool = False
