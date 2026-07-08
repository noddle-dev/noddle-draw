/**
 * editor-core/types — shared value types for the framework-agnostic engine.
 *
 * PURE TypeScript: no React, no DOM globals beyond the SVG/DOM lib types that
 * are inherent to editing real SVG DOM (SVGSVGElement, DOMMatrix, …). These are
 * platform types, not app framework dependencies, so the engine stays
 * unit-testable (jsdom/happy-dom provide DOMMatrix in Vitest).
 */

/** A top-level editable object: a direct child of the #content group. */
export type SceneObject = SVGGraphicsElement;

/** Camera / viewport transform: translate(x, y) scale(z). */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned rectangle in some coordinate space (content or stage px). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 2D point. */
export interface Point {
  x: number;
  y: number;
}

/** Artboard dimensions (from the uploaded SVG viewBox / width-height). */
export interface Artboard {
  w: number;
  h: number;
  /** Top-left origin in content coords (default 0,0). Goes negative when the
   * page auto-extends up/left to contain shapes dragged past the origin. */
  ox?: number;
  oy?: number;
}

/** Editing tools. */
export type Tool = "select" | "pan";

/** Resize handle ids (corners). */
export type HandleId = "nw" | "ne" | "se" | "sw";

/**
 * Host DOM references the engine operates on. Passed in as params so the engine
 * never reaches for `document.getElementById` — keeps it testable and decoupled
 * from any particular DOM layout.
 */
export interface StageRefs {
  /** The <g id="content"> that holds the editable SVG children. */
  content: SVGGElement;
  /** The scrollable host element (canvas viewport) for rect measurements. */
  host: HTMLElement;
}

/** Elements that exist in the SVG tree but are not user-selectable objects. */
export const NON_VISUAL = new Set([
  "defs",
  "title",
  "desc",
  "metadata",
  "style",
]);

/** Return the local (namespace-stripped) tag name of an element. */
export const localName = (el: Element): string =>
  el.tagName.replace(/^.*:/, "");
