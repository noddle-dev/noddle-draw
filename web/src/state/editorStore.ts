/**
 * state/editorStore — the single source of truth (Zustand).
 *
 * Holds the editor's non-DOM state (docId, camera, tool, selection refs, dirty,
 * status, history flags) and exposes actions that drive editor-core against the
 * live DOM. Cross-feature communication goes through this store ONLY — no
 * feature imports another feature. React components subscribe with selectors so
 * high-frequency drag updates don't re-render the whole tree (ADR rationale).
 *
 * DOM ownership: the actual editable SVG lives in real DOM (the <g id="content">
 * inside Canvas). The store keeps *refs* to those nodes plus derived state. The
 * engine (editor-core) is passed those refs; the store never reaches for
 * document.getElementById.
 */
import { create } from "zustand";
import {
  History,
  cameraTransform,
  currentSvgString,
  fit,
  loadInto,
  parseSvg,
  recenterAfterZoom,
  screenToContent,
  clampZoom,
  type Artboard,
  type Camera,
  type SceneObject,
  type StageRefs,
  type Tool,
} from "../editor-core";
import { FLOW_INTENSITY, type FlowIntensity } from "../editor-core/diagram";
import type { DiagramEdge, DiagramNode, NodeKind, PenBrush, Vec } from "../editor-core/diagram";
import { api, ApiError, type DocMeta } from "../shared/api/client";
import { scrubSvgString } from "../shared/svgScrub";
import {
  clearLastBoardId,
  forgetBoard,
  lastBoardId,
  recentBoards,
  rememberBoard,
  useAppStore,
} from "./appStore";
import { getIdentity } from "./collabStore";
import { useDiagramStore } from "./diagramStore";
import { onPageSwitch, usePagesStore } from "./pagesStore";
import { resetHistory, useDiagramHistory } from "./diagramHistory";

/** The default pen: Excalidraw-like ink — pressure thinning + tapered ends. */
export const DEFAULT_BRUSH: PenBrush = { type: "pen", thinning: 0.5, smoothing: 0.4, taper: true, softness: 0 };

/**
 * What a DRAWN shape wears before the user touches the style panel — the
 * panel shows these same values, so what you see is what you draw
 * (Excalidraw). Merged UNDER the palette entry's init, so stickies/notes keep
 * their own fill; `drawStyle` (the user's picks) wins over both.
 */
export const DRAW_STYLE_DEFAULTS: Partial<DiagramNode> = {
  // House style (shared with the commercial edition): hand-drawn, rounded,
  // big bold label.
  stroke: "#2d3142",
  fill: "transparent",
  strokeWidth: 2,
  sketch: true,
  cornerRadius: 12,
  fontSize: 28,
  bold: true,
};

export type StatusKind = "" | "ok" | "error";

// --- per-PAGE camera persistence (zoom/pan restored across reloads) ---
// Key is (board, page): every page keeps its own view. The old per-board key
// remains as a read fallback so pre-existing saved views still restore once.
const CAM_KEY = (docId: string, pageId?: string | null) =>
  pageId ? `noddle:cam:${docId}:${pageId}` : `noddle:cam:${docId}`;
let _camSaveTimer: ReturnType<typeof setTimeout> | null = null;

function writeCam(docId: string, pageId: string | null, cam: Camera): void {
  try {
    localStorage.setItem(
      CAM_KEY(docId, pageId),
      JSON.stringify({ x: cam.x, y: cam.y, z: cam.z }),
    );
  } catch { /* private mode / quota — best-effort */ }
}

function persistCam(docId: string, pageId: string | null, cam: Camera): void {
  if (_camSaveTimer) clearTimeout(_camSaveTimer);
  _camSaveTimer = setTimeout(() => writeCam(docId, pageId, cam), 400);
}

function loadCam(docId: string, pageId?: string | null): Camera | null {
  try {
    const raw =
      localStorage.getItem(CAM_KEY(docId, pageId)) ??
      localStorage.getItem(CAM_KEY(docId)); // legacy per-board fallback
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (typeof c?.x === "number" && typeof c?.y === "number" && typeof c?.z === "number") {
      return { x: c.x, y: c.y, z: c.z };
    }
  } catch { /* ignore corrupt value */ }
  return null;
}

interface EditorState {
  // ---- refs to the live DOM (set once by Canvas on mount) ----
  refs: StageRefs | null;
  cameraEl: SVGGElement | null;

