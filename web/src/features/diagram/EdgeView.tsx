/**
 * features/diagram/EdgeView — render one edge as an SVG path.
 *
 * Geometry is derived on render via editor-core/diagram.edgePath from the
 * referenced nodes, so it re-routes when a node moves (sticky). Memoized on the
 * two endpoints' node bounds + edge routing so unrelated node moves don't
 * recompute this edge.
 */
import { useMemo } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  edgePath,
  cycleCss,
  DASH_CYCLE_MS,
  BEAM_CYCLE_MS,
  PULSE_CYCLE_MS,
  DOTS_CYCLE_MS,
  dotsForLength,
  pointAtT,
  tOfPoint,
  FLOW_INTENSITY,
  type NodeMap,
} from "../../editor-core/diagram";
import type { ArrowHead, DiagramEdge, FlowIntensity } from "../../editor-core/diagram";
import { screenToContent } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { panState } from "../../state/panState";
import { beginEdgeLabelEdit } from "./edgeLabelEdit";

const HIT_STROKE = 12;

/** The head kinds that render a marker (i.e. everything but "none"). */
export const ARROW_HEADS: Exclude<ArrowHead, "none">[] = [
  "arrow",
  "triangle",
  "circle",
  "diamond",
];

/** Stable <marker> id for a head kind. A single marker serves BOTH ends —
 * orient="auto-start-reverse" flips it for a start decoration. */
export function headMarkerId(head: Exclude<ArrowHead, "none">): string {
  return `diagram-head-${head}`;
}

/** Resolve the effective head, honoring the legacy boolean fallback. */
function effectiveHead(explicit: ArrowHead | undefined, legacy: boolean): ArrowHead {
  return explicit ?? (legacy ? "arrow" : "none");
}

/** marker url() for a head, or undefined for "none". */
function headMarker(head: ArrowHead): string | undefined {
  return head === "none" ? undefined : `url(#${headMarkerId(head)})`;
}

/** Static dasharray for a non-animated line style (scaled by stroke width). */
function staticDashArray(dash: DiagramEdge["dash"], sw: number): string | undefined {
  if (dash === "dashed") return `${Math.max(4, sw * 3)} ${Math.max(3, sw * 2)}`;
  if (dash === "dotted") return `${Math.max(1, sw)} ${Math.max(2, sw * 1.8)}`;
  return undefined;
}

/** A compact dependency key for the nodes this edge references.
 *
 * MUST encode the attachment KIND and port rel too — switching floating→port
 * on the same node (magnet live-attach) changes the route while the node
 * bounds stay identical; a bounds-only key kept a stale memoized path while
 * the (unmemoized) handles rendered the new one, drawing them apart. */
function depKey(edge: DiagramEdge, nodes: NodeMap): string {
  const parts: string[] = [edge.routing, edge.id, edge.flowStyle ?? ""];
  for (const att of [edge.source, edge.target]) {
    if (att.kind === "free") {
      parts.push(`f:${att.point.x},${att.point.y}`);
    } else {
      const n = nodes[att.nodeId];
      const bounds = n ? `${n.x},${n.y},${n.w},${n.h}` : "gone";
      parts.push(
        att.kind === "port"
          ? `p:${att.nodeId}@${att.rel.x},${att.rel.y}:${bounds}`
          : `fl:${att.nodeId}:${bounds}`,
      );
    }
  }
  // A user-dragged route must invalidate the memoized path too.
  if (edge.waypoints?.length) {
    parts.push("w:" + edge.waypoints.map((w) => `${w.x},${w.y}`).join(";"));
  }
  return parts.join("|");
}

/** Traveling-packet dots along the path (SMIL animateMotion → GPU cheap).
 * Speed scales the SMIL dur; intensity scales the packet radius. */
