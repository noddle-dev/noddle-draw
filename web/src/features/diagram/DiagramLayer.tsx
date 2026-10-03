/**
 * features/diagram/DiagramLayer — the diagram render layer, mounted INSIDE the
 * Canvas camera group so it shares the same pan/zoom transform.
 *
 * Renders edges (behind) then nodes. Each node owns its hover + connection
 * ports internally (see NodeView) — there is no standalone ports layer, so
 * nothing can cover a sibling node and steal its pointer events. This layer
 * holds only the transient drag-to-connect preview + reconnect-target
 * highlight. All persisted state lives in diagramStore; geometry is derived
 * on render.
 */
import { useState } from "react";
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";
import { groupState } from "../../state/grouping";
import { EdgeView, ARROW_HEADS, headMarkerId, OPEN_ARROW_MARKER_ID } from "./EdgeView";
import { EdgeEndpointHandles } from "./EdgeEndpointHandles";
import { SegmentHandles } from "./SegmentHandles";
import { BendHandle } from "./BendHandle";
import { NodeView, RotateHandle } from "./NodeView";
import { SelectionFrame } from "./SelectionFrame";
import { BIND_GLOW_FILTER, BindGlow } from "./BindGlow";
import type { PreviewEdge } from "./ConnectionPorts";
import type { ArrowHead, DiagramEdge, DiagramNode } from "../../editor-core/diagram";

const ACCENT = "#2563eb";

/** The <marker> geometry for each arrowhead kind, authored in a 0..10 box and
 * pointing along +x. A SINGLE marker per kind serves both ends —
 * orient="auto-start-reverse" flips it for a start decoration. Fills/strokes
 * use `context-stroke` so the head always matches the edge's colour (including
 * the selection highlight). */
function HeadMarker({ head }: { head: Exclude<ArrowHead, "none"> }) {
  const common = {
    id: headMarkerId(head),
    viewBox: "0 0 10 10",
    refY: 5,
    markerWidth: 9,
    markerHeight: 9,
    orient: "auto-start-reverse" as const,
    markerUnits: "userSpaceOnUse" as const,
  };
  switch (head) {
    case "arrow":
      return (
        <marker {...common} refX={9}>
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      );
    case "triangle":
      return (
        <marker {...common} refX={9}>
          <path
            d="M 1 1 L 9 5 L 1 9 z"
            fill="none"
            stroke="context-stroke"
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
        </marker>
      );
    case "circle":
      return (
        <marker {...common} refX={5}>
          <circle cx={5} cy={5} r={4} fill="context-stroke" />
        </marker>
      );
    case "diamond":
      return (
        <marker {...common} refX={9}>
          <polygon points="1,5 5,1 9,5 5,9" fill="context-stroke" />
        </marker>
      );
  }
}

