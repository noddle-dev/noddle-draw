/**
 * features/library/builtins/_kit — authoring helpers for the built-in packs.
 *
 * Every built-in item is written with three calls:
 *   const a = box("rounded", x, y, w, h, "Label", "sky");   // a node
 *   const e = link(a, b, { label: "Yes" });                  // an edge
 *   item("id", "Name", ["tags"], [a, b], [e]);               // the finisher
 *
 * The helpers apply the house style (hand-drawn `sketch`, radius 12 on
 * rect-like kinds, 2px strokes, bold ink labels) and take colours ONLY from
 * LIB_PALETTE — no item file ever inlines a hex. `item()` re-bases the
 * fragment to (0,0), snaps it to the 4px grid, renumbers ids n1…/e1… and
 * computes the bbox, so authors can lay items out in any local coordinates.
 */
import type { Attachment, DiagramEdge, DiagramNode, EdgeDash, NodeKind, Vec, ArrowHead } from "../../../editor-core/diagram";
import { LIB_INK, LIB_PALETTE } from "../palette";
import type { LibHue, LibraryItem } from "../types";

export type { LibHue };

/** Invisible fill/stroke for text-only label nodes (a CSS keyword, not a colour). */
export const CLEAR = "transparent";
/** White — the palette's paper fill, also used as text on solid fills. */
export const WHITE = LIB_PALETTE.ink.fill;
/** Default connector colour. */
export const LINE = LIB_PALETTE.slate.stroke;

const RECT_LIKE: ReadonlySet<NodeKind> = new Set<NodeKind>(["rect", "rounded"]);

let seq = 0;
const tmpId = () => `tmp${++seq}`;

export interface BoxOpts extends Partial<Omit<DiagramNode, "id" | "kind" | "x" | "y" | "w" | "h" | "text">> {
  /** Fill with the hue's STROKE colour and white text (primary buttons, badges). */
  solid?: boolean;
  /** White fill, hue stroke (paper cards, frames). */
  paper?: boolean;
}

/** A styled node. `x/y` are top-left in the item's local coordinates. */
export function box(
  kind: NodeKind,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  hue: LibHue,
  opts: BoxOpts = {},
): DiagramNode {
  const { solid, paper, ...rest } = opts;
  const p = LIB_PALETTE[hue];
  const n: DiagramNode = {
    id: tmpId(),
    kind,
    x,
    y,
    w,
    h,
    text,
    fill: solid ? p.stroke : paper ? WHITE : p.fill,
    stroke: p.stroke,
    strokeWidth: 2,
    sketch: true,
    bold: true,
    fontSize: 16,
    textColor: solid ? WHITE : LIB_INK,
  };
  if (RECT_LIKE.has(kind)) n.cornerRadius = 12;
  return { ...n, ...rest };
}

/** A text-only label (invisible box). Defaults: 16px, bold, ink. */
export function text(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  opts: Partial<DiagramNode> = {},
): DiagramNode {
  return {
    id: tmpId(),
    kind: "rect",
    x,
    y,
    w,
    h,
    text: label,
    fill: CLEAR,
    stroke: CLEAR,
    strokeWidth: 1,
    sketch: true,
    bold: true,
    fontSize: 16,
    textColor: LIB_INK,
    ...opts,
  };
}

/** Port side shorthand → relative port position. */
export type Side = "t" | "b" | "l" | "r";
const SIDE_REL: Record<Side, Vec> = {
  t: { x: 0.5, y: 0 },
  b: { x: 0.5, y: 1 },
  l: { x: 0, y: 0.5 },
  r: { x: 1, y: 0.5 },
};

export type End = DiagramNode | Vec;

export interface LinkOpts {
  label?: string;
  /** "elbow" (default — flows), "straight" (callouts, spokes) or "curved" (mind-map branches). */
  routing?: "straight" | "elbow" | "curved";
  from?: Side;
  to?: Side;
  /** Exact relative port (0..1 of w/h) on the source — overrides `from`. */
  fromAt?: Vec;
  /** Exact relative port on the target — overrides `to`. */
  toAt?: Vec;
  dash?: EdgeDash;
  /** End decoration (default arrow). "none" = plain line. */
  head?: ArrowHead;
  /** Start decoration (default none). */
  tail?: ArrowHead;
  stroke?: string;
  strokeWidth?: number;
  animated?: boolean;
}

