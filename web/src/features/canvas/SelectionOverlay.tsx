/**
 * features/canvas/SelectionOverlay — the selection box + 4 corner resize
 * handles, drawn in stage-pixel space (outside the camera). Ported from
 * drawSelection() in `frontend/editor.js`.
 *
 * Exposes an imperative `redraw()` via ref so the Canvas can refresh the box
 * during a drag (when element transforms are mutated imperatively, without a
 * store update) without paying a full React re-render per pointermove.
 */
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import {
  contentToStage,
  unionBBox,
  type HandleId,
  type Rect,
} from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";

export interface SelectionOverlayHandle {
  redraw: () => void;
}

interface Props {
  onStartResize: (e: PointerEvent, handle: HandleId, box: Rect) => void;
}

const HANDLE_SIZE = 8;
const HANDLES: HandleId[] = ["nw", "ne", "se", "sw"];

export const SelectionOverlay = forwardRef<SelectionOverlayHandle, Props>(
  function SelectionOverlay({ onStartResize }, ref) {
    const groupRef = useRef<SVGGElement>(null);

    const redraw = () => {
      const g = groupRef.current;
      if (!g) return;
      while (g.firstChild) g.removeChild(g.firstChild);

      const { selection, refs } = useEditorStore.getState();
      if (!selection.length || !refs) return;

      const b = unionBBox(selection); // content-space bbox
      const c0 = contentToStage(refs.content, refs.host, b.x, b.y);
      const c1 = contentToStage(refs.content, refs.host, b.x + b.w, b.y + b.h);
      const x = Math.min(c0.x, c1.x);
      const y = Math.min(c0.y, c1.y);
      const w = Math.abs(c1.x - c0.x);
      const h = Math.abs(c1.y - c0.y);

      const box = mk("rect", {
        x,
        y,
        width: w,
        height: h,
        class: "sel-box",
      });
      g.appendChild(box);

      const corners: Record<HandleId, [number, number]> = {
        nw: [x, y],
        ne: [x + w, y],
        se: [x + w, y + h],
        sw: [x, y + h],
      };
      HANDLES.forEach((id) => {
        const [hx, hy] = corners[id];
        const hnd = mk("rect", {
          x: hx - HANDLE_SIZE / 2,
          y: hy - HANDLE_SIZE / 2,
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          class: "handle",
          "data-handle": id,
        });
        hnd.addEventListener("pointerdown", (e) =>
          onStartResize(e as PointerEvent, id, b),
        );
        g.appendChild(hnd);
      });
    };

    useImperativeHandle(ref, () => ({ redraw }));

    // Declarative redraw when selection / camera / content revision change.
    const selection = useEditorStore((s) => s.selection);
    const cam = useEditorStore((s) => s.cam);
    const contentRev = useEditorStore((s) => s.contentRev);
    useLayoutEffect(() => {
      redraw();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection, cam, contentRev]);

    return <g ref={groupRef} />;
  },
);

/** Create a namespaced SVG element with attributes (ported mk() helper). */
function mk(
  tag: string,
  attrs: Record<string, string | number>,
): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}
