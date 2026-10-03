/**
 * features/diagram/BindGlow — Excalidraw's binding highlight: a soft, blurred
 * outline hugging the shape's REAL silhouette (rounded rect, ellipse,
 * diamond, …) — the one cue the arrow tool shows (hover / magnet target /
 * reconnect target). Replaces the old port dots, follow-dot and hard accent
 * rectangle. Editor-only chrome: never baked into saves or exports.
 */
import type { DiagramNode } from "../../editor-core/diagram";
import { shapeElement } from "./ShapePalette";

/** Shared blur filter id (defined once in DiagramLayer's <defs>). */
export const BIND_GLOW_FILTER = "noddle-bind-glow";
const GLOW = "#8b85f0";

export function BindGlow({ node, strong = false }: { node: DiagramNode; strong?: boolean }) {
  // Icons / images / borderless labels have no outline worth tracing — glow
  // their box instead, softly rounded.
  const boxy = node.kind === "icon" || node.kind === "image" || node.stroke === "transparent";
  const sw = strong ? 7 : 5;
  return (
    <g
      data-editor-only="1"
      // OSS nodes can rotate — the glow hugs the shape the user sees.
      transform={node.rotation ? `rotate(${node.rotation} ${node.x + node.w / 2} ${node.y + node.h / 2})` : undefined}
      filter={`url(#${BIND_GLOW_FILTER})`}
      opacity={strong ? 0.6 : 0.42}
      style={{ pointerEvents: "none" }}
    >
      {boxy ? (
        <rect x={node.x - 2} y={node.y - 2} width={node.w + 4} height={node.h + 4} rx={8}
          fill="none" stroke={GLOW} strokeWidth={sw} />
      ) : (
        shapeElement({ ...node, fill: "none", stroke: GLOW, strokeWidth: sw, strokeDash: undefined })
      )}
    </g>
  );
}
