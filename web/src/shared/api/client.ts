/**
 * shared/api/client — typed fetch wrapper for the /api endpoints.
 *
 * Contract mirrors backend (anonymous-only — the board URL is the capability):
 *   POST   /api/documents (FormData)   -> DocMeta            (upload + sanitize)
 *   POST   /api/documents/new          -> DocMeta            (blank/template/AI)
 *   POST   /api/documents/import       -> DocMeta            (draw.io import)
 *   GET    /api/documents/{id}         -> { meta, svg, diagram, my_role }
 *   PUT    /api/documents/{id}         -> DocMeta            ({ svg, diagram?, author_name? })
 *   PATCH  /api/documents/{id}         -> DocMeta            ({ name })
 *
 * In dev, Vite proxies /api → http://127.0.0.1:8000 (see vite.config.ts). In
 * prod the FastAPI app serves web/dist same-origin, so the base is "".
 *
 * AI endpoints use CLIENT-SIDE BYOK: the provider/key/model live in
 * localStorage ("noddle.aiKey") and ride each request as X-AI-* headers — the
 * server proxies the call and never stores the key. "noddle.clientId" is an
 * opaque UUID identifying this browser's AI-job history (X-Client-Id).
 */
import type { DiagramEdge, DiagramNode } from "../../editor-core/diagram";

const BASE = ""; // same-origin (dev: Vite proxy; prod: served by FastAPI)

export interface DocMeta {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  link_policy?: "edit" | "view" | "private";
}

/** Editable board payload persisted alongside the SVG. */
export interface DiagramPayload {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DocumentOut {
  meta: Partial<DocMeta>;
  svg: string;
  diagram?: DiagramPayload | null;
  /** The caller's effective role — the UI locks itself accordingly. */
  my_role?: "editor" | "viewer";
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
  resolved: boolean;
  created_at: number;
  updated_at: number;
}

export interface CommentsOut {
  comments: CommentOut[];
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

// ---- AI ----

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

export type AiProvider = "claude" | "openai" | "gemini" | "openrouter" | "custom";

/** The browser-kept BYOK config (localStorage "noddle.aiKey"). */
export interface AiKeyConfig {
  provider: AiProvider;
  key: string;
  /** Model-id override; "" ⇒ the provider's default model. */
  model: string;
  /** For provider "custom": OpenAI-compatible base URL (LiteLLM pattern). */
  base: string;
}

const AI_KEY_STORAGE = "noddle.aiKey";
const CLIENT_ID_STORAGE = "noddle.clientId";

/** The stored BYOK config, or null (never throws — storage may be blocked). */
export function getAiKeyConfig(): AiKeyConfig | null {
  try {
    const raw = localStorage.getItem(AI_KEY_STORAGE);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AiKeyConfig>;
    if (!v || typeof v.key !== "string" || !v.key.trim()) return null;
    return {
      provider: (v.provider as AiProvider) || "claude",
      key: v.key,
      model: typeof v.model === "string" ? v.model : "",
      base: typeof v.base === "string" ? v.base : "",
    };
  } catch {
    return null;
  }
}

export function setAiKeyConfig(cfg: AiKeyConfig | null): void {
  try {
    if (cfg) localStorage.setItem(AI_KEY_STORAGE, JSON.stringify(cfg));
    else localStorage.removeItem(AI_KEY_STORAGE);
  } catch {
    /* storage blocked — AI simply stays off */
  }
}

/** This browser's opaque AI-job-history id (minted once). */
export function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_ID_STORAGE);
    if (!id) {
      id =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(CLIENT_ID_STORAGE, id);
    }
    return id;
  } catch {
    return "c-ephemeral";
  }
}

/** X-AI-* headers for one key config (BYOK travels per-request). */
function keyHeaders(cfg: AiKeyConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "X-AI-Provider": cfg.provider,
    "X-AI-Key": cfg.key,
  };
  if (cfg.model) headers["X-AI-Model"] = cfg.model;
  if (cfg.base) headers["X-AI-Base"] = cfg.base;
  return headers;
}

