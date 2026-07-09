/**
 * editor-core/diagram/types — value types for the node/edge diagram layer.
 *
 * PURE TypeScript: no React, no DOM globals. Edges store an ATTACHMENT
 * (port/floating/free), never absolute endpoint coordinates (except `free`),
 * so geometry is derived on render and moving a node re-routes automatically.
 */

export interface Vec {
  x: number;
  y: number;
}

export type NodeKind =
  | "rect"
  | "rounded"
  | "ellipse"
  | "diamond"
  // flowchart family (rendered in features/diagram/ShapePalette.shapeElement)
  | "process"
  | "terminator"
  | "document"
  | "parallelogram"
  | "cylinder"
  | "hexagon"
  | "manualInput"
  | "delay"
  | "display"
  | "card"
  | "internalStorage"
  | "note"
  // square sticky note (retro / brainstorm) — flat fill + soft drop shadow
  | "sticky"
  | "actor"
  // extra geometric shapes (rendered in shapeElement)
  | "triangle"
  | "pentagon"
  | "star"
  | "cross"
  | "cloud"
  | "callout"
  // geometric (2026-07 catalog expansion — features/diagram/shapes/geometric.tsx)
  | "trapezoid"
  | "octagon"
  | "semicircle"
  | "ring"
  | "shield"
  | "lightning"
  | "heart"
  | "banner"
  // flowchart expansion (features/diagram/shapes/flowchart.tsx)
  | "multiDocument"
  | "storedData"
  | "queue"
  | "loopLimit"
  | "merge"
  | "offPage"
  // block arrows (features/diagram/shapes/arrows.tsx)
  | "arrowRight"
  | "arrowLeft"
  | "arrowDouble"
  | "chevron"
  // UML-lite (features/diagram/shapes/uml.tsx)
  | "umlClass"
  | "package"
  | "component"
  // rounded tile hosting an `iconKey` glyph (AWS / GCP / Azure — see icons.ts)
  | "icon"
  // uploaded raster image (data URL in `imageHref`) behaving like any shape:
  // rect perimeter, ports, arrows, resize — see features/editor/pasteImage.ts
  | "image";

/**
 * Animation speed multiplier shared by edges and nodes. Cycle durations are
 * base/speed (base 1.2s → 0.5x = 2.4s, 2x = 0.6s) so GIF export durations
 * that are multiples of 1.2s keep looping seamlessly.
 */
export type FlowSpeed = 0.5 | 1 | 2;

/**
 * Animation strength for an animated edge: drives dot radius, beam segment
 * length + base-line dimming, pulse opacity depth and dash contrast.
 */
export type FlowIntensity = "subtle" | "normal" | "strong";

/**
 * Optional idle animation for a node:
 * - pulse:   gentle scale beat (transform-origin center)
 * - glow:    soft drop-shadow halo breathing in stroke color
 * - breathe: opacity fade in/out
 * - wobble:  tiny rotation swing
 */
export type NodeAnim = "pulse" | "glow" | "breathe" | "wobble";

/** Horizontal alignment of a node's label (absent → "center"). */
export type TextAlign = "left" | "center" | "right";

/** Static border dash pattern for a node's shape outline (absent → "solid"). */
export type NodeStrokeDash = "solid" | "dashed" | "dotted";

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  /** Top-left corner (content coords). */
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Rotation in degrees clockwise around the node center (absent → 0).
   * Rendering only — the x/y/w/h bbox, ports and edge routing stay
   * axis-aligned (Lucid-style v1). */
  rotation?: number;
  /** Idle animation (absent → none). */
  anim?: NodeAnim;
  /** Animation speed when `anim` is set (absent → 1). */
  animSpeed?: FlowSpeed;
  /** Hand-drawn look: roughen filter on the shape + a sketchy font (Excalidraw-style). */
  sketch?: boolean;
  // ---- Lucid-style format: all OPTIONAL, absent → current default look ----
  /** Label font size in px (absent → 14). */
  fontSize?: number;
  /** Bold label (absent → false → font-weight 400). */
  bold?: boolean;
  /** Italic label (absent → false). */
  italic?: boolean;
  /** Underlined label (absent → false). */
  underline?: boolean;
  /** Label color (absent → the default #1a1d23). */
  textColor?: string;
  /** Label horizontal alignment (absent → "center"). */
  textAlign?: TextAlign;
  /**
   * Excel-style "wrap text": auto-break the label into lines that fit the
   * shape's width (explicit \n breaks are always honored). Absent → single
   * line per \n, may overflow the shape.
   */
  wrap?: boolean;
  /** Whole-node opacity 0..1 (absent → 1). */
  opacity?: number;
  /** Corner radius (px) for rect/rounded kinds (absent → kind default). */
  cornerRadius?: number;
  /** Static border dash pattern on the shape outline (absent → "solid"). */
  strokeDash?: NodeStrokeDash;
  /** For kind "icon": which registry glyph to render (see features/diagram/icons.ts). */
  iconKey?: string;
  /**
   * For kind "image": the embedded raster as a `data:image/…` URL. MUST be a
   * data URL — the backend sanitizer strips remote hrefs and PNG/GIF export
   * can't rasterize external refs (see security/svg_sanitizer.py).
   */
  imageHref?: string;
  /**
   * Nodes sharing a groupId select and drag as one unit (⌘G / ⌘⇧G). Flat —
   * no nesting; grouping an already-grouped node moves it to the new group.
   */
  groupId?: string;
  /**
   * Unified paint order across BOTH nodes and edges (higher → on top). Assigned
   * a monotonic value at creation so a freshly added shape/arrow lands on top
   * of everything. Absent → legacy object: the renderer places legacy edges
   * behind legacy nodes (the old two-pass look) while new z-stamped objects sit
   * above both. See DiagramLayer's paint-order sort.
   */
  z?: number;
}