  // ---- document / persistence ----
  docId: string | null;
  docName: string;
  /** This browser's recent boards (localStorage — there is no server list). */
  docs: DocMeta[];
  dirty: boolean;
  /** Caller's effective role on the open board (server-derived). */
  myRole: "editor" | "viewer";
  /** A /d/{id} deep link that 404'd/403'd — show the not-found screen. */
  notFound: boolean;

  // ---- viewport ----
  cam: Camera;
  artboard: Artboard;

  // ---- interaction ----
  tool: Tool;
  selection: SceneObject[];

  // ---- ui ----
  status: string;
  statusKind: StatusKind;
  /** Version counter bumped whenever #content mutates, so panels re-derive. */
  contentRev: number;
  canUndo: boolean;
  canRedo: boolean;

  // ---- history (engine instance; not reactive itself) ----
  history: History;

  // ---- actions ----
  attach: (refs: StageRefs, cameraEl: SVGGElement) => void;
  setStatus: (msg: string, kind?: StatusKind) => void;
  setTool: (tool: Tool) => void;
  /** Shape the "draw" tool creates (Excalidraw-style: arm a shape, then drag
   * A→B on the canvas for that size — a plain click draws nothing). */
  drawSpec: { kind: NodeKind; init?: Partial<DiagramNode> } | null;
  armDrawTool: (spec: { kind: NodeKind; init?: Partial<DiagramNode> }) => void;
  /** Style the draw tool stamps on every new shape (stroke/fill/width/dash/
   * sketch/corner/opacity). Persisted per browser; merged over the palette
   * entry's own init. */
  drawStyle: Partial<DiagramNode>;
  setDrawStyle: (patch: Partial<DiagramNode>) => void;
  /** Excalidraw tool lock (Q): off ⇒ a finished draw or arrow drops back
   * to Select; on ⇒ the tool stays armed. Per session. */
  toolLocked: boolean;
  setToolLocked: (locked: boolean) => void;
  /** Called after a draw/arrow gesture COMMITS — honors the tool lock. */
  finishToolUse: () => void;
  /** Transient magnet feedback while a free canvas arrow is dragged: the
   * shape its head will bind to (+ the exact port when snapped to a dot). */
  bindHint: { nodeId: string; rel?: Vec } | null;
  setBindHint: (hint: { nodeId: string; rel?: Vec } | null) => void;
  /** Pen tool style (its own — a pen width must not change shape borders).
   * Persisted per browser. */
  penStyle: { stroke: string; strokeWidth: number; opacity?: number; brush: PenBrush };
  setPenStyle: (patch: Partial<{ stroke: string; strokeWidth: number; opacity?: number; brush: PenBrush }>) => void;
  /** Eraser sweep: objects marked for deletion (faded until pointer up). */
  eraseMarked: string[];
  setEraseMarked: (ids: string[]) => void;
  /** Smart alignment guides shown while dragging shapes (content coords). */
  alignGuides: { x: number[]; y: number[] };
  setAlignGuides: (g: { x: number[]; y: number[] }) => void;
  /** Style every NEW connector is born with — remembered from the last time
   * the user styled one (quick panel), persisted per browser. */
  edgeStyle: Partial<DiagramEdge>;
  setEdgeStyle: (patch: Partial<DiagramEdge>) => void;

  applyCamera: () => void;
  setCam: (cam: Camera) => void;
  fitToView: () => void;
  zoomBy: (factor: number, anchorClientX?: number, anchorClientY?: number) => void;

  loadSvgString: (svg: string) => void;
  setSelection: (els: SceneObject[]) => void;
  bumpContent: () => void;

  beginAction: () => void;
  commitAction: () => void;
  undo: () => void;
  redo: () => void;

  currentSvg: () => string;
  /** Serialise the FULL board (uploaded content + diagram layer) to SVG. */
  /** Serialize the board to SVG. ``scope`` frames the viewBox:
   *  "page" (default) = the full artboard; "fit" = cropped to the content
   *  bounding box + margin (draw.io "fit to content"); "selection" = cropped
   *  to the current diagram selection (falls back to "fit" when nothing is
   *  selected). */
  currentBoardSvg: (opts?: { scope?: "page" | "fit" | "selection" }) => string;
  /** Grow the white page so it always contains every diagram node (+margin).
   * Never shrinks — the artboard only expands as content spreads out. */
  ensureArtboardFits: () => void;

