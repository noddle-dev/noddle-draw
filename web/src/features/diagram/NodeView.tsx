/**
 * features/diagram/NodeView — render one diagram node (shape + centered text)
 * and wire the full Lucid-style interaction set:
 *   • click → select (shift toggles); drag → move ALL selected nodes together,
 *     snapping to the grid when appStore.snapOn;
 *   • hover → connection ports appear INSIDE this group (so they can never
 *     steal pointerdown from other nodes — the old separate ports layer
 *     covered sibling nodes and broke dragging);
 *   • double-click → inline text edit.
 *
 * Thin-React: screen→content conversion uses the SHARED camera via the
 * editorStore content ref; math lives in editor-core. Drag mutates only x/y
 * through moveNode so connected edges re-route on render ("sticky").
 */
import { useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { screenToContent } from "../../editor-core";
import { cycleCss, NODE_ANIM_CYCLE_MS } from "../../editor-core/diagram";
import type { DiagramNode } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";
import { panState } from "../../state/panState";
import { beginNodeTextEdit } from "./nodeTextEdit";
import { ConnectionPorts, type PreviewEdge } from "./ConnectionPorts";
import { DirectionalArrows } from "./DirectionalArrows";
import { shapeElement } from "./ShapePalette";
import { labelLines } from "./textWrap";

const SELECT_STROKE = "#2563eb";
/** Snap increment — half of the 22px background grid. */
const SNAP = 11;
/** Forgiving hover halo around the node so ports are easy to reach. */
// Must exceed the connection band's outer reach (BAND/2 ≈ 11) so the pointer
// staying on the band keeps the node "hovered" — otherwise ConnectionPorts
// unmounts as the cursor nears the border and the follow-dot can't be grabbed.
const HALO = 20;

// shapeElement (all kinds + icon glyphs) lives in ./ShapePalette — the single
// source of truth shared by the canvas render and the palette mini-previews.

export function NodeView({
  node,
  onPreviewChange,
}: {
  node: DiagramNode;
  /** Bubble the drag-to-connect preview up to DiagramLayer for rendering. */
  onPreviewChange: (p: PreviewEdge | null) => void;
}) {
  const selected = useDiagramStore((s) =>
    s.diagramSelection.includes(node.id),
  );
  // draw.io-style growth arrows only make sense on a SOLO selection.
  const soloSelected = useDiagramStore(
    (s) => s.diagramSelection.length === 1 && s.diagramSelection[0] === node.id,
  );
  // Hand cursor: open hand (grab) over a shape, closed hand (grabbing) while
  // dragging it — the Lucid/Figma affordance for "this is draggable".
  const dragging = useDiagramStore((s) => s.draggingId === node.id);
  const [hovered, setHovered] = useState(false);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (panState.spaceHeld) return; // Space-pan owns the gesture — hand drags the page
    e.stopPropagation();
    const d = useDiagramStore.getState();
    let sel = d.diagramSelection.filter((id) => d.nodes[id]); // nodes only
    // A grouped node selects/deselects its whole group (⌘G unit).
    const gid = d.nodes[node.id]?.groupId;
    const members = gid
      ? Object.values(d.nodes).filter((n) => n.groupId === gid).map((n) => n.id)
      : [node.id];
    if (e.shiftKey) {
      sel = sel.includes(node.id)
        ? sel.filter((id) => !members.includes(id))
        : [...sel, ...members.filter((id) => !sel.includes(id))];
      d.setDiagramSelection(sel);
      if (!sel.includes(node.id)) return; // toggled off → no drag
    } else if (!sel.includes(node.id)) {
      sel = members;
      d.setDiagramSelection(sel);
    }

    const refs = useEditorStore.getState().refs;
    if (!refs) return;
    const content = refs.content;
    // Mark this node as locally dragging so remote collab merges don't yank it.
    d.setDraggingId(node.id);
    const start = screenToContent(content, e.clientX, e.clientY);
    // Snapshot original positions so snapping never accumulates drift.
    const origs = sel
      .map((id) => {
        const n = useDiagramStore.getState().nodes[id];
        return n ? { id, x: n.x, y: n.y } : null;
      })
      .filter(Boolean) as { id: string; x: number; y: number }[];

    const move = (ev: PointerEvent) => {
      const p = screenToContent(content, ev.clientX, ev.clientY);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      const snap = useAppStore.getState().snapOn;
      const store = useDiagramStore.getState();
      for (const o of origs) {
        let nx = o.x + dx;
        let ny = o.y + dy;
        if (snap) {
          nx = Math.round(nx / SNAP) * SNAP;
          ny = Math.round(ny / SNAP) * SNAP;
        }
        const cur = store.nodes[o.id];
        if (cur && (cur.x !== nx || cur.y !== ny)) {
          store.moveNode(o.id, nx - cur.x, ny - cur.y);
        }
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      useDiagramStore.getState().setDraggingId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    beginNodeTextEdit(node);
  };

  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  // Label formatting (all optional → default look). Alignment shifts both the
  // anchor point AND the text-anchor; a small pad keeps left/right text off the
  // border. Every field is rendered as an INLINE SVG attribute so it survives
  // the DOM-clone bake in editorStore.currentBoardSvg (CSS classes do NOT).
  const align = node.textAlign ?? "center";
  const TEXT_PAD = 8;
  const tx = align === "left" ? node.x + TEXT_PAD : align === "right" ? node.x + node.w - TEXT_PAD : cx;
  const textAnchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  // Icon tiles draw their badge in the upper ~62% of the node, so the caption
  // sits in the bottom band instead of the vertical center (else it overlaps
  // the glyph). All other kinds keep the centered label.
  const textY = node.kind === "icon" ? node.y + node.h * 0.87 : cy;
  // Multi-line block stays vertically centered on textY: shift the first
  // line up by half the extra lines' height.
  const lines = labelLines(node);
  const lineHeight = (node.fontSize ?? 14) * 1.25;
  const firstLineY = textY - ((lines.length - 1) * lineHeight) / 2;
  // Node-level opacity (absent/1 → omitted so the attribute never bloats saves).
  const nodeOpacity = node.opacity != null && node.opacity !== 1 ? node.opacity : undefined;
  // Glow halo takes the node's stroke color; transparent strokes fall back
  // to the accent so the effect is never invisible.
  const glowColor =
    node.stroke && node.stroke !== "none" && node.stroke !== "transparent"
      ? node.stroke
      : "#2563eb";

  return (
    <g
      data-diagram-node={node.id}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{ cursor: dragging ? "grabbing" : "grab" }}
    >
      {/* forgiving hover/drag halo (transparent but hit-testable) */}
      <rect
        data-editor-only="1"
        x={node.x - HALO}
        y={node.y - HALO}
        width={node.w + HALO * 2}
        height={node.h + HALO * 2}
        fill="transparent"
        stroke="none"
      />
      {/* Idle animation wraps shape+text so they move as one; the halo,
          selection box and ports stay OUTSIDE the group so editor chrome
          never pulses/wobbles. transform-box/origin come from the CSS class;
          speed is inline (beats the class default); data-* attrs let the GIF
          exporter bake the exact same motion deterministically. */}
      <g
        opacity={nodeOpacity}
        // Rotation wraps shape+text only — halo, selection box, grips and
        // ports stay axis-aligned (the bbox model the router/ports use).
        transform={node.rotation ? `rotate(${node.rotation} ${cx} ${cy})` : undefined}
        className={node.anim ? `node-anim node-anim-${node.anim}` : undefined}
        data-node-anim={node.anim ?? undefined}
        data-anim-speed={node.anim ? node.animSpeed ?? 1 : undefined}
        data-anim-cx={node.anim ? cx : undefined}
        data-anim-cy={node.anim ? cy : undefined}
        data-anim-color={node.anim === "glow" ? glowColor : undefined}
        style={
          node.anim
            ? ({
                animationDuration: cycleCss(NODE_ANIM_CYCLE_MS, node.animSpeed ?? 1),
                "--glow-color": glowColor,
              } as CSSProperties)
            : undefined
        }
      >
        {/* Hand-drawn look: a shared roughen filter jitters the shape edges;
            the text switches to a handwriting font. Filter id is global +
            idempotent (see SketchDefs, rendered once by DiagramLayer). */}
        <g filter={node.sketch ? "url(#noddle-sketch)" : undefined}>
          {shapeElement(node)}
        </g>
        <text
          x={node.kind === "icon" ? cx : tx}
          y={firstLineY}
          textAnchor={node.kind === "icon" ? "middle" : textAnchor}
          dominantBaseline="central"
          fontSize={node.fontSize ?? 14}
          fontWeight={node.bold ? 700 : undefined}
          fontStyle={node.italic ? "italic" : undefined}
          textDecoration={node.underline ? "underline" : undefined}
          fill={node.textColor ?? "#1a1d23"}
          fontFamily={node.sketch ? '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive' : undefined}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {/* Multi-line labels: \n from the editor + auto word-wrap when
              node.wrap. tspans (not CSS) so the DOM-clone bake keeps them. */}
          {lines.map((line, i) => (
            <tspan
              key={i}
              x={node.kind === "icon" ? cx : tx}
              dy={i === 0 ? 0 : lineHeight}
            >
              {line || " "}
            </tspan>
          ))}
        </text>
      </g>
      {/* Connect affordance FIRST (below the selection chrome) — its full-node
          overlay must not sit on top of the resize grips or it steals their
          pointerdown and the shape can't be scaled. */}
      {(hovered || selected) && (
        <ConnectionPorts node={node} onPreviewChange={onPreviewChange} />
      )}
      {selected && (
        <rect
          data-editor-only="1"
          x={node.x - 3}
          y={node.y - 3}
          width={node.w + 6}
          height={node.h + 6}
          fill="none"
          stroke={SELECT_STROKE}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: "none" }}
        />
      )}
      {/* Resize grips LAST so they sit above the connect overlay. */}
      {selected && <ResizeHandles node={node} />}
      {/* draw.io-style directional arrows: click → same-kind connected shape,
          hover → mini shape picker. Solo selection only. */}
      {soloSelected && <DirectionalArrows node={node} />}
    </g>
  );
}

