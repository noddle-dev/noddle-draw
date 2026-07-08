/**
 * features/canvas — the SVG stage (<svg> with camera + content + overlay) plus
 * all pointer interactions (pan, select, move, resize, marquee, wheel-zoom,
 * double-click text edit). Ported from the pointer/interaction section of
 * `frontend/editor.js`.
 *
 * Thin-React principle (ADR): the heavy math lives in editor-core; this file
 * wires DOM pointer events to engine functions and the store. The editable SVG
 * lives in real DOM (refs), NOT in React state — React only renders the shell
 * and (imperatively) the selection overlay.
 */
import { useEffect, useRef } from "react";
import {
  matrixToString,
  moveMatrix,
  ownMatrix,
  resizeMatrix,
  resizePivot,
  resizeScale,
  screenToContent,
  topObject,
  marqueeHits,
  type HandleId,
  type Rect,
  type SceneObject,
} from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";
import { useAppStore } from "../../state/appStore";
import { useDiagramStore } from "../../state/diagramStore";
import {
  SelectionOverlay,
  type SelectionOverlayHandle,
} from "./SelectionOverlay";
import { useTextEdit } from "./useTextEdit";
import { panState } from "../../state/panState";
import { DiagramLayer } from "../diagram";
import { beginNodeTextEdit } from "../diagram/nodeTextEdit";

type DragHandlers = {
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
};

