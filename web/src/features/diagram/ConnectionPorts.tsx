/**
 * features/diagram/ConnectionPorts — the 4 connection dots (N/E/S/W) rendered
 * INSIDE a node's group while it is hovered/selected. Dragging from a dot
 * starts a preview edge (source = port{nodeId,rel}); dropping on another node
 * commits a connector (target = floating{nodeId}); dropping on empty space
 * cancels.
 *
 * The dots stopPropagation on pointerdown so the node's own drag never starts,
 * and the whole thing lives inside the node <g> — it can never cover a sibling
 * node (the old standalone hover-catcher layer did, which broke node dragging).
 */
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { screenToContent } from "../../editor-core";
import { perimeterPoint, snapConnect, rotatePoint, worldPointToRel } from "../../editor-core/diagram";
import type { DiagramEdge, DiagramNode, Vec } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { panState } from "../../state/panState";
import { beginNodeTextEdit } from "./nodeTextEdit";
import { PORTS } from "./ports";

/** Status-bar hint shown while the connect affordance is hovered. */
const HOVER_HINT =
  "Drag from a port or the border: release on a shape to connect, on empty canvas to create a connected shape.";

const ACCENT = "#2563eb";
const HIT_R = 14;
const DOT_R = 6;
/** How far outside the shape the connect overlay reaches (catches just-outside
 * presses). */
const BAND = 20;
/** Distance from the true perimeter within which a press connects (vs. moves
 * the node). Kept snug so the deep interior still drags the shape. */
const NEAR = 13;

export interface PreviewEdge {
  source: { nodeId: string; rel: Vec };
  /** Where the preview line ends — magnetically snapped when near a shape. */
  cursor: Vec;
  hoverTargetId: string | null;
  /** Set when snapped onto a specific port dot (rendered enlarged). */
  snapPort?: { nodeId: string; rel: Vec } | null;
}

function mintEdgeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export function ConnectionPorts({
  node,
  onPreviewChange,
}: {
  node: DiagramNode;
  onPreviewChange: (p: PreviewEdge | null) => void;
}) {
  // The live "you can connect here" dot — the cursor's position projected onto
  // the shape border, so ANY point on the perimeter is a visible anchor.
  const [hoverPt, setHoverPt] = useState<Vec | null>(null);
  // The full-node overlay owns the cursor while ports are visible — it must
  // MIRROR the gesture zones: hand deep inside (move), crosshair near the
  // border (connect), closed hand while this node is being dragged.
  const dragging = useDiagramStore((s) => s.draggingId === node.id);

  // Begin a connection from a relative point on THIS node (0..1 of w/h). The
  // 4 dots pass a fixed cardinal rel; the border band passes the exact pressed
  // point projected onto the perimeter, so any spot on the edge can start one.
  const beginConnect = (rel: Vec, e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      if (panState.spaceHeld) return; // hand-pan wins over connecting
      e.stopPropagation(); // don't start the node drag
      const refs = useEditorStore.getState().refs;
      if (!refs) return;
      const content = refs.content;
      // Select the source node so NodeView keeps rendering the ports (and this
      // component stays mounted) for the whole drag — otherwise moving off the
      // node unhovers it, unmounts the ports, and on pen/touch the captured
      // pointer is lost mid-drag (the preview then never updates).
      useDiagramStore.getState().setDiagramSelection([node.id]);
      // Route this pointer's events to a stable element that won't unmount.
      try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }

      onPreviewChange({
        source: { nodeId: node.id, rel },
        cursor: screenToContent(content, e.clientX, e.clientY),
        hoverTargetId: null,
        snapPort: null,
      });

      // Magnet radii are screen-consistent: scale by 1/zoom.
      const magnetScale = () => 1 / (useEditorStore.getState().cam.z || 1);

      // The exact target port under the cursor: a cardinal dot when near one,
      // else the cursor projected onto the target's border (hit.point) — so the
      // arrow attaches WHERE you point, not just to the 4 dots.
      const targetPort = (hit: ReturnType<typeof snapConnect>): { nodeId: string; rel: Vec } | null => {
        if (!hit) return null;
        if (hit.portRel) return { nodeId: hit.nodeId, rel: hit.portRel };
        const t = useDiagramStore.getState().nodes[hit.nodeId];
        if (!t || !t.w || !t.h) return null;
        return { nodeId: hit.nodeId, rel: worldPointToRel(t, hit.point) };
      };

      const move = (ev: PointerEvent) => {
        const p = screenToContent(content, ev.clientX, ev.clientY);
        const nodes = useDiagramStore.getState().nodes;
        // Magnet: near a shape → the preview end sticks to its border; near a
        // port dot → sticks exactly to the port (Lucid auto-connect feel).
        const hit = snapConnect(nodes, p, node.id, magnetScale());
        const tp = targetPort(hit);
        onPreviewChange({
          source: { nodeId: node.id, rel },
          cursor: hit ? hit.point : { ...p },
          hoverTargetId: hit?.nodeId ?? null,
          snapPort: tp,
        });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const p = screenToContent(content, ev.clientX, ev.clientY);
        const ds = useDiagramStore.getState();
        const hit = snapConnect(ds.nodes, p, node.id, magnetScale());
        onPreviewChange(null);
        if (!hit || hit.nodeId === node.id) {
          // Empty canvas: a REAL drag creates a connected shape right there
          // (Lucid flow — arrow + next step in one gesture). A short slip
          // still cancels so accidental presses don't spawn shapes.
          const src = ds.nodes[node.id];
          if (!src) return;
          const from = { x: src.x + rel.x * src.w, y: src.y + rel.y * src.h };
          const MIN_DRAG = 48 * magnetScale(); // ~48 screen px
          if (Math.hypot(p.x - from.x, p.y - from.y) < MIN_DRAG) return;
          const newId = ds.addNodeAt(src.kind, p, {
            w: src.w,
            h: src.h,
            fill: src.fill,
            stroke: src.stroke,
            strokeWidth: src.strokeWidth,
            sketch: src.sketch,
            wrap: src.wrap,
          });
          useDiagramStore.getState().addEdge({
            id: mintEdgeId(),
            source: { kind: "port", nodeId: node.id, rel },
            target: { kind: "floating", nodeId: newId },
            routing: "elbow",
            stroke: "#475569",
            strokeWidth: 2,
            endArrow: true,
            startArrow: false,
            animated: false,
          });
          const st = useDiagramStore.getState();
          st.setDiagramSelection([newId]);
          const created = st.nodes[newId];
          if (created) beginNodeTextEdit(created); // type the label right away
          useEditorStore.getState().setStatus("Shape added and connected.", "ok");
          return;
        }
        const tp = targetPort(hit);
        const edge: DiagramEdge = {
          id: mintEdgeId(),
          source: { kind: "port", nodeId: node.id, rel },
          target: tp
            ? { kind: "port", nodeId: tp.nodeId, rel: tp.rel }
            : { kind: "floating", nodeId: hit.nodeId },
          routing: "elbow",
          stroke: "#475569",
          strokeWidth: 2,
          endArrow: true,
          startArrow: false,
          animated: false,
        };
        useDiagramStore.getState().addEdge(edge);
        useDiagramStore.getState().setDiagramSelection([edge.id]);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

  const startConnect = (rel: Vec) => (e: ReactPointerEvent) => beginConnect(rel, e);

  // Border band: pointerdown anywhere near the perimeter → connection from the
  // exact pressed point (projected onto the shape) — so, like Lucid, the whole
  // edge is a connection anchor, not only the 4 dots.
  const relOfPoint = (pt: Vec): Vec => ({
    x: node.w ? (pt.x - node.x) / node.w : 0.5,
    y: node.h ? (pt.y - node.y) / node.h : 0.5,
  });

  // A single invisible overlay covering the node (+ a margin) drives the whole
  // connect affordance — far more reliable than a thin stroke band:
  //  • pointermove near the border → show the follow-dot at the projected point
  //  • pointerdown near the border → start a connection from that point
  //  • anywhere deeper inside → do nothing, so the press bubbles to the node
  //    group and moves the shape as usual.
  // The overlay + dots render inside a group rotated with the node, so all of
  // this component's geometry lives in the node's LOCAL (un-rotated) frame:
  // inverse-rotate the world cursor before projecting, and keep hoverPt local
  // so it draws on the rotated border.
  const center = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  const toLocal = (p: Vec): Vec =>
    node.rotation ? rotatePoint(p, center, -node.rotation) : p;

  const borderInfo = (e: ReactPointerEvent): { pt: Vec; near: boolean } | null => {
    const refs = useEditorStore.getState().refs;
    if (!refs) return null;
    const c = toLocal(screenToContent(refs.content, e.clientX, e.clientY));
    const pt = perimeterPoint(node, c);
    const near = Math.hypot(c.x - pt.x, c.y - pt.y) <= NEAR;
    return { pt, near };
  };
  const overlayMove = (e: ReactPointerEvent) => {
    const info = borderInfo(e);
    setHoverPt(info?.near ? info.pt : null);
    // Tell the user what the affordance does the moment it lights up.
    if (info?.near) useEditorStore.getState().setStatus(HOVER_HINT);
  };
  const overlayDown = (e: ReactPointerEvent) => {
    const info = borderInfo(e);
    if (info?.near) beginConnect(relOfPoint(info.pt), e); // else: bubbles → move
  };

  // A visible accent outline hugging the shape — the Lucid cue that the WHOLE
  // border is connectable (non-interactive).
  const isEllipse = node.kind === "ellipse";
  const cue = isEllipse ? (
    <ellipse cx={node.x + node.w / 2} cy={node.y + node.h / 2} rx={node.w / 2} ry={node.h / 2}
      fill="none" stroke={ACCENT} strokeWidth={2} opacity={0.5} style={{ pointerEvents: "none" }} />
  ) : (
    <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={node.kind === "rounded" ? 8 : 0}
      fill="none" stroke={ACCENT} strokeWidth={2} opacity={0.5} style={{ pointerEvents: "none" }} />
  );

  const rotateTransform = node.rotation
    ? `rotate(${node.rotation} ${center.x} ${center.y})`
    : undefined;

  return (
    <g data-editor-only="1" transform={rotateTransform}>
      {cue}
      {/* full-node overlay: near-border → connect/hover-dot, interior → move */}
      <rect
        x={node.x - BAND}
        y={node.y - BAND}
        width={node.w + BAND * 2}
        height={node.h + BAND * 2}
        fill="transparent"
        style={{
          pointerEvents: "all",
          cursor: dragging ? "grabbing" : hoverPt ? "crosshair" : "grab",
        }}
        onPointerMove={overlayMove}
        onPointerLeave={() => setHoverPt(null)}
        onPointerDown={overlayDown}
      />
      {/* live anchor dot at the projected border point */}
      {hoverPt && (
        <circle
          cx={hoverPt.x}
          cy={hoverPt.y}
          r={DOT_R}
          fill={ACCENT}
          stroke="#fff"
          strokeWidth={1.5}
          style={{ pointerEvents: "none" }}
        />
      )}
      {PORTS.filter((p) => p.id !== "c").map((port) => {
        const px = node.x + port.rel.x * node.w;
        const py = node.y + port.rel.y * node.h;
        return (
          <g key={port.id}>
            {/* generous transparent hit target */}
            <circle
              cx={px}
              cy={py}
              r={HIT_R}
              fill="transparent"
              style={{ cursor: "crosshair" }}
              onPointerDown={startConnect(port.rel)}
            >
              <title>Drag to draw an arrow — drop on empty canvas to add a connected shape</title>
            </circle>
            <circle
              cx={px}
              cy={py}
              r={DOT_R}
              fill="#fff"
              stroke={ACCENT}
              strokeWidth={1.5}
              style={{ pointerEvents: "none" }}
            />
          </g>
        );
      })}
    </g>
  );
}
