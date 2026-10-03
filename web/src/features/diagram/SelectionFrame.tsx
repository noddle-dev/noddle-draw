/**
 * features/diagram/SelectionFrame — the multi-select bounding frame.
 *
 * A multi-selection — or ANY selection containing a connector — gets one
 * dashed rectangle around its union bbox (Figma/Excalidraw-style) so the
 * group reads as one thing. Exporting the selection lives in the right-click
 * context menu and the topbar Export menu (scope "Selection") — not here:
 * always-visible chips were noise for a rarely used action.
 * Its 4 corner grips SCALE the whole selection proportionally about the
 * opposite corner (Excalidraw multi-resize): positions, sizes, font sizes,
 * free arrow ends and bend points all scale; attached arrows follow their
 * shapes. One applyPatch per move, so the gesture is one undo step.
 * Editor-only chrome (data-editor-only): never baked into saves/exports.
 * All sizes scale by 1/zoom so the frame stays screen-constant.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { screenToContent } from "../../editor-core";
import type { Attachment, DiagramEdge, DiagramNode, Vec } from "../../editor-core/diagram";
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";
import { panState } from "../../state/panState";

const GRIP = "#6965db";
const MIN_SCALE = 0.1;

const PAD = 12;

export function SelectionFrame() {
  const z = useEditorStore((s) => s.cam.z) || 1;
  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const sel = useDiagramStore((s) => s.diagramSelection);

  const pickedNodes = sel.map((id) => nodes[id]).filter(Boolean);
  const pickedEdgeIds = sel.filter((id) => edges[id]);
  // Frame rule (Excalidraw): ONE frame for a multi-selection or a group, and
  // nothing for a single object — a lone shape draws its own outline + grips,
  // a lone arrow only its endpoint handles (no box around a diagonal line).
  if (pickedNodes.length + pickedEdgeIds.length < 2) return null;

  // Union bbox: node geometry from the store; edge geometry measured off the
  // live DOM (routes are renderer-owned — waypoints, elbows, arrowheads).
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const n of pickedNodes) {
    bx0 = Math.min(bx0, n.x); by0 = Math.min(by0, n.y);
    bx1 = Math.max(bx1, n.x + n.w); by1 = Math.max(by1, n.y + n.h);
  }
  for (const id of pickedEdgeIds) {
    const g = document.querySelector(
      `#diagram-layer [data-diagram-edge="${CSS.escape(id)}"]`,
    ) as SVGGraphicsElement | null;
    const b = g?.getBBox?.();
    if (!b || (b.width === 0 && b.height === 0)) continue;
    bx0 = Math.min(bx0, b.x); by0 = Math.min(by0, b.y);
    bx1 = Math.max(bx1, b.x + b.width); by1 = Math.max(by1, b.y + b.height);
  }
  if (!isFinite(bx0)) return null;

  const k = 1 / z; // screen-constant sizing
  const pad = PAD * k;
  const x0 = bx0 - pad;
  const y0 = by0 - pad;
  const x1 = bx1 + pad;
  const y1 = by1 + pad;

  // Arrows aren't resizable on their own, so scaling needs ≥1 shape in play.
  const canScale = pickedNodes.length > 0;
  const s = 8 * k;
  const corners: { id: string; x: number; y: number; ax: number; ay: number; cur: string }[] = [
    { id: "nw", x: x0, y: y0, ax: bx1, ay: by1, cur: "nwse-resize" },
    { id: "ne", x: x1, y: y0, ax: bx0, ay: by1, cur: "nesw-resize" },
    { id: "sw", x: x0, y: y1, ax: bx1, ay: by0, cur: "nesw-resize" },
    { id: "se", x: x1, y: y1, ax: bx0, ay: by0, cur: "nwse-resize" },
  ];

  const startScale = (c: (typeof corners)[number]) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || panState.spaceHeld) return;
    e.stopPropagation();
    const refs = useEditorStore.getState().refs;
    if (!refs) return;
    const ds = useDiagramStore.getState();
    const ids = new Set(ds.diagramSelection);
    const origNodes = Object.values(ds.nodes).filter((n) => ids.has(n.id));
    const origEdges = Object.values(ds.edges).filter((ed) => ids.has(ed.id));
    const a = { x: c.ax, y: c.ay };
    const w0 = Math.max(1, bx1 - bx0);
    const h0 = Math.max(1, by1 - by0);
    const sp = (p: Vec, k2: number): Vec => ({ x: a.x + (p.x - a.x) * k2, y: a.y + (p.y - a.y) * k2 });
    const att = (t: Attachment, k2: number): Attachment => (t.kind === "free" ? { kind: "free", point: sp(t.point, k2) } : t);
    const move = (ev: PointerEvent) => {
      const p = screenToContent(refs.content, ev.clientX, ev.clientY);
      // uniform scale from the larger axis — proportions are kept
      const k2 = Math.max(MIN_SCALE, Math.max(Math.abs(p.x - a.x) / w0, Math.abs(p.y - a.y) / h0));
      const upsertNodes: DiagramNode[] = origNodes.map((n) => {
        const o = sp({ x: n.x, y: n.y }, k2);
        const next: DiagramNode = { ...n, x: o.x, y: o.y, w: Math.max(4, n.w * k2), h: Math.max(4, n.h * k2) };
        if (n.kind !== "freedraw") next.fontSize = Math.max(6, Math.round((n.fontSize ?? 14) * k2 * 10) / 10);
        return next;
      });
      const upsertEdges: DiagramEdge[] = origEdges.map((ed) => ({
        ...ed,
        source: att(ed.source, k2),
        target: att(ed.target, k2),
        ...(ed.waypoints ? { waypoints: ed.waypoints.map((w) => sp(w, k2)) } : {}),
      }));
      useDiagramStore.getState().applyPatch({ upsertNodes, upsertEdges });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <g data-editor-only="1">
      <rect
        x={x0}
        y={y0}
        width={x1 - x0}
        height={y1 - y0}
        fill="none"
        stroke="#6965db"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: "none" }}
        opacity={0.9}
      />
      {canScale &&
        corners.map((c) => (
          <rect
            key={c.id}
            data-handle={`frame-${c.id}`}
            x={c.x - s / 2}
            y={c.y - s / 2}
            width={s}
            height={s}
            rx={s * 0.25}
            fill="#fff"
            stroke={GRIP}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: c.cur }}
            onPointerDown={startScale(c)}
          >
            <title>Drag to scale the selection</title>
          </rect>
        ))}
    </g>
  );
}
