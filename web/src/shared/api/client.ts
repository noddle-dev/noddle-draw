/**
 * shared/api/client — typed fetch wrapper for the /api/documents endpoints.
 *
 * Contract mirrors backend (see backend/main.py / ADR-0001 api/documents.py):
 *   GET    /api/documents            -> DocMeta[]
 *   POST   /api/documents (FormData) -> DocMeta            (upload + sanitize)
 *   GET    /api/documents/{id}       -> { meta, svg }
 *   PUT    /api/documents/{id}       -> DocMeta            (body: { svg })
 *   DELETE /api/documents/{id}       -> { ok: true }
 *
 * In dev, Vite proxies /api → http://127.0.0.1:8000 (see vite.config.ts). In
 * prod the FastAPI app serves web/dist same-origin, so the base is "".
 *
 * Also wraps the /api/ai/* endpoints (image→SVG, text→diagram), whose payloads
 * reuse noddle's own diagram value types so the returned nodes/edges load
 * straight into diagramStore.
 */
import type { DiagramEdge, DiagramNode } from "../../editor-core/diagram";

const BASE = ""; // same-origin (dev: Vite proxy; prod: served by FastAPI)

export interface DocMeta {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  folder_id?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  link_policy?: "edit" | "view" | "private";
}

// ---- identity & access (ADR-0002) ----

export interface Me {
  kind: "user" | "agent" | "guest";
  id?: string;
  name?: string;
  email?: string;
  color?: string;
  /** Profile picture as a small data:image/… URL; null/absent → initials. */
  avatar?: string | null;
  /** Job title shown on user cards (≤ 80 chars). */
  title?: string;
}

/** PATCH /api/me — omitted fields keep their value; `avatar: null` removes. */
export interface MePatch {
  name?: string;
  color?: string;
  title?: string;
  avatar?: string | null;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  scopes: string[];
  created_at: number;
  last_used_at: number | null;
  /** Present ONLY in the create response — shown once, never again. */
  token?: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  created_at: number;
  members: {
    id: string;
    name: string;
    email: string;
    color: string;
    role: string;
    avatar?: string | null;
    title?: string;
  }[];
}

/** Per-user AI provider settings (subscription credits vs BYOK). */
export interface AiSettings {
  mode: "subscription" | "byok";
  provider: "claude" | "openai" | "gemini" | "openrouter" | "custom";
  /** BYOK model-id override; "" ⇒ the provider's default model. */
  model: string;
  /** For provider "custom": OpenAI-compatible base URL (LiteLLM pattern). */
  api_base: string;
  /** Current ✦ wallet balance. */
  credits: number;
  /** ✦ spent since the start of the current month (usage meter). */
  month_spent: number;
  /** The effective tier's monthly refill floor (free 25 / pro 500 / team 1000). */
  monthly_allowance: number;
  /** ✦ cost per AI action, e.g. { image_to_svg: 5, text_to_diagram: 2, edit_diagram: 1 }. */
  costs: Record<string, number>;
  /** Provider → default model id (UI placeholders for the override input). */
  default_models: Record<AiSettings["provider"], string>;
  /**
   * Token↔credit conversion, derived from the server's pricing catalog:
   * model → tokens one ✦ buys, per token type (input/output/cache_read/cache_write).
   * 0 = not metered for that type.
   */
  token_rates: Record<string, { input: number; output: number; cache_read: number; cache_write: number }>;
  /** This month's usage (from the per-call ledger). */
  usage: {
    calls: number;
    prompt: number;
    completion: number;
    cache_read: number;
    cache_write: number;
    credits_charged: number;
  };
  /** Masked BYOK key for display (e.g. `sk-…abcd`); null when none set.
   * Reflects the LEGACY single-config key (kept for back-compat). */
  masked_key: string | null;
  has_key: boolean;
  /** Priced models with human labels + descriptions (from the pricing catalog). */
  model_catalog?: { model: string; provider: string; label: string; description: string }[];
  /** NAMED BYOK profiles — several saved key configs; keys are always masked. */
  byok_profiles: ByokProfile[];
  /** Which profile byok-mode calls resolve against ("" when none). */
  byok_active_id: string;
}

