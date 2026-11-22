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
    nodes: DiagramNode[];
    edges: DiagramEdge[];
    node_ids?: string[];
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
  const layer = svg.querySelector("#diagram-layer") as SVGGElement;
  const edgeRoutes = sampleEdgeRoutes(layer);
  const { textMetrics, edgeLabelMetrics } = measureRenderedText(layer);
  // Bounds include actual text and routed edges; when node_ids are supplied, crop
  // tightly around those nodes (and edges between them) for crisp 2x readability.
  const box = targetBounds(layer, payload.nodes, payload.edges, payload.node_ids);
  const pad = payload.node_ids?.length ? 48 : 40;
  const w = Math.max(1, box.width + pad * 2), h = Math.max(1, box.height + pad * 2);
  if (![box.x, box.y, w, h].every(Number.isFinite)) throw new Error("Invalid render bounds");
  const scale = Math.min(2, 2400 / w, 2000 / h);
  const width = Math.max(1, Math.ceil(w * scale)), height = Math.max(1, Math.ceil(h * scale));
  svg.setAttribute("viewBox", `${box.x - pad} ${box.y - pad} ${w} ${h}`);
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
    cropped: Boolean(payload.node_ids?.length),
    edge_routes: edgeRoutes,
    text_metrics: textMetrics,
    edge_label_metrics: edgeLabelMetrics,
  });
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function transformBBox(el: SVGGraphicsElement, toLayer: DOMMatrix | null): { x: number; y: number; w: number; h: number } | null {
  let b: DOMRect;
  try {
    b = el.getBBox();
  } catch {
    return null;
  }
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || (b.width <= 0 && b.height <= 0)) return null;
  const ctm = toLayer && el.getCTM() ? toLayer.multiply(el.getCTM()!) : null;
  if (!ctm) return { x: round1(b.x), y: round1(b.y), w: round1(b.width), h: round1(b.height) };
  const corners = [
    new DOMPoint(b.x, b.y).matrixTransform(ctm),
    new DOMPoint(b.x + b.width, b.y).matrixTransform(ctm),
    new DOMPoint(b.x, b.y + b.height).matrixTransform(ctm),
    new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(ctm),
  ];
  const minX = Math.min(...corners.map((p) => p.x));
  const minY = Math.min(...corners.map((p) => p.y));
  const maxX = Math.max(...corners.map((p) => p.x));
  const maxY = Math.max(...corners.map((p) => p.y));
  return { x: round1(minX), y: round1(minY), w: round1(maxX - minX), h: round1(maxY - minY) };
}

/** Real browser-measured <text> bounding boxes in diagram-content coords, so MCP lint
 * checks pixel-accurate text overflow and text-on-text collisions instead of guessing. */
function measureRenderedText(layer: SVGGElement): {
  textMetrics: Record<string, { x: number; y: number; w: number; h: number }>;
  edgeLabelMetrics: Record<string, Array<{ x: number; y: number; w: number; h: number; text: string }>>;
} {
  const toLayer = layer.getCTM()?.inverse() ?? null;
  const textMetrics: Record<string, { x: number; y: number; w: number; h: number }> = {};
  layer.querySelectorAll<SVGGElement>("g[data-diagram-node]").forEach((g) => {
    const id = g.getAttribute("data-diagram-node");
    const textEl = g.querySelector("text");
    if (!id || !textEl || !(textEl.textContent || "").trim()) return;
    const box = transformBBox(textEl, toLayer);
    if (box) textMetrics[id] = box;
  });
  const edgeLabelMetrics: Record<string, Array<{ x: number; y: number; w: number; h: number; text: string }>> = {};
  layer.querySelectorAll<SVGGElement>("g[data-diagram-edge]").forEach((g) => {
    const id = g.getAttribute("data-diagram-edge");
    if (!id) return;
    const items: Array<{ x: number; y: number; w: number; h: number; text: string }> = [];
    g.querySelectorAll("text").forEach((textEl) => {
      const text = (textEl.textContent || "").trim();
      if (!text) return;
      const box = transformBBox(textEl, toLayer);
      if (box) items.push({ ...box, text });
    });
    if (items.length) edgeLabelMetrics[id] = items;
  });
  return { textMetrics, edgeLabelMetrics };
}

function targetBounds(
  layer: SVGGElement,
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  nodeIds?: string[],
): { x: number; y: number; width: number; height: number } {
  if (!nodeIds || nodeIds.length === 0) return layer.getBBox();
  const wanted = new Set(nodeIds);
  const toLayer = layer.getCTM()?.inverse() ?? null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (b: { x: number; y: number; w: number; h: number } | null) => {
    if (!b) return;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  };
  layer.querySelectorAll<SVGGElement>("g[data-diagram-node]").forEach((g) => {
    const id = g.getAttribute("data-diagram-node");
    if (id && wanted.has(id)) include(transformBBox(g, toLayer));
  });
  const includedEdges = new Set(
    edges
      .filter((e) => {
        const s = "nodeId" in e.source ? e.source.nodeId : null;
        const t = "nodeId" in e.target ? e.target.nodeId : null;
        return (s && wanted.has(s)) && (t && wanted.has(t));
      })
      .map((e) => e.id),
  );
  layer.querySelectorAll<SVGGElement>("g[data-diagram-edge]").forEach((g) => {
    const id = g.getAttribute("data-diagram-edge");
    if (id && includedEdges.has(id)) include(transformBBox(g, toLayer));
  });
  if (!Number.isFinite(minX)) {
    const matched = nodes.filter((n) => wanted.has(n.id));
    if (matched.length) {
      minX = Math.min(...matched.map((n) => n.x));
      minY = Math.min(...matched.map((n) => n.y));
      maxX = Math.max(...matched.map((n) => n.x + n.w));
      maxY = Math.max(...matched.map((n) => n.y + n.h));
    } else {
      return layer.getBBox();
    }
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
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
