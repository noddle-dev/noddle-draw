/**
 * state/canvasDrop — the palette → canvas pointer-drag gesture, shared by every
 * feature that places things on the board (shape palette, "My shapes", the
 * Library panel). Lives in state/ because it resolves the drop point through
 * the SHARED camera (editorStore.refs).
 *
 * Contract (Lucid-style): a press that never moves past DRAG_SLOP is a CLICK
 * → place at the visible canvas centre; a real drag shows a fixed-position
 * ghost that follows the cursor (".droppable" while over the canvas) and
 * places at the exact content point under the pointer — only when released
 * over the canvas host. Releasing elsewhere cancels.
 */
import { screenToContent } from "../editor-core";
import type { Vec } from "../editor-core/diagram";
import { useEditorStore } from "./editorStore";

const DRAG_SLOP = 4; // px of travel before a press becomes a drag

/** The minimal pointer-down shape — a DOM PointerEvent or React's wrapper. */
interface PressEvent {
  button: number;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}

export interface FragmentDragOptions {
  /** The cursor ghost — an element, or a factory called once the drag starts.
   * It is appended to <body> and removed on release. */
  ghost: HTMLElement | (() => HTMLElement);
  /** Place at a CONTENT point: the pointer on a drop, the canvas centre on a
   * click. `dropped` tells the two apart. */
  onDrop: (at: Vec, dropped: boolean) => void;
}

/** Content point at the centre of the visible canvas (fallback 200,150 when
 * the canvas isn't mounted). */
export function canvasCenterPoint(): Vec {
  const refs = useEditorStore.getState().refs;
  if (!refs) return { x: 200, y: 150 };
  const r = refs.host.getBoundingClientRect();
  return screenToContent(refs.content, r.left + r.width / 2, r.top + r.height / 2);
}

/** Content point under a client position, or null when it's off the canvas. */
export function canvasPointAt(clientX: number, clientY: number): Vec | null {
  const refs = useEditorStore.getState().refs;
  if (!refs) return null;
  const r = refs.host.getBoundingClientRect();
  const inside =
    clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  return inside ? screenToContent(refs.content, clientX, clientY) : null;
}

export function startFragmentDrag(e: PressEvent, opts: FragmentDragOptions): void {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLElement | null = null;
  let moved = false;

  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_SLOP) {
      moved = true;
      ghost = typeof opts.ghost === "function" ? opts.ghost() : opts.ghost;
      document.body.appendChild(ghost);
    }
    if (ghost) {
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
      // highlight while the drop would land on the canvas
      ghost.classList.toggle("droppable", canvasPointAt(ev.clientX, ev.clientY) !== null);
    }
  };
  const finish = (ev: PointerEvent, cancelled: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    ghost?.remove();
    if (cancelled) return;
    if (!moved) {
      opts.onDrop(canvasCenterPoint(), false);
      return;
    }
    const at = canvasPointAt(ev.clientX, ev.clientY);
    if (at) opts.onDrop(at, true);
  };
  const up = (ev: PointerEvent) => finish(ev, false);
  const cancel = (ev: PointerEvent) => finish(ev, true);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

/** The default text ghost (".shape-ghost") — a glyph in a dashed tile. */
export function textGhost(glyph: string, className = "shape-ghost"): () => HTMLElement {
  return () => {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = glyph;
    return el;
  };
}
