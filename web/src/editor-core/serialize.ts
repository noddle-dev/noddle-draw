/**
 * editor-core/serialize — parse an uploaded SVG into #content, and serialise
 * the current #content back to an SVG string.
 *
 * Ported from `frontend/editor.js` (loadSvgString / reindex / currentSvgString).
 * Re-exports `esc` so the engine's public surface owns the XSS-escape helper
 * per the ADR ("serialize.ts … esc()").
 */
import type { Artboard } from "./types";
import { esc } from "../shared/utils/esc";

export { esc };

export interface ParsedSvg {
  /** Parsed <svg> root; caller imports its children into #content. */
  root: SVGSVGElement;
  /** Artboard derived from viewBox, else width/height, else 100×100. */
  artboard: Artboard;
}

/**
 * Parse an SVG string. Throws on invalid input (no <svg> root). Does NOT touch
 * the DOM stage — the caller decides how to import the children (see loadInto).
 */
export function parseSvg(svgText: string): ParsedSvg {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.querySelector("svg");
  if (!root) {
    throw new Error("File is not a valid SVG.");
  }

  let w = 100;
  let h = 100;
  let ox = 0;
  let oy = 0;
  const vb = root.getAttribute("viewBox");
  if (vb) {
    const p = vb.split(/[\s,]+/).map(Number);
    // Keep the ORIGIN too — a board whose page auto-extended up/left saves a
    // negative-origin viewBox; dropping p[0]/p[1] made the white page reload
    // at (0,0), offset from every shape that sits at negative coords.
    ox = p[0] || 0;
    oy = p[1] || 0;
    w = p[2];
    h = p[3];
  } else {
    w = parseFloat(root.getAttribute("width") ?? "") || 100;
    h = parseFloat(root.getAttribute("height") ?? "") || 100;
  }
  return { root: root as SVGSVGElement, artboard: { w, h, ox, oy } };
}

/**
 * Load parsed SVG children into the #content group (replacing existing), then
 * assign stable ids + a move cursor to every visual top-level element.
 * Returns the artboard so the store can update camera/fit.
 */
export function loadInto(content: SVGGElement, parsed: ParsedSvg): Artboard {
  content.innerHTML = "";
  const owner = content.ownerDocument;
  Array.from(parsed.root.childNodes).forEach((n) => {
    content.appendChild(owner.importNode(n, true));
  });
  reindex(content);
  return parsed.artboard;
}

/** Give every visual top-level element a stable id + editor cursor hook. */
export function reindex(content: SVGGElement): void {
  let i = 1;
  Array.from(content.children).forEach((el) => {
    if (!el.id) el.setAttribute("id", "obj-" + i++);
    (el as SVGElement).style.cursor = "move";
  });
}

/**
 * Serialise the current #content into a standalone SVG document string.
 *
 * NOTE: `content.innerHTML` is the browser's own serialisation of DOM the user
 * has been editing; the artboard w/h come from the parsed viewBox (numbers), so
 * this string is not an XSS sink here. Untrusted-value escaping (`esc`) is
 * enforced at the *panel render* boundary (layers/properties), where ids/attrs
 * are injected into UI markup.
 */
export function currentSvgString(content: SVGGElement, artboard: Artboard): string {
  const { w, h } = artboard;
  const ox = artboard.ox ?? 0;
  const oy = artboard.oy ?? 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ox} ${oy} ${w} ${h}" width="${w}" height="${h}">${content.innerHTML}</svg>`;
}
