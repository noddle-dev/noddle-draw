/**
 * editor-core/diagram/semanticSummary — a LIVE semantic read of one page:
 * zones, components, flows and a synthesized overview paragraph. Pure
 * TypeScript (no React, no DOM), re-exported from ./semantics.
 *
 * A TypeScript port of the MCP `read_board_summary` page pass
 * (mcp/noddle_mcp.py `_summarize_page`), tuned for humans instead of agents:
 *   • decorative strokes (line/curve/freedraw) never count;
 *   • composite cards fold their small badges / icon tiles / caption labels
 *     into the parent card instead of listing them as separate components;
 *   • a hollow/dashed (or container-role) frame is a ZONE, titled by its own
 *     text or by the text label sitting in its top band (that label is then
 *     consumed — never listed twice);
 *   • roles come from `meta.role`, else iconKey, shape kind or palette colour;
 *   • edges become readable flows ("A ──[HTTPS]──▶ B"), endpoints resolved to
 *     the card / zone a badge or title label belongs to.
 * Explicit metadata always wins over inference. The overview sentences and
 * the Markdown export live in ./semanticNarrative.
 */
import type { DiagramEdge, DiagramMetadata, DiagramNode, PageMetadata } from "./types";
import { synthesizeOverview } from "./semanticNarrative";

/* ------------------------------------------------------------------------ */
/* Public shapes                                                              */
/* ------------------------------------------------------------------------ */

export type RoleSource = "meta" | "icon" | "kind" | "color";

export interface SemanticComponent {
  id: string;
  label: string;
  kind: string;
  role?: string;
  roleSource?: RoleSource;
  iconKey?: string;
  /** Short badge texts folded in from micro-tags (e.g. "ADO"). */
  tags: string[];
  /** Secondary caption lines folded in from labels inside the card. */
  details: string[];
  /** meta.tech / meta.description, when set. */
  tech?: string;
  description?: string;
  /** Innermost zone id, if any. */
  groupId?: string;
  inDegree: number;
  outDegree: number;
}

export interface SemanticGroup {
  id: string;
  label: string;
  role: string;
  roleSource?: RoleSource;
  iconKey?: string;
  parentId?: string;
  depth: number;
  memberIds: string[];
  childGroupIds: string[];
  /** frame = detected container shape; meta = node.meta.group name. */
  source: "frame" | "meta";
}

export interface SemanticFlow {
  id: string;
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
  viaLabel?: string;
  bidirectional: boolean;
  /** False for a plain line without any arrowhead. */
  directed: boolean;
  text: string;
}

export interface PageSemanticSummary {
  nodeCount: number;
  edgeCount: number;
  components: SemanticComponent[];
  groups: SemanticGroup[];
  /** Components that sit in no zone. */
  ungroupedIds: string[];
  flows: SemanticFlow[];
  /** Free text labels (titles, annotations) — not components. */
  annotations: Array<{ id: string; text: string }>;
  entryIds: string[];
  hubIds: string[];
  sinkIds: string[];
  decorations: number;
  autoSummary: string;
  board?: DiagramMetadata;
  page?: PageMetadata;
}

/* ------------------------------------------------------------------------ */
/* Tables                                                                     */
/* ------------------------------------------------------------------------ */

