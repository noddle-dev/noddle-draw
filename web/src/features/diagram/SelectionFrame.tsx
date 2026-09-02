/**
 * features/diagram/SelectionFrame — the multi-select bounding frame.
 *
 * ≥2 selected diagram nodes get one dashed rectangle around their union bbox
 * (Figma/Excalidraw-style: the GROUP reads as one thing) plus two export
 * chips (PNG / SVG) hanging off its top-right corner — one click exports just
 * the selection (the exported page cropped to the selection's union bbox).
 * Editor-only chrome (data-editor-only): never baked into saves/exports.
 * All sizes scale by 1/zoom so the frame stays screen-constant.
 */
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";
import { useExport } from "../toolbar/useExport";

const PAD = 12;

export function SelectionFrame() {
  const z = useEditorStore((s) => s.cam.z) || 1;
  const nodes = useDiagramStore((s) => s.nodes);
  const sel = useDiagramStore((s) => s.diagramSelection);
  const { exportSelectionPng, exportSelectionSvg } = useExport();

  const picked = sel.map((id) => nodes[id]).filter(Boolean);
  if (picked.length < 2) return null;

  const k = 1 / z; // screen-constant sizing
  const pad = PAD * k;
  const x0 = Math.min(...picked.map((n) => n.x)) - pad;
  const y0 = Math.min(...picked.map((n) => n.y)) - pad;
  const x1 = Math.max(...picked.map((n) => n.x + n.w)) + pad;
  const y1 = Math.max(...picked.map((n) => n.y + n.h)) + pad;

  const chip = (dx: number, label: string, onClick: () => void) => (
    <g
      transform={`translate(${x1 + dx * k} ${y0 - 34 * k}) scale(${k})`}
      style={{ cursor: "pointer" }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      role="button"
      aria-label={`Export selection as ${label}`}
    >
      <rect width="58" height="26" rx="13" fill="#ffffff" stroke="#c9cedb" strokeWidth="1" />
      <text x="29" y="17" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#374151">
        ↓ {label}
      </text>
      <title>Export just the selected shapes as {label}</title>
    </g>
  );

  return (
    <g data-editor-only="1">
      <rect
        x={x0}
        y={y0}
        width={x1 - x0}
        height={y1 - y0}
        fill="none"
        stroke="#2563eb"
        strokeWidth={1.5}
        strokeDasharray="6 4"
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: "none" }}
        opacity={0.9}
      />
      {chip(-124, "PNG", () => exportSelectionPng())}
      {chip(-62, "SVG", () => exportSelectionSvg())}
    </g>
  );
}
