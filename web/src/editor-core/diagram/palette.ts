/**
 * editor-core/diagram/palette — the editor's draw palette (style panel swatches).
 * MIRRORED in backend/app/domain/board_palette.py, the AI's DEFAULT colours —
 * backend/tests/test_board_palette.py fails on drift, so edit both together.
 */
export const STROKES = ["#2d3142", "#dc2626", "#16a34a", "#2563eb", "#eb6c36"];

export const FILLS: { v: string; label: string }[] = [
  { v: "transparent", label: "Transparent" },
  { v: "#ffffff", label: "White" },
  { v: "#fee2e2", label: "Soft red" },
  { v: "#dcfce7", label: "Soft green" },
  { v: "#dbeafe", label: "Soft blue" },
  { v: "#fef9c3", label: "Soft yellow" },
];

/** Stroke + matching pastel fill (one-click "Style" row). */
export const STYLE_PAIRS: { name: string; stroke: string; fill: string }[] = [
  { name: "Ink", stroke: "#2d3142", fill: "#ffffff" },
  { name: "Red", stroke: "#dc2626", fill: "#fee2e2" },
  { name: "Green", stroke: "#16a34a", fill: "#dcfce7" },
  { name: "Blue", stroke: "#2563eb", fill: "#dbeafe" },
  { name: "Ember", stroke: "#eb6c36", fill: "#fef9c3" },
];
