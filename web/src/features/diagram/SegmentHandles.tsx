/**
 * features/diagram/SegmentHandles — Lucid-style elbow segment editing.
 *
 * For the selected elbow connector, every sufficiently long segment shows a
 * pill handle at its midpoint. Dragging a handle moves that segment
 * perpendicular to itself (ns/ew cursor), turning the route into user-owned
 * waypoints (edge.waypoints). End segments are handled by first splitting off
 * a stub corner so the endpoints stay attached to their shapes — exactly how
 * excalidraw's fixedSegments behave. Collinear/degenerate corners merge on
 * release.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { screenToContent } from "../../editor-core";
import {
  edgePath,
  simplifyOrtho,
  type DiagramEdge,
  type NodeMap,
  type Vec,
} from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { panState } from "../../state/panState";

const ACCENT = "#2563eb";
const MIN_SEG = 18; // don't offer handles on tiny stubs
const PILL_L = 22;
const PILL_W = 7;

export function SegmentHandles({
  edge,
  nodes,
}: {
  edge: DiagramEdge;
  nodes: NodeMap;
}) {
  if (edge.routing !== "elbow") return null;
  const geom = edgePath(edge, nodes);
  if (!geom || geom.points.length < 2) return null;
  const pts = geom.points;

  const startDrag =
    (segIndex: number, horizontal: boolean) => (e: ReactPointerEvent) => {
      if (panState.spaceHeld) return; // hand-pan wins
      if (e.button !== 0) return;
      e.stopPropagation();
      const refs = useEditorStore.getState().refs;
      if (!refs) return;
      const content = refs.content;

      // Work on a private copy of the corner list; make the dragged segment
      // interior by splitting stub corners off the endpoints when needed.
      const P: Vec[] = pts.map((p) => ({ ...p }));
      let idx = segIndex;
      if (idx === 0) {
        P.splice(1, 0, { ...P[0] });
        idx = 1;
      }
      if (idx === P.length - 2) {
        P.splice(P.length - 1, 0, { ...P[P.length - 1] });
      }

      const p0 = screenToContent(content, e.clientX, e.clientY);

      const move = (ev: PointerEvent) => {
        const p = screenToContent(content, ev.clientX, ev.clientY);
        const Q = P.map((q) => ({ ...q }));
        if (horizontal) {
          const dy = p.y - p0.y;
          Q[idx].y += dy;
          Q[idx + 1].y += dy;
        } else {
          const dx = p.x - p0.x;
          Q[idx].x += dx;
          Q[idx + 1].x += dx;
        }
        useDiagramStore.getState().updateEdge(edge.id, {
          waypoints: Q.slice(1, -1),
        });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        // Merge collinear/degenerate corners so the stored route stays minimal.
        const cur = useDiagramStore.getState().edges[edge.id];
        if (cur?.waypoints) {
          const full = simplifyOrtho([
            { ...P[0] },
            ...cur.waypoints,
            { ...P[P.length - 1] },
          ]);
          useDiagramStore.getState().updateEdge(edge.id, {
            waypoints: full.slice(1, -1),
          });
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

  const handles: JSX.Element[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (len < MIN_SEG) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const w = horizontal ? PILL_L : PILL_W;
    const h = horizontal ? PILL_W : PILL_L;
    handles.push(
      <g key={i} data-editor-only="1">
        {/* generous hit area */}
        <rect
          x={mx - w / 2 - 6}
          y={my - h / 2 - 6}
          width={w + 12}
          height={h + 12}
          fill="transparent"
          style={{ cursor: horizontal ? "ns-resize" : "ew-resize" }}
          onPointerDown={startDrag(i, horizontal)}
        />
        <rect
          x={mx - w / 2}
          y={my - h / 2}
          width={w}
          height={h}
          rx={PILL_W / 2}
          fill="#fff"
          stroke={ACCENT}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: "none" }}
        />
      </g>,
    );
  }

  return <g data-editor-only="1">{handles}</g>;
}
