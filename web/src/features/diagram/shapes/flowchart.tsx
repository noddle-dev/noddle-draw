/**
 * features/diagram/shapes/flowchart — renderers for the 2026-07 flowchart
 * catalog expansion (the original flowchart family still lives in
 * ShapePalette.shapeElement; new kinds register here via shapes/index.ts).
 */
import type { DiagramNode } from "../../../editor-core/diagram";
import { polygonPoints, type ShapeRenderer } from "./util";

function common(node: DiagramNode) {
  const { fill, stroke, strokeWidth } = node;
  return { fill, stroke, strokeWidth };
}

export const flowchartShapes: Record<string, ShapeRenderer> = {
  multiDocument: (n) => {
    const { x, y, w, h } = n;
    const off = Math.min(w, h) * 0.08;
    const wave = h * 0.14;
    const doc = (dx: number, dy: number, dw: number, dh: number) => {
      const by = dy + dh - wave;
      return `M ${dx} ${dy} H ${dx + dw} V ${by} C ${dx + dw * 0.72} ${by + wave * 1.6} ${dx + dw * 0.28} ${by - wave * 1.6} ${dx} ${by} Z`;
    };
    return (
      <g>
        <path d={doc(x + off * 2, y, w - off * 2, h - off * 2)} {...common(n)} />
        <path d={doc(x + off, y + off, w - off * 2, h - off * 2)} {...common(n)} />
        <path d={doc(x, y + off * 2, w - off * 2, h - off * 2)} {...common(n)} />
      </g>
    );
  },

  storedData: (n) => {
    const { x, y, w, h } = n;
    const rx = Math.min(w * 0.16, 22);
    const d = `M ${x + rx} ${y} H ${x + w} A ${rx} ${h / 2} 0 0 0 ${x + w} ${y + h} H ${x + rx} A ${rx} ${h / 2} 0 0 1 ${x + rx} ${y} Z`;
    return <path d={d} {...common(n)} strokeLinejoin="round" />;
  },

  queue: (n) => {
    // Horizontal cylinder (message queue): body + left cap.
    const { x, y, w, h } = n;
    const rx = Math.min(w * 0.12, 18);
    const body = `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${h / 2} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${h / 2} 0 0 1 ${x + rx} ${y} Z`;
    const cap = `M ${x + w - rx} ${y} A ${rx} ${h / 2} 0 0 0 ${x + w - rx} ${y + h}`;
    return (
      <g>
        <path d={body} {...common(n)} />
        <path d={cap} fill="none" stroke={n.stroke} strokeWidth={n.strokeWidth} />
      </g>
    );
  },

  loopLimit: (n) => {
    const { x, y, w, h } = n;
    const cut = Math.min(w * 0.16, h * 0.4, 22);
    const pts = [
      `${x + cut},${y}`,
      `${x + w - cut},${y}`,
      `${x + w},${y + cut}`,
      `${x + w},${y + h}`,
      `${x},${y + h}`,
      `${x},${y + cut}`,
    ].join(" ");
    return <polygon points={pts} {...common(n)} strokeLinejoin="round" />;
  },

  merge: (n) => (
    <polygon points={polygonPoints(n, "merge")} {...common(n)} strokeLinejoin="round" />
  ),

  offPage: (n) => (
    <polygon points={polygonPoints(n, "offPage")} {...common(n)} strokeLinejoin="round" />
  ),
};
