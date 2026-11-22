/**
 * Diagram label typography — the ONE place a font token or a text ink becomes
 * a concrete CSS value.
 *
 * Two things used to be hardcoded twice over: the label ink (`#1a1d23` in
 * NodeView, `#2d3142` in EdgeView — the same role, two different colours, one
 * of them off-palette) and the font stack (only the sketch handwriting face
 * existed). Both now resolve here, so a board's saved JSON carries a token and
 * the stack behind it stays swappable.
 *
 * Values must be INLINE SVG attributes at the call site, not CSS classes: the
 * board bake in `editorStore.currentBoardSvg` DOM-clones the live SVG and
 * classes do not survive it.
 */
import type { DiagramNode, NodeFontFamily } from "../../editor-core/diagram/types";

/**
 * Default label ink — the editorial `ink` token (ADR-0009).
 *
 * NodeView's old default was `#1a1d23`, ΔE 12 off the palette. That is far
 * enough to read as a foreign hue and it applied to every node whose JSON
 * simply omitted `textColor`, so a board could fail the colour gate on a field
 * nobody had set.
 */
export const LABEL_INK = "#2d3142";

/**
 * Three compatible typography tokens, backed by self-hosted fonts.
 * The shared font loader embeds the same files into exports and MCP capture.
 */
export const FONT_STACKS: Record<NodeFontFamily, string> = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'Cousine, ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  serif: '"Gentium Book Plus", ui-serif, Georgia, "Times New Roman", serif',
};

/** The handwriting face for `node.sketch` — outranks any family token. */
const SKETCH_STACK = 'Kalam, "Comic Sans MS", "Segoe Print", "Bradley Hand", cursive';

/** Edge-label metrics mirrored in backend domain/editorial.py. Labels sit on
 * the connector; a transparent SVG mask clears the line below their text. */
export const LABEL_CHIP = { FONT_SIZE: 12, PAD: 12, CHAR_RATIO: 0.62, MIN_W: 18, GAP: 0 } as const;

/** Rendered width of an edge-label chip. */
export function labelChipWidth(text: string): number {
  return Math.max(
    LABEL_CHIP.MIN_W,
    text.length * LABEL_CHIP.FONT_SIZE * LABEL_CHIP.CHAR_RATIO + LABEL_CHIP.PAD,
  );
}

/**
 * Resolve a label font stack. Inter is explicit so SVG/PNG use the same face.
 * Sketch mode uses the self-hosted Kalam handwriting face.
 */
export function nodeFontStack(node: DiagramNode): string | undefined {
  if (node.sketch) return SKETCH_STACK;
  const fam = node.fontFamily;
  return FONT_STACKS[fam ?? "sans"];
}

/** Medium body labels stay legible without reading as bold. */
export function nodeFontWeight(node: DiagramNode): number {
  return node.bold ? 700 : node.kind === "icon" && node.bold === undefined ? 600 : 500;
}