/**
 * Per-call AI billing selector (the `backend` field of image-to-svg):
 * "" = follow the account's AI mode, "subscription" = force the ✦ wallet,
 * "byok" = the active profile, "byok:{profileId}" = that specific profile.
 */
export type AiBackendChoice = "" | "subscription" | "byok" | `byok:${string}`;

/** One server-side image→board conversion job (see /api/ai/jobs). */
export interface AiJobOut {
  id: string;
  name: string;
  prompt: string;
  status: "queued" | "processing" | "done" | "error";
  error: string;
  doc_id: string;
  created_at: number;
  updated_at: number;
}

/** One saved BYOK key config (key never leaves the server unmasked). */
export interface ByokProfile {
  id: string;
  name: string;
  provider: AiSettings["provider"];
  model: string;
  api_base: string;
  masked_key: string | null;
  has_key: boolean;
}

/** GET /api/me/usage — AI usage dashboard (from the per-call ledger). */
export interface UsageReport {
  days: { date: string; calls: number; credits: number; tokens: number; usd: number }[];
  by_action: Record<string, { calls: number; credits: number; tokens: number }>;
  by_model: Record<string, { calls: number; tokens: number }>;
  /** Breakdown by billing mode: subscription | byok | pool (BYOK spends 0 ✦). */
  by_mode: Record<string, { calls: number; credits: number; tokens: number }>;
  total: { calls: number; credits: number; tokens: number; usd: number };
  recent: {
    ts: number; action: string; model: string; mode: string;
    prompt: number; completion: number; credits_charged: number; usd_cost: number;
  }[];
  window_days: number;
}

/** Paid plan variants sold via Lemon Squeezy. */
export type PlanVariant = "pro_monthly" | "pro_yearly" | "team_yearly";

/** GET /api/me/subscription — the caller's effective plan. */
export interface SubscriptionInfo {
  tier: "free" | "pro" | "team";
  source: "personal" | "team" | "free";
  status: "active" | "past_due" | "cancelled" | null;
  current_period_end: number | null;
  /** Lemon Squeezy self-service portal ("Manage billing"); null until the
   * first subscription webhook delivers it. */
  customer_portal_url: string | null;
  features: { boards_max: number; ai_credits_month: number };
}

/** One row of GET /api/me/billing-events (newest first). */
export interface BillingEventOut {
  /** Lemon Squeezy event name, e.g. "subscription_payment_success". */
  event: string;
  /** Invoice total in USD (payments only); null when not applicable. */
  amount_usd: number | null;
  /** ✦ credits granted by this event (payments only). */
  credits_granted: number;
  created_at: number;
}

export interface SharesInfo {
  owner: { id: string; name: string; email: string; color: string } | null;
  shares: { id: string; name: string; email: string; color: string; role: string }[];
  link_policy: string;
  team_id: string | null;
}

