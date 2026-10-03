/**
 * features/library/LibraryThumb — a small static SVG preview of a fragment.
 *
 * Nodes render through the SAME shapeElement the canvas uses (so a thumb can
 * never drift from what gets inserted); edges are straight centre→centre
 * lines — a preview, not a router. No sketch filter (hand-drawn wobble is
 * noise at this size). Strokes are non-scaling (CSS) so big items don't fade.
 */
import { memo } from "react";
import type { Attachment, DiagramEdge, DiagramNode, Vec } from "../../editor-core/diagram";
import { shapeElement } from "../diagram";
import { LIB_INK } from "./palette";

const PAD = 8;
/** Rendered thumb width (CSS) — used to skip labels too small to read. */
const THUMB_PX = 116;
const MIN_TEXT_PX = 4.5;

interface Props {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

function bbox(nodes: DiagramNode[]): { x: number; y: number; w: number; h: number } {
  if (!nodes.length) return { x: 0, y: 0, w: 100, h: 60 };
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const r = Math.max(...nodes.map((n) => n.x + n.w));
  const b = Math.max(...nodes.map((n) => n.y + n.h));
  return { x, y, w: Math.max(1, r - x), h: Math.max(1, b - y) };
}

function endPoint(a: Attachment, byId: Map<string, DiagramNode>): Vec | null {
  if (a.kind === "free") return a.point;
  const n = byId.get(a.nodeId);
  if (!n) return null;
  if (a.kind === "port") return { x: n.x + a.rel.x * n.w, y: n.y + a.rel.y * n.h };
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

export const LibraryThumb = memo(function LibraryThumb({ nodes, edges }: Props) {
  const b = bbox(nodes);
  const vb = { x: b.x - PAD, y: b.y - PAD, w: b.w + PAD * 2, h: b.h + PAD * 2 };
  const scale = THUMB_PX / Math.max(vb.w, vb.h);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Same paint order as the canvas: z ascending, legacy (no z) at the bottom.
  const ordered = [...nodes].sort((p, q) => (p.z ?? 0) - (q.z ?? 0));

  return (
    <svg
      className="lib-thumb"
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {edges.map((e) => {
        const p = endPoint(e.source, byId);
        const q = endPoint(e.target, byId);
        if (!p || !q) return null;
        return (
          <line
            key={e.id}
            x1={p.x} y1={p.y} x2={q.x} y2={q.y}
            stroke={e.stroke || LIB_INK}
            strokeWidth={1.2}
            strokeLinecap="round"
          />
        );
      })}
      {ordered.map((n) => {
        const fs = n.fontSize ?? 13;
        // Icons caption BELOW their box (outside the thumb) and the card shows
        // the name anyway — drawing it centred would sit ON the glyph.
        const label = n.kind === "icon" ? undefined : n.text?.split("\n")[0]?.trim();
        return (
          <g key={n.id}>
            {shapeElement(n)}
            {label && fs * scale >= MIN_TEXT_PX && (
              <text
                x={n.x + n.w / 2}
                y={n.y + n.h / 2}
                fontSize={fs}
                fontWeight={n.bold ? 700 : 500}
                fill={n.textColor ?? LIB_INK}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {label.length > 18 ? label.slice(0, 17) + "…" : label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});