  // document ops
  /** Refresh the recents list from localStorage (no server call). */
  refreshDocs: () => Promise<void>;
  openDoc: (id: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  /** Persist the board. `quiet` = autosave: no "Saving…" flash, light status. */
  save: (opts?: { quiet?: boolean }) => Promise<void>;

  // object ops (toolbar)
  deleteSelection: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
}

const initialCam: Camera = { x: 0, y: 0, z: 1 };

/** Content bounding box (content coords) for an export scope, or null when it
 * can't be measured. "selection" unions the bbox of the selected node/edge
 * DOM groups; "fit" uses the whole diagram layer. Falls back gracefully. */
function bboxForScope(
  layerEl: Element | null | undefined,
  scope: "fit" | "selection",
  selection: string[],
): { x: number; y: number; w: number; h: number } | null {
  if (!layerEl) return null;
  const union = (els: Element[]): DOMRect | null => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of els) {
      const b = (el as SVGGraphicsElement).getBBox?.();
      if (!b || (b.width === 0 && b.height === 0)) continue;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    }
    if (!isFinite(x0)) return null;
    return new DOMRect(x0, y0, x1 - x0, y1 - y0);
  };
  let box: DOMRect | null = null;
  if (scope === "selection" && selection.length) {
    const sel = selection
      .map(
        (id) =>
          layerEl.querySelector(`[data-diagram-node="${CSS.escape(id)}"]`) ??
          layerEl.querySelector(`[data-diagram-edge="${CSS.escape(id)}"]`),
      )
      .filter((e): e is Element => !!e);
    box = union(sel);
  }
  if (!box) box = (layerEl as SVGGraphicsElement).getBBox?.() ?? null;
  if (!box || (box.width === 0 && box.height === 0)) return null;
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  refs: null,
  cameraEl: null,

  docId: null,
  docName: "",
  docs: [],
  dirty: false,
  // Fail-safe: assume view-only until the server says otherwise (GET /documents/{id}
  // always returns my_role for accessible boards — "editor" whenever edit passes).
  myRole: "viewer",
  notFound: false,

  cam: { ...initialCam },
  artboard: { w: 100, h: 100 },

  tool: "select",
  selection: [],

  status: "Ready. Upload an SVG to get started.",
  statusKind: "",
  contentRev: 0,
  canUndo: false,
  canRedo: false,

  history: new History(),

  attach(refs, cameraEl) {
    set({ refs, cameraEl });
    get().applyCamera();
  },

  setStatus(msg, kind = "") {
    set({ status: msg, statusKind: kind });
  },

  setTool(tool) {
    set({ tool });
  },

  drawSpec: null,
  armDrawTool(spec) {
    set({ tool: "draw", drawSpec: spec });
  },

  toolLocked: false,
  setToolLocked(locked) {
    set({ toolLocked: locked });
  },
  finishToolUse() {
    const { tool, toolLocked } = get();
    // pen + eraser stay armed (Excalidraw) — you scribble / sweep repeatedly
    if (!toolLocked && (tool === "draw" || tool === "arrow" || tool === "text")) set({ tool: "select" });
  },
  bindHint: null,
  setBindHint(hint) {
    const cur = get().bindHint;
    // pointermove fires constantly — only re-render when the target changes
    if (cur?.nodeId === hint?.nodeId && cur?.rel?.x === hint?.rel?.x && cur?.rel?.y === hint?.rel?.y) return;
    set({ bindHint: hint });
  },
  penStyle: (() => {
    try {
      return { stroke: "#2d3142", strokeWidth: 2, brush: { ...DEFAULT_BRUSH }, ...JSON.parse(localStorage.getItem("noddle-pen-style") ?? "{}") };
    } catch {
      return { stroke: "#2d3142", strokeWidth: 2, brush: { ...DEFAULT_BRUSH } };
    }
  })(),
  setPenStyle(patch) {
    const next = { ...get().penStyle, ...patch };
    if (next.opacity === undefined || next.opacity >= 1) delete next.opacity;
    try {
      localStorage.setItem("noddle-pen-style", JSON.stringify(next));
    } catch {
      /* private mode */
    }
    set({ penStyle: next });
  },
  alignGuides: { x: [], y: [] },
  setAlignGuides(g) {
    const cur = get().alignGuides;
    if (cur.x.join() === g.x.join() && cur.y.join() === g.y.join()) return; // no re-render churn
    set({ alignGuides: g });
  },
  eraseMarked: [],
  setEraseMarked(ids) {
    set({ eraseMarked: ids });
  },
  edgeStyle: (() => {
    try {
      return JSON.parse(localStorage.getItem("noddle-edge-style") ?? "{}");
    } catch {
      return {};
    }
  })(),
  setEdgeStyle(patch) {
    // Only STYLE fields are remembered — endpoints/labels/z are per-edge intent.
    const KEEP = new Set([
      "stroke", "strokeWidth", "dash", "routing",
      "endHead", "endArrow", "startHead", "startArrow",
    ]);
    const next: Partial<DiagramEdge> = { ...get().edgeStyle };
    for (const [k, v] of Object.entries(patch)) {
      if (!KEEP.has(k)) continue;
      if (v === undefined) delete (next as Record<string, unknown>)[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    try {
      localStorage.setItem("noddle-edge-style", JSON.stringify(next));
    } catch {
      /* private mode */
    }
    set({ edgeStyle: next });
  },

  drawStyle: (() => {
    try {
      return JSON.parse(localStorage.getItem("noddle-draw-style") ?? "{}");
    } catch {
      return {};
    }
  })(),
  setDrawStyle(patch) {
    // undefined values REMOVE the key (e.g. back to solid stroke / opaque).
    const next: Partial<DiagramNode> = { ...get().drawStyle };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (next as Record<string, unknown>)[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    try {
      localStorage.setItem("noddle-draw-style", JSON.stringify(next));
    } catch {
      /* private mode */
    }
    set({ drawStyle: next });
  },

  applyCamera() {
    const { cameraEl, cam, docId } = get();
    if (cameraEl) cameraEl.setAttribute("transform", cameraTransform(cam));
    // Remember this PAGE's zoom/pan so a reload restores the same view.
    if (docId) persistCam(docId, usePagesStore.getState().activeId, cam);
  },

  setCam(cam) {
    set({ cam });
    get().applyCamera();
  },

  fitToView() {
    const { refs, artboard } = get();
    if (!refs) return;
    const cam = fit(refs.host, artboard);
    // Lucid-style: never OPEN zoomed-in past 100% — a tiny artboard blown up to
    // 800% makes pointer deltas feel dead (snap eats them) and text huge. The
    // user can still zoom in manually up to MAX_ZOOM.
    if (cam.z > 1) {
      const r = refs.host.getBoundingClientRect();
      cam.z = 1;
      cam.x = (r.width - artboard.w) / 2 - (artboard.ox ?? 0);
      cam.y = (r.height - artboard.h) / 2 - (artboard.oy ?? 0);
    }
    set({ cam });
    get().applyCamera();
  },

  zoomBy(factor, anchorClientX, anchorClientY) {
    const { refs, cam } = get();
    if (!refs) return;
    const r = refs.host.getBoundingClientRect();
    const ax = anchorClientX ?? r.left + r.width / 2;
    const ay = anchorClientY ?? r.top + r.height / 2;
    // Two-phase anchored zoom (mirrors editor.js): capture the content point
    // under the anchor, apply the new zoom, then nudge translate to keep it fixed.
    const before = screenToContent(refs.content, ax, ay);
    const zoomed: Camera = { ...cam, z: clampZoom(cam.z * factor) };
    set({ cam: zoomed });
    get().applyCamera();
    const recentred = recenterAfterZoom(refs.content, get().cam, before, ax, ay);
    set({ cam: recentred });
    get().applyCamera();
  },

  loadSvgString(svg) {
    const { refs, history } = get();
    if (!refs) return;
    let artboard: Artboard;
    try {
      artboard = loadInto(refs.content, parseSvg(svg));
    } catch (err) {
      set({
        status: err instanceof Error ? err.message : "File is not a valid SVG.",
        statusKind: "error",
      });
      return;
    }
    history.reset();
    set({
      artboard,
      selection: [],
      dirty: true,
      canUndo: false,
      canRedo: false,
    });
    get().bumpContent();
    get().fitToView();
    set({
      status: `Loaded SVG · artboard ${Math.round(artboard.w)}×${Math.round(artboard.h)}.`,
      statusKind: "ok",
    });
  },

  setSelection(els) {
    set({ selection: els.filter(Boolean) });
  },

  bumpContent() {
    set((s) => ({ contentRev: s.contentRev + 1 }));
  },

  beginAction() {
    const { refs, history } = get();
    if (refs) history.begin(refs.content.innerHTML);
  },

  commitAction() {
    const { refs, history } = get();
    if (!refs) return;
    const changed = history.commit(refs.content.innerHTML);
    if (changed) set({ dirty: true });
    set({ canUndo: history.canUndo, canRedo: history.canRedo });
    if (changed) get().bumpContent();
  },

  undo() {
    // Diagram boards: undo the node/edge layer (Cmd/Ctrl+Z). Fall through to
    // the SVG-content history for uploaded-SVG docs.
    if (useDiagramStore.getState().diagramMode && useDiagramHistory.getState().canUndo) {
      useDiagramHistory.getState().undo();
      return;
    }
    const { refs, history } = get();
    if (!refs) return;
    const html = history.undo(refs.content.innerHTML);
    if (html == null) return;
    refs.content.innerHTML = html;
    set({
      selection: [],
      dirty: true,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
    get().bumpContent();
  },

  redo() {
    if (useDiagramStore.getState().diagramMode && useDiagramHistory.getState().canRedo) {
      useDiagramHistory.getState().redo();
      return;
    }
    const { refs, history } = get();
    if (!refs) return;
    const html = history.redo(refs.content.innerHTML);
    if (html == null) return;
    refs.content.innerHTML = html;
    set({
      selection: [],
      dirty: true,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
    });
    get().bumpContent();
  },

  currentSvg() {
    const { refs, artboard } = get();
    if (!refs) return "";
    return currentSvgString(refs.content, artboard);
  },

  ensureArtboardFits() {
    const nodes = Object.values(useDiagramStore.getState().nodes);
    if (!nodes.length) return;
    const PAD = 240; // breathing room past the furthest shape
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    const { artboard } = get();
    const curOx = artboard.ox ?? 0, curOy = artboard.oy ?? 0;
    // Grow-only in all four directions: origin can only move up/left (≤ 0 by
    // default), the far edge can only move down/right. Never shrinks, so the
    // page is stable once it has expanded to cover the spread of shapes.
    const ox = Math.min(curOx, Math.floor(minX - PAD), 0);
    const oy = Math.min(curOy, Math.floor(minY - PAD), 0);
    const right = Math.max(curOx + artboard.w, Math.ceil(maxX + PAD));
    const bottom = Math.max(curOy + artboard.h, Math.ceil(maxY + PAD));
    const w = right - ox, h = bottom - oy;
    if (ox !== curOx || oy !== curOy || w !== artboard.w || h !== artboard.h) {
      set({ artboard: { ox, oy, w, h } });
    }
  },

  currentBoardSvg(opts) {
    const { refs, artboard } = get();
    if (!refs) return "";
    const { w, h } = artboard;
    // Content WITHOUT any previously-baked diagram render (see below) — else
    // every save would accumulate another flattened copy.
    const contentClone = refs.content.cloneNode(true) as SVGGElement;
    contentClone.querySelector("#noddle-diagram-baked")?.remove();
    // The diagram layer is live SVG DOM rendered by React inside the same
    // camera group — clone it, strip editor-only chrome (ports, halos,
    // selection boxes, previews), and mark it as the BAKED render so openDoc
    // can drop it when the editable diagram JSON is restored on top.
    let diagramHtml = "";
    const parent = refs.content.parentNode as Element | null;
    const layer = parent?.querySelector("#diagram-layer");
    if (layer) {
      const clone = layer.cloneNode(true) as Element;
      clone.setAttribute("id", "noddle-diagram-baked");
      clone.querySelectorAll("[data-editor-only]").forEach((el) => el.remove());
      // Flow-style dash patterns live in CSS — CSS never travels with
      // serialized markup, so bake them inline for export/preview parity,
      // honoring each edge's intensity (from the data attr EdgeView emits).
      // (Dots use SMIL <animateMotion>, which serializes by itself and even
      // ANIMATES when the exported SVG is opened in a browser. Node idle
      // animations — pulse/glow/breathe/wobble — are identity at rest, so a
      // static export needs no baking for them.)
      const intensityOf = (el: Element): FlowIntensity => {
        const v = el.closest("[data-flow]")?.getAttribute("data-flow-intensity");
        return v === "subtle" || v === "strong" ? v : "normal";
      };
      clone.querySelectorAll(".edge-animated").forEach((el) => {
        el.setAttribute("stroke-dasharray", FLOW_INTENSITY[intensityOf(el)].dashArray);
      });
      clone.querySelectorAll(".edge-beam").forEach((el) => {
        el.setAttribute("stroke-dasharray", FLOW_INTENSITY[intensityOf(el)].beamArray);
      });
      // XML serialization, NOT outerHTML: the HTML fragment serializer emits
      // HTML-only named entities — a label containing U+00A0 (an empty label
      // renders one) becomes &nbsp;, which is undefined in XML, and the
      // backend parses the save strictly ("Not a valid SVG: undefined entity").
      diagramHtml = new XMLSerializer().serializeToString(clone);
    }
    // viewBox framing. "page" = the full white artboard (default, and always
    // used for save so the stored board keeps its canvas). "fit"/"selection"
    // crop to a content/selection bounding box measured from the LIVE diagram
    // layer via getBBox (content coords), so exports match draw.io's
    // "fit to content" / "selection only".
    let vx = artboard.ox ?? 0, vy = artboard.oy ?? 0, vw = w, vh = h;
    const scope = opts?.scope ?? "page";
    if (scope !== "page") {
      const layerEl = (refs.content.parentNode as Element | null)?.querySelector(
        "#diagram-layer",
      );
      const box = bboxForScope(layerEl, scope, useDiagramStore.getState().diagramSelection);
      if (box) {
        const m = 24; // breathing margin around the framed content
        vx = box.x - m;
        vy = box.y - m;
        vw = box.w + m * 2;
        vh = box.h + m * 2;
      }
    }
    // xmlns:xlink unconditionally — content may carry xlink:href (uploaded
    // SVGs); without it the save is rejected as not-well-formed XML.
    // Children serialized as XML for the same &nbsp; reason as diagramHtml.
    const xml = new XMLSerializer();
    const contentXml = Array.from(contentClone.childNodes)
      .map((n) => xml.serializeToString(n))
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vx} ${vy} ${vw} ${vh}" width="${Math.round(vw)}" height="${Math.round(vh)}">${contentXml}${diagramHtml}</svg>`;
  },

  async refreshDocs() {
    // Anonymous product: there is no server-side listing (link access ≠
    // discovery) — "your boards" are the ones this browser remembers.
    set({
      docs: recentBoards().map((r) => ({
        id: r.id,
        name: r.name,
        created_at: r.at / 1000,
        updated_at: r.at / 1000,
      })),
    });
  },

  async openDoc(id) {
    try {
      const { svg, meta, diagram, my_role } = await api.get(id);
      set({
        docId: id,
        docName: meta?.name ? "· " + meta.name : "",
        myRole: my_role ?? "viewer", // fail-safe: no role from server ⇒ view-only
        notFound: false,
      });
      // Remember what this browser is working on — drives "/" and the Boards
      // menu. Embeds are passive views, never "your" board.
      if (!useAppStore.getState().embedMode) {
        rememberBoard(id, meta?.name || "Untitled board");
      }
      get().loadSvgString(svg);
      // Restore the editable board through the PAGES store: a board's diagram
      // payload is `{pages:[…]}` (or legacy `{nodes,edges}` → 1 page). The
      // active page's nodes/edges land in diagramStore. An svg-only upload has
      // no diagram → no pages.
      const payload = diagram as unknown as
        | { pages?: unknown[]; nodes?: unknown[]; edges?: unknown[] }
        | null;
      const hasDiagram =
        !!payload && (Array.isArray(payload.pages) || Array.isArray(payload.nodes));
      if (hasDiagram) {
        // Drop the baked (flattened) render from the SVG — the live editable
        // diagram replaces it; keeping both doubles every shape.
        get().refs?.content.querySelector("#noddle-diagram-baked")?.remove();
        get().bumpContent();
        usePagesStore.getState().loadFromPayload(payload, id);
      } else {
        usePagesStore.getState().reset();
        useDiagramStore.getState().clearDiagram();
      }
      resetHistory(); // fresh undo stack per opened document
      set({ dirty: false });
      // Restore the last zoom/pan for the RESTORED PAGE (loadSvgString just
      // did a fitToView); a saved view overrides it so a reload lands where
      // you left — page included.
      const savedCam = loadCam(id, usePagesStore.getState().activeId);
      if (savedCam) get().setCam(savedCam);
      await get().refreshDocs();
    } catch (err) {
      const gone =
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403 || err.status === 404);
      if (gone) {
        forgetBoard(id);
        if (id === lastBoardId() || !lastBoardId()) {
          // OUR remembered board is stale (deleted server-side / wiped
          // storage) — silently start a fresh one instead of a dead end.
          clearLastBoardId();
          try {
            const meta = await api.create({ name: "Untitled board" });
            rememberBoard(meta.id, meta.name);
            useAppStore.getState().openInEditor(meta.id, { replace: true });
            return;
          } catch {
            /* backend down — fall through to the error status */
          }
        } else {
          // Someone ELSE's link that doesn't resolve — say so.
          set({ notFound: true, docId: null, docName: "" });
          return;
        }
      }
      set({
        status: "Failed to open document: " + (err instanceof Error ? err.message : String(err)),
        statusKind: "error",
      });
    }
  },

  async uploadFile(file) {
    set({ status: "Uploading & sanitizing…", statusKind: "" });
    try {
      const meta = await api.upload(file);
      await get().refreshDocs();
      await get().openDoc(meta.id);
      set({ status: `Uploaded "${meta.name}".`, statusKind: "ok" });
    } catch (err) {
      // offline fallback: load locally without backend (mirrors editor.js).
      // The server sanitizer is unreachable here, so scrub client-side before
      // touching the DOM — a raw local .svg must never run script in our origin.
      try {
        const text = await file.text();
        const safe = /\.svg$/i.test(file.name) ? scrubSvgString(text) : text;
        if (!safe) throw new Error("File couldn't be safely parsed.");
        get().loadSvgString(safe);
        set({
          status: "Backend didn't respond — opened the file locally (not saved).",
          statusKind: "",
        });
      } catch {
        set({
          status: "Upload failed: " + (err instanceof Error ? err.message : String(err)),
          statusKind: "error",
        });
      }
    }
  },

  async save(opts) {
    const { docId, myRole } = get();
    if (!docId) return;
    if (myRole === "viewer") return; // watch-only — the server rejects anyway
    const quiet = opts?.quiet ?? false;
    if (!quiet) set({ status: "Saving…", statusKind: "" });
    try {
      const ds = useDiagramStore.getState();
      const pagesState = usePagesStore.getState();
      // Board docs persist BOTH the flattened SVG (preview/export) and the
      // editable diagram JSON. Multi-page boards save `{pages:[…]}`; a board
      // that never touched the pages store falls back to the single-diagram
      // shape; a board with no shapes at all clears the sidecar.
      const nodeCount = Object.keys(ds.nodes).length;
      let diagram: unknown = null;
      if (pagesState.pages.length) {
        diagram = pagesState.collect(); // {pages:[…]} — snapshots the active page
      } else if (nodeCount) {
        diagram = { nodes: Object.values(ds.nodes), edges: Object.values(ds.edges) };
      }
      await api.save(docId, get().currentBoardSvg(), diagram as never, getIdentity().name);
      const when = new Date().toLocaleTimeString();
      set({
        dirty: false,
        status: quiet ? `Autosaved · ${when}` : "Saved.",
        statusKind: "ok",
      });
      if (!quiet) await get().refreshDocs();
    } catch (err) {
      set({
        status: "Save failed: " + (err instanceof Error ? err.message : String(err)),
        statusKind: "error",
      });
    }
  },

  deleteSelection() {
    const { selection } = get();
    if (!selection.length) return;
    get().beginAction();
    selection.forEach((el) => el.remove());
    set({ selection: [] });
    get().commitAction();
  },

  bringToFront() {
    const { refs, selection } = get();
    if (!refs || !selection.length) return;
    get().beginAction();
    selection.forEach((el) => refs.content.appendChild(el));
    get().commitAction();
  },

  sendToBack() {
    const { refs, selection } = get();
    if (!refs || !selection.length) return;
    get().beginAction();
    selection
      .slice()
      .reverse()
      .forEach((el) => refs.content.prepend(el));
    get().commitAction();
  },
}));

// Per-page camera: when the active page changes, remember the old page's view
// and restore the new page's (registered here — pagesStore must not import
// this module; see onPageSwitch). No saved view for the new page ⇒ keep the
// current camera (better than a jarring re-fit).
onPageSwitch((oldPageId: string | null, newPageId: string) => {
  const st = useEditorStore.getState();
  if (!st.docId) return;
  if (oldPageId) writeCam(st.docId, oldPageId, st.cam);
  const saved = loadCam(st.docId, newPageId);
  if (saved) st.setCam(saved);
});