/**
 * Eight resize grips (corners + edge midpoints) on the selected node — the
 * on-canvas "scale up/down" affordance that was missing (users could only resize
 * via the Properties W/H fields). Grips keep a constant SCREEN size by dividing
 * by the camera zoom, so they stay grabbable at any zoom. Dragging mutates
 * x/y/w/h through updateNode (min 20); connected edges re-route automatically.
 */
interface HandleRole {
  id: string;
  fx: number;
  fy: number;
  L?: boolean;
  R?: boolean;
  T?: boolean;
  B?: boolean;
  cur: string;
}
const HANDLE_ROLES: HandleRole[] = [
  { id: "nw", fx: 0, fy: 0, L: true, T: true, cur: "nwse-resize" },
  { id: "n", fx: 0.5, fy: 0, T: true, cur: "ns-resize" },
  { id: "ne", fx: 1, fy: 0, R: true, T: true, cur: "nesw-resize" },
  { id: "e", fx: 1, fy: 0.5, R: true, cur: "ew-resize" },
  { id: "se", fx: 1, fy: 1, R: true, B: true, cur: "nwse-resize" },
  { id: "s", fx: 0.5, fy: 1, B: true, cur: "ns-resize" },
  { id: "sw", fx: 0, fy: 1, L: true, B: true, cur: "nesw-resize" },
  { id: "w", fx: 0, fy: 0.5, L: true, cur: "ew-resize" },
];

