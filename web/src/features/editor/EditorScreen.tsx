/**
 * features/editor/EditorScreen — the editor: the canvas engine with REAL
 * collaboration overlays, under the Excalidraw-style floating chrome
 * (SimpleMode.tsx — the only editor UI since the Full layout was retired).
 *
 * Responsibilities beyond composition:
 *   • apply queued hand-offs (pendingDocId → openDoc, pendingSvg → load) once
 *     the canvas refs exist;
 *   • keep the URL at /d/{docId} (the shareable address);
 *   • join/leave the document's live-collab room on docId change and stream
 *     the local pointer as a cursor (content coords).
 */
import { isApplyingRemote } from "../../state/collabStore";
import { useEffect, useRef, useState } from "react";
import { Canvas } from "../canvas";
import { screenToContent } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";
import { startDiagramHistory } from "../../state/diagramHistory";
import { ContextMenu, type CtxMenuState } from "./ContextMenu";
import { PresentHud } from "./PresentHud";
import { PageBar } from "./PageBar";
import { connectCollab, disconnectCollab, sendCursor } from "../../state/collabStore";
import { rememberBoard } from "../../state/appStore";
import { api } from "../../shared/api/client";
import { SimpleChrome } from "./SimpleMode";
import { GifExportModal } from "./GifExportModal";
import { CanvasCollab } from "./CanvasCollab";
import { CommentsLayer } from "../comments/CommentsLayer";
import { addImageToBoard, imageFromDataTransfer } from "./pasteImage";
import { usePagesStore } from "../../state/pagesStore";

/** Autosave debounce — long enough to batch a drag, short enough to feel safe. */
const AUTOSAVE_MS = 1800;

/** Status lines that are background noise, not news (there is no status bar). */
const TOAST_SKIP = /^(Autosaved|Saving|Editing text|Loading|Opened)/;
/** Every toast lives exactly this long (3s, then it fades). */
const TOAST_MS = 3000;
/** A neutral hint already shown is not repeated within this window. */
const HINT_REPEAT_MS = 30000;

/**
 * The editor has no status bar, so editor feedback ("Grouped 3 shapes…",
 * "Couldn't rename…", import errors) used to vanish. This toast surfaces each
 * NEW status for a few seconds under the tool island; routine autosave/edit
 * hints are skipped. aria-live so screen readers announce it too.
 */
function SimpleToast() {
  const status = useEditorStore((s) => s.status);
  const kind = useEditorStore((s) => s.statusKind);
  const [shown, setShown] = useState<{ text: string; kind: string; id: number } | null>(null);
  const seen = useRef(new Map<string, number>());
  useEffect(() => {
    if (!status || TOAST_SKIP.test(status)) return;
    // Results (ok/error) always show; a neutral HINT shows once per 30s —
    // tool hints used to re-fire on every hover and never went away.
    const now = Date.now();
    if (!kind && now - (seen.current.get(status) ?? 0) < HINT_REPEAT_MS) return;
    seen.current.set(status, now);
    setShown({ text: status, kind, id: now });
  }, [status, kind]);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown(null), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [shown]);
  return (
    <div className="simple-toast-host" aria-live="polite">
      {shown && (
        <div key={shown.id} className={`simple-toast${shown.kind ? " " + shown.kind : ""}`}>
          {shown.kind && <span className="simple-toast-dot" aria-hidden="true" />}
          {shown.text}
        </div>
      )}
    </div>
  );
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

export function EditorScreen() {
  const refs = useEditorStore((s) => s.refs);
  const docId = useEditorStore((s) => s.docId);
  const pendingDocId = useAppStore((s) => s.pendingDocId);
  const pendingSvg = useAppStore((s) => s.pendingSvg);
  const embedMode = useAppStore((s) => s.embedMode);
  const presenting = useAppStore((s) => s.presenting);
  const zenMode = useAppStore((s) => s.zenMode);
  // The floating-island chrome (and its `.editor.simple` CSS) is the editor
  // UI everywhere except embeds, which stay chrome-less.
  const gifExportScope = useAppStore((s) => s.gifExportScope);
  const simple = !embedMode;
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const notFound = useEditorStore((s) => s.notFound);

  // Start diagram-layer undo/redo checkpointing (idempotent).
  useEffect(startDiagramHistory, []);

  // Right-click a diagram object (or a multi-selection) → context menu with
  // AI-enrich / group-by / z-order / delete.
  useEffect(() => {
    if (!refs) return;
    const host = refs.host;
    const onCtx = (e: MouseEvent) => {
      if (useAppStore.getState().presenting) { e.preventDefault(); return; }
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
      if (useAppStore.getState().presenting) return;
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
        if (!isApplyingRemote()) kick();
      }
    });
    const unsubContent = useEditorStore.subscribe((s, prev) => {
      if (s.contentRev !== prev.contentRev && s.dirty) kick();
    });
    // Page add/delete/rename/duplicate lives in pagesStore, not diagramStore —
    // watch it too so structural page changes actually persist (a deleted page
    // used to reappear on reload).
    // Board-level semantic metadata lives on the same store (root `metadata`).
    const unsubPages = usePagesStore.subscribe((s, prev) => {
      if (s.pages !== prev.pages || s.metadata !== prev.metadata) kick();
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
      className={`editor${presenting ? " presenting" : ""}${embedMode ? " embedding" : ""}${simple ? " simple" : ""}${zenMode && !presenting ? " zen" : ""}`}
    >
      <div className="editor-body">
        <div className="editor-canvas">
          <Canvas />
          <CanvasCollab />
          {!presenting && <CommentsLayer />}
          {!presenting && ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
          <PageBar />
        </div>
      </div>
      {simple && <SimpleToast />}
      {simple && !presenting && <SimpleChrome />}
      {gifExportScope && (
        <GifExportModal
          scope={gifExportScope}
          onClose={() => useAppStore.getState().setGifExportScope(null)}
        />
      )}
      {presenting && <PresentHud />}
      {notFound && <BoardNotFound />}
    </div>
  );
}