export function Canvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<SVGSVGElement>(null);
  const cameraRef = useRef<SVGGElement>(null);
  const artboardRef = useRef<SVGRectElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const marqueeRef = useRef<SVGRectElement>(null);
  const overlayApiRef = useRef<SelectionOverlayHandle>(null);

  const dragRef = useRef<DragHandlers | null>(null);
  const spaceDownRef = useRef(false);

  const artboard = useEditorStore((s) => s.artboard);
  const selection = useEditorStore((s) => s.selection);
  const contentRev = useEditorStore((s) => s.contentRev);
  const gridOn = useAppStore((s) => s.gridOn);
  const diagramNodeCount = useDiagramStore((s) => Object.keys(s.nodes).length);

  const { beginTextEdit, editingRef } = useTextEdit(hostRef, contentRef);

  const redrawOverlay = () => overlayApiRef.current?.redraw();

  // Attach DOM refs to the store once mounted; kick off document list load.
  useEffect(() => {
    if (contentRef.current && hostRef.current && cameraRef.current) {
      const st = useEditorStore.getState();
      st.attach(
        { content: contentRef.current, host: hostRef.current },
        cameraRef.current,
      );
      void st.refreshDocs();
    }
  }, []);

  // Keep artboard rect attributes in sync with parsed dimensions.
  useEffect(() => {
    const ab = artboardRef.current;
    if (ab) {
      ab.setAttribute("x", String(artboard.ox ?? 0));
      ab.setAttribute("y", String(artboard.oy ?? 0));
      ab.setAttribute("width", String(artboard.w));
      ab.setAttribute("height", String(artboard.h));
    }
  }, [artboard]);

  // ---- pointer / wheel / dblclick interaction (native listeners) ----
  useEffect(() => {
    const stage = stageRef.current;
    const host = hostRef.current;
    const content = contentRef.current;
    if (!stage || !host || !content) return;
    const s = useEditorStore.getState;

    const startPan = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      host.classList.add("panning"); // closed hand while dragging
      const cam0 = s().cam;
      const start = { x: e.clientX, y: e.clientY, cx: cam0.x, cy: cam0.y };
      dragRef.current = {
        move: (ev) =>
          s().setCam({
            ...s().cam,
            x: start.cx + (ev.clientX - start.x),
            y: start.cy + (ev.clientY - start.y),
          }),
        up: () => host.classList.remove("panning"),
      };
    };

    const startMove = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      s().beginAction();
      const start = screenToContent(content, e.clientX, e.clientY);
      const origs = s().selection.map((el) => ({ el, m: ownMatrix(el) }));
      dragRef.current = {
        move: (ev) => {
          const p = screenToContent(content, ev.clientX, ev.clientY);
          const dx = p.x - start.x;
          const dy = p.y - start.y;
          origs.forEach(({ el, m }) =>
            el.setAttribute("transform", matrixToString(moveMatrix(m, dx, dy))),
          );
          redrawOverlay();
        },
        up: () => s().commitAction(),
      };
    };

    const startResize = (e: PointerEvent, handleId: HandleId, box0: Rect) => {
      e.stopPropagation();
      stage.setPointerCapture(e.pointerId);
      s().beginAction();
      const pivot = resizePivot(handleId, box0);
      const start = screenToContent(content, e.clientX, e.clientY);
      const origs = s().selection.map((el) => ({ el, m: ownMatrix(el) }));
      const d0 = { x: start.x - pivot.x, y: start.y - pivot.y };
      dragRef.current = {
        move: (ev) => {
          const p = screenToContent(content, ev.clientX, ev.clientY);
          const { sx, sy } = resizeScale(pivot, d0, p, ev.shiftKey);
          origs.forEach(({ el, m }) =>
            el.setAttribute(
              "transform",
              matrixToString(resizeMatrix(m, pivot, sx, sy)),
            ),
          );
          redrawOverlay();
        },
        up: () => s().commitAction(),
      };
    };
    resizeStarterRef.current = startResize;

    const startMarquee = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      const p0 = screenToContent(content, e.clientX, e.clientY);
      const marqueeEl = marqueeRef.current;
      const hostRect = host.getBoundingClientRect();
      const o = { x: e.clientX - hostRect.left, y: e.clientY - hostRect.top };
      dragRef.current = {
        move: (ev) => {
          if (!marqueeEl) return;
          const x = ev.clientX - hostRect.left;
          const y = ev.clientY - hostRect.top;
          marqueeEl.setAttribute("x", String(Math.min(o.x, x)));
          marqueeEl.setAttribute("y", String(Math.min(o.y, y)));
          marqueeEl.setAttribute("width", String(Math.abs(x - o.x)));
          marqueeEl.setAttribute("height", String(Math.abs(y - o.y)));
          marqueeEl.style.display = "block";
        },
        up: (ev) => {
          if (marqueeEl) marqueeEl.style.display = "none";
          const p1 = screenToContent(content, ev.clientX, ev.clientY);
          const hits = marqueeHits(content, p0, p1);
          const base = ev.shiftKey ? s().selection : [];
          s().setSelection([...new Set([...base, ...hits])] as SceneObject[]);
          // Lucid-style: the marquee also selects diagram nodes it intersects.
          const ds = useDiagramStore.getState();
          const x0 = Math.min(p0.x, p1.x);
          const y0 = Math.min(p0.y, p1.y);
          const x1 = Math.max(p0.x, p1.x);
          const y1 = Math.max(p0.y, p1.y);
          const nodeHits = Object.values(ds.nodes)
            .filter(
              (n) => n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0,
            )
            .map((n) => n.id);
          const dsBase = ev.shiftKey ? ds.diagramSelection : [];
          ds.setDiagramSelection([...new Set([...dsBase, ...nodeHits])]);
        },
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      // Space-pan overrides EVERYTHING — grips, shapes, ports all step aside
      // (they check panState themselves) and the hand drags the page.
      if (!spaceDownRef.current) {
        if ((e.target as Element).closest("[data-handle]")) return; // startResize owns it
        // The diagram layer owns its own pointer interactions (node drag, port
        // drag-to-connect, edge select). This handler is a NATIVE listener so it
        // fires regardless of React stopPropagation — skip explicitly.
        if ((e.target as Element).closest("#diagram-layer")) return;
      }
      const wantPan =
        s().tool === "pan" || e.button === 1 || spaceDownRef.current;
      if (wantPan) {
        startPan(e);
        return;
      }
      const obj = topObject(
        content,
        document.elementFromPoint(e.clientX, e.clientY),
      );
      if (obj) {
        const sel = s().selection;
        if (e.shiftKey) {
          const next = sel.includes(obj)
            ? sel.filter((x) => x !== obj)
            : [...sel, obj];
          s().setSelection(next);
        } else if (!sel.includes(obj)) {
          s().setSelection([obj]);
        }
        if (s().selection.length) startMove(e);
      } else {
        if (!e.shiftKey) {
          s().setSelection([]);
          useDiagramStore.getState().setDiagramSelection([]);
        }
        startMarquee(e);
      }
    };

    const onPointerMove = (e: PointerEvent) => dragRef.current?.move(e);
    const onPointerUp = (e: PointerEvent) => {
      if (dragRef.current) {
        dragRef.current.up(e);
        dragRef.current = null;
        redrawOverlay();
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Lucid/Figma convention: plain wheel/trackpad SCROLLS the board
      // (vertical + horizontal; Shift turns a mouse's vertical wheel into
      // horizontal), ⌘/Ctrl+wheel — and the trackpad pinch, which browsers
      // report as a ctrlKey wheel — ZOOMS at the cursor.
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        s().zoomBy(factor, e.clientX, e.clientY);
        return;
      }
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      const cam = s().cam;
      s().setCam({ ...cam, x: cam.x - dx, y: cam.y - dy });
    };

    const localTag = (n: Element) => n.tagName.replace(/^.*:/, "");
    const onDblClick = (e: MouseEvent) => {
      // Diagram nodes/edges own their own dblclick (inline text edit).
      if ((e.target as Element).closest("#diagram-layer")) return;
      let node: Node | null = document.elementFromPoint(e.clientX, e.clientY);
      while (node && node !== content && localTag(node as Element) !== "text") {
        node = node.parentNode;
      }
      let textEl: SVGTextElement | null =
        node && localTag(node as Element) === "text"
          ? (node as SVGTextElement)
          : null;
      if (!textEl) {
        const obj = topObject(
          content,
          document.elementFromPoint(e.clientX, e.clientY),
        );
        textEl = obj ? obj.querySelector("text") : null;
      }
      if (!textEl) {
        s().setStatus("This object has no text to edit.");
        return;
      }
      beginTextEdit(textEl);
    };

    stage.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    host.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("dblclick", onDblClick);

    return () => {
      stage.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("wheel", onWheel);
      stage.removeEventListener("dblclick", onDblClick);
    };
  }, [beginTextEdit]);

  const resizeStarterRef = useRef<
    ((e: PointerEvent, id: HandleId, box: Rect) => void) | null
  >(null);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const s = useEditorStore.getState;
    const typingInField = () => {
      const a = document.activeElement as HTMLElement | null;
      return (
        editingRef.current ||
        (a != null &&
          (a.tagName === "INPUT" ||
            a.tagName === "TEXTAREA" ||
            a.isContentEditable))
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDownRef.current = true;
        if (!typingInField()) {
          e.preventDefault();
          // open-hand cursor + let node/grip/port handlers step aside
          panState.spaceHeld = true;
          hostRef.current?.classList.add("space-pan");
        }
      }
      if (typingInField()) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s().redo();
        else s().undo();
      } else if (meta && e.key.toLowerCase() === "a") {
        // ⌘A / Ctrl+A selects every object on the board — NOT the browser's
        // "select all text". preventDefault kills the native text selection.
        e.preventDefault();
        const ds = useDiagramStore.getState();
        const ids = [...Object.keys(ds.nodes), ...Object.keys(ds.edges)];
        if (ids.length) ds.setDiagramSelection(ids);
      } else if (meta && e.key.toLowerCase() === "g") {
        // ⌘G group / ⌘⇧G ungroup the selected diagram nodes.
        const ds = useDiagramStore.getState();
        if (ds.diagramSelection.some((id) => ds.nodes[id])) {
          e.preventDefault();
          if (e.shiftKey) ds.ungroupSelection();
          else ds.groupSelection();
        }
      } else if (meta && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
        // ⌘C copy / ⌘X cut the selected shapes+connectors (in-app clipboard).
        const ds = useDiagramStore.getState();
        if (ds.diagramSelection.length && ds.copySelection()) {
          e.preventDefault();
          if (e.key.toLowerCase() === "x") ds.deleteSelectedDiagram();
          s().setStatus(e.key.toLowerCase() === "x" ? "Cut to clipboard." : "Copied — ⌘V to paste.", "ok");
        }
      } else if (meta && e.key.toLowerCase() === "v" && !e.shiftKey) {
        // ⌘V paste (only claims the shortcut when OUR clipboard has shapes —
        // otherwise the browser paste event still feeds pasteImage.ts).
        const ds = useDiagramStore.getState();
        const before = ds.diagramSelection;
        ds.pasteClipboard();
        if (useDiagramStore.getState().diagramSelection !== before) e.preventDefault();
      } else if (meta && e.key.toLowerCase() === "d") {
        // ⌘D duplicate in place (browser would bookmark the page).
        e.preventDefault();
        useDiagramStore.getState().duplicateSelection();
      } else if (meta && !e.shiftKey && ["b", "i", "u"].includes(e.key.toLowerCase())) {
        // ⌘B/⌘I/⌘U toggle bold/italic/underline on the selected shapes
        // (multi-select: everything flips to the opposite of "all on").
        const ds = useDiagramStore.getState();
        const ids = ds.diagramSelection.filter((id) => ds.nodes[id]);
        if (ids.length) {
          e.preventDefault();
          const prop = (
            { b: "bold", i: "italic", u: "underline" } as const
          )[e.key.toLowerCase() as "b" | "i" | "u"];
          const all = ids.every((id) => !!ds.nodes[id][prop]);
          const patch =
            prop === "bold" ? { bold: !all } : prop === "italic" ? { italic: !all } : { underline: !all };
          ids.forEach((id) => ds.updateNode(id, patch));
        }
      } else if (meta && ["=", "+", "-", "_"].includes(e.key)) {
        // ⌘/Ctrl +/− zoom the BOARD by 20% (instead of the browser page).
        e.preventDefault();
        const zoomIn = e.key === "=" || e.key === "+";
        s().zoomBy(zoomIn ? 1.2 : 1 / 1.2);
      } else if (meta && e.key === "0") {
        // ⌘/Ctrl 0 — fit the board (matches the browser's reset-zoom muscle memory)
        e.preventDefault();
        s().fitToView();
      } else if (meta && e.shiftKey && [">", ".", "<", ","].includes(e.key)) {
        // ⌘⇧. / ⌘⇧, (Docs-style) grow/shrink the selected shapes' font size.
        const ds = useDiagramStore.getState();
        const ids = ds.diagramSelection.filter((id) => ds.nodes[id]);
        if (ids.length) {
          e.preventDefault();
          const delta = e.key === ">" || e.key === "." ? 1 : -1;
          ids.forEach((id) => {
            const fs = ds.nodes[id].fontSize ?? 14;
            ds.updateNode(id, { fontSize: Math.min(200, Math.max(6, fs + delta)) });
          });
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const ds = useDiagramStore.getState();
        if (s().selection.length) {
          e.preventDefault();
          s().deleteSelection();
        } else if (ds.diagramSelection.length) {
          e.preventDefault();
          ds.deleteSelectedDiagram();
        }
      } else if (
        !meta &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key !== " " &&
        useDiagramStore.getState().diagramSelection.length === 1 &&
        useDiagramStore.getState().nodes[useDiagramStore.getState().diagramSelection[0]]
      ) {
        // Type-to-edit (Lucid): a printable key with ONE shape selected starts
        // typing its label right away — replacing the old text — no dblclick.
        // Runs BEFORE the v/h tool keys, which yield to typing here.
        e.preventDefault();
        const ds = useDiagramStore.getState();
        beginNodeTextEdit(ds.nodes[ds.diagramSelection[0]], { seed: e.key });
      } else if (e.key === "v") {
        s().setTool("select");
      } else if (e.key === "h") {
        s().setTool("pan");
      } else if (e.key === "Escape") {
        s().setSelection([]);
        useDiagramStore.getState().setDiagramSelection([]);
      } else if (e.shiftKey && e.key === "!") {
        s().fitToView();
      }
    };
    const releaseSpace = () => {
      spaceDownRef.current = false;
      panState.spaceHeld = false;
      hostRef.current?.classList.remove("space-pan");
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") releaseSpace();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // alt-tab while holding Space would leave the hand stuck on
    window.addEventListener("blur", releaseSpace);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpace);
    };
  }, [editingRef]);

  const showEmptyHint =
    selection.length === 0 && contentRev === 0 && diagramNodeCount === 0;

  return (
    <section className={`canvas-host${gridOn ? "" : " no-grid"}`} ref={hostRef}>
      <svg id="stage" ref={stageRef} xmlns="http://www.w3.org/2000/svg">
        <g id="camera" ref={cameraRef}>
          <rect
            id="artboard"
            ref={artboardRef}
            x={artboard.ox ?? 0}
            y={artboard.oy ?? 0}
            width={artboard.w}
            height={artboard.h}
            className="artboard"
          />
          <g id="content" ref={contentRef} />
          <DiagramLayer />
        </g>
        <g id="overlay">
          <SelectionOverlay
            ref={overlayApiRef}
            onStartResize={(e, id, box) =>
              resizeStarterRef.current?.(e, id, box)
            }
          />
          <rect
            ref={marqueeRef}
            className="marquee"
            style={{ display: "none" }}
          />
        </g>
      </svg>

      {showEmptyHint && (
        <div className="empty-hint">
          <p className="big">
            Drag and drop or click <strong>Upload SVG</strong> to get started
          </p>
          <p className="muted">
            Native SVG DOM · lossless round-trip · double-click text to
            edit it
          </p>
        </div>
      )}

      <ZoomWidget />
    </section>
  );
}

/** Floating zoom control (bottom-right). Reads/writes camera via the store. */
function ZoomWidget() {
  const cam = useEditorStore((s) => s.cam);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const fitToView = useEditorStore((s) => s.fitToView);
  return (
    <div className="zoom-widget">
      <button title="Zoom out" onClick={() => zoomBy(0.8)}>
        −
      </button>
      <span className="zoom-label">{Math.round(cam.z * 100)}%</span>
      <button title="Zoom in" onClick={() => zoomBy(1.25)}>
        +
      </button>
      <span className="sep" />
      <button title="Fit (⇧1)" onClick={fitToView}>
        ⤢ Fit
      </button>
    </div>
  );
}
