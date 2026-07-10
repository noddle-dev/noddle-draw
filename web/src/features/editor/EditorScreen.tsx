/**
 * features/editor/EditorScreen — the full editor: top chrome, Shapes/Layers
 * panel, the canvas engine with REAL collaboration overlays, and the
 * Properties/Claude panel.
 *
 * Responsibilities beyond composition:
 *   • apply queued hand-offs (pendingDocId → openDoc, pendingSvg → load) once
 *     the canvas refs exist;
 *   • keep the URL at /d/{docId} (the shareable address);
 *   • join/leave the document's live-collab room on docId change and stream
 *     the local pointer as a cursor (content coords).
 */
import { useEffect, useState } from "react";
import { Canvas } from "../canvas";
import { screenToContent } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";
import { startDiagramHistory } from "../../state/diagramHistory";
import { ContextMenu, type CtxMenuState } from "./ContextMenu";
import { PageBar } from "./PageBar";
import { connectCollab, disconnectCollab, sendCursor } from "../../state/collabStore";
import { rememberBoard } from "../../state/appStore";
import { api } from "../../shared/api/client";
import { EditorTopbar } from "./EditorTopbar";
import { LeftPanel } from "./LeftPanel";
import { RightPanel } from "./RightPanel";
import { CanvasCollab } from "./CanvasCollab";
import { CommentsLayer } from "../comments/CommentsLayer";
import { ShortcutsModal } from "./ShortcutsModal";
import { addImageToBoard, imageFromDataTransfer } from "./pasteImage";
import { usePagesStore } from "../../state/pagesStore";

/** Autosave debounce — long enough to batch a drag, short enough to feel safe. */
const AUTOSAVE_MS = 1800;

function StatusBar() {
  const status = useEditorStore((s) => s.status);
  const kind = useEditorStore((s) => s.statusKind);
  return <div className={`editor-statusbar${kind ? " " + kind : ""}`}>{status}</div>;
}

/** A /d/{id} deep link that doesn't resolve (deleted / view-restricted). */
function BoardNotFound() {
  const startNew = () => {
    void api.create({ name: "Untitled board" }).then((meta) => {
      rememberBoard(meta.id, meta.name);
      useEditorStore.setState({ notFound: false });
      useAppStore.getState().openInEditor(meta.id, { replace: true });
    });
  };
  return (
    <div className="board-notfound" role="alert">
      <div className="board-notfound-card">
        <h2>Board not found</h2>
        <p>
          This board doesn't exist anymore, or its link doesn't allow viewing.
        </p>
        <button className="btn primary" onClick={startNew}>
          Start a new board
        </button>
      </div>
    </div>
  );
}

/** Presentation HUD: page x/y + arrows + exit (chrome is CSS-hidden). */
function PresentHud() {
  const pages = usePagesStore((s) => s.pages);
  const activeId = usePagesStore((s) => s.activeId);
  const switchPage = usePagesStore((s) => s.switchPage);
  const setPresenting = useAppStore((s) => s.setPresenting);
  // Slides = VISIBLE pages only; hidden pages are skipped in present mode.
  const slides = pages.filter((p) => !p.hidden);
  const idx = Math.max(0, slides.findIndex((p) => p.id === activeId));
  const goto = (i: number) => {
    if (i >= 0 && i < slides.length) switchPage(slides[i].id);
  };
  return (
    <div className="present-hud">
      <button onClick={() => goto(idx - 1)} disabled={idx <= 0}>←</button>
      <span className="pg">
        {slides[idx]?.name ?? ""} · {idx + 1}/{Math.max(1, slides.length)}
      </span>
      <button onClick={() => goto(idx + 1)} disabled={idx >= slides.length - 1}>→</button>
      <button className="exit" onClick={() => setPresenting(false)}>✕ Exit</button>
    </div>
  );
}

