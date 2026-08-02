/**
 * features/diagram/shapes/flowchart — renderers for the flowchart catalog
 * expansions (the original flowchart family still lives in
 * ShapePalette.shapeElement; new kinds register here via shapes/index.ts):
 * 2026-07 multiDocument…offPage, then 2026-08 stencil parity — paper tape,
 * the two junctions, brace/bracket annotations and the two table frames.
 */
import type { DiagramNode } from "../../../editor-core/diagram";
import { polygonPoints, type ShapeRenderer } from "./util";

function common(node: DiagramNode) {
  const { fill, stroke, strokeWidth } = node;
  return { fill, stroke, strokeWidth };
}

/** Stroke-only props for the marks drawn INSIDE/BESIDE a shape (dividers,
 * junction crosses, annotation braces) — these must never take the node fill. */
function strokeOnly(node: DiagramNode) {
  return { fill: "none", stroke: node.stroke, strokeWidth: node.strokeWidth };
}

/** Circle carrying a cross: diagonal ✕ (summing junction) or upright ✚ (or). */
function junction(n: DiagramNode, diagonal: boolean) {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const r = Math.max(1, Math.min(n.w, n.h) / 2 - n.strokeWidth / 2);
  const k = diagonal ? r / Math.SQRT2 : r;
  const arms: [number, number, number, number][] = diagonal
    ? [
        [cx - k, cy - k, cx + k, cy + k],
        [cx - k, cy + k, cx + k, cy - k],
      ]
    : [
        [cx - k, cy, cx + k, cy],
        [cx, cy - k, cx, cy + k],
      ];
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} {...common(n)} />
      {arms.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} {...strokeOnly(n)} />
      ))}
    </g>
  );
}

/**
 * A curly brace spanning the node's full height. `x0` is where the two ends
 * sit, `xTip` where the middle point reaches — so a right-facing "}" passes
 * x0 < xTip and a left-facing "{" passes x0 > xTip.
 */
function bracePath(x0: number, xTip: number, y: number, h: number) {
  const xMid = (x0 + xTip) / 2;
  return (
    `M ${x0} ${y}` +
    ` Q ${xMid} ${y} ${xMid} ${y + h * 0.25}` +
    ` L ${xMid} ${y + h * 0.42}` +
    ` Q ${xMid} ${y + h / 2} ${xTip} ${y + h / 2}` +
    ` Q ${xMid} ${y + h / 2} ${xMid} ${y + h * 0.58}` +
    ` L ${xMid} ${y + h * 0.75}` +
    ` Q ${xMid} ${y + h} ${x0} ${y + h}`
  );
}

/** Width of an annotation mark — a slice of the box, so the label keeps the rest. */
function markWidth(n: DiagramNode) {
  return Math.min(n.w * 0.16, 22);
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

  paperTape: (n) => {
    // Torn strip: both edges wave in the SAME phase (opposite phases would
    // read as a lens/leaf instead of tape).
    const { x, y, w, h } = n;
    const wv = Math.min(h * 0.16, 18);
    const d =
      `M ${x} ${y + wv}` +
      ` C ${x + w * 0.28} ${y - wv * 0.7} ${x + w * 0.72} ${y + wv * 1.7} ${x + w} ${y + wv}` +
      ` V ${y + h - wv}` +
      ` C ${x + w * 0.72} ${y + h - wv - wv * 1.7} ${x + w * 0.28} ${y + h - wv + wv * 1.7} ${x} ${y + h - wv}` +
      ` Z`;
    return <path d={d} {...common(n)} />;
  },

  summingJunction: (n) => junction(n, true),
  orJunction: (n) => junction(n, false),

  braceRight: (n) => {
    const bw = markWidth(n);
    return <path d={bracePath(n.x, n.x + bw, n.y, n.h)} {...strokeOnly(n)} />;
  },
  braceLeft: (n) => {
    const bw = markWidth(n);
    return <path d={bracePath(n.x + n.w, n.x + n.w - bw, n.y, n.h)} {...strokeOnly(n)} />;
  },
  bracketLeft: (n) => {
    const bw = markWidth(n);
    const d = `M ${n.x + bw} ${n.y} H ${n.x} V ${n.y + n.h} H ${n.x + bw}`;
    return <path d={d} {...strokeOnly(n)} />;
  },
  bracketRight: (n) => {
    const bw = markWidth(n);
    const d = `M ${n.x + n.w - bw} ${n.y} H ${n.x + n.w} V ${n.y + n.h} H ${n.x + n.w - bw}`;
    return <path d={d} {...strokeOnly(n)} />;
  },

  table: (n) => {
    const { x, y, w, h } = n;
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} {...common(n)} />
        {[1, 2].map((i) => (
          <line key={`c${i}`} x1={x + (w * i) / 3} y1={y} x2={x + (w * i) / 3} y2={y + h} {...strokeOnly(n)} />
        ))}
        {[1, 2].map((i) => (
          <line key={`r${i}`} x1={x} y1={y + (h * i) / 3} x2={x + w} y2={y + (h * i) / 3} {...strokeOnly(n)} />
        ))}
      </g>
    );
  },

  tableHeader: (n) => {
    const { x, y, w, h } = n;
    // Header band is deliberately taller than a body row AND closed by a
    // heavier rule — with equal bands and one weight it just reads "4 rows".
    const head = Math.min(h * 0.34, 40);
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} {...common(n)} />
        <line
          x1={x}
          y1={y + head}
          x2={x + w}
          y2={y + head}
          fill="none"
          stroke={n.stroke}
          strokeWidth={n.strokeWidth * 1.8}
        />
        {[1, 2].map((i) => {
          const ly = y + head + ((h - head) * i) / 3;
          return <line key={i} x1={x} y1={ly} x2={x + w} y2={ly} {...strokeOnly(n)} />;
        })}
      </g>
    );
  },
};