/** Headers for AI calls: the stored BYOK key + this browser's job-history id. */
function aiHeaders(): Record<string, string> {
  const cfg = getAiKeyConfig();
  return {
    "X-Client-Id": clientId(),
    ...(cfg ? keyHeaders(cfg) : {}),
  };
}

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

  /** Save (overwrite) a document's SVG + editable diagram (null clears it).
   * `authorName` attributes the version snapshot (localStorage identity). */
  async save(
    id: string,
    svg: string,
    diagram?: DiagramPayload | null,
    authorName?: string,
  ): Promise<DocMeta> {
    const body: Record<string, unknown> = { svg };
    if (diagram !== undefined) body.diagram = diagram;
    if (authorName) body.author_name = authorName;
    const res = await fetch(`${BASE}/api/documents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  }): Promise<DocMeta> {
    const res = await fetch(`${BASE}/api/documents/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return json<DocMeta>(res);
  },

  /** Rename a board (needs edit access — i.e. the link). */
  async patchDoc(id: string, patch: { name?: string }): Promise<DocMeta> {
    const res = await fetch(`${BASE}/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return json<DocMeta>(res);
  },

  /** Prove a key/model/base combination works BEFORE saving it — always
   * resolves {ok, message} (a bad key is ok:false, not a throw). Takes the
   * config explicitly so the modal can test unsaved form values. */
  async testAiKey(cfg: AiKeyConfig): Promise<{ ok: boolean; message: string }> {
    return json<{ ok: boolean; message: string }>(
      await fetch(`${BASE}/api/ai/test-key`, {
        method: "POST",
        headers: keyHeaders(cfg),
      }),
    );
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
      guest_name?: string;
      guest_color?: string;
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
   * BYOK rides the X-AI-* headers; non-2xx (e.g. 503 "no AI backend") throws
   * an ApiError with the server's `detail` message.
   */
  async imageToSvg(file: File, prompt = ""): Promise<ImageToSvgOut> {
    const fd = new FormData();
    fd.append("file", file);
    if (prompt.trim()) fd.append("prompt", prompt.trim());
    const res = await fetch(`${BASE}/api/ai/image-to-svg`, {
      method: "POST",
      headers: aiHeaders(),
      body: fd,
    });
    return json<ImageToSvgOut>(res);
  },

  // ---- background image→board jobs (survive reloads, run in parallel) -------
  /** Queue an image conversion server-side; returns the job record (202). */
  async createImageJob(file: File, prompt = ""): Promise<AiJobOut> {
    const fd = new FormData();
    fd.append("file", file);
    if (prompt.trim()) fd.append("prompt", prompt.trim());
    const res = await fetch(`${BASE}/api/ai/jobs/image-to-svg`, {
      method: "POST",
      headers: aiHeaders(),
      body: fd,
    });
    return json<AiJobOut>(res);
  },
  /** This browser's conversion history, newest first. */
  async listAiJobs(): Promise<AiJobOut[]> {
    return json<AiJobOut[]>(
      await fetch(`${BASE}/api/ai/jobs`, { headers: aiHeaders() }),
    );
  },
  async getAiJob(id: string): Promise<AiJobOut> {
    return json<AiJobOut>(
      await fetch(`${BASE}/api/ai/jobs/${id}`, { headers: aiHeaders() }),
    );
  },
  /** Remove one finished job from history. */
  async deleteAiJob(id: string): Promise<{ ok: boolean }> {
    return json<{ ok: boolean }>(
      await fetch(`${BASE}/api/ai/jobs/${id}`, {
        method: "DELETE",
        headers: aiHeaders(),
      }),
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
      headers: { "Content-Type": "application/json", ...aiHeaders() },
      body: JSON.stringify({ text, format }),
    });
    return json<TextToDiagramOut>(res);
  },

  /**
   * AI: live co-editing — apply a natural-language instruction to the CURRENT
   * board. Returns the model's one-line reply plus the full updated diagram.
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
      headers: { "Content-Type": "application/json", ...aiHeaders() },
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
};