function isNode(e: End): e is DiagramNode {
  return (e as DiagramNode).id !== undefined;
}

function attach(e: End, side?: Side, at?: Vec): Attachment {
  if (!isNode(e)) return { kind: "free", point: { x: e.x, y: e.y } };
  if (at) return { kind: "port", nodeId: e.id, rel: { ...at } };
  return side ? { kind: "port", nodeId: e.id, rel: { ...SIDE_REL[side] } } : { kind: "floating", nodeId: e.id };
}

/** A connector between two nodes (or a node and a free point {x,y}). */
export function link(a: End, b: End, opts: LinkOpts = {}): DiagramEdge {
  const head = opts.head ?? "arrow";
  const tail = opts.tail ?? "none";
  const e: DiagramEdge = {
    id: tmpId(),
    source: attach(a, opts.from, opts.fromAt),
    target: attach(b, opts.to, opts.toAt),
    routing: opts.routing ?? "elbow",
    stroke: opts.stroke ?? LINE,
    strokeWidth: opts.strokeWidth ?? 2,
    endArrow: head !== "none",
    startArrow: tail !== "none",
    endHead: head,
    startHead: tail,
    animated: opts.animated ?? false,
  };
  if (opts.dash) e.dash = opts.dash;
  if (opts.label) e.label = opts.label;
  return e;
}

const snap = (v: number) => Math.round(v / 4) * 4;

export interface ItemOpts {
  /** Give every node one shared groupId so the item drags as a unit. */
  group?: boolean;
}

/** Finish an item: re-base to (0,0), snap to 4px, renumber ids, compute bbox. */
export function item(
  id: string,
  name: string,
  tags: string[],
  nodes: DiagramNode[],
  edges: DiagramEdge[] = [],
  opts: ItemOpts = {},
): LibraryItem {
  const free: Vec[] = [];
  for (const e of edges) {
    if (e.source.kind === "free") free.push(e.source.point);
    if (e.target.kind === "free") free.push(e.target.point);
  }
  const xs = [...nodes.map((n) => n.x), ...free.map((p) => p.x)];
  const ys = [...nodes.map((n) => n.y), ...free.map((p) => p.y)];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  const idMap = new Map<string, string>();
  nodes.forEach((n, i) => idMap.set(n.id, `n${i + 1}`));
  const group = opts.group && nodes.length > 1;

  const outNodes: DiagramNode[] = nodes.map((n) => {
    const m: DiagramNode = {
      ...n,
      id: idMap.get(n.id)!,
      x: snap(n.x - minX),
      y: snap(n.y - minY),
      w: Math.max(4, snap(n.w)),
      h: Math.max(4, snap(n.h)),
    };
    if (group) m.groupId = "g1";
    return m;
  });

  const remap = (a: Attachment): Attachment => {
    if (a.kind === "free") return { kind: "free", point: { x: snap(a.point.x - minX), y: snap(a.point.y - minY) } };
    const nid = idMap.get(a.nodeId);
    if (!nid) throw new Error(`library item ${id}: edge references a node outside the item`);
    return a.kind === "port" ? { ...a, nodeId: nid } : { ...a, nodeId: nid };
  };
  const outEdges: DiagramEdge[] = edges.map((e, i) => ({
    ...e,
    id: `e${i + 1}`,
    source: remap(e.source),
    target: remap(e.target),
  }));

  let w = 0;
  let h = 0;
  for (const n of outNodes) {
    w = Math.max(w, n.x + n.w);
    h = Math.max(h, n.y + n.h);
  }
  for (const e of outEdges) {
    for (const a of [e.source, e.target]) {
      if (a.kind === "free") {
        w = Math.max(w, a.point.x);
        h = Math.max(h, a.point.y);
      }
    }
  }
  return { id, name, tags, nodes: outNodes, edges: outEdges, w, h };
}

/**
 * A cloud / network stencil icon (features/diagram/icons registry key). The
 * node box IS the icon (Lucid-style, 64×64 by default) and `caption` hangs
 * BELOW it — keep ~28px under every icon free of other shapes.
 */
export function icon(iconKey: string, x: number, y: number, caption: string, size = 64): DiagramNode {
  return {
    id: tmpId(),
    kind: "icon",
    iconKey,
    x,
    y,
    w: size,
    h: size,
    text: caption,
    fill: WHITE,
    stroke: LIB_INK,
    strokeWidth: 2,
    fontSize: 13,
  };
}
