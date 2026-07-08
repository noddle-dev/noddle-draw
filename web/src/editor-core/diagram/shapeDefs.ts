/**
 * editor-core/diagram/shapeDefs — the PURE-DATA shape catalog.
 *
 * One row per NodeKind: palette group, label, ghost glyph, default size,
 * default text, and (for polygonal shapes) the normalized outline used for
 * true perimeter clipping of connectors. NO React/SVG here — the JSX
 * renderers live in features/diagram/shapes/* (one module per group);
 * this file is what state/ (sizes, labels) and editor-core/perimeter
 * (outlines) are allowed to import.
 *
 * Adding a shape = one row here + one renderer entry in its group module.
 */
import type { NodeKind } from "./types";

export type ShapeGroup =
  | "basic"
  | "geometric"
  | "flowchart"
  | "arrows"
  | "uml"
  | "misc"; // sticky/actor/icon — special palette handling

export interface ShapeDef {
  kind: NodeKind;
  group: ShapeGroup;
  /** Palette label + search key. */
  label: string;
  /** Text shown on the palette drag ghost. */
  glyph: string;
  /** Default node size on create. */
  size: { w: number; h: number };
  /** Default text on create ("" = no label). */
  text: string;
  /**
   * Normalized convex/concave outline (0..1 of w/h, clockwise) for connector
   * perimeter clipping. Absent → AABB (or the closed-form ellipse/diamond
   * formulas in perimeter.ts).
   */
  polygon?: [number, number][];
}

// Reused outlines --------------------------------------------------------------
const DIAMOND: [number, number][] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
const TRIANGLE: [number, number][] = [[0.5, 0], [1, 1], [0, 1]];
const PENTAGON: [number, number][] = [[0.5, 0], [1, 0.38], [0.82, 1], [0.18, 1], [0, 0.38]];
const HEXAGON: [number, number][] = [[0.17, 0], [0.83, 0], [1, 0.5], [0.83, 1], [0.17, 1], [0, 0.5]];
const PARALLELOGRAM: [number, number][] = [[0.2, 0], [1, 0], [0.8, 1], [0, 1]];
const TRAPEZOID: [number, number][] = [[0.22, 0], [0.78, 0], [1, 1], [0, 1]];
const OCTAGON: [number, number][] = [
  [0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3],
];
const MERGE: [number, number][] = [[0, 0], [1, 0], [0.5, 1]];
const OFF_PAGE: [number, number][] = [[0, 0], [1, 0], [1, 0.62], [0.5, 1], [0, 0.62]];
const CHEVRON: [number, number][] = [[0, 0], [0.78, 0], [1, 0.5], [0.78, 1], [0, 1], [0.22, 0.5]];
const ARROW_R: [number, number][] = [
  [0, 0.28], [0.62, 0.28], [0.62, 0], [1, 0.5], [0.62, 1], [0.62, 0.72], [0, 0.72],
];
const ARROW_L: [number, number][] = ARROW_R.map(([px, py]) => [1 - px, py] as [number, number]);
const ARROW_LR: [number, number][] = [
  [0, 0.5], [0.24, 0], [0.24, 0.28], [0.76, 0.28], [0.76, 0], [1, 0.5],
  [0.76, 1], [0.76, 0.72], [0.24, 0.72], [0.24, 1],
];