/** Editable board payload persisted alongside the SVG. */
export interface DiagramPayload {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** A user's public profile as returned on documents/shares (no email needed). */
export interface PublicUser {
  id: string;
  name: string;
  color: string;
  avatar?: string | null;
  email?: string;
  title?: string;
}

export interface DocumentOut {
  meta: Partial<DocMeta>;
  svg: string;
  diagram?: DiagramPayload | null;
  /** The caller's effective role — the UI locks itself accordingly. */
  my_role?: "owner" | "editor" | "viewer";
  /** The board owner's public profile — powers the "Owned by …" chip. */
  owner?: PublicUser | null;
}

export interface FolderOut {
  id: string;
  name: string;
  color: string;
  created_at: number;
  count: number;
}

// ---- comments (M1) ----

/** Where a comment thread is pinned: an object (follows it) or a fixed point. */
export type CommentAnchor =
  | { kind: "node" | "edge"; ref: string }
  | { kind: "point"; x: number; y: number };

export interface CommentOut {
  id: string;
  body: string;
  author_id: string | null;
  author_name: string;
  author_color: string;
  page_id: string | null;
  /** null → thread root (carries the anchor); set → reply to that root. */
  parent_id: string | null;
  anchor: CommentAnchor | null;
  mentions: string[];
  resolved: boolean;
  created_at: number;
  updated_at: number;
}

export interface CommentsOut {
  comments: CommentOut[];
  /** Mention candidates (owner + shares + team) — GET only. */
  people?: { id: string; name: string; email: string; color: string }[] | null;
}

/** One row of the "Shared with me" table. */
export interface SharedDocRow {
  id: string;
  name: string;
  updated_at: number;
  owner: { id: string; name: string; email: string; color: string } | null;
  my_role: "owner" | "editor" | "viewer";
  via: "share" | "team";
}

/** One @mention of me, across boards (the 🔔 inbox feed). */
export interface MentionOut {
  comment_id: string;
  doc_id: string;
  doc_name: string;
  body: string;
  author_name: string;
  author_color: string;
  resolved: boolean;
  created_at: number;
}

/** One 🔔 notification for the signed-in user (share invite, …). */
export interface NotificationOut {
  id: string;
  user_id: string;
  kind: string;
  ts: number;
  /** share-kind fields: */
  doc_id?: string;
  doc_name?: string;
  role?: string;
  actor_name?: string;
  actor_color?: string;
}

/** One append-only audit event of a board (#22). */
export interface AuditEvent {
  ts: number;
  action: string;
  actor_kind: string;
  actor_id: string | null;
  actor_name: string;
  doc_id: string | null;
  detail: string;
}

// ---- version history (M1) ----

export interface VersionMeta {
  id: string;
  created_at: number;
  author_name: string;
}

/** One full snapshot — restore = PUT this payload back as a normal save. */
export interface VersionOut extends VersionMeta {
  svg: string;
  diagram: { pages?: unknown[]; nodes?: unknown[]; edges?: unknown[] } | null;
}

/** Response of POST /api/ai/image-to-svg. */
export interface ImageToSvgOut {
  svg: string;
}

/** Response of POST /api/ai/text-to-diagram — noddle's native diagram model. */
export interface TextToDiagramOut {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** Diagram-source format accepted by the text→diagram endpoint. */
export type DiagramTextFormat = "text" | "mermaid";

/** Error carrying the backend's `detail` message when available. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseError(res: Response): Promise<never> {
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { detail?: unknown };
    const d = body?.detail;
    if (typeof d === "string") {
      detail = d;
    } else if (d && typeof d === "object") {
      // AI 422s carry {message, raw} — surface the human message, never
      // String(object) ("[object Object]").
      const msg = (d as { message?: unknown }).message;
      detail = typeof msg === "string" ? msg : JSON.stringify(d).slice(0, 300);
    }
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(detail, res.status);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) return parseError(res);
  return (await res.json()) as T;
}

export const api = {
  /** List documents (newest first, per backend sort). */
  async list(): Promise<DocMeta[]> {
    const res = await fetch(`${BASE}/api/documents`);
    return json<DocMeta[]>(res);
  },

  /** Fetch one document with its SVG payload. */
  async get(id: string): Promise<DocumentOut> {
    const res = await fetch(`${BASE}/api/documents/${id}`);
    return json<DocumentOut>(res);
  },