/**
 * How an edge endpoint attaches to the diagram:
 * - port:     a fixed relative point on a node (rel in 0..1 of w/h).
 * - floating: any node; the exact border point is computed toward the far end.
 * - free:     an absolute content point not bound to any node.
 */
export type Attachment =
  | { kind: "port"; nodeId: string; rel: Vec }
  | { kind: "floating"; nodeId: string }
  | { kind: "free"; point: Vec };

export type Routing = "straight" | "elbow";

/**
 * An edge endpoint decoration:
 * - none:     bare line end (no marker)
 * - arrow:    classic filled arrowhead (the legacy default)
 * - triangle: hollow/open triangle
 * - circle:   filled dot terminator
 * - diamond:  filled diamond terminator
 *
 * Back-compat: legacy edges carry only the `endArrow`/`startArrow` booleans —
 * an absent head falls back to `arrow` when the matching boolean is true, else
 * `none` (see EdgeView.effectiveHead).
 */
export type ArrowHead = "none" | "arrow" | "triangle" | "circle" | "diamond";

/** Static line dash pattern (independent of the `animated` flow). */
export type EdgeDash = "solid" | "dashed" | "dotted";

/**
 * Animation style for an `animated` edge:
 * - dash:  marching ants (stroke-dashoffset)
 * - dots:  packets traveling along the path (SMIL animateMotion)
 * - beam:  a bright comet sweeping over a dimmed base line
 * - pulse: the whole line breathes (opacity)
 */
export type FlowStyle = "dash" | "dots" | "beam" | "pulse";

/** One text block anchored at fraction `t` (0..1) along a connector. */
export interface EdgeLabelBlock {
  id: string;
  t: number;
  text: string;
}

export interface DiagramEdge {
  id: string;
  source: Attachment;
  target: Attachment;
  routing: Routing;
  stroke: string;
  strokeWidth: number;
  endArrow: boolean;
  startArrow: boolean;
  /**
   * Explicit endpoint decorations (Lucid-style). When absent the renderer
   * derives them from the `endArrow`/`startArrow` booleans (true → "arrow",
   * false → "none") so legacy edges keep their look.
   */
  endHead?: ArrowHead;
  startHead?: ArrowHead;
  /** Static dash pattern (absent → "solid"). Distinct from `animated` flow. */
  dash?: EdgeDash;
  /** Legacy single label at the midpoint (kept for back-compat). */
  label?: string;
  /** Multiple text blocks placed anywhere along the line: `t` is the arc-length
   * fraction (0..1) where the block sits (Lucid-style multi-label). */
  labels?: EdgeLabelBlock[];
  animated: boolean;
  /** Animation style when `animated` (absent → "dash"). */
  flowStyle?: FlowStyle;
  /** Animation speed multiplier when `animated` (absent → 1). Continuous — a
   * 1–100 UI slider maps to value/50, so 50 = 1×. Legacy 0.5|1|2 still valid. */
  flowSpeed?: number;
  /** Animation strength when `animated` (absent → "normal"). */
  flowIntensity?: FlowIntensity;
  /**
   * User-owned elbow route: the interior corner points (content coords), set
   * when a segment is dragged (Lucid-style). Absent → the auto router decides.
   * End corners re-anchor to the moving endpoints at render, middle corners
   * stay fixed. Cleared by "auto route".
   */
  waypoints?: Vec[];
  /**
   * Unified paint order across BOTH nodes and edges (higher → on top) — see the
   * matching field on DiagramNode. Absent → legacy edge (painted behind legacy
   * nodes); a newly drawn arrow is z-stamped so it sits on top of shapes.
   */
  z?: number;
}