export function DiagramLayer() {
  const diagramMode = useDiagramStore((s) => s.diagramMode);
  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const selection = useDiagramStore((s) => s.diagramSelection);
  const [preview, setPreview] = useState<PreviewEdge | null>(null);
  // Node highlighted while dragging a selected edge's endpoint to reconnect.
  const [endpointHoverId, setEndpointHoverId] = useState<string | null>(null);
  // Free canvas arrows (Canvas.startDrawArrow) report their magnet target here.
  const bindHint = useEditorStore((s) => s.bindHint);

  if (!diagramMode) return null;

  const nodeList = Object.values(nodes);
  const edgeList = Object.values(edges);

  // Unified paint order across nodes AND edges. Objects carry a `z` stamped at
  // creation (higher → on top), so a freshly drawn arrow/shape sits above what
  // it crosses. Legacy objects (no z) keep the old look: edges behind (-2)
  // nodes (-1). Stable sort ⇒ ties preserve record (insertion) order.
  const painted: Array<{ kind: "edge"; edge: DiagramEdge } | { kind: "node"; node: DiagramNode }> = [
    ...edgeList.map((edge) => ({ kind: "edge" as const, edge, z: edge.z ?? -2 })),
    ...nodeList.map((node) => ({ kind: "node" as const, node, z: node.z ?? -1 })),
  ]
    .sort((a, b) => a.z - b.z)
    .map((it) => (it.kind === "edge" ? { kind: "edge" as const, edge: it.edge } : { kind: "node" as const, node: it.node }));

  // The single selected edge, if any — its endpoints get drag-to-reconnect
  // handles (Lucid-style change-direction).
  const selEdge =
    selection.length === 1 && edges[selection[0]] ? edges[selection[0]] : null;
  // The single selected node — its rotate grip renders in the TOP overlay at
  // the end of this layer (interleaved node/edge z-order means a later edge's
  // fat hit-path would otherwise cover a grip floating above the node).
  const selNode =
    selection.length === 1 && nodes[selection[0]] ? nodes[selection[0]] : null;
  const endpointHoverNode = endpointHoverId ? nodes[endpointHoverId] : null;
  const gs = groupState(nodes, selection);
  const groupFrames = [
    ...(gs.wholeGroup ? [{ gid: gs.wholeGroup, partial: false }] : []),
    ...gs.partialGroups.map((gid) => ({ gid, partial: true })),
  ].flatMap(({ gid, partial }) => {
    const m = nodeList.filter((n) => n.groupId === gid);
    if (!m.length) return [];
    const PAD = partial ? 10 : 6;
    const x0 = Math.min(...m.map((n) => n.x)) - PAD;
    const y0 = Math.min(...m.map((n) => n.y)) - PAD;
    const x1 = Math.max(...m.map((n) => n.x + n.w)) + PAD;
    const y1 = Math.max(...m.map((n) => n.y + n.h)) + PAD;
    return [{ gid, partial, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }];
  });
  // Magnet feedback — port-drawn preview first, else a free canvas arrow.
  const hlId = preview?.hoverTargetId ?? bindHint?.nodeId ?? null;
  const hlNode = hlId ? nodes[hlId] : null;

  // Preview connector: a synthetic edge rendered through EdgeView so the drag
  // shows the REAL arrow (arrowhead + elbow routing), not just a dashed line.
  // Over a valid target it attaches (port/floating) so it routes exactly like
  // the committed edge; otherwise the free end follows the cursor.
  let previewEdge: DiagramEdge | null = null;
  if (preview && nodes[preview.source.nodeId]) {
    previewEdge = {
      id: "__preview__",
      source: { kind: "port", nodeId: preview.source.nodeId, rel: preview.source.rel },
      target: preview.snapPort
        ? { kind: "port", nodeId: preview.snapPort.nodeId, rel: preview.snapPort.rel }
        : preview.hoverTargetId
          ? { kind: "floating", nodeId: preview.hoverTargetId }
          : { kind: "free", point: preview.cursor },
      routing: "elbow",
      stroke: ACCENT,
      strokeWidth: 2,
      endArrow: true,
      startArrow: false,
      animated: false,
      // The committed arrow is born with the REMEMBERED style — the preview
      // must look identical (same width/dash/heads/routing/color), exactly
      // like the shape draw tool previews the real node.
      ...useEditorStore.getState().edgeStyle,
    };
  }

  return (
    <g id="diagram-layer">
      <defs>
        {ARROW_HEADS.map((h) => (
          <HeadMarker key={h} head={h} />
        ))}
        {/* Excalidraw-style hand-drawn roughen — turbulence + displacement.
            Shared by every node with `sketch: true`. */}
        <filter id="noddle-sketch" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* Excalidraw open-chevron head for hand-drawn arrows (EdgeView) */}
        <marker id={OPEN_ARROW_MARKER_ID} viewBox="0 0 12 12" refX={10.5} refY={6} markerWidth={15}
          markerHeight={15} orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M1.5 1.5 L10.5 6 L1.5 10.5" fill="none" stroke="context-stroke" strokeWidth={1.5}
            strokeLinecap="round" strokeLinejoin="round" />
        </marker>
        {/* Excalidraw binding highlight blur (BindGlow) */}
        <filter id={BIND_GLOW_FILTER} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>

      {/* nodes + edges in one z-order (creation order → newest on top); each
          node still owns its hover + ports internally. */}
      {painted.map((it) =>
        it.kind === "edge" ? (
          <EdgeView key={it.edge.id} edge={it.edge} nodes={nodes} />
        ) : (
          <NodeView key={it.node.id} node={it.node} onPreviewChange={setPreview} />
        ),
      )}

      {/* multi-select bounding frame + export-selection chips */}
      <SelectionFrame />

      {/* group affordance, Excalidraw-quiet: a whole selected group is just the
          SelectionFrame; while ONE member is deep-selected (⌘-click) a faint
          dotted outline shows the group it belongs to. No tags. */}
      {groupFrames.map((g) => (
        <g key={g.gid} data-editor-only="1" style={{ pointerEvents: "none" }}>
          {g.partial && (
            <rect
              x={g.x}
              y={g.y}
              width={g.w}
              height={g.h}
              rx={6}
              fill="none"
              stroke="#6965db"
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
      ))}

      {/* preview connector while dragging from a port — the real arrow look
          (arrowhead + elbow routing) at reduced opacity; snaps solid on a
          valid target. */}
      {previewEdge && (
        <g
          data-editor-only="1"
          style={{ pointerEvents: "none" }}
          opacity={preview?.hoverTargetId ? 1 : 0.6}
        >
          <EdgeView edge={previewEdge} nodes={nodes} preview />
        </g>
      )}

      {/* target highlight while connecting */}
      {/* (port snapping still works — Excalidraw shows no dot for it) */}
      {hlNode && <BindGlow node={hlNode} strong />}

      {/* highlight the node an endpoint is being dragged onto */}
      {endpointHoverNode && <BindGlow node={endpointHoverNode} strong />}

      {/* selected connector editing chrome — drawn last so it sits above
          nodes and ports: perpendicular segment pills + endpoint handles. */}
      {selEdge && <SegmentHandles edge={selEdge} nodes={nodes} />}
      {selEdge && <BendHandle edge={selEdge} nodes={nodes} />}
      {selEdge && (
        <EdgeEndpointHandles
          edge={selEdge}
          nodes={nodes}
          onHoverTarget={setEndpointHoverId}
        />
      )}
      {/* rotate grip for the selected node — TOP-most so no edge hit-path
          can steal its pointerdown. */}
      {selNode && <RotateHandle node={selNode} />}
    </g>
  );
}
