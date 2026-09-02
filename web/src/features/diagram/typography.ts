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
 * Token → font stack. System faces on purpose: the reference style is set in
 * Geist / Geist Mono, and shipping webfonts would add a runtime dependency the
 * repo does not take AND break PNG/GIF export, which can only rasterize faces
 * the renderer already has. The typographic HIERARCHY is what carries the
 * style; the exact glyphs are not reproducible without the licensed faces.
 */
export const FONT_STACKS: Record<NodeFontFamily, string> = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
};

/** The handwriting face for `node.sketch` — outranks any family token. */
const SKETCH_STACK = '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive';

/**
 * Edge-label chip geometry. Mirrored in `backend/app/domain/editorial.py`
 * (`LABEL_CHIP_*` / `label_chip_offset`) so the style gate measures the pixels
 * this file actually paints; `backend/tests/test_editorial.py` fails on drift.
 *
 * `GAP` is the reference style's hard rule: the mask must clear the connector
 * by 6–10px. A label centred ON its own line hides the line it annotates,
 * which the reference calls a hard fail — and it was also the source of the
 * recurring "chip clipped by the node" gate finding, since a chip sitting in
 * the gap between two boxes has only that gap to fit in, while a chip lifted
 * clear of the line has the whole canvas above it.
 */
export const LABEL_CHIP = { FONT_SIZE: 12, PAD: 12, CHAR_RATIO: 0.62, MIN_W: 18, GAP: 6 } as const;

/** Rendered width of an edge-label chip. */
export function labelChipWidth(text: string): number {
  return Math.max(
    LABEL_CHIP.MIN_W,
    text.length * LABEL_CHIP.FONT_SIZE * LABEL_CHIP.CHAR_RATIO + LABEL_CHIP.PAD,
  );
}

/**
 * Where the chip sits relative to the point on the line, given the local
 * segment direction. A mostly-horizontal run pushes the chip UP; a vertical
 * run pushes it to the RIGHT, because a chip stacked above a vertical arrow
 * lands on whatever that arrow is heading into.
 */
export function labelChipOffset(text: string, dir: { x: number; y: number }): { dx: number; dy: number } {
  const chipH = LABEL_CHIP.FONT_SIZE + 8;
  if (Math.abs(dir.x) >= Math.abs(dir.y)) return { dx: 0, dy: -(chipH / 2 + LABEL_CHIP.GAP) };
  return { dx: labelChipWidth(text) / 2 + LABEL_CHIP.GAP, dy: 0 };
}

/**
 * Resolve a node's label font stack. `sketch` wins: the hand-drawn look is a
 * whole-node mode, not a typographic role, so a sketch node stays sketchy even
 * if its JSON also names a family. Returns undefined for plain sans so the
 * attribute is omitted and saved boards don't carry a redundant default.
 */
export function nodeFontStack(node: DiagramNode): string | undefined {
  if (node.sketch) return SKETCH_STACK;
  const fam = node.fontFamily;
  return fam && fam !== "sans" ? FONT_STACKS[fam] : undefined;
}