/** Focus mode HUD: a minimal exit affordance (all chrome is CSS-hidden). */
function FocusHud() {
  return (
    <div className="present-hud focus-hud">
      <span className="pg">Focus mode</span>
      <button className="exit" onClick={() => useAppStore.getState().toggleFocusMode(false)}>
        ✕ Exit (Esc)
      </button>
    </div>
  );
}

export function EditorScreen() {
  const refs = useEditorStore((s) => s.refs);
  const docId = useEditorStore((s) => s.docId);
  const pendingDocId = useAppStore((s) => s.pendingDocId);
  const pendingSvg = useAppStore((s) => s.pendingSvg);
  const embedMode = useAppStore((s) => s.embedMode);
  const presenting = useAppStore((s) => s.presenting);
  const leftPanelOpen = useAppStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const focusMode = useAppStore((s) => s.focusMode);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const notFound = useEditorStore((s) => s.notFound);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  // Presentation mode: fullscreen (best-effort) + ←/→ page nav + Esc exits.
  useEffect(() => {
    if (!presenting) return;
    void document.documentElement.requestFullscreen?.().catch(() => {});
    // If the active page is hidden when presentation starts, jump to the first
    // visible slide so we never present a hidden page.
    {
      const ps = usePagesStore.getState();
      const active = ps.pages.find((p) => p.id === ps.activeId);
      if (active?.hidden) {
        const firstVisible = ps.pages.find((p) => !p.hidden);
        if (firstVisible) ps.switchPage(firstVisible.id);
      }
    }
    const onKey = (e: KeyboardEvent) => {
      const ps = usePagesStore.getState();
      // Navigate VISIBLE pages only — hidden pages are skipped as slides.
      const slides = ps.pages.filter((p) => !p.hidden);
      const idx = slides.findIndex((p) => p.id === ps.activeId);
      if (e.key === "ArrowRight" && idx < slides.length - 1) {
        ps.switchPage(slides[idx + 1].id);
      } else if (e.key === "ArrowLeft" && idx > 0) {
        ps.switchPage(slides[idx - 1].id);
      } else if (e.key === "Escape") {
        useAppStore.getState().setPresenting(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [presenting]);

  // Start diagram-layer undo/redo checkpointing (idempotent).
  useEffect(startDiagramHistory, []);

  // Right-click a diagram object (or a multi-selection) → context menu with
  // AI-enrich / group-by / z-order / delete.
  useEffect(() => {
    if (!refs) return;
    const host = refs.host;
    const onCtx = (e: MouseEvent) => {
      const target = e.target as Element;
      const nodeG = target.closest("[data-diagram-node]");
      const edgeG = target.closest("[data-diagram-edge]");
      const hitId =
        nodeG?.getAttribute("data-diagram-node") ??
        edgeG?.getAttribute("data-diagram-edge") ??
        null;
      const ds = useDiagramStore.getState();
      let ids = ds.diagramSelection;
      if (hitId && !ids.includes(hitId)) {
        ids = [hitId];
        ds.setDiagramSelection(ids);
      }
      if (!hitId && ids.length === 0) return; // empty canvas → browser menu
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY, ids });
    };
    host.addEventListener("contextmenu", onCtx);
    return () => host.removeEventListener("contextmenu", onCtx);
  }, [refs]);

  // Apply the queued hand-off once the canvas refs exist.
  useEffect(() => {
    if (!refs) return;
    const app = useAppStore.getState();
    if (pendingDocId) {
      void useEditorStore.getState().openDoc(pendingDocId);
      app.consumePending();
    } else if (pendingSvg) {
      useEditorStore.getState().loadSvgString(pendingSvg);
      app.consumePending();
    }
  }, [refs, pendingDocId, pendingSvg]);

  // The URL is the share link: keep it at /d/{docId} — except in embed mode,
  // whose address IS /embed/{id} (rewriting it would break the iframe).
  useEffect(() => {
    if (docId && !embedMode && location.pathname !== `/d/${docId}`) {
      history.replaceState({}, "", `/d/${docId}`);
    }
  }, [docId, embedMode]);

  // REAL live collaboration: join the room for this document. The identity is
  // auto-generated into localStorage (rename any time in the Share dialog) —
  // no name gate, drawing starts instantly. Embeds are passive views — they
  // never join the room (no presence spam from every page load).
  useEffect(() => {
    if (!docId || embedMode) return;
    connectCollab(docId);
    return () => disconnectCollab();
  }, [docId, embedMode]);

  // Stream the local pointer to the room (content coords, throttled).
  useEffect(() => {
    if (!refs || !docId) return;
    const host = refs.host;
    const onMove = (e: PointerEvent) => {
      const p = screenToContent(refs.content, e.clientX, e.clientY);
      sendCursor(p.x, p.y);
    };
    host.addEventListener("pointermove", onMove);
    return () => host.removeEventListener("pointermove", onMove);
  }, [refs, docId]);

  // PASTE image (Cmd/Ctrl+V) → embed onto the board as an editable <image>.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (
        a &&
        (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)
      ) {
        return; // typing in a field — let the browser paste text
      }
      const blob = imageFromDataTransfer(e.clipboardData);
      if (blob) {
        e.preventDefault();
        void addImageToBoard(blob);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // AUTOSAVE: any diagram/content change debounces a quiet save. Skips while
  // there is no bound document; a pending save flushes on unmount/doc switch.
  useEffect(() => {
    if (!docId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    const kick = () => {
      pending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        pending = false;
        void useEditorStore.getState().save({ quiet: true });
      }, AUTOSAVE_MS);
    };
    const unsubDiagram = useDiagramStore.subscribe((s, prev) => {
      if (s.nodes !== prev.nodes || s.edges !== prev.edges) {
        // Grow the white page to contain shapes dragged past its edge.
        if (s.nodes !== prev.nodes) useEditorStore.getState().ensureArtboardFits();
        kick();
      }
    });
    const unsubContent = useEditorStore.subscribe((s, prev) => {
      if (s.contentRev !== prev.contentRev && s.dirty) kick();
    });
    // Page add/delete/rename/duplicate lives in pagesStore, not diagramStore —
    // watch it too so structural page changes actually persist (a deleted page
    // used to reappear on reload).
    const unsubPages = usePagesStore.subscribe((s, prev) => {
      if (s.pages !== prev.pages) kick();
    });
    // Flush a pending debounced save when the tab is hidden or reloaded — a
    // quick F5 within the 1.8s window would otherwise drop the last change
    // (e.g. an animation-speed tweak) since React cleanup doesn't run on reload.
    const flush = () => {
      if (pending && useEditorStore.getState().docId === docId) {
        void useEditorStore.getState().save({ quiet: true });
      }
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      unsubDiagram();
      unsubContent();
      unsubPages();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      if (timer) clearTimeout(timer);
      // Don't lose the last edits when navigating away mid-debounce — but only
      // if the store still points at THIS doc (switching docs runs cleanup
      // after docId already changed; saving then would write the old board
      // under the new id).
      if (pending && useEditorStore.getState().docId === docId) {
        void useEditorStore.getState().save({ quiet: true });
      }
    };
  }, [docId]);

  return (
    <div
      className={
        "editor" +
        (presenting ? " presenting" : "") +
        (embedMode ? " embedding" : "") +
        (focusMode ? " focus" : "") +
        (!leftPanelOpen ? " hide-left" : "") +
        (!rightPanelOpen ? " hide-right" : "")
      }
    >
      <EditorTopbar />
      <div className="editor-body">
        <LeftPanel />
        <div className="editor-canvas">
          <Canvas />
          <CanvasCollab />
          <CommentsLayer />
          {ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
          <PageBar />
        </div>
        <RightPanel />
      </div>
      <StatusBar />
      {presenting && <PresentHud />}
      {focusMode && !presenting && <FocusHud />}
      {shortcutsOpen && <ShortcutsModal />}
      {notFound && <BoardNotFound />}
    </div>
  );
}
