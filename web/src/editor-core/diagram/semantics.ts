/**
 * editor-core/diagram/semantics — pure helpers for the "quiet" semantic
 * metadata UI (board / page / object level). No React, no DOM.
 *
 * Bounds mirror backend/app/domain/diagram_metadata.py (≤20 keys of ≤64
 * chars, values primitives or lists of ≤20 primitives). The backend sanitizer
 * is still the authority — these helpers only keep the client from storing
 * empty strings / empty lists and from offering more keys than will survive.
 */
import type {
  DiagramMetadata,
  DiagramNode,
  MetaValue,
  ObjectMeta,
  PageMetadata,
} from "./types";

export const MAX_META_KEYS = 20;
export const MAX_META_KEY_LEN = 64;

/** Board/page categories the MCP tooling understands (custom values allowed). */
export const BOARD_CATEGORIES = ["architecture", "flowchart", "data", "org", "timeline"] as const;

/** Quick role presets for nodes (any custom text is allowed too). */
export const NODE_ROLE_PRESETS = [
  "client",
  "gateway",
  "service",
  "database",
  "queue",
  "security",
  "step",
  "decision",
  "source",
  "transform",
  "milestone",
  "frame",
  "label",
] as const;

/** Quick role presets for connectors. */
export const EDGE_ROLE_PRESETS = ["request", "response", "event", "data", "dependency"] as const;

/** Node meta keys with a dedicated field in the inspector (the rest = custom rows). */
export const NODE_META_FIELDS = ["role", "description", "notes", "tech", "owner", "url"] as const;
/** Edge meta keys with a dedicated field. */
export const EDGE_META_FIELDS = ["role", "protocol", "notes"] as const;

/** Roles that mark a container (no badge on a hollow frame). */
const FRAME_ROLES = new Set(["frame", "zone", "vpc", "group", "cluster", "layer", "lane", "tier", "boundary", "phase", "stage", "track"]);

/** "Kafka" → "Kafka"; "architecture" → "Architecture". */
export function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** True for an absolute http(s) URL (never javascript:/data:). */
export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

function emptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return !Number.isFinite(v);
  if (Array.isArray(v)) return v.every(emptyValue);
  return false;
}

/** Drop empty strings / empty lists / invalid keys; cap at MAX_META_KEYS.
 * An empty result is `undefined` (= "absent", the key is omitted on save). */
export function cleanObjectMeta(meta: ObjectMeta | undefined | null): ObjectMeta | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const out: ObjectMeta = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (n >= MAX_META_KEYS) break;
    if (!k || k.length > MAX_META_KEY_LEN || emptyValue(v)) continue;
    out[k] = Array.isArray(v) ? v.filter((x) => !emptyValue(x)) : v;
    n++;
  }
  return n ? out : undefined;
}

/** Set (or remove, when `value` is empty/undefined) one key of an ObjectMeta. */
export function setMetaKey(
  meta: ObjectMeta | undefined,
  key: string,
  value: MetaValue | MetaValue[] | undefined,
): ObjectMeta | undefined {
  const next: ObjectMeta = { ...(meta ?? {}) };
  if (value === undefined || emptyValue(value)) delete next[key];
  else next[key] = value;
  return cleanObjectMeta(next);
}

/** Rename a key, keeping its value and position. No-op on collision/empty. */
export function renameMetaKey(meta: ObjectMeta | undefined, from: string, to: string): ObjectMeta | undefined {
  const key = to.trim().slice(0, MAX_META_KEY_LEN);
  if (!meta || !key || key === from || key in meta) return meta;
  const next: ObjectMeta = {};
  for (const [k, v] of Object.entries(meta)) next[k === from ? key : k] = v;
  return cleanObjectMeta(next);
}

/** Display string for a meta value (lists joined with ", "). */
export function metaValueText(v: MetaValue | MetaValue[] | undefined): string {
  if (v == null) return "";
  return Array.isArray(v) ? v.map(String).join(", ") : String(v);
}

/** Parse an edited string back, keeping the previous value's TYPE when the
 * text still fits it (list stays a list, number a number, boolean a boolean). */
