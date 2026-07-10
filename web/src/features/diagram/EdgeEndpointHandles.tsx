/**
 * features/diagram/EdgeEndpointHandles — draggable endpoints for the selected
 * connector (Lucid-style "change direction").
 *
 * Rendered only for the single selected edge. Each endpoint shows a grab dot at
 * its resolved point. Dragging an endpoint:
 *   - live-updates the edge to a `free` point that tracks the cursor (the line
 *     follows and the OTHER floating end re-aims automatically), and
 *   - on drop over a node body → re-attaches as `floating` to that node; over
 *     empty space → keeps the free point.
 * The edge's other endpoint is excluded from hit-testing so an endpoint can't
 * snap onto its own far node (degenerate self-loop).
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { screenToContent } from "../../editor-core";
import {
  edgePath,
  snapConnect,
  worldPointToRel,
  type Attachment,
  type DiagramEdge,
  type NodeMap,
} from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { panState } from "../../state/panState";

const ACCENT = "#2563eb";
const HANDLE_R = 6;
const HIT_R = 12;

export function EdgeEndpointHandles({
  edge,
  nodes,
  onHoverTarget,
}: {
  edge: DiagramEdge;
  nodes: NodeMap;
  onHoverTarget: (id: string | null) => void;
}) {
  const geom = edgePath(edge, nodes);
  if (!geom) return null;

  const startDrag =
    (which: "source" | "target") => (e: ReactPointerEvent) => {
      if (panState.spaceHeld) return; // hand-pan wins
      if (e.button !== 0) return;
      e.stopPropagation();
      const refs = useEditorStore.getState().refs;
      if (!refs) return;
      const content = refs.content;

      // Node id of the OTHER endpoint — excluded from snapping (no self-loop).
      const other = which === "source" ? edge.target : edge.source;
      const otherNodeId = other.kind !== "free" ? other.nodeId : undefined;

      const move = (ev: PointerEvent) => {
        const p = screenToContent(content, ev.clientX, ev.clientY);
        // Magnet: near a shape/port the endpoint LIVE-attaches (the edge
        // re-routes side-aware immediately, like Lucid); in the open it
        // follows the cursor as a free point. Radii are screen-consistent.
        const scale = 1 / (useEditorStore.getState().cam.z || 1);
        const hit = snapConnect(nodes, p, otherNodeId, scale);
        onHoverTarget(hit?.nodeId ?? null);
        // Pin to the EXACT point under the cursor projected onto the target's
        // border (a port at that rel) — same as creating a connection, so
        // editing an endpoint lands where you drop it, not just on the 4 dots.
        let att: Attachment;
        if (!hit) {
          att = { kind: "free", point: p };
        } else if (hit.portRel) {
          att = { kind: "port", nodeId: hit.nodeId, rel: hit.portRel };
        } else {
          const t = nodes[hit.nodeId];
          att = t && t.w && t.h
            ? { kind: "port", nodeId: hit.nodeId, rel: worldPointToRel(t, hit.point) }
            : { kind: "floating", nodeId: hit.nodeId };
        }
        useDiagramStore.getState().updateEdge(edge.id, {
          [which]: att,
        } as Partial<DiagramEdge>);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onHoverTarget(null);
        // The attachment (or free point) was already applied during move.
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

  const ends: { which: "source" | "target"; x: number; y: number }[] = [
    { which: "source", x: geom.sx, y: geom.sy },
    { which: "target", x: geom.tx, y: geom.ty },
  ];

  return (
    <g>
      {ends.map((h) => (
        <g key={h.which}>
          <circle
            cx={h.x}
            cy={h.y}
            r={HIT_R}
            fill="transparent"
            style={{ cursor: "grab" }}
            onPointerDown={startDrag(h.which)}
          />
          <circle
            cx={h.x}
            cy={h.y}
            r={HANDLE_R}
            fill="#fff"
            stroke={ACCENT}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: "none" }}
          />
        </g>
      ))}
    </g>
  );
}
