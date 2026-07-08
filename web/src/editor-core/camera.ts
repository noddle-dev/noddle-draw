/**
 * editor-core/camera — pan/zoom + screen↔content coordinate transforms.
 *
 * Ported from `frontend/editor.js` (applyCamera / screenToContent /
 * contentToStage / fitToView / zoomBy). All screen↔user conversion goes through
 * getScreenCTM().inverse() so it stays correct at any zoom/pan. Refs are passed
 * in as params — the engine never queries the document itself.
 */
import type { Artboard, Camera, Point } from "./types";

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

const clampZoom = (z: number): number =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Serialise a camera to the transform attribute string for the <g id="camera">. */
export function cameraTransform(cam: Camera): string {
  return `translate(${cam.x} ${cam.y}) scale(${cam.z})`;
}

/** screen (clientX/Y) → #content user space. */
export function screenToContent(
  content: SVGGraphicsElement,
  cx: number,
  cy: number,
): Point {
  const ctm = content.getScreenCTM();
  if (!ctm) return { x: cx, y: cy };
  const p = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/** #content user point → stage-pixel space (for drawing the overlay). */
export function contentToStage(
  content: SVGGraphicsElement,
  host: HTMLElement,
  x: number,
  y: number,
): Point {
  const hostRect = host.getBoundingClientRect();
  const ctm = content.getScreenCTM();
  if (!ctm) return { x, y };
  const p = new DOMPoint(x, y).matrixTransform(ctm);
  return { x: p.x - hostRect.left, y: p.y - hostRect.top };
}

/** Compute a camera that centres and fits the artboard within the host. */
export function fit(host: HTMLElement, artboard: Artboard): Camera {
  const r = host.getBoundingClientRect();
  const pad = 48;
  const z = Math.min(
    (r.width - pad) / artboard.w,
    (r.height - pad) / artboard.h,
  );
  const zoom = z > 0 ? z : 1;
  // Center the ACTUAL page rect [ox..ox+w] — a negative-origin artboard
  // (page auto-extended up/left) must shift the camera by its origin.
  const ox = artboard.ox ?? 0;
  const oy = artboard.oy ?? 0;
  return {
    z: zoom,
    x: (r.width - artboard.w * zoom) / 2 - ox * zoom,
    y: (r.height - artboard.h * zoom) / 2 - oy * zoom,
  };
}

/**
 * Anchored zoom (two-phase), mirroring the wheel/zoomBy dance in editor.js.
 *
 * Phase 1 — the caller captures the content point currently under the anchor
 * via `screenToContent`, then applies a new camera with zoom `clampZoom(z*f)`
 * to the DOM. Phase 2 — `recenterAfterZoom` reads the *new* screen CTM and
 * nudges translate so that content point maps back under the anchor, keeping it
 * fixed on screen. The store (editorStore.zoomBy) orchestrates both phases;
 * this split exists because `getScreenCTM()` must reflect the applied camera.
 */
export function recenterAfterZoom(
  content: SVGGraphicsElement,
  cam: Camera,
  before: Point,
  anchorClientX: number,
  anchorClientY: number,
): Camera {
  const after = screenToContent(content, anchorClientX, anchorClientY);
  return {
    ...cam,
    x: cam.x + (after.x - before.x) * cam.z,
    y: cam.y + (after.y - before.y) * cam.z,
  };
}

export { clampZoom };