export function parseMetaValue(raw: string, prev?: MetaValue | MetaValue[]): MetaValue | MetaValue[] {
  if (Array.isArray(prev)) return splitList(raw);
  const t = raw.trim();
  if (typeof prev === "number" && t !== "" && Number.isFinite(Number(t))) return Number(t);
  if (typeof prev === "boolean" && (t === "true" || t === "false")) return t === "true";
  return raw;
}

/** "a, b,, c" → ["a","b","c"] (trimmed, de-duplicated, ≤20). */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_META_KEYS) break;
  }
  return out;
}

/** Merge a patch into board/page metadata: `undefined`/empty values remove
 * the key; an empty result is `undefined`. `patch === undefined` clears all. */
export function mergeBoardMetadata<T extends DiagramMetadata | PageMetadata>(
  current: T | undefined,
  patch: Partial<T> | undefined,
): T | undefined {
  if (patch === undefined) return undefined;
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || emptyValue(v)) {
      delete next[k];
    } else if (Array.isArray(v)) {
      next[k] = k === "tags" ? v.filter((x) => typeof x === "string" && x.trim() !== "") : v;
      if ((next[k] as unknown[]).length === 0) delete next[k];
    } else if (k === "custom" && typeof v === "object") {
      const c = cleanObjectMeta(v as ObjectMeta);
      if (c) next[k] = c;
      else delete next[k];
    } else {
      next[k] = v;
    }
  }
  return Object.keys(next).length ? (next as T) : undefined;
}

/** Meta worth surfacing: anything beyond an auto-inferred `role: "label"`. */
export function hasSemanticMeta(meta: ObjectMeta | undefined): boolean {
  if (!meta) return false;
  return Object.entries(meta).some(
    ([k, v]) => !emptyValue(v) && !(k === "role" && v === "label"),
  );
}

function invisible(c: string | undefined): boolean {
  return !c || c === "none" || c === "transparent";
}

/** Whether a node may wear the on-canvas semantic badge: it must carry
 * meaningful meta and be a real "box" — not a borderless text label, a hollow
 * container frame, an open stroke or a pen stroke. */
export function wantsSemanticBadge(node: DiagramNode): boolean {
  if (!hasSemanticMeta(node.meta)) return false;
  if (node.kind === "freedraw" || node.kind === "line" || node.kind === "curve" || node.kind === "curveDown") return false;
  const hollow = invisible(node.fill);
  if (hollow && invisible(node.stroke)) return false; // borderless label
  const role = typeof node.meta?.role === "string" ? node.meta.role.toLowerCase() : "";
  if (hollow && (FRAME_ROLES.has(role) || (node.strokeDash && node.strokeDash !== "solid"))) {
    return false; // hollow container frame
  }
  return node.w >= 24 && node.h >= 20;
}

export interface SemanticSummary {
  role?: string;
  tech?: string;
  text?: string;
  url?: string;
  /** Remaining key/value chips (owner, sla, custom …), display-ready. */
  extras: Array<{ key: string; value: string }>;
}

/** Split an ObjectMeta into the tooltip's display slots. */
export function summarizeMeta(meta: ObjectMeta | undefined): SemanticSummary {
  const out: SemanticSummary = { extras: [] };
  if (!meta) return out;
  const str = (k: string) => {
    const v = metaValueText(meta[k]).trim();
    return v || undefined;
  };
  out.role = str("role");
  out.tech = str("tech");
  const desc = str("description");
  out.text = desc ?? str("notes");
  const url = str("url");
  if (isHttpUrl(url)) out.url = url;
  // `notes` shows as an extra chip only when `description` took the text slot.
  const used = new Set(["role", "tech", "description", "url", ...(desc ? [] : ["notes"])]);
  for (const [k, v] of Object.entries(meta)) {
    if (used.has(k) || emptyValue(v)) continue;
    out.extras.push({ key: k, value: metaValueText(v) });
  }
  return out;
}

// The live whole-page analyzer (zones / components / flows / overview) lives
// in its own module to keep this file small; re-exported here as the one
// public entry point for semantic helpers.
export {
  buildPageSemanticSummary,
  flowText,
  iconLabel,
  roleFromIcon,
  oneLine,
} from "./semanticSummary";
export { toSemanticMarkdown } from "./semanticNarrative";
export type {
  PageSemanticSummary,
  SemanticComponent,
  SemanticFlow,
  SemanticGroup,
  RoleSource,
  IconInfo,
  SemanticSummaryOptions,
} from "./semanticSummary";