/**
 * Rotation grip — a circle floating above the top edge (Lucid/Figma style).
 * Dragging rotates the node around its center; with snap on (or Shift) the
 * angle sticks to 15° steps, and 0/90/180/270 always attract within ±3° so
 * "back to straight" is easy. Double-click resets to 0°.
 */
export function RotateHandle({ node }: { node: DiagramNode }) {
  const z = useEditorStore((s) => s.cam.z) || 1;
  const r = 5.5 / z; // constant ~11px screen circle
  const lift = 26 / z; // distance above the top edge
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const hx = cx;
  const hy = node.y - lift;

  const start = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (panState.spaceHeld) return;
    e.stopPropagation();
    const refs = useEditorStore.getState().refs;
    if (!refs) return;
    const content = refs.content;
    const d = useDiagramStore.getState();
    d.setDraggingId(node.id); // collab merges must not yank mid-gesture
    const p0 = screenToContent(content, e.clientX, e.clientY);
    const startPointer = (Math.atan2(p0.y - cy, p0.x - cx) * 180) / Math.PI;
    const startRotation = node.rotation ?? 0;

    const move = (ev: PointerEvent) => {
      const p = screenToContent(content, ev.clientX, ev.clientY);
      const pointer = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
      let deg = startRotation + (pointer - startPointer);
      if (useAppStore.getState().snapOn || ev.shiftKey) {
        deg = Math.round(deg / 15) * 15;
      } else {
        // The cardinal angles always attract — a straight shape is one flick away.
        const near = Math.round(deg / 90) * 90;
        if (Math.abs(deg - near) <= 3) deg = near;
      }
      deg = ((deg % 360) + 360) % 360;
      useDiagramStore.getState().updateNode(node.id, {
        rotation: deg === 0 ? undefined : Math.round(deg * 10) / 10,
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      useDiagramStore.getState().setDraggingId(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <g data-editor-only="1">
      {/* stem from the box to the grip */}
      <line
        x1={hx}
        y1={node.y - 3}
        x2={hx}
        y2={hy + r}
        stroke={SELECT_STROKE}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: "none" }}
      />
      <circle
        data-handle="rotate"
        cx={hx}
        cy={hy}
        r={r}
        fill="#fff"
        stroke={SELECT_STROKE}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        style={{ cursor: "grab" }}
        onPointerDown={start}
        onDoubleClick={(e) => {
          e.stopPropagation();
          useDiagramStore.getState().updateNode(node.id, { rotation: undefined });
        }}
      />
    </g>
  );
}

function ResizeHandles({ node }: { node: DiagramNode }) {
  const z = useEditorStore((s) => s.cam.z) || 1;
  const s = 9 / z; // constant ~9px screen handle
  const min = 20;

  const startResize =
    (role: HandleRole) => (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      if (panState.spaceHeld) return; // hand-pan wins over resizing
      e.stopPropagation();
      const refs = useEditorStore.getState().refs;
      if (!refs) return;
      const content = refs.content;
      const start = screenToContent(content, e.clientX, e.clientY);
      const o = { x: node.x, y: node.y, w: node.w, h: node.h };
      const d = useDiagramStore.getState();
      d.setDraggingId(node.id); // guard against collab merge yanking it

      const move = (ev: PointerEvent) => {
        const p = screenToContent(content, ev.clientX, ev.clientY);
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        let { x, y, w, h } = o;
        if (role.L) { const right = o.x + o.w; w = Math.max(min, o.w - dx); x = right - w; }
        if (role.R) { w = Math.max(min, o.w + dx); }
        if (role.T) { const bot = o.y + o.h; h = Math.max(min, o.h - dy); y = bot - h; }
        if (role.B) { h = Math.max(min, o.h + dy); }
        useDiagramStore.getState().updateNode(node.id, { x, y, w, h });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        useDiagramStore.getState().setDraggingId(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

  return (
    <g data-editor-only="1">
      {HANDLE_ROLES.map((r) => {
        const hx = node.x + node.w * r.fx;
        const hy = node.y + node.h * r.fy;
        return (
          <rect
            key={r.id}
            data-handle={r.id}
            x={hx - s / 2}
            y={hy - s / 2}
            width={s}
            height={s}
            rx={s * 0.22}
            fill="#fff"
            stroke={SELECT_STROKE}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            style={{ cursor: r.cur }}
            onPointerDown={startResize(r)}
          />
        );
      })}
    </g>
  );
}
