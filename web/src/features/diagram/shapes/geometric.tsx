/**
 * features/diagram/shapes/geometric — renderers for the 2026-07 geometric
 * catalog expansion. One entry per NodeKind; registered in shapes/index.ts.
 * Pure node → SVG, no store imports (same contract as shapeElement).
 */
import type { DiagramNode } from "../../../editor-core/diagram";
import { polygonPoints, type ShapeRenderer } from "./util";

function common(node: DiagramNode) {
  const { fill, stroke, strokeWidth } = node;
  return { fill, stroke, strokeWidth };
}

export const geometricShapes: Record<string, ShapeRenderer> = {
  trapezoid: (n) => (
    <polygon points={polygonPoints(n, "trapezoid")} {...common(n)} strokeLinejoin="round" />
  ),

  octagon: (n) => (
    <polygon points={polygonPoints(n, "octagon")} {...common(n)} strokeLinejoin="round" />
  ),

  semicircle: (n) => {
    const { x, y, w, h } = n;
    const d = `M ${x} ${y + h} A ${w / 2} ${h} 0 0 1 ${x + w} ${y + h} Z`;
    return <path d={d} {...common(n)} strokeLinejoin="round" />;
  },

  ring: (n) => {
    const { x, y, w, h } = n;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const t = Math.min(w, h) * 0.18; // ring thickness
    return (
      <g>
        <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} {...common(n)} />
        <ellipse cx={cx} cy={cy} rx={w / 2 - t} ry={h / 2 - t} fill="#ffffff" stroke={n.stroke} strokeWidth={n.strokeWidth} />
      </g>
    );
  },

  shield: (n) => {
    const { x, y, w, h } = n;
    const d = `M ${x + w / 2} ${y}
      C ${x + w * 0.72} ${y + h * 0.09} ${x + w * 0.9} ${y + h * 0.12} ${x + w} ${y + h * 0.12}
      V ${y + h * 0.55}
      C ${x + w} ${y + h * 0.8} ${x + w * 0.72} ${y + h * 0.94} ${x + w / 2} ${y + h}
      C ${x + w * 0.28} ${y + h * 0.94} ${x} ${y + h * 0.8} ${x} ${y + h * 0.55}
      V ${y + h * 0.12}
      C ${x + w * 0.1} ${y + h * 0.12} ${x + w * 0.28} ${y + h * 0.09} ${x + w / 2} ${y} Z`;
    return <path d={d} {...common(n)} strokeLinejoin="round" />;
  },

  lightning: (n) => {
    const { x, y, w, h } = n;
    const pts = [
      [0.62, 0], [0.18, 0.56], [0.44, 0.56], [0.32, 1], [0.82, 0.4], [0.55, 0.4],
    ]
      .map(([px, py]) => `${x + px * w},${y + py * h}`)
      .join(" ");
    return <polygon points={pts} {...common(n)} strokeLinejoin="round" />;
  },

  heart: (n) => {
    const { x, y, w, h } = n;
    const d = `M ${x + w / 2} ${y + h}
      C ${x - w * 0.18} ${y + h * 0.52} ${x + w * 0.08} ${y - h * 0.12} ${x + w / 2} ${y + h * 0.28}
      C ${x + w * 0.92} ${y - h * 0.12} ${x + w * 1.18} ${y + h * 0.52} ${x + w / 2} ${y + h} Z`;
    return <path d={d} {...common(n)} strokeLinejoin="round" />;
  },

  banner: (n) => {
    const { x, y, w, h } = n;
    const notch = Math.min(w * 0.12, h * 0.5);
    const pts = [
      `${x},${y}`,
      `${x + w},${y}`,
      `${x + w - notch},${y + h / 2}`,
      `${x + w},${y + h}`,
      `${x},${y + h}`,
      `${x + notch},${y + h / 2}`,
    ].join(" ");
    return <polygon points={pts} {...common(n)} strokeLinejoin="round" />;
  },
};
