/**
 * features/diagram/shapes/uml — UML-lite structure shapes (2026-07 expansion).
 * The node's `text` renders in the TITLE compartment via NodeView's normal
 * centered label; compartment dividers are proportional.
 */
import type { DiagramNode } from "../../../editor-core/diagram";
import type { ShapeRenderer } from "./util";

function common(node: DiagramNode) {
  const { fill, stroke, strokeWidth } = node;
  return { fill, stroke, strokeWidth };
}

function line(node: DiagramNode) {
  const { stroke, strokeWidth } = node;
  return { stroke, strokeWidth };
}

export const umlShapes: Record<string, ShapeRenderer> = {
  umlClass: (n) => {
    const { x, y, w, h } = n;
    const t1 = y + h * 0.38; // title / attributes divider
    const t2 = y + h * 0.72; // attributes / methods divider
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} {...common(n)} />
        <line x1={x} y1={t1} x2={x + w} y2={t1} {...line(n)} />
        <line x1={x} y1={t2} x2={x + w} y2={t2} {...line(n)} />
      </g>
    );
  },

  package: (n) => {
    const { x, y, w, h } = n;
    const tabW = Math.min(w * 0.42, 90);
    const tabH = Math.min(h * 0.22, 26);
    return (
      <g>
        <rect x={x} y={y} width={tabW} height={tabH} {...common(n)} />
        <rect x={x} y={y + tabH} width={w} height={h - tabH} {...common(n)} />
      </g>
    );
  },

  component: (n) => {
    const { x, y, w, h } = n;
    const tabW = Math.min(w * 0.18, 26);
    const tabH = Math.min(h * 0.14, 16);
    const bx = x + tabW / 2; // body inset so the tabs stick out on the left
    return (
      <g>
        <rect x={bx} y={y} width={w - tabW / 2} height={h} {...common(n)} />
        <rect x={x} y={y + h * 0.22} width={tabW} height={tabH} {...common(n)} />
        <rect x={x} y={y + h * 0.52} width={tabW} height={tabH} {...common(n)} />
      </g>
    );
  },
};
