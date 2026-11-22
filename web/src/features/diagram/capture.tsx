/** Offline PNG capture, sharing DiagramLayer/NodeView/EdgeView with the editor. */
import { ensureFonts, embedFonts } from "../../shared/fonts";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DiagramLayer } from "./DiagramLayer";
import { useDiagramStore } from "../../state/diagramStore";
import type { DiagramNode, DiagramEdge } from "../../editor-core/diagram";

async function capture() {
  await ensureFonts();
  const payload = JSON.parse(document.getElementById("capture-data")!.textContent!) as {
    nodes: DiagramNode[]; edges: DiagramEdge[];
  };
  useDiagramStore.getState().loadDiagram(payload.nodes, payload.edges);
  useDiagramStore.setState({ diagramMode: true, diagramSelection: [] });
  flushSync(() => createRoot(document.getElementById("root")!).render(
    <svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600" style={{ fontFamily: "sans-serif" }}>
      <DiagramLayer />
    </svg>,
  ));
  await document.fonts.ready;
  const svg = document.querySelector("svg")!;
  svg.querySelectorAll("[data-editor-only]").forEach((el) => el.remove());
  const edgeRoutes = sampleEdgeRoutes(svg.querySelector("#diagram-layer") as SVGGElement);
  // Bounds include actual text and routed edges, including content outside nodes.
  const box = (svg.querySelector("#diagram-layer") as SVGGElement).getBBox();
  const w = Math.max(1, box.width + 80), h = Math.max(1, box.height + 80);
  if (![box.x, box.y, w, h].every(Number.isFinite)) throw new Error("Invalid render bounds");
  const scale = Math.min(2, 2400 / w, 2000 / h);
  const width = Math.max(1, Math.ceil(w * scale)), height = Math.max(1, Math.ceil(h * scale));
  svg.setAttribute("viewBox", `${box.x - 40} ${box.y - 40} ${w} ${h}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const image = new Image();
  const url = URL.createObjectURL(new Blob([await embedFonts(new XMLSerializer().serializeToString(svg))], { type: "image/svg+xml" }));
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Diagram image could not be rendered"));
    image.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0);
  URL.revokeObjectURL(url);
  document.getElementById("capture-result")!.textContent = JSON.stringify({
    png_base64: canvas.toDataURL("image/png").split(",")[1], width, height,
    scale, renderer: "editor-react", visual_validation: "pending_image_inspection",
    edge_routes: edgeRoutes,
  });
}

/** The ROUTED path of every edge (A* route or waypoints, exactly as EdgeView drew it), sampled every
 * ~6px in diagram-content coordinates, so MCP lint can tell when a line runs through a shape
 * or a label. Capped per edge to keep the payload small. */
function sampleEdgeRoutes(layer: SVGGElement): Record<string, number[][]> {
  const toLayer = layer.getCTM()?.inverse();
  const routes: Record<string, number[][]> = {};
  layer.querySelectorAll<SVGPathElement>('path[id^="edge-vis-"]').forEach((path) => {
    const m = toLayer && path.getCTM() ? toLayer.multiply(path.getCTM()!) : null;
    const len = path.getTotalLength();
    if (!m || !Number.isFinite(len) || len <= 0) return;
    const steps = Math.min(400, Math.max(2, Math.ceil(len / 6)));
    const pts: number[][] = [];
    for (let i = 0; i <= steps; i++) {
      const p = path.getPointAtLength((len * i) / steps).matrixTransform(m);
      pts.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    }
    routes[path.id.slice("edge-vis-".length)] = pts;
  });
  return routes;
}

capture().catch(() => {
  document.getElementById("capture-result")!.textContent = JSON.stringify({ error: "Diagram capture failed" });
});
