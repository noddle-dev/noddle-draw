/**
 * features/diagram/BendHandle — Excalidraw's arrow midpoint handle for
 * STRAIGHT and CURVED connectors (elbow arrows keep SegmentHandles): drag it
 * to bend the arrow through that point (stored as `waypoints[0]`), double-
 * click it to snap back to the default line/arc. Editor-only chrome.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { screenToContent } from "../../editor-core";
import { edgePath, type DiagramEdge, type NodeMap } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { panState } from "../../state/panState";

const HANDLE = "#6965db";

export function BendHandle({ edge, nodes }: { edge: DiagramEdge; nodes: NodeMap }) {
  const z = useEditorStore((s) => s.cam.z) || 1;
  if (edge.routing === "elbow") return null;
  const geom = edgePath(edge, nodes);
  if (!geom) return null;
  const at = edge.waypoints?.[0] ?? geom.mid;
  const r = 5 / z;
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || panState.spaceHeld) return;
    e.stopPropagation();
    const refs = useEditorStore.getState().refs;
    if (!refs) return;
    const move = (ev: PointerEvent) => {
      const p = screenToContent(refs.content, ev.clientX, ev.clientY);
      useDiagramStore.getState().updateEdge(edge.id, { waypoints: [p] });
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
      {/* generous hit target */}
      <circle cx={at.x} cy={at.y} r={r * 2.4} fill="transparent" style={{ cursor: "move" }}
        onPointerDown={onPointerDown}
        onDoubleClick={(e) => {
          e.stopPropagation();
          useDiagramStore.getState().updateEdge(edge.id, { waypoints: undefined });
        }}>
        <title>Drag to bend the arrow · double-click to straighten</title>
      </circle>
      <circle cx={at.x} cy={at.y} r={r} fill="#fff" stroke={HANDLE} strokeWidth={1.5}
        vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
    </g>
  );
}
