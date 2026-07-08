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
import { api, ApiError, type DocMeta, type PublicUser } from "../shared/api/client";
import { useAppStore } from "./appStore";
import { useAuthStore } from "./authStore";
import { useDiagramStore } from "./diagramStore";
import { onPageSwitch, usePagesStore } from "./pagesStore";
import { resetHistory, useDiagramHistory } from "./diagramHistory";

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
  docs: DocMeta[];
  dirty: boolean;
  /** Caller's effective role on the open board (server-derived). */
  myRole: "owner" | "editor" | "viewer";
  /** The open board's owner (public profile) — powers the "Owned by …" chip. */
  docOwner: PublicUser | null;

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
  currentBoardSvg: (opts?: { watermark?: boolean }) => string;
  /** Grow the white page so it always contains every diagram node (+margin).
   * Never shrinks — the artboard only expands as content spreads out. */
  ensureArtboardFits: () => void;

  // document ops (documents feature calls these)
  refreshDocs: () => Promise<void>;
  openDoc: (id: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  /** Persist the board. `quiet` = autosave: no "Saving…" flash, light status. */
  save: (opts?: { quiet?: boolean }) => Promise<void>;
  deleteDoc: (id: string) => Promise<void>;

  // object ops (toolbar)
  deleteSelection: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
}

const initialCam: Camera = { x: 0, y: 0, z: 1 };

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
  docOwner: null,

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
      diagramHtml = clone.outerHTML;
    }
    // Free-tier export watermark: a small Noddle mark bottom-right (paid tiers
    // pass watermark:false). NOT added on save() — it's export-only, so the
    // stored/round-tripped board never carries it.
    let mark = "";
    if (opts?.watermark) {
      const s = Math.max(18, Math.min(w, h) * 0.03); // tile side, scales gently
      const mx = w - s - s * 0.7;
      const my = h - s - s * 0.7;
      const label = s * 0.9;
      mark =
        `<g opacity="0.55" font-family="Inter, system-ui, sans-serif">` +
        `<rect x="${mx}" y="${my}" width="${s}" height="${s}" rx="${s * 0.28}" fill="#211e19"/>` +
        `<rect x="${mx + s * 0.32}" y="${my + s * 0.32}" width="${s * 0.36}" height="${s * 0.36}" ` +
        `transform="rotate(45 ${mx + s / 2} ${my + s / 2})" fill="none" stroke="#fff" stroke-width="${s * 0.075}"/>` +
        `<circle cx="${mx + s * 0.78}" cy="${my + s * 0.22}" r="${s * 0.12}" fill="#ea580c"/>` +
        `<text x="${mx - s * 0.35}" y="${my + s * 0.66}" text-anchor="end" ` +
        `font-size="${label}" fill="#6b7280" font-weight="600">Made with Noddle</text>` +
        `</g>`;
    }
    const ox = artboard.ox ?? 0, oy = artboard.oy ?? 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ox} ${oy} ${w} ${h}" width="${w}" height="${h}">${contentClone.innerHTML}${diagramHtml}${mark}</svg>`;
  },

  async refreshDocs() {
    try {
      const docs = await api.list();
      set({ docs });
    } catch {
      set({ docs: [] });
    }
  },

  async openDoc(id) {
    try {
      const { svg, meta, diagram, my_role, owner } = await api.get(id);
      set({
        docId: id,
        docName: meta?.name ? "· " + meta.name : "",
        myRole: my_role ?? "viewer", // fail-safe: no role from server ⇒ view-only
        docOwner: owner ?? null,
      });
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
      // Access denied: guests are routed to the login screen (the board
      // reopens automatically after sign-in); signed-in users go back to
      // their dashboard — a broken empty canvas helps no one.
      const denied =
        err instanceof ApiError && (err.status === 401 || err.status === 403);
      if (denied) {
        const me = useAuthStore.getState().me;
        if (me?.kind !== "user") {
          useAppStore.getState().promptSignIn("Sign in to view this board.", id);
          return;
        }
        useAppStore.getState().go("dashboard");
        set({ status: "You don't have access to this board.", statusKind: "error" });
        return;
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
      // offline fallback: load locally without backend (mirrors editor.js)
      try {
        const text = await file.text();
        get().loadSvgString(text);
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
      await api.save(docId, get().currentBoardSvg(), diagram as never);
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

  async deleteDoc(id) {
    try {
      await api.remove(id);
      if (get().docId === id) {
        set({ docId: null, docName: "" });
      }
      await get().refreshDocs();
      set({ status: "Document deleted.", statusKind: "ok" });
    } catch (err) {
      set({
        status: "Delete failed: " + (err instanceof Error ? err.message : String(err)),
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
