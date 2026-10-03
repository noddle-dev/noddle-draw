/**
 * features/library/palette — the ONE colour table every built-in library item
 * draws from (never inline a hex in an item). Pastel fill + mid-tone stroke
 * per hue, tuned for the hand-drawn house style (sketch, radius 12) on the
 * paper ground; ink #2d3142 carries text. Rose/mint/sky/lemon match the
 * Simple-mode style-panel swatches, ink/ember/link/slate the editorial canon.
 */
export const LIB_PALETTE = {
  ink: { fill: "#ffffff", stroke: "#2d3142" },
  ember: { fill: "#fde4d6", stroke: "#eb6c36" }, // accent — ≤2 focal nodes per item
  link: { fill: "#dbe6f7", stroke: "#2e5aa8" },
  sky: { fill: "#dbeafe", stroke: "#2563eb" },
  mint: { fill: "#dcfce7", stroke: "#16a34a" },
  lemon: { fill: "#fef9c3", stroke: "#ca8a04" },
  rose: { fill: "#fee2e2", stroke: "#dc2626" },
  lilac: { fill: "#ede9fe", stroke: "#7c3aed" },
  slate: { fill: "#e8eaef", stroke: "#4f5d75" },
} as const;

/** Label ink for every library item. */
export const LIB_INK = "#2d3142";
