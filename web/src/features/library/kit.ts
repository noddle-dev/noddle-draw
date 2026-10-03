/**
 * features/library/kit — the Library's PURE authoring vocabulary, public for
 * other features (templates can be built from it, so a template and a Library
 * item never drift apart visually).
 *
 * Pure data helpers only: no React, no stores, no icon registry — importing
 * this barrel must stay safe outside a browser (e.g. bundled into a Node
 * script).
 */
export { box, CLEAR, icon, item, LINE, link, text, WHITE } from "./builtins/_kit";
export type { BoxOpts, End, LinkOpts, Side } from "./builtins/_kit";
export { LIB_INK, LIB_PALETTE } from "./palette";
export type { LibHue, LibraryItem } from "./types";
// Parametric widgets shared with the packs (same geometry as the Library items).
export { entity } from "./builtins/database";
export { sticky } from "./builtins/brainstorm";
export { figure } from "./builtins/people";