export const SHAPE_DEFS: ShapeDef[] = [
  // ---- basic ---------------------------------------------------------------
  { kind: "rect", group: "basic", label: "Rectangle", glyph: "▭", size: { w: 140, h: 80 }, text: "Process" },
  { kind: "rounded", group: "basic", label: "Rounded", glyph: "▢", size: { w: 140, h: 80 }, text: "Step" },
  { kind: "ellipse", group: "basic", label: "Ellipse", glyph: "◯", size: { w: 140, h: 90 }, text: "Start" },
  { kind: "diamond", group: "basic", label: "Diamond", glyph: "◇", size: { w: 140, h: 100 }, text: "Decision", polygon: DIAMOND },

  // ---- geometric -----------------------------------------------------------
  { kind: "triangle", group: "geometric", label: "Triangle", glyph: "△", size: { w: 130, h: 110 }, text: "Triangle", polygon: TRIANGLE },
  { kind: "pentagon", group: "geometric", label: "Pentagon", glyph: "⬠", size: { w: 130, h: 120 }, text: "Pentagon", polygon: PENTAGON },
  { kind: "hexagon", group: "geometric", label: "Hexagon", glyph: "⬡", size: { w: 150, h: 90 }, text: "Prepare", polygon: HEXAGON },
  { kind: "trapezoid", group: "geometric", label: "Trapezoid", glyph: "⏢", size: { w: 150, h: 84 }, text: "Manual op", polygon: TRAPEZOID },
  { kind: "octagon", group: "geometric", label: "Octagon", glyph: "⯃", size: { w: 120, h: 120 }, text: "Stop", polygon: OCTAGON },
  { kind: "semicircle", group: "geometric", label: "Semicircle", glyph: "◓", size: { w: 140, h: 80 }, text: "" },
  { kind: "ring", group: "geometric", label: "Ring", glyph: "◎", size: { w: 110, h: 110 }, text: "" },
  { kind: "star", group: "geometric", label: "Star", glyph: "★", size: { w: 120, h: 120 }, text: "Star" },
  { kind: "cross", group: "geometric", label: "Cross", glyph: "✚", size: { w: 110, h: 110 }, text: "" },
  { kind: "cloud", group: "geometric", label: "Cloud", glyph: "☁", size: { w: 160, h: 110 }, text: "Cloud" },
  { kind: "callout", group: "geometric", label: "Callout", glyph: "💬", size: { w: 150, h: 110 }, text: "Note" },
  { kind: "shield", group: "geometric", label: "Shield", glyph: "🛡", size: { w: 110, h: 120 }, text: "" },
  { kind: "lightning", group: "geometric", label: "Lightning", glyph: "⚡", size: { w: 90, h: 120 }, text: "" },
  { kind: "heart", group: "geometric", label: "Heart", glyph: "♡", size: { w: 120, h: 110 }, text: "" },
  { kind: "banner", group: "geometric", label: "Banner", glyph: "🏷", size: { w: 160, h: 70 }, text: "Title" },

  // ---- flowchart -----------------------------------------------------------
  { kind: "process", group: "flowchart", label: "Predefined process", glyph: "▤", size: { w: 150, h: 80 }, text: "Process" },
  { kind: "terminator", group: "flowchart", label: "Terminator", glyph: "⬭", size: { w: 150, h: 64 }, text: "Start" },
  { kind: "document", group: "flowchart", label: "Document", glyph: "▽", size: { w: 150, h: 96 }, text: "Document" },
  { kind: "multiDocument", group: "flowchart", label: "Multi-document", glyph: "⧉", size: { w: 150, h: 100 }, text: "Docs" },
  { kind: "parallelogram", group: "flowchart", label: "Data (I/O)", glyph: "▱", size: { w: 150, h: 80 }, text: "Data", polygon: PARALLELOGRAM },
  { kind: "cylinder", group: "flowchart", label: "Database", glyph: "◍", size: { w: 130, h: 100 }, text: "Database" },
  { kind: "queue", group: "flowchart", label: "Queue", glyph: "▭", size: { w: 160, h: 70 }, text: "Queue" },
  { kind: "storedData", group: "flowchart", label: "Stored data", glyph: "◖", size: { w: 150, h: 84 }, text: "Store" },
  { kind: "manualInput", group: "flowchart", label: "Manual input", glyph: "▰", size: { w: 150, h: 84 }, text: "Input" },
  { kind: "delay", group: "flowchart", label: "Delay", glyph: "◗", size: { w: 140, h: 80 }, text: "Delay" },
  { kind: "display", group: "flowchart", label: "Display", glyph: "◑", size: { w: 160, h: 84 }, text: "Display" },
  { kind: "card", group: "flowchart", label: "Card", glyph: "◰", size: { w: 140, h: 90 }, text: "Card" },
  { kind: "internalStorage", group: "flowchart", label: "Internal storage", glyph: "⊞", size: { w: 140, h: 90 }, text: "Storage" },
  { kind: "loopLimit", group: "flowchart", label: "Loop limit", glyph: "⬓", size: { w: 150, h: 80 }, text: "Loop" },
  { kind: "merge", group: "flowchart", label: "Merge", glyph: "▽", size: { w: 130, h: 100 }, text: "", polygon: MERGE },
  { kind: "offPage", group: "flowchart", label: "Off-page link", glyph: "⌂", size: { w: 110, h: 110 }, text: "A", polygon: OFF_PAGE },
  { kind: "note", group: "flowchart", label: "Note", glyph: "◪", size: { w: 130, h: 110 }, text: "Note" },

  // ---- arrows / connectors -------------------------------------------------
  { kind: "arrowRight", group: "arrows", label: "Arrow right", glyph: "➡", size: { w: 160, h: 80 }, text: "", polygon: ARROW_R },
  { kind: "arrowLeft", group: "arrows", label: "Arrow left", glyph: "⬅", size: { w: 160, h: 80 }, text: "", polygon: ARROW_L },
  { kind: "arrowDouble", group: "arrows", label: "Double arrow", glyph: "⬌", size: { w: 180, h: 80 }, text: "", polygon: ARROW_LR },
  { kind: "chevron", group: "arrows", label: "Chevron", glyph: "⮞", size: { w: 150, h: 80 }, text: "Step", polygon: CHEVRON },

  // ---- UML-lite ------------------------------------------------------------
  { kind: "umlClass", group: "uml", label: "Class", glyph: "☰", size: { w: 160, h: 110 }, text: "Class" },
  { kind: "package", group: "uml", label: "Package", glyph: "📦", size: { w: 160, h: 100 }, text: "Package" },
  { kind: "component", group: "uml", label: "Component", glyph: "⊟", size: { w: 160, h: 90 }, text: "Component" },

  // ---- misc (special palette handling) --------------------------------------
  { kind: "sticky", group: "misc", label: "Sticky note", glyph: "▧", size: { w: 150, h: 130 }, text: "" },
  { kind: "actor", group: "misc", label: "Actor", glyph: "☻", size: { w: 76, h: 120 }, text: "Actor" },
  { kind: "icon", group: "misc", label: "Icon", glyph: "▣", size: { w: 104, h: 112 }, text: "" },
];

export const SHAPE_DEF_BY_KIND: Partial<Record<NodeKind, ShapeDef>> = Object.fromEntries(
  SHAPE_DEFS.map((d) => [d.kind, d]),
);

export function shapeDef(kind: NodeKind): ShapeDef | undefined {
  return SHAPE_DEF_BY_KIND[kind];
}