const DECOR_KINDS = new Set(["line", "curve", "curveDown", "freedraw"]);
const CONTAINER_ROLES = new Set([
  "zone", "vpc", "group", "cluster", "layer", "frame", "lane", "tier", "boundary",
  "region", "subnet", "phase", "stage", "track", "swimlane", "account",
]);
const KIND_ROLES: Record<string, string> = {
  cylinder: "database", storedData: "database", internalStorage: "datastore",
  queue: "queue", actor: "actor", cloud: "external", diamond: "decision",
  terminator: "terminal", document: "document", multiDocument: "document",
  parallelogram: "io", manualInput: "input", display: "output", shield: "security",
  hexagon: "preparation", component: "component", package: "package",
  umlClass: "class", table: "table", tableHeader: "table", sticky: "note",
  note: "note", callout: "note", delay: "delay", offPage: "connector",
  merge: "merge", loopLimit: "loop",
};
/** iconKey (vendor prefix stripped) → role; first match wins. */
const ICON_ROLES: Array<[RegExp, string]> = [
  [/vpc|vnet|virtual-?network|subnet/, "vpc"],
  [/elasticache|redis|memcache|memorystore|cache/, "cache"],
  [/rds|aurora|dynamo|database|sql|cosmos|bigtable|spanner|firestore|documentdb|neptune|redshift|db\b/, "database"],
  [/s3|storage|blob|bucket|efs|glacier|lake|filestore|disk/, "storage"],
  [/api-?gateway|apim|gateway|elb|alb|nlb|load-?balanc|front-?door|cloudfront|cdn|route-?53|dns|nat|igw|transit|endpoint|privatelink/, "gateway"],
  [/sqs|sns|kinesis|eventbridge|event-?hub|pub-?sub|service-?bus|kafka|msk|\bmq\b|queue|stream/, "queue"],
  [/iam|cognito|kms|secret|waf|shield|guard|key-?vault|entra|active-?directory|firewall|security|identity|certificate/, "security"],
  [/cloudwatch|monitor|logging|log|x-?ray|trail|insights|observ/, "monitoring"],
  [/glue|emr|databricks|athena|dataflow|dataproc|synapse|bigquery|analytics|etl|airflow|composer/, "analytics"],
  [/sagemaker|vertex|ml|ai|bedrock|openai|cognitive/, "ml"],
  [/lambda|function|cloud-?run|ec2|ecs|eks|fargate|compute|\bvm\b|aks|gke|app-?service|beanstalk|batch|container|kubernetes|server/, "compute"],
  [/user|client|mobile|browser|laptop|desktop|device/, "client"],
];
/** fill/stroke palette → role (board palette, ADR-0009 accent). */
const COLOR_ROLES: Record<string, string> = {
  "#dbeafe": "client", "#2563eb": "client",
  "#dcfce7": "service", "#16a34a": "service",
  "#fef9c3": "focal", "#eb6c36": "focal",
  "#fee2e2": "security", "#dc2626": "security",
};
const SINK_ROLES = new Set(["database", "datastore", "storage", "cache", "table"]);
const FOCAL_ROLES = new Set(["focal", "gateway"]);

/* ------------------------------------------------------------------------ */
/* Geometry + text helpers                                                    */
/* ------------------------------------------------------------------------ */

type Box = [number, number, number, number];

function boxOf(n: DiagramNode): Box | null {
  const { x, y, w, h } = n;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return [x, y, x + w, y + h];
}
const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const contains = (p: Box, q: Box, tol = 2) =>
  p[0] <= q[0] + tol && p[1] <= q[1] + tol && p[2] >= q[2] - tol && p[3] >= q[3] - tol;
const centerIn = (p: Box, q: Box) => {
  const cx = (q[0] + q[2]) / 2;
  const cy = (q[1] + q[3]) / 2;
  return cx >= p[0] && cx <= p[2] && cy >= p[1] && cy <= p[3];
};

const invisible = (c: string | undefined) => !c || c === "none" || c === "transparent";
const isTextOnly = (n: DiagramNode) => invisible(n.fill) && invisible(n.stroke);
const isDashed = (n: DiagramNode) => !!n.strokeDash && n.strokeDash !== "solid";