  /** Upload an SVG file (server sanitizes before storing). */
  async upload(file: File): Promise<DocMeta> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/api/documents`, {
      method: "POST",
      body: fd,
    });
    return json<DocMeta>(res);
  },

  /** Save (overwrite) a document's SVG + editable diagram (null clears it). */
  async save(
    id: string,
    svg: string,
    diagram?: DiagramPayload | null,
  ): Promise<DocMeta> {
    const res = await fetch(`${BASE}/api/documents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diagram === undefined ? { svg } : { svg, diagram }),
    });
    return json<DocMeta>(res);
  },

  /** Import a foreign diagram file (draw.io .drawio/.xml) as a new board. */
  async importFile(file: File): Promise<DocMeta> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/api/documents/import`, {
      method: "POST",
      body: fd,
    });
    return json<DocMeta>(res);
  },

  /** JSON create: blank board, template instance, or AI-generated diagram. */
  async create(body: {
    name?: string;
    svg?: string;
    diagram?: DiagramPayload | { pages: unknown[] };
    folder_id?: string | null;
  }): Promise<DocMeta> {
    const res = await fetch(`${BASE}/api/documents/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return json<DocMeta>(res);
  },

  /** Rename/move ("edit") or adjust sharing knobs ("manage"). */
  async patchDoc(
    id: string,
    patch: {
      name?: string;
      folder_id?: string | null;
      link_policy?: "edit" | "view" | "private";
      team_id?: string | null;
    },
  ): Promise<DocMeta> {
    const res = await fetch(`${BASE}/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return json<DocMeta>(res);
  },

  // ---- folders ------------------------------------------------------------
  async listFolders(): Promise<FolderOut[]> {
    const res = await fetch(`${BASE}/api/folders`);
    return json<FolderOut[]>(res);
  },

  async createFolder(name: string): Promise<FolderOut> {
    const res = await fetch(`${BASE}/api/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return json<FolderOut>(res);
  },

  async renameFolder(id: string, name: string, color?: string): Promise<FolderOut> {
    const res = await fetch(`${BASE}/api/folders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...(color ? { color } : {}) }),
    });
    return json<FolderOut>(res);
  },

  async deleteFolder(id: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${BASE}/api/folders/${id}`, {
      method: "DELETE",
    });
    return json<{ ok: boolean }>(res);
  },

  /** Delete a document. */
  async remove(id: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${BASE}/api/documents/${id}`, {
      method: "DELETE",
    });
    return json<{ ok: boolean }>(res);
  },

  /** Cross-board mention inbox (signed-in users; guests get []). */
  async myMentions(): Promise<MentionOut[]> {
    return json<MentionOut[]>(await fetch(`${BASE}/api/me/mentions`));
  },

  /** 🔔 notification feed (share invites, …); signed-in users only, else []. */
  async myNotifications(): Promise<NotificationOut[]> {
    return json<NotificationOut[]>(await fetch(`${BASE}/api/me/notifications`));
  },

  /** Is an OIDC SSO provider configured? (shows/hides + labels the SSO button) */
  async oidcStatus(): Promise<{ enabled: boolean; issuer: string | null }> {
    return json<{ enabled: boolean; issuer: string | null }>(
      await fetch(`${BASE}/api/auth/oidc/status`),
    );
  },
  /** REAL storage accounting (#23) — bytes at rest across boards I own. */
  async myStorage(): Promise<{ used: number; quota: number }> {
    return json<{ used: number; quota: number }>(
      await fetch(`${BASE}/api/me/storage`),
    );
  },
  /** Owner-visible audit trail of one board (#22). */
  async docAudit(docId: string): Promise<AuditEvent[]> {
    return json<AuditEvent[]>(await fetch(`${BASE}/api/documents/${docId}/audit`));
  },

  /** "Shared with me": boards someone else owns that I can access by name. */
  async listShared(): Promise<SharedDocRow[]> {
    return json<SharedDocRow[]>(await fetch(`${BASE}/api/documents/shared`));
  },

  // ---- version history --------------------------------------------------------
  async listVersions(docId: string): Promise<VersionMeta[]> {
    return json<VersionMeta[]>(
      await fetch(`${BASE}/api/documents/${docId}/versions`),
    );
  },
  async getVersion(docId: string, versionId: string): Promise<VersionOut> {
    return json<VersionOut>(
      await fetch(`${BASE}/api/documents/${docId}/versions/${versionId}`),
    );
  },

  // ---- comments -------------------------------------------------------------
  async listComments(docId: string): Promise<CommentsOut> {
    return json<CommentsOut>(
      await fetch(`${BASE}/api/documents/${docId}/comments`),
    );
  },
  /** Create a thread root (with anchor) or a reply (with parent_id). Every
   * mutation returns the FULL updated list (LWW, like the collab protocol). */
  async addComment(
    docId: string,
    body: {
      body: string;
      page_id?: string | null;
      parent_id?: string | null;
      anchor?: CommentAnchor | null;
      mentions?: string[];
      guest_name?: string;
    },
  ): Promise<CommentsOut> {
    return json<CommentsOut>(
      await fetch(`${BASE}/api/documents/${docId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async patchComment(
    docId: string,
    commentId: string,
    patch: { body?: string; resolved?: boolean },
  ): Promise<CommentsOut> {
    return json<CommentsOut>(
      await fetch(`${BASE}/api/documents/${docId}/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },
  async deleteComment(docId: string, commentId: string): Promise<CommentsOut> {
    return json<CommentsOut>(
      await fetch(`${BASE}/api/documents/${docId}/comments/${commentId}`, {
        method: "DELETE",
      }),
    );
  },

  /**
   * AI: convert an uploaded raster/vector image to an editable SVG string.
   * `backend` picks who pays for THIS call: "" follows the account's AI mode,
   * "subscription" forces the ✦ wallet, "byok:{profileId}" a named BYOK key.
   * Non-2xx (e.g. 503 "AI not configured") throws an ApiError with the
   * server's `detail` message.
   */
  async imageToSvg(file: File, prompt = "", backend: AiBackendChoice = ""): Promise<ImageToSvgOut> {
    const fd = new FormData();
    fd.append("file", file);
    if (prompt.trim()) fd.append("prompt", prompt.trim());
    if (backend) fd.append("backend", backend);
    const res = await fetch(`${BASE}/api/ai/image-to-svg`, {
      method: "POST",
      body: fd,
    });
    return json<ImageToSvgOut>(res);
  },

  // ---- background image→board jobs (survive reloads, run in parallel) -------
  /** Queue an image conversion server-side; returns the job record (202). */
  async createImageJob(file: File, prompt = "", backend: AiBackendChoice = ""): Promise<AiJobOut> {
    const fd = new FormData();
    fd.append("file", file);
    if (prompt.trim()) fd.append("prompt", prompt.trim());
    if (backend) fd.append("backend", backend);
    const res = await fetch(`${BASE}/api/ai/jobs/image-to-svg`, { method: "POST", body: fd });
    return json<AiJobOut>(res);
  },
  /** This user's conversion history, newest first. */
  async listAiJobs(): Promise<AiJobOut[]> {
    return json<AiJobOut[]>(await fetch(`${BASE}/api/ai/jobs`));
  },
  async getAiJob(id: string): Promise<AiJobOut> {
    return json<AiJobOut>(await fetch(`${BASE}/api/ai/jobs/${id}`));
  },
  /** Remove one finished job from history. */
  async deleteAiJob(id: string): Promise<{ ok: boolean }> {
    return json<{ ok: boolean }>(
      await fetch(`${BASE}/api/ai/jobs/${id}`, { method: "DELETE" }),
    );
  },

  /**
   * AI: turn free text or a Mermaid definition into noddle diagram nodes/edges.
   * Non-2xx throws an ApiError carrying the server's `detail` message.
   */
  async textToDiagram(
    text: string,
    format: DiagramTextFormat,
  ): Promise<TextToDiagramOut> {
    const res = await fetch(`${BASE}/api/ai/text-to-diagram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, format }),
    });
    return json<TextToDiagramOut>(res);
  },

  // ---- identity & access ----------------------------------------------------
  /** Server feature flags — `anon` = Excalidraw-style no-login drawing. */
  async getConfig(): Promise<{ anon: boolean }> {
    return json<{ anon: boolean }>(await fetch(`${BASE}/api/config`));
  },
  async me(): Promise<Me> {
    return json<Me>(await fetch(`${BASE}/api/me`));
  },
  async register(email: string, name: string, password: string): Promise<Me> {
    return json<Me>(
      await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      }),
    );
  },
  async login(email: string, password: string): Promise<Me> {
    return json<Me>(
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  },
  async logout(): Promise<void> {
    await fetch(`${BASE}/api/auth/logout`, { method: "POST" });
  },
  async patchMe(patch: MePatch): Promise<Me> {
    return json<Me>(
      await fetch(`${BASE}/api/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },
  /** Rotate the account password (401 = wrong current, 400 = new too short).
   * Every other session is revoked server-side; this one stays valid. */
  async changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return json<{ ok: boolean }>(
      await fetch(`${BASE}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      }),
    );
  },

  async listApiTokens(): Promise<ApiTokenInfo[]> {
    return json<ApiTokenInfo[]>(await fetch(`${BASE}/api/tokens`));
  },
  async createApiToken(name: string, scopes: string[]): Promise<ApiTokenInfo> {
    return json<ApiTokenInfo>(
      await fetch(`${BASE}/api/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes }),
      }),
    );
  },
  async deleteApiToken(id: string): Promise<void> {
    await fetch(`${BASE}/api/tokens/${id}`, { method: "DELETE" });
  },

  async listTeams(): Promise<TeamInfo[]> {
    return json<TeamInfo[]>(await fetch(`${BASE}/api/teams`));
  },
  async createTeam(name: string): Promise<TeamInfo> {
    return json<TeamInfo>(
      await fetch(`${BASE}/api/teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
  },
  async addTeamMember(teamId: string, email: string, role: string): Promise<TeamInfo> {
    return json<TeamInfo>(
      await fetch(`${BASE}/api/teams/${teamId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      }),
    );
  },

  // ---- billing (Lemon Squeezy) -----------------------------------------------
  /** My effective plan (guests get the free tier). */
  async mySubscription(): Promise<SubscriptionInfo> {
    return json<SubscriptionInfo>(await fetch(`${BASE}/api/me/subscription`));
  },
  /** My billing history, newest first (401 when signed out). */
  async myBillingEvents(): Promise<BillingEventOut[]> {
    return json<BillingEventOut[]>(await fetch(`${BASE}/api/me/billing-events`));
  },
  /** Create a hosted checkout; redirect the browser to the returned url.
   * 503 (ApiError) when billing is not configured on this server. */
  async createCheckout(
    variant: PlanVariant,
    seats?: number,
  ): Promise<{ url: string }> {
    return json<{ url: string }>(
      await fetch(`${BASE}/api/payments/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant, ...(seats ? { seats } : {}) }),
      }),
    );
  },

  // ---- per-user AI provider settings ----------------------------------------
  async getAiSettings(): Promise<AiSettings> {
    return json<AiSettings>(await fetch(`${BASE}/api/ai-settings`));
  },
  async putAiSettings(patch: {
    mode?: "subscription" | "byok";
    provider?: "claude" | "openai" | "gemini" | "openrouter" | "custom";
    api_key?: string;
    /** BYOK model-id override; "" clears back to the provider default. */
    model?: string;
    /** Custom provider's OpenAI-compatible base URL; "" clears it. */
    api_base?: string;
  }): Promise<AiSettings> {
    return json<AiSettings>(
      await fetch(`${BASE}/api/ai-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },

  // ---- named BYOK profiles --------------------------------------------------
  /** Create a saved BYOK key config. Returns the enriched AI settings. */
  async addByokProfile(body: {
    name: string;
    provider: AiSettings["provider"];
    api_key?: string;
    model?: string;
    api_base?: string;
  }): Promise<AiSettings> {
    return json<AiSettings>(
      await fetch(`${BASE}/api/ai-settings/byok`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  /** Patch a saved profile (omitted fields kept; non-empty api_key rotates). */
  async updateByokProfile(
    pid: string,
    patch: {
      name?: string;
      provider?: AiSettings["provider"];
      api_key?: string;
      model?: string;
      api_base?: string;
    },
  ): Promise<AiSettings> {
    return json<AiSettings>(
      await fetch(`${BASE}/api/ai-settings/byok/${pid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },
  async deleteByokProfile(pid: string): Promise<AiSettings> {
    return json<AiSettings>(
      await fetch(`${BASE}/api/ai-settings/byok/${pid}`, { method: "DELETE" }),
    );
  },
  /** Make this profile active AND switch the account into byok mode. */
  async activateByokProfile(pid: string): Promise<AiSettings> {
    return json<AiSettings>(
      await fetch(`${BASE}/api/ai-settings/byok/${pid}/activate`, { method: "POST" }),
    );
  },
  /** Fire a minimal chat at the profile's provider to prove the key works.
   * Always resolves with `{ok, message}` — a bad key is ok:false, not a throw
   * (only an unknown profile id is an HTTP error). */
  async testByokProfile(pid: string): Promise<{ ok: boolean; message: string }> {
    return json<{ ok: boolean; message: string }>(
      await fetch(`${BASE}/api/ai-settings/byok/${pid}/test`, { method: "POST" }),
    );
  },

  async myUsage(days = 30): Promise<UsageReport> {
    return json<UsageReport>(await fetch(`${BASE}/api/me/usage?days=${days}`));
  },

  async getShares(docId: string): Promise<SharesInfo> {
    return json<SharesInfo>(await fetch(`${BASE}/api/documents/${docId}/shares`));
  },
  async addShare(docId: string, email: string, role: string): Promise<{ ok: boolean }> {
    return json(
      await fetch(`${BASE}/api/documents/${docId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      }),
    );
  },
  async removeShare(docId: string, userId: string): Promise<{ ok: boolean }> {
    return json(
      await fetch(`${BASE}/api/documents/${docId}/shares/${userId}`, {
        method: "DELETE",
      }),
    );
  },

  /**
   * AI: live co-editing — apply a natural-language instruction to the CURRENT
   * board. Returns Claude's one-line reply plus the full updated diagram.
   */
  async editDiagram(
    instruction: string,
    diagram: DiagramPayload,
    history: { role: "user" | "assistant"; content: string }[] = [],
    model?: string,
    image?: string,
  ): Promise<{ message: string; usage?: { prompt: number; completion: number; total: number } } & TextToDiagramOut> {
    const res = await fetch(`${BASE}/api/ai/edit-diagram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction,
        diagram,
        history,
        ...(model ? { model } : {}),
        ...(image ? { image } : {}),
      }),
    });
    return json<{ message: string; usage?: { prompt: number; completion: number; total: number } } & TextToDiagramOut>(res);
  },

  /** Team-games cross-session leaderboard (top players by wins then points). */
  async gameLeaderboard(): Promise<LeaderboardRow[]> {
    return json<LeaderboardRow[]>(await fetch(`${BASE}/api/games/leaderboard`));
  },

  /** Live snapshot of active game rooms (for the "Playing now" panel). */
  async gameActive(): Promise<ActiveGames> {
    return json<ActiveGames>(await fetch(`${BASE}/api/games/active`));
  },

  /**
   * Force-close a game room. The room HOST passes the one-time `hostToken` the
   * server handed them on join; ops can pass the `adminKey` override. A normal
   * (non-host) player is rejected server-side with 403.
   */
  async closeGameRoom(
    roomId: string,
    opts: { hostToken?: string; adminKey?: string } = {},
  ): Promise<{ ok: boolean; closed: number }> {
    const headers: Record<string, string> = {};
    if (opts.hostToken) headers["X-Host-Token"] = opts.hostToken;
    if (opts.adminKey) headers["X-Admin-Key"] = opts.adminKey;
    return json(
      await fetch(`${BASE}/api/games/rooms/${roomId}/kill`, { method: "POST", headers }),
    );
  },
};

export interface LeaderboardRow {
  name: string;
  color: string;
  points: number;
  wins: number;
  games: number;
}

export interface ActiveRoom {
  id: string;
  type: "draw" | "trivia" | "wordbomb";
  game: string;
  emoji: string;
  players: number;
  phase: string;
  turn: number;
  totalTurns: number;
}

export interface ActiveGames {
  rooms: ActiveRoom[];
  totalUsers: number;
  totalRooms: number;
}