function FlowDots({
  pathId,
  stroke,
  strokeWidth,
  speed,
  intensity,
  count,
}: {
  pathId: string;
  stroke: string;
  strokeWidth: number;
  speed: number;
  intensity: FlowIntensity;
  /** Number of evenly-spaced packets (scales with edge length). */
  count: number;
}) {
  const params = FLOW_INTENSITY[intensity];
  const r = Math.max(params.dotMinR, strokeWidth * params.dotScale);
  const durS = DOTS_CYCLE_MS / speed / 1000;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} r={r} fill={stroke} style={{ pointerEvents: "none" }}>
          <animateMotion
            dur={`${durS}s`}
            repeatCount="indefinite"
            begin={`${(-i * durS) / count}s`}
            rotate="0"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}
    </>
  );
}

/** Polyline length from the geometry corner list (dots-per-edge scaling). */
function polylineLength(points: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

export function EdgeView({
  edge,
  nodes,
  preview = false,
}: {
  edge: DiagramEdge;
  nodes: NodeMap;
  /** Render-only preview (drag-to-connect): no selection state, no handlers. */
  preview?: boolean;
}) {
  const key = depKey(edge, nodes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geom = useMemo(() => edgePath(edge, nodes), [key]);
  const selectedReal = useDiagramStore((s) => s.diagramSelection.includes(edge.id));
  const selected = preview ? false : selectedReal;

  if (!geom) return null;

  const onPointerDown = (e: ReactPointerEvent) => {
    if (panState.spaceHeld) return; // hand-pan wins
    if (e.button !== 0) return;
    e.stopPropagation();
    useDiagramStore.getState().setDiagramSelection([edge.id]);
  };

  // Label/dblclick anchor: the true middle of the (possibly multi-corner)
  // polyline, not the endpoint average.
  const mx = geom.mid.x;
  const my = geom.mid.y;

  // Double-click ANYWHERE on the line → add a text block at that point (a new
  // one each time, so an edge can carry several). Double-clicking an existing
  // block edits it instead (its own handler stops propagation).
  const onDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const refs = useEditorStore.getState().refs;
    if (!refs) {
      beginEdgeLabelEdit(edge.id, { x: mx, y: my });
      return;
    }
    const c = screenToContent(refs.content, e.clientX, e.clientY);
    const t = tOfPoint(geom.points, c);
    const lid = useDiagramStore.getState().addEdgeLabel(edge.id, t);
    beginEdgeLabelEdit(edge.id, pointAtT(geom.points, t), lid);
  };

  // Flow style: which animation the edge runs (see editor-core FlowStyle),
  // scaled by speed (cycle = base/speed) and shaped by intensity. Both are
  // applied INLINE (style + SMIL dur) so they beat the class defaults and
  // serialize with the markup; data-* attrs feed the GIF exporter.
  const flow = edge.animated ? edge.flowStyle ?? "dash" : null;
  const speed = edge.flowSpeed ?? 1;
  const intensity = edge.flowIntensity ?? "normal";
  const params = FLOW_INTENSITY[intensity];
  const visId = `edge-vis-${edge.id}`;
  const strokeColor = selected ? "#2563eb" : edge.stroke;

  // Endpoint decorations — explicit head wins, else derive from the legacy
  // endArrow/startArrow booleans so old boards keep their arrows.
  const endHead = effectiveHead(edge.endHead, edge.endArrow);
  const startHead = effectiveHead(edge.startHead, edge.startArrow);

  // Static dash pattern applies to every style EXCEPT the marching-ants "dash"
  // flow (which owns the dasharray for its animation).
  const staticDash = flow === "dash" ? undefined : staticDashArray(edge.dash, edge.strokeWidth);

  const visStyle: CSSProperties = {};
  if (flow === "dash") {
    visStyle.strokeDasharray = params.dashArray;
    visStyle.animationDuration = cycleCss(DASH_CYCLE_MS, speed);
  } else if (flow === "pulse") {
    visStyle.animationDuration = cycleCss(PULSE_CYCLE_MS, speed);
    (visStyle as CSSProperties & { "--pulse-min"?: number })["--pulse-min"] = params.pulseMin;
  }
  if (staticDash) visStyle.strokeDasharray = staticDash;

  return (
    <g
      data-diagram-edge={edge.id}
      data-flow={flow ?? undefined}
      data-flow-speed={flow ? speed : undefined}
      data-flow-intensity={flow ? intensity : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      style={{ cursor: "pointer" }}
    >
      {/* wide invisible hit area for easy selection */}
      <path
        d={geom.d}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_STROKE}
        vectorEffect="non-scaling-stroke"
      />
      <path
        id={visId}
        className={
          flow === "dash" ? "edge-animated" : flow === "pulse" ? "edge-pulse" : undefined
        }
        d={geom.d}
        fill="none"
        stroke={strokeColor}
        strokeWidth={edge.strokeWidth}
        opacity={flow === "beam" ? params.beamBaseOpacity : undefined}
        markerEnd={headMarker(endHead)}
        markerStart={headMarker(startHead)}
        style={visStyle}
      />
      {/* beam: a bright comet sweeping over the dimmed base line */}
      {flow === "beam" && (
        <path
          className="edge-beam"
          d={geom.d}
          fill="none"
          stroke={strokeColor}
          strokeWidth={edge.strokeWidth + 0.5}
          strokeLinecap="round"
          style={{
            pointerEvents: "none",
            strokeDasharray: params.beamArray,
            animationDuration: cycleCss(BEAM_CYCLE_MS, speed),
          }}
        />
      )}
      {flow === "dots" && (
        <FlowDots
          // Remount when speed/count change: SMIL animateMotion doesn't adopt a
          // new `dur` mid-flight cleanly (it glitches until reload), so a fresh
          // key restarts the packets smoothly at the new speed.
          key={`dots-${speed}-${dotsForLength(polylineLength(geom.points))}`}
          pathId={visId}
          stroke={strokeColor}
          strokeWidth={edge.strokeWidth}
          speed={speed}
          intensity={intensity}
          count={dotsForLength(polylineLength(geom.points))}
        />
      )}
      {/* Legacy single midpoint label + the multi-block labels, each a chip
          floating ON the line (double-click a chip to edit just that block). */}
      {edge.label && <LabelChip cx={mx} cy={my} text={edge.label} onEdit={() => beginEdgeLabelEdit(edge.id, { x: mx, y: my })} />}
      {(edge.labels ?? []).map((lb) => {
        const p = pointAtT(geom.points, lb.t);
        return (
          <LabelChip
            key={lb.id}
            cx={p.x}
            cy={p.y}
            text={lb.text}
            onEdit={() => beginEdgeLabelEdit(edge.id, p, lb.id)}
            onDragTo={(clientX, clientY) => {
              const refs = useEditorStore.getState().refs;
              if (!refs) return;
              const cp = screenToContent(refs.content, clientX, clientY);
              useDiagramStore.getState().moveEdgeLabel(edge.id, lb.id, tOfPoint(geom.points, cp));
            }}
          />
        );
      })}
    </g>
  );
}

/** A rounded white chip with centered text, floating on the connector.
 * Double-click edits this block; press-and-drag slides it along the line. */
function LabelChip({
  cx, cy, text, onEdit, onDragTo,
}: {
  cx: number; cy: number; text: string;
  onEdit: () => void;
  onDragTo?: (clientX: number, clientY: number) => void;
}) {
  const fs = 12;
  const chipW = Math.max(18, text.length * fs * 0.62 + 12);
  const chipH = fs + 8;
  const onPointerDown = (e: ReactPointerEvent) => {
    if (panState.spaceHeld) return; // hand-pan wins
    if (e.button !== 0 || !onDragTo) return;
    e.stopPropagation(); // don't select the edge / start a pan
    const move = (ev: PointerEvent) => onDragTo(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <g
      style={{ cursor: onDragTo ? "grab" : "text" }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}
    >
      <rect x={cx - chipW / 2} y={cy - chipH / 2} width={chipW} height={chipH} rx={6} ry={6}
        fill="#ffffff" stroke="var(--border, #e6e8ec)" strokeWidth={1} />
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={fs}
        fill="#1a1d23" style={{ userSelect: "none" }}>
        {text}
      </text>
    </g>
  );
}