/** Collapse whitespace; clip with an ellipsis. */
export function oneLine(text: unknown, cap = 80): string {
  const s = String(text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return s.length <= cap ? s : s.slice(0, cap - 1) + "…";
}

function metaRole(n: { meta?: DiagramNode["meta"] }): string {
  const r = n.meta?.role;
  return typeof r === "string" ? r.trim() : "";
}

/** "aws-rds" → "rds"; "gcp-cloud-run" → "cloud-run". */
function iconStem(key: string): string {
  return key.toLowerCase().replace(/^(aws|azure|az|gcp|google|gc)[-_:]/, "");
}

/** Human label for a bare icon: "aws-rds" → "RDS", "aws-lambda" → "Lambda". */
export function iconLabel(key: string): string {
  const stem = iconStem(key);
  if (stem.length <= 4) return stem.toUpperCase();
  return stem.split(/[-_]/).filter(Boolean).map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
}

export function roleFromIcon(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const stem = iconStem(key);
  for (const [re, role] of ICON_ROLES) if (re.test(stem)) return role;
  return undefined;
}

function inferRole(n: DiagramNode): { role?: string; source?: RoleSource } {
  const explicit = metaRole(n);
  if (explicit) return { role: explicit, source: "meta" };
  const byIcon = roleFromIcon(n.iconKey);
  if (byIcon) return { role: byIcon, source: "icon" };
  const byKind = KIND_ROLES[n.kind];
  if (byKind) return { role: byKind, source: "kind" };
  const fill = (n.fill || "").toLowerCase();
  const stroke = (n.stroke || "").toLowerCase();
  const byColor = COLOR_ROLES[fill] ?? COLOR_ROLES[stroke];
  if (byColor) return { role: byColor, source: "color" };
  return {};
}

/* ------------------------------------------------------------------------ */
/* The analyzer                                                               */
/* ------------------------------------------------------------------------ */

const BADGE_W = 64;
const BADGE_H = 48;

/** Icon registry lookup injected by the UI (editor-core can't import features). */
export interface IconInfo {
  label?: string;
  /** Service cluster: compute, storage, database, networking, security … */
  category?: string;
}
export interface SemanticSummaryOptions {
  iconInfo?: (key: string) => IconInfo | undefined;
}

const ICON_CATEGORY_ROLES: Record<string, string> = {
  compute: "compute", containers: "compute", storage: "storage", database: "database",
  networking: "gateway", integration: "queue", analytics: "analytics", ai: "ml",
  security: "security", management: "monitoring", frontend: "client",
};

export function buildPageSemanticSummary(
  nodesIn: DiagramNode[] | Record<string, DiagramNode>,
  edgesIn: DiagramEdge[] | Record<string, DiagramEdge>,
  boardMeta?: DiagramMetadata,
  pageMeta?: PageMetadata,
  opts: SemanticSummaryOptions = {},
): PageSemanticSummary {
  const iconName = (key: string) => oneLine(opts.iconInfo?.(key)?.label, 48) || iconLabel(key);
  const iconRole = (key: string | undefined): string | undefined => {
    if (!key) return undefined;
    const cat = opts.iconInfo?.(key)?.category;
    return roleFromIcon(key) ?? (cat ? ICON_CATEGORY_ROLES[cat] : undefined);
  };
  /** meta.role → icon (own or a folded icon tile) → shape kind → palette. */
  const roleOf = (n: DiagramNode, icon: string | undefined): { role?: string; source?: RoleSource } => {
    const explicit = metaRole(n);
    if (explicit) return { role: explicit, source: "meta" };
    const byIcon = iconRole(icon);
    if (byIcon) return { role: byIcon, source: "icon" };
    return inferRole(n);
  };
  const nodes = (Array.isArray(nodesIn) ? nodesIn : Object.values(nodesIn ?? {}))
    .filter((n): n is DiagramNode => !!n && typeof n.id === "string");
  const edges = (Array.isArray(edgesIn) ? edgesIn : Object.values(edgesIn ?? {}))
    .filter((e): e is DiagramEdge => !!e && typeof e.id === "string" && !!e.source && !!e.target);
  const by = new Map(nodes.map((n) => [n.id, n]));
  const boxes = new Map<string, Box>();
  for (const n of nodes) {
    const b = boxOf(n);
    if (b) boxes.set(n.id, b);
  }
  const text = (n: DiagramNode) => oneLine(n.text);
  const isBadgeSized = (n: DiagramNode) => n.w <= BADGE_W && n.h <= BADGE_H;
  const semantic = nodes.filter((n) => !DECOR_KINDS.has(n.kind) && boxes.has(n.id));
  const decorations = nodes.length - semantic.length;

  // ---- 1. container (zone) candidates --------------------------------------
  const isCandidate = (n: DiagramNode): boolean => {
    if (n.kind === "icon" || n.kind === "image") return false;
    if (CONTAINER_ROLES.has(metaRole(n).toLowerCase())) return true;
    if (n.w < 180 || n.h < 90 || isTextOnly(n)) return false;
    if (invisible(n.fill) || isDashed(n)) return true;
    // A FILLED big shape is a zone when it holds ≥2 real (non-badge) shapes, or —
    // untitled itself — one shape much smaller than it (a subnet around an ALB).
    const b = boxes.get(n.id)!;
    let held = 0;
    let biggest = 0;
    for (const m of semantic) {
      if (m.id === n.id || isBadgeSized(m) || isTextOnly(m)) continue;
      const mb = boxes.get(m.id)!;
      if (!contains(b, mb) || area(b) <= area(mb)) continue;
      if (++held >= 2) return true;
      biggest = Math.max(biggest, area(mb));
    }
    return held === 1 && !text(n) && biggest < area(b) * 0.2;
  };
  // innermost candidate fully holding each node
  const innermost = (pool: string[]) => {
    const out = new Map<string, string>();
    for (const n of semantic) {
      const b = boxes.get(n.id)!;
      let best: string | undefined;
      for (const cid of pool) {
        const cb = boxes.get(cid)!;
        if (cid === n.id || !contains(cb, b) || area(cb) <= area(b)) continue;
        if (!best || area(cb) < area(boxes.get(best)!)) best = cid;
      }
      if (best) out.set(n.id, best);
    }
    return out;
  };
  const cands = semantic.filter(isCandidate).map((n) => n.id);
  const first = innermost(cands);
  // A hollow box that only wraps a badge / icon tile / caption is a CARD, not a
  // zone — it needs at least one substantial child (or an explicit zone role).
  const substantial = new Set<string>();
  for (const [child, par] of first) {
    const c = by.get(child)!;
    if (!isTextOnly(c) && !isBadgeSized(c)) substantial.add(par);
  }
  const zonesOnly = cands.filter((cid) => substantial.has(cid) || CONTAINER_ROLES.has(metaRole(by.get(cid)!).toLowerCase()));
  const parentOf = zonesOnly.length === cands.length ? first : innermost(zonesOnly);
  const containerSet = new Set(zonesOnly.filter((cid) => [...parentOf.values()].includes(cid)));

  const wired = new Set<string>();
  for (const e of edges) {
    if ("nodeId" in e.source) wired.add(e.source.nodeId);
    if ("nodeId" in e.target) wired.add(e.target.nodeId);
  }
  /** A short, unwired, labelled strip — a lane header / zone tab, not a component. */
  const isHeaderChip = (n: DiagramNode) =>
    !!text(n) && n.h <= 56 && !wired.has(n.id) && !metaRole(n) && n.kind !== "icon" && n.kind !== "image";

  // ---- 2. zone titles + corner icons ---------------------------------------
  const consumed = new Map<string, string>(); // node id → the zone/card it belongs to
  const titleOf = new Map<string, string>(); // zone/card id → title node id
  const groupIcon = new Map<string, string>(); // zone id → iconKey
  for (const cid of containerSet) {
    const c = by.get(cid)!;
    const [cx0, cy0, cx1, cy1] = boxes.get(cid)!;
    // corner icon (AWS group convention): a small icon at the top-left corner
    for (const n of semantic) {
      if (n.kind !== "icon" || n.w > BADGE_W || n.h > BADGE_W || parentOf.get(n.id) !== cid || consumed.has(n.id)) continue;
      const b = boxes.get(n.id)!;
      if (b[0] - cx0 <= 16 && b[1] - cy0 <= 16) {
        groupIcon.set(cid, n.iconKey ?? "");
        consumed.set(n.id, cid);
        if (!text(c) && text(n) && !titleOf.has(cid)) titleOf.set(cid, n.id);
        break;
      }
    }
    if (text(c) || titleOf.has(cid)) continue;
    const band = Math.max(48, (cy1 - cy0) * 0.25);
    let best: { rank: [number, number]; id: string } | undefined;
    // rank 0 text label in the top band · 1 header chip hugging the top edge
    // · 2 label straddling the top edge · 3 swimlane side header or a tab right above it.
    // A free label merely ABOVE the frame (e.g. the board title) never counts.
    for (const n of semantic) {
      const b = boxes.get(n.id)!;
      if (n.id === cid || consumed.has(n.id) || containerSet.has(n.id) || !text(n)) continue;
      const textOnly = isTextOnly(n);
      // swimlane: a labelled header cell glued to the lane's left edge, same height
      const sideHeader = !textOnly && !wired.has(n.id) && !metaRole(n) && Math.abs(b[2] - cx0) <= 4 &&
        Math.abs(b[1] - cy0) <= 8 && Math.abs(b[3] - cy1) <= 8 && (b[2] - b[0]) <= (cx1 - cx0) * 0.4;
      if (!textOnly && !isHeaderChip(n) && !sideHeader) continue;
      const within = b[0] >= cx0 - 8 && b[2] <= cx1 + 8;
      const child = parentOf.get(n.id) === cid;
      let rank0: number;
      if (textOnly && child && b[1] - cy0 <= band) rank0 = 0;
      else if (!textOnly && child && b[1] - cy0 <= 24) rank0 = 1;
      else if (textOnly && !parentOf.has(n.id) && within && b[1] <= cy0 + 4 && b[3] >= cy0 - 4) rank0 = 2;
      else if (sideHeader) rank0 = 3;
      else if (!textOnly && parentOf.get(n.id) === parentOf.get(cid) && within && b[3] <= cy0 + 4 && b[3] >= cy0 - 28 && (b[2] - b[0]) >= (cx1 - cx0) * 0.25) rank0 = 3;
      else continue;
      const rank: [number, number] = [rank0, b[1]];
      if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { rank, id: n.id };
    }
    if (best) {
      titleOf.set(cid, best.id);
      consumed.set(best.id, cid);
    }
  }

  // ---- 3. composite cards: fold badges / icon tiles / caption labels -------
  const cards = semantic.filter((n) => !containerSet.has(n.id) && !isTextOnly(n) && n.kind !== "icon" && n.kind !== "image");
  const hostOf = (n: DiagramNode): DiagramNode | undefined => {
    const b = boxes.get(n.id)!;
    let best: DiagramNode | undefined;
    for (const c of cards) {
      if (c.id === n.id) continue;
      const cb = boxes.get(c.id)!;
      if (area(cb) <= area(b) * 1.5 || !centerIn(cb, b)) continue;
      if (!best || area(cb) < area(boxes.get(best.id)!)) best = c;
    }
    return best;
  };
  const foldTags = new Map<string, string[]>();
  const foldDetails = new Map<string, string[]>();
  const foldIcon = new Map<string, string>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const arr = m.get(k) ?? [];
    if (v && !arr.includes(v)) arr.push(v);
    m.set(k, arr);
  };
  // Small badges first (they may sit on a card that is itself labelled by a caption).
  for (const n of semantic) {
    if (consumed.has(n.id) || containerSet.has(n.id) || !isBadgeSized(n) || metaRole(n)) continue;
    const host = hostOf(n);
    if (!host) continue;
    consumed.set(n.id, host.id);
    if (n.kind === "icon" && n.iconKey && !foldIcon.has(host.id)) foldIcon.set(host.id, n.iconKey);
    const t = text(n);
    if (t) push(t.length <= 5 ? foldTags : foldDetails, host.id, t);
  }
  // Text-only labels inside a card: the card's title when it has no text of its own.
  for (const n of semantic) {
    if (consumed.has(n.id) || !isTextOnly(n) || !text(n) || metaRole(n)) continue;
    const host = hostOf(n);
    if (!host) continue;
    consumed.set(n.id, host.id);
    if (!text(host) && !titleOf.has(host.id)) titleOf.set(host.id, n.id);
    else push(foldDetails, host.id, text(n));
  }

  // A borderless caption right below an unlabeled shape names it (actor, icon…).
  for (const n of semantic) {
    if (consumed.has(n.id) || containerSet.has(n.id) || text(n) || titleOf.has(n.id) || isTextOnly(n)) continue;
    const [x0, , x1, y1] = boxes.get(n.id)!;
    let best: DiagramNode | undefined;
    for (const m of semantic) {
      if (consumed.has(m.id) || !isTextOnly(m) || !text(m) || metaRole(m) || wired.has(m.id)) continue;
      const mb = boxes.get(m.id)!;
      const mcx = (mb[0] + mb[2]) / 2;
      if (mb[1] < y1 - 6 || mb[1] > y1 + 24 || mcx < x0 || mcx > x1) continue;
      if (!best || mb[1] < boxes.get(best.id)![1]) best = m;
    }
    if (best) {
      titleOf.set(n.id, best.id);
      consumed.set(best.id, n.id);
    }
  }

  /** Where an edge endpoint really points: badge → its card, title → its zone. */
  const resolve = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 4 && consumed.has(cur); i++) cur = consumed.get(cur)!;
    return cur;
  };

  // ---- 4. labels --------------------------------------------------------------
  const labelOf = (id: string): string => {
    const n = by.get(id);
    if (!n) return `?${id}`;
    const own = oneLine(n.text, 48);
    if (own) return own;
    const t = titleOf.get(id);
    if (t) return oneLine(by.get(t)?.text, 48);
    const icon = n.iconKey ?? foldIcon.get(id) ?? groupIcon.get(id);
    if (icon) return iconName(icon);
    const tags = foldTags.get(id);
    if (tags?.length) return tags.join(" · ");
    if (containerSet.has(id)) return titleCaseWord(metaRole(n) || "zone");
    return titleCaseWord(n.kind);
  };

  // ---- 5. flows + degrees -------------------------------------------------------
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const flows: SemanticFlow[] = [];
  const attached = new Set<string>();
  for (const e of edges) {
    const s = "nodeId" in e.source && by.has(e.source.nodeId) ? resolve(e.source.nodeId) : undefined;
    const t = "nodeId" in e.target && by.has(e.target.nodeId) ? resolve(e.target.nodeId) : undefined;
    if (!s && !t) continue; // a free doodle arrow
    if (s && s === t) continue; // badge ↔ its own card
    const endHead = e.endHead ? e.endHead !== "none" : e.endArrow !== false;
    const startHead = e.startHead ? e.startHead !== "none" : !!e.startArrow;
    const reverse = startHead && !endHead;
    const [a, b] = reverse ? [t, s] : [s, t];
    const vias = [oneLine(e.label, 32), ...(e.labels ?? []).map((l) => oneLine(l?.text, 32))].filter(Boolean);
    const proto = typeof e.meta?.protocol === "string" ? oneLine(e.meta.protocol, 32) : "";
    const via = vias.length ? vias.join(" / ") : proto || undefined;
    const bidirectional = startHead && endHead;
    const directed = startHead || endHead;
    const sourceLabel = a ? labelOf(a) : "(free end)";
    const targetLabel = b ? labelOf(b) : "(free end)";
    flows.push({
      id: e.id,
      sourceId: a ?? "",
      targetId: b ?? "",
      sourceLabel,
      targetLabel,
      viaLabel: via,
      bidirectional,
      directed,
      text: flowText(sourceLabel, targetLabel, via, bidirectional, directed),
    });
    for (const x of [a, b]) if (x) attached.add(x);
    if (a && b) {
      if (directed) {
        bump(outDeg, a);
        bump(inDeg, b);
        if (bidirectional) {
          bump(outDeg, b);
          bump(inDeg, a);
        }
      } else {
        // an undirected link counts as both ways for hubs, neither for entry/sink
        bump(inDeg, a); bump(outDeg, a); bump(inDeg, b); bump(outDeg, b);
      }
    }
  }

  // ---- 6. zones -------------------------------------------------------------------
  const groups: SemanticGroup[] = [];
  const groupOf = new Map<string, string>();
  const zoneIds = [...containerSet].sort((p, q) => area(boxes.get(q)!) - area(boxes.get(p)!));
  const depthOf = (id: string) => {
    let d = 0;
    for (let cur = parentOf.get(id); cur && d < 32; cur = parentOf.get(cur)) if (containerSet.has(cur)) d++;
    return d;
  };
  const zoneParent = (id: string) => {
    const p = parentOf.get(id);
    return p && containerSet.has(p) ? p : undefined;
  };

  // ---- 7. components ------------------------------------------------------------
  const components: SemanticComponent[] = [];
  const annotations: Array<{ id: string; text: string }> = [];
  let decorCount = decorations;
  for (const n of semantic) {
    if (containerSet.has(n.id) || consumed.has(n.id)) continue;
    const t = text(n);
    const hasMeta = !!n.meta && Object.keys(n.meta).length > 0;
    if (isTextOnly(n) && !attached.has(n.id) && !hasMeta && n.kind !== "icon") {
      if (t) annotations.push({ id: n.id, text: oneLine(n.text, 120) });
      else decorCount++;
      continue;
    }
    if (!t && !hasMeta && !attached.has(n.id) && !n.iconKey && !foldIcon.has(n.id) && !titleOf.has(n.id) && !foldTags.has(n.id)) {
      decorCount++; // unlabeled, unconnected, unannotated
      continue;
    }
    const icon = n.iconKey ?? foldIcon.get(n.id);
    const { role, source } = roleOf(n, icon);
    const comp: SemanticComponent = {
      id: n.id,
      label: labelOf(n.id),
      kind: n.kind,
      role,
      roleSource: source,
      iconKey: icon,
      tags: foldTags.get(n.id) ?? [],
      details: (foldDetails.get(n.id) ?? []).slice(0, 4),
      tech: metaText(n, "tech"),
      description: metaText(n, "description") ?? metaText(n, "notes"),
      groupId: zoneParent(n.id),
      inDegree: inDeg.get(n.id) ?? 0,
      outDegree: outDeg.get(n.id) ?? 0,
    };
    components.push(comp);
    if (comp.groupId) groupOf.set(n.id, comp.groupId);
  }

  for (const zid of zoneIds) {
    const z = by.get(zid)!;
    const explicit = metaRole(z);
    const icon = groupIcon.get(zid);
    const label = labelOf(zid);
    let role = explicit;
    let roleSource: RoleSource | undefined = explicit ? "meta" : undefined;
    if (!role && icon) {
      role = iconRole(icon) ?? "";
      if (role) roleSource = "icon";
    }
    if (!role) role = zoneRoleFromText(label);
    groups.push({
      id: zid,
      label,
      role: role || "zone",
      roleSource,
      iconKey: icon,
      parentId: zoneParent(zid),
      depth: depthOf(zid),
      memberIds: components.filter((c) => c.groupId === zid).map((c) => c.id),
      childGroupIds: zoneIds.filter((o) => zoneParent(o) === zid),
      source: "frame",
    });
  }
  // explicit semantic groups (node.meta.group) the geometry didn't express
  const byMetaGroup = new Map<string, string[]>();
  for (const c of components) {
    const g = by.get(c.id)?.meta?.group;
    if (typeof g === "string" && g.trim()) {
      const arr = byMetaGroup.get(g.trim()) ?? [];
      arr.push(c.id);
      byMetaGroup.set(g.trim(), arr);
    }
  }
  for (const [name, members] of byMetaGroup) {
    groups.push({ id: `group:${name}`, label: name, role: "group", roleSource: "meta", depth: 0, memberIds: members, childGroupIds: [], source: "meta" });
    for (const m of members) if (!groupOf.has(m)) groupOf.set(m, `group:${name}`);
  }
  const ungroupedIds = components.filter((c) => !groupOf.has(c.id)).map((c) => c.id);

  // ---- 8. key roles ---------------------------------------------------------------
  const compById = new Map(components.map((c) => [c.id, c]));
  const linked = components.filter((c) => c.inDegree + c.outDegree > 0);
  const deg = (c: SemanticComponent) => c.inDegree + c.outDegree;
  const directedIn = new Map<string, number>();
  const directedOut = new Map<string, number>();
  for (const f of flows) {
    if (!f.directed || !f.sourceId || !f.targetId) continue;
    bump(directedOut, f.sourceId);
    bump(directedIn, f.targetId);
    if (f.bidirectional) {
      bump(directedOut, f.targetId);
      bump(directedIn, f.sourceId);
    }
  }
  const dIn = (id: string) => directedIn.get(id) ?? 0;
  const dOut = (id: string) => directedOut.get(id) ?? 0;
  const entryIds = linked
    .filter((c) => dOut(c.id) > 0 && dIn(c.id) === 0)
    .sort((p, q) => dOut(q.id) - dOut(p.id))
    .map((c) => c.id);
  const sinkIds = linked
    .filter((c) => (dIn(c.id) > 0 && dOut(c.id) === 0) || (!!c.role && SINK_ROLES.has(c.role) && dIn(c.id) > 0))
    .filter((c) => !entryIds.includes(c.id))
    .sort((p, q) => dIn(q.id) - dIn(p.id))
    .map((c) => c.id);
  const maxDeg = linked.reduce((m, c) => Math.max(m, deg(c)), 0);
  const hubIds = linked
    .filter((c) => !entryIds.includes(c.id) && !sinkIds.includes(c.id))
    .filter((c) => (deg(c) >= 3 && deg(c) >= Math.ceil(maxDeg * 0.5)) || (!!c.role && FOCAL_ROLES.has(c.role) && deg(c) >= 2))
    .sort((p, q) => deg(q) - deg(p))
    .map((c) => c.id);

  const summary: PageSemanticSummary = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    components,
    groups,
    ungroupedIds,
    flows,
    annotations,
    entryIds,
    hubIds,
    sinkIds,
    decorations: decorCount,
    autoSummary: "",
    board: boardMeta,
    page: pageMeta,
  };
  summary.autoSummary = synthesizeOverview(summary, compById);
  return summary;
}

function metaText(n: DiagramNode, key: string): string | undefined {
  const v = n.meta?.[key];
  const s = oneLine(Array.isArray(v) ? v.join(", ") : v, 160);
  return s || undefined;
}

function titleCaseWord(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function zoneRoleFromText(label: string): string {
  const l = label.toLowerCase();
  if (/\bvpc\b|\bvnet\b/.test(l)) return "vpc";
  if (/subnet/.test(l)) return "subnet";
  if (/region/.test(l)) return "region";
  if (/account|subscription|project/.test(l)) return "account";
  if (/cluster/.test(l)) return "cluster";
  if (/lane|swimlane/.test(l)) return "lane";
  if (/layer|tier/.test(l)) return "layer";
  return "";
}

export function flowText(src: string, tgt: string, via: string | undefined, bidirectional: boolean, directed: boolean): string {
  const mid = via ? `──[${via}]──` : "────";
  const left = bidirectional ? "◀" : "";
  const right = directed ? "▶" : "";
  return `${src} ${left}${mid}${right} ${tgt}`;
}
