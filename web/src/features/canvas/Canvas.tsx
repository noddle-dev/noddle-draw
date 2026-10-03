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
import { DRAW_STYLE_DEFAULTS, useEditorStore } from "../../state/editorStore";
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
import { mintEdgeId } from "../diagram/ConnectionPorts";
import { groupSelected, ungroupSelected } from "../../state/grouping";
import { arrangeSelection, copyStyles, flipSelection, hasCopiedStyles, pasteStyles } from "../../state/arrange";
import { edgePath, normaliseStroke, snapConnect, type Attachment } from "../../editor-core/diagram";

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
  const tool = useEditorStore((s) => s.tool);
  // Pen cursor follows the brush (nib / marker / highlighter tip).
  const penType = useEditorStore((s) => s.penStyle.brush?.type ?? "pen");
  const gridOn = useAppStore((s) => s.gridOn);
  const pageBackdrop = useAppStore((s) => s.pageBackdrop);
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
          // Lucid-style: the marquee also selects diagram nodes AND the
          // connectors it touches, so a rubber-band sweep grabs a whole
          // sub-graph in one gesture (then ⌘G groups it, Delete removes it).
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
          // Arrows join when their WHOLE route sits inside the box (Excalidraw)
          // — a connector merely crossing the marquee stays out.
          const inBox = (p: { x: number; y: number }) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
          const edgeHits = Object.values(ds.edges)
            .filter((ed) => {
              const g = edgePath(ed, ds.nodes);
              return !!g && g.points.every(inBox);
            })
            .map((ed) => ed.id);
          const dsBase = ev.shiftKey ? ds.diagramSelection : [];
          ds.setDiagramSelection([...new Set([...dsBase, ...nodeHits, ...edgeHits])]);
        },
      };
    };

    // Draw-shape tool (Excalidraw-style): with a shape armed (editorStore
    // drawSpec), dragging on the canvas draws the REAL shape live — the node
    // is created once the pointer travels 6px and then resized with the drag,
    // so the preview is pixel-true (kind, colors, label). A plain click
    // (never crossing 6px) creates NOTHING, so accidental taps stay
    // consequence-free. Modifiers follow Excalidraw: Shift = square/circle,
    // Alt = grow from the press point as CENTER. A committed draw drops back
    // to Select unless the tool lock (Q) is on.
    const startDrawShape = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      const p0 = screenToContent(content, e.clientX, e.clientY);
      let createdId: string | null = null;
      const frame = (ev: PointerEvent) => {
        const p1 = screenToContent(content, ev.clientX, ev.clientY);
        let dx = p1.x - p0.x;
        let dy = p1.y - p0.y;
        if (ev.shiftKey) {
          const m = Math.max(Math.abs(dx), Math.abs(dy));
          dx = (dx < 0 ? -1 : 1) * m;
          dy = (dy < 0 ? -1 : 1) * m;
        }
        if (ev.altKey) {
          const hw = Math.max(10, Math.abs(dx));
          const hh = Math.max(10, Math.abs(dy));
          return { x: p0.x - hw, y: p0.y - hh, w: hw * 2, h: hh * 2 };
        }
        const x = Math.min(p0.x, p0.x + dx);
        const y = Math.min(p0.y, p0.y + dy);
        const w = Math.max(20, Math.abs(dx));
        const h = Math.max(20, Math.abs(dy));
        return { x, y, w, h };
      };
      dragRef.current = {
        move: (ev) => {
          const spec = s().drawSpec;
          if (!spec) return;
          const ds = useDiagramStore.getState();
          const box = frame(ev);
          if (!createdId) {
            if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
            ds.setDiagramMode(true);
            createdId = ds.addNodeAt(
              spec.kind,
              { x: box.x + box.w / 2, y: box.y + box.h / 2 },
              {
                ...DRAW_STYLE_DEFAULTS,
                ...spec.init,
                // A drawn shape starts blank (dblclick/type to name it); its
                // corner radius comes from DRAW_STYLE_DEFAULTS like the rest.
                text: "",
                ...s().drawStyle,
                ...box,
              },
            );
          } else {
            ds.updateNode(createdId, box);
          }
        },
        up: () => {
          // A click without a drag minted nothing — keep the tool armed.
          if (createdId) s().finishToolUse();
        },
      };
    };

    // Free text label at a screen point (Text tool click / empty-canvas
    // dblclick, Excalidraw): a borderless transparent box wearing the panel's
    // TEXT picks, straight into typing. One that ends up empty is removed.
    const dropTextAt = (clientX: number, clientY: number) => {
      const ds = useDiagramStore.getState();
      ds.setDiagramMode(true);
      const st = { ...DRAW_STYLE_DEFAULTS, ...s().drawStyle };
      const fontSize = st.fontSize ?? 14;
      // OSS keeps its dedicated shapeless "text" kind for free labels.
      const id = ds.addNodeAt("text", screenToContent(content, clientX, clientY), {
        w: 160,
        h: Math.max(40, Math.round(fontSize * 2)),
        text: "",
        fontSize: st.fontSize,
        sketch: st.sketch,
        bold: st.bold,
        italic: st.italic,
        underline: st.underline,
        fontFamily: st.fontFamily,
        textAlign: st.textAlign,
        textColor: st.textColor,
      });
      const created = useDiagramStore.getState().nodes[id];
      if (!created) return;
      beginNodeTextEdit(created, {
        onEnd: (text) => {
          const cur = useDiagramStore.getState();
          if (!text.trim()) {
            cur.setDiagramSelection([id]);
            cur.deleteSelectedDiagram();
            return;
          }
          // Shrink-wrap the box to the typed text (Excalidraw) so the
          // invisible frame never grabs presses far from the letters.
          requestAnimationFrame(() => fitTextBox(id));
        },
      });
    };

    /** Resize a borderless text node to its rendered label, anchored per align. */
    const fitTextBox = (id: string) => {
      const ds = useDiagramStore.getState();
      const n = ds.nodes[id];
      const texts = [...host.querySelectorAll<SVGGraphicsElement>(`[data-diagram-node="${id}"] text`)]
        .filter((t) => !t.closest("[data-editor-only]"));
      if (!n || !texts.length) return;
      const boxes = texts.map((t) => t.getBBox());
      const w = Math.max(24, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x)) + 16));
      const h = Math.max(24, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y)) + 12));
      const x = n.textAlign === "left" ? n.x : n.textAlign === "right" ? n.x + n.w - w : n.x + (n.w - w) / 2;
      ds.updateNode(id, { x, y: n.y + (n.h - h) / 2, w, h });
    };

    // Text tool: the label drops on pointer UP — by then the browser's own
    // mousedown focus change is over, so it can't blur the fresh editor.
    const startDropText = (e: PointerEvent) => {
      dragRef.current = {
        move: () => {},
        up: (ev) => {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 6) return;
          dropTextAt(ev.clientX, ev.clientY);
          s().finishToolUse();
        },
      };
    };

    // Pen (Excalidraw freedraw): samples the pointer into ONE freedraw node
    // whose box/points are re-normalised as the stroke grows (rAF-throttled).
    // Points closer than ~1.5 screen px are dropped. The pen stays armed.
    const startPen = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      const abs = [screenToContent(content, e.clientX, e.clientY)];
      let id: string | null = null;
      let frame = 0;
      const minStep = 1.5 / (s().cam.z || 1);
      const flush = () => {
        frame = 0;
        if (abs.length < 2) return;
        const ds = useDiagramStore.getState();
        const box = normaliseStroke(abs);
        if (!id) {
          ds.setDiagramMode(true);
          const pen = s().penStyle;
          id = ds.addNodeAt("freedraw", { x: box.x + box.w / 2, y: box.y + box.h / 2 }, {
            ...box,
            text: "",
            fill: "transparent",
            stroke: pen.stroke,
            strokeWidth: pen.strokeWidth,
            opacity: pen.opacity,
            pen: { ...pen.brush },
          });
          ds.setDiagramSelection([]); // no selection chrome flickering while inking
        } else {
          ds.updateNode(id, box);
        }
      };
      dragRef.current = {
        move: (ev) => {
          const p = screenToContent(content, ev.clientX, ev.clientY);
          const last = abs[abs.length - 1];
          if (Math.hypot(p.x - last.x, p.y - last.y) < minStep) return;
          abs.push(p);
          if (!frame) frame = requestAnimationFrame(flush);
        },
        up: () => {
          if (frame) cancelAnimationFrame(frame);
          flush();
        },
      };
    };

    // Eraser (Excalidraw): sweep to MARK objects (they fade), release to
    // delete them all in one undo step; holding ⌥/Alt while sweeping
    // un-marks instead. Sampling every ~4px along the motion so a fast flick
    // still catches thin strokes in between pointer events.
    const startErase = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      const marked = new Set<string>();
      const hitAt = (cx: number, cy: number, revert: boolean) => {
        for (const el of document.elementsFromPoint(cx, cy)) {
          if ((el as Element).closest("[data-editor-only]")) continue;
          const n = (el as Element).closest("[data-diagram-node]")?.getAttribute("data-diagram-node");
          const ed = (el as Element).closest("[data-diagram-edge]")?.getAttribute("data-diagram-edge");
          const id = n ?? ed;
          if (!id) continue;
          if (revert) marked.delete(id);
          else marked.add(id);
          break; // topmost object only, like a real eraser tip
        }
      };
      let last = { x: e.clientX, y: e.clientY };
      hitAt(last.x, last.y, e.altKey);
      s().setEraseMarked([...marked]);
      dragRef.current = {
        move: (ev) => {
          const steps = Math.max(1, Math.ceil(Math.hypot(ev.clientX - last.x, ev.clientY - last.y) / 4));
          for (let i = 1; i <= steps; i++) {
            hitAt(last.x + ((ev.clientX - last.x) * i) / steps, last.y + ((ev.clientY - last.y) * i) / steps, ev.altKey);
          }
          last = { x: ev.clientX, y: ev.clientY };
          s().setEraseMarked([...marked]);
        },
        up: () => {
          s().setEraseMarked([]);
          if (!marked.size) return;
          const ds = useDiagramStore.getState();
          ds.setDiagramSelection([...marked].filter((id) => ds.nodes[id] || ds.edges[id]));
          ds.deleteSelectedDiagram();
        },
      };
    };

    // Laser pointer (Excalidraw K): a red trail in SCREEN space that fades
    // ~0.7s behind the pointer — for presenting/explaining, never saved and
    // never selects anything. Drawn imperatively into an overlay <svg> so a
    // fast wiggle doesn't re-render React.
    const startLaser = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      const host = hostRef.current;
      if (!host) return;
      const r0 = host.getBoundingClientRect();
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "laser-layer");
      svg.setAttribute("data-editor-only", "1");
      const glow = document.createElementNS(NS, "path");
      glow.setAttribute("class", "laser-glow");
      const core = document.createElementNS(NS, "path");
      core.setAttribute("class", "laser-core");
      svg.append(glow, core);
      host.appendChild(svg);
      const LIFE = 700;
      const pts: { x: number; y: number; t: number }[] = [];
      let down = true;
      let frame = 0;
      const add = (ev: PointerEvent) => pts.push({ x: ev.clientX - r0.left, y: ev.clientY - r0.top, t: performance.now() });
      const draw = () => {
        const now = performance.now();
        while (pts.length && now - pts[0].t > LIFE) pts.shift();
        const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
        glow.setAttribute("d", d);
        core.setAttribute("d", d);
        if (pts.length || down) frame = requestAnimationFrame(draw);
        else svg.remove();
      };
      add(e);
      frame = requestAnimationFrame(draw);
      dragRef.current = {
        move: (ev) => add(ev),
        up: () => {
          down = false;
          if (!frame) svg.remove();
        },
      };
    };

    // Text tool pressed on an existing shape → edit THAT shape's label (on
    // pointer up, for the same focus reason as startDropText).
    const startEditLabel = (e: PointerEvent, nodeId: string) => {
      dragRef.current = {
        move: () => {},
        up: (ev) => {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 6) return;
          const n = useDiagramStore.getState().nodes[nodeId];
          if (!n) return;
          useDiagramStore.getState().setDiagramSelection([nodeId]);
          beginNodeTextEdit(n);
          s().finishToolUse();
        },
      };
    };

    // Arrow tool on EMPTY canvas (Excalidraw): dragging draws a free-standing
    // arrow from the press point; the head binds to a shape when released
    // near one (the same magnet port-drawn connectors use). Shape borders keep
    // their own connect gesture (ConnectionPorts). A plain click draws nothing.
    const startDrawArrow = (e: PointerEvent) => {
      stage.setPointerCapture(e.pointerId);
      const p0 = screenToContent(content, e.clientX, e.clientY);
      let edgeId: string | null = null;
      const targetOf = (ev: PointerEvent): Attachment => {
        const p = screenToContent(content, ev.clientX, ev.clientY);
        const hit = snapConnect(useDiagramStore.getState().nodes, p, undefined, 1 / (s().cam.z || 1));
        // Magnet feedback (Excalidraw): outline the shape the head will bind to.
        s().setBindHint(hit ? { nodeId: hit.nodeId, rel: hit.portRel ?? undefined } : null);
        if (!hit) return { kind: "free", point: p };
        return hit.portRel
          ? { kind: "port", nodeId: hit.nodeId, rel: hit.portRel }
          : { kind: "floating", nodeId: hit.nodeId };
      };
      dragRef.current = {
        move: (ev) => {
          const ds = useDiagramStore.getState();
          if (edgeId) {
            ds.updateEdge(edgeId, { target: targetOf(ev) });
            return;
          }
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
          ds.setDiagramMode(true);
          edgeId = mintEdgeId();
          ds.addEdge({
            id: edgeId,
            source: { kind: "free", point: p0 },
            target: targetOf(ev),
            routing: "straight",
            stroke: "#2d3142", // same ink as shapes (Excalidraw)
            strokeWidth: 2,
            endArrow: true,
            startArrow: false,
            animated: false,
            // New arrows inherit the LAST style the user set on one.
            ...s().edgeStyle,
          });
        },
        up: () => {
          s().setBindHint(null);
          if (!edgeId) return;
          useDiagramStore.getState().setDiagramSelection([edgeId]);
          s().finishToolUse();
        },
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      // Space-pan overrides EVERYTHING — grips, shapes, ports all step aside
      // (they check panState themselves) and the hand drags the page.
      // An armed draw/text tool wins over whatever is under the pointer
      // (Excalidraw): a shape drawn ON or INSIDE an existing shape is a new
      // shape, not a move of the old one; the Text tool on a shape edits that
      // shape's label. NodeView/EdgeView stand down for these tools. This
      // listener is NATIVE on the stage, so it runs before React's handlers.
      if (!spaceDownRef.current && e.button === 0) {
        if (s().tool === "draw" && s().drawSpec) {
          startDrawShape(e);
          return;
        }
        if (s().tool === "pen") {
          startPen(e);
          return;
        }
        if (s().tool === "eraser") {
          startErase(e);
          return;
        }
        if (s().tool === "laser") {
          startLaser(e);
          return;
        }
        if (s().tool === "text") {
          const host = (e.target as Element).closest("[data-diagram-node]");
          const nid = host?.getAttribute("data-diagram-node");
          if (nid && useDiagramStore.getState().nodes[nid]) startEditLabel(e, nid);
          else startDropText(e);
          return;
        }
      }
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
      if (s().tool === "arrow" && e.button === 0) {
        startDrawArrow(e);
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

    // Walks stop at non-elements: a press on the bare stage climbs PAST
    // `content` up to `document`, which has no tagName.
    const isText = (n: Node | null) =>
      !!n && n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName.replace(/^.*:/, "") === "text";
    const onDblClick = (e: MouseEvent) => {
      // Diagram nodes/edges own their own dblclick (inline text edit).
      if ((e.target as Element).closest("#diagram-layer")) return;
      let node: Node | null = document.elementFromPoint(e.clientX, e.clientY);
      while (node && node !== content && node.nodeType === Node.ELEMENT_NODE && !isText(node)) {
        node = node.parentNode;
      }
      let textEl: SVGTextElement | null = isText(node) ? (node as SVGTextElement) : null;
      const obj = textEl
        ? null
        : topObject(content, document.elementFromPoint(e.clientX, e.clientY));
      if (!textEl && obj) textEl = obj.querySelector("text");
      if (!textEl && obj) {
        s().setStatus("This object has no text to edit.");
        return;
      }
      if (!textEl) {
        dropTextAt(e.clientX, e.clientY); // empty canvas → new text label
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
      // View toggles: [ hides the left rail, ] the right rail, \ enters focus
      // mode (just the canvas). Handled up here so the type-to-edit branch
      // below (which swallows any single char when one node is selected)
      // can't eat them.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "[") { e.preventDefault(); useAppStore.getState().toggleLeftPanel(); return; }
        if (e.key === "]") { e.preventDefault(); useAppStore.getState().toggleRightPanel(); return; }
        if (e.key === "\\") { e.preventDefault(); useAppStore.getState().toggleFocusMode(); return; }
        if (e.key === "?") { e.preventDefault(); useAppStore.getState().setShortcutsOpen(true); return; }
      }
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
          if (e.shiftKey) ungroupSelected();
          else groupSelected();
        }
      } else if (meta && e.altKey && (e.code === "KeyC" || e.code === "KeyV")) {
        // ⌘⌥C / ⌘⌥V copy / paste STYLES (Excalidraw). e.code — ⌥ remaps e.key on macOS.
        e.preventDefault();
        if (e.code === "KeyC") {
          if (copyStyles()) s().setStatus("Styles copied — ⌘⌥V to paste them onto another shape.", "ok");
        } else if (!pasteStyles()) {
          s().setStatus(hasCopiedStyles() ? "Select shapes to paste styles onto." : "Copy styles first with ⌘⌥C.");
        }
      } else if (meta && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        // ⌘[ / ⌘] one step backward/forward, with ⇧ all the way to back/front.
        const ds = useDiagramStore.getState();
        if (ds.diagramSelection.length) {
          e.preventDefault();
          const fwd = e.code === "BracketRight";
          arrangeSelection(e.shiftKey ? (fwd ? "front" : "back") : fwd ? "forward" : "backward");
        }
      } else if (!meta && !e.altKey && e.shiftKey && (e.code === "KeyH" || e.code === "KeyV") && useDiagramStore.getState().diagramSelection.length) {
        // ⇧H / ⇧V flip the selection horizontally / vertically (Excalidraw).
        e.preventDefault();
        flipSelection(e.code === "KeyH" ? "h" : "v");
      } else if (meta && !e.shiftKey && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
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
      } else if (meta && e.key.toLowerCase() === "s" && !e.shiftKey) {
        // ⌘S save now (the browser would download the page). Autosave runs
        // anyway; this is the reassuring explicit save the File menu hints at.
        e.preventDefault();
        const ed = s();
        if (ed.docId && ed.myRole !== "viewer") void ed.save();
        else ed.setStatus("View only — this board can't be saved from here.");
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
        // DIGITS are the visible tool shortcuts (hints under the island
        // buttons) and must keep working right after an add left the new
        // shape selected — so they never start type-to-edit. Letters still
        // do; a label rarely starts with a digit and dblclick covers that.
        // Q (tool lock) and L (Library) are tool keys too.
        !/^[0-9qQlLkK?]$/.test(e.key) &&
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
      } else if (e.key === "k") {
        s().setTool("laser");
      } else if (e.key === "a") {
        // Arrow tool — the ONLY mode where shape borders/ports draw connectors.
        s().setTool("arrow");
      } else if (e.key === "Escape") {
        // Esc leaves focus mode first (it hid the exit chrome); only then does
        // it clear the selection.
        if (useAppStore.getState().focusMode) {
          useAppStore.getState().toggleFocusMode(false);
          return;
        }
        s().setSelection([]);
        useDiagramStore.getState().setDiagramSelection([]);
        if (s().tool !== "select" && s().tool !== "pan") s().setTool("select"); // disarm
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

  // Before any board content exists the artboard still has its 100×100
  // default — rendering it would paint a stray white square in the top-left
  // corner on every reload, so keep the paper hidden until something loads.
  const boardEmpty = contentRev === 0 && diagramNodeCount === 0;

  return (
    <section
      className={`canvas-host${gridOn ? "" : " no-grid"}${pageBackdrop ? "" : " no-backdrop"}${tool === "arrow" || tool === "draw" ? " arrow-tool" : ""}${tool === "text" ? " text-tool" : ""}${tool === "pen" ? ` pen-tool brush-${penType}` : ""}${tool === "eraser" ? " eraser-tool" : ""}${tool === "laser" ? " laser-tool" : ""}`}
      ref={hostRef}
    >
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
            style={{ visibility: boardEmpty ? "hidden" : undefined }}
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
