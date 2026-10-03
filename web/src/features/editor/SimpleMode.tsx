/**
 * features/editor/SimpleMode — the editor chrome (the only one since the Full
 * docked layout was retired; the name and `.editor.simple` CSS stayed).
 *
 * Excalidraw-style spatial hierarchy over the UNCHANGED canvas engine:
 *   • top-left     — ☰ File menu island (board, export, view, present…)
 *                    + renamable board title (view-only tag);
 *   • top-center   — floating tool island: the essential shapes (click to add,
 *                    drag to place — same startShapeDrag as the full palette)
 *                    plus the Library browser (L) and ⋯ which opens the
 *                    full Shapes/Layers panel floating;
 *   • top-right    — presence avatars, comment tool, Share, and a toggle for
 *                    the floating Properties/AI panel;
 *   • bottom-left  — zoom island (−/%/+, % fits) + undo/redo island. The
 *                    canvas's own bottom-right zoom widget is CSS-hidden.
 * EditorScreen mounts this over the canvas (never in embeds/present mode).
 */
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramHistory } from "../../state/diagramHistory";
import { broadcastName, onCollabName } from "../../state/collabStore";
import { api } from "../../shared/api/client";
import { SHAPE_SECTIONS, MiniGlyph, type PaletteEntry } from "../diagram";
import { Icon } from "../../shared/ui";
import { entryInit, LeftPanel } from "./LeftPanel";
import { useDiagramStore } from "../../state/diagramStore";
import { useCommentsStore } from "../../state/commentsStore";
import { ShareDialog } from "./ShareDialog";
import { TemplatesModal } from "../templates/TemplatesModal";
import { Presence } from "./Presence";
import { DrawStylePanel } from "./DrawStylePanel";
import { SimpleFileMenu } from "./SimpleFileMenu";
import { HistoryPanel } from "./HistoryPanel";
import { RightPanel } from "./RightPanel";
import { LibraryPanel } from "../library";
import { copyPngToClipboard } from "../toolbar/useExport";
import { ShortcutsDialog } from "./ShortcutsDialog";

/** One island slot: a MODE (select cursor / draw-arrow) or a shape to add. */
type IslandMode = "select" | "arrow" | "text" | "pan" | "pen" | "eraser" | "laser";
type IslandItem = (
  | { kind: "mode"; mode: IslandMode; label: string; letter?: string }
  | { kind: "shape"; entry: PaletteEntry; letter?: string }
) & {
  /** Digit shortcut (1–9) — only the core tools; extras are letter-only so
   * adding a tool never renumbers the ones people already know. */
  digit?: number;
};

/**
 * The island: H hand, 1 select, 2 rectangle, 3 TEXT (the most-used tool after
 * boxes), 4 ellipse, 5 arrow, 6 diamond, then P pen, E eraser and K laser.
 * Rounded / note / sticky are not on the island — they live in ⋯ (Shapes
 * panel) and the Library. Same order and keys as the commercial edition.
 */
const ISLAND: IslandItem[] = (() => {
  const section = (name: string) =>
    SHAPE_SECTIONS.find((s) => s.name === name)?.entries ?? [];
  const basic = section("Basic");
  const byKind = (k: string) => basic.find((e) => e.kind === k);
  const core: (IslandItem | null | undefined)[] = [
    { kind: "mode", mode: "select", label: "Select", letter: "v" },
    byKind("rect") && { kind: "shape", entry: byKind("rect")!, letter: "r" },
    { kind: "mode", mode: "text", label: "Text", letter: "t" },
    byKind("ellipse") && { kind: "shape", entry: byKind("ellipse")!, letter: "o" },
    { kind: "mode", mode: "arrow", label: "Arrow", letter: "a" },
    byKind("diamond") && { kind: "shape", entry: byKind("diamond")!, letter: "d" },
  ];
  const numbered = (core.filter(Boolean) as IslandItem[]).map((t, i) => ({ ...t, digit: i + 1 }));
  return [
    { kind: "mode", mode: "pan", label: "Hand", letter: "h" },
    ...numbered,
    { kind: "mode", mode: "pen", label: "Pen", letter: "p" },
    { kind: "mode", mode: "eraser", label: "Eraser", letter: "e" },
    { kind: "mode", mode: "laser", label: "Laser pointer", letter: "k" },
  ] as IslandItem[];
})();

/** key (digit or letter) → ISLAND index. */
const TOOL_KEYS: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  ISLAND.forEach((t, i) => {
    if (t.digit) m[String(t.digit)] = i;
    if (t.letter && m[t.letter] === undefined) m[t.letter] = i;
  });
  return m;
})();

/** The keyboard hint for a slot's tooltip ("2 · R"). */
const keyHint = (i: number): string => {
  const t = ISLAND[i];
  if (!t.digit) return (t.letter ?? "").toUpperCase();
  return t.letter ? `${t.digit} · ${t.letter.toUpperCase()}` : String(t.digit);
};
/** What the corner of the button shows: the digit, else the letter. */
const cornerKey = (i: number): string => {
  const t = ISLAND[i];
  return t.digit ? String(t.digit) : (t.letter ?? "").toUpperCase();
};

const MODE_TITLES: Record<IslandMode, string> = {
  select: "the normal cursor",
  text: "click the canvas to type a label",
  arrow: "drag from a shape or empty canvas to draw an arrow",
  pan: "drag to move around the board (or hold Space)",
  pen: "draw freehand",
  eraser: "sweep over objects to erase them",
  laser: "point at things — the trail fades, nothing is saved",
};

/** Doodle-style inline glyphs for the mode slots (no emoji per repo rule). */
function ModeGlyph({ mode }: { mode: IslandMode }) {
  const P = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (mode === "pan") {
    return (
      <svg {...P}>
        <path d="M8 12.5 V6.5 C8 5.4, 9.8 5.4, 9.8 6.5 V11.5 M9.8 6 V4.8 C9.8 3.7, 11.6 3.7, 11.6 4.8 V11 M11.6 5.4 C11.6 4.3, 13.4 4.3, 13.4 5.4 V11.2 M13.4 7 C13.4 5.9, 15.2 5.9, 15.2 7 V13.5 C15.2 17.5, 13 19.6, 10.6 19.6 C8.4 19.6, 7.1 18.4, 5.8 16.2 L4.4 13.6 C3.9 12.6, 5.3 11.8, 6 12.6 L8 14.6" />
      </svg>
    );
  }
  if (mode === "pen") {
    return (
      <svg {...P}>
        <path d="M14.8 5.2 L18.8 9.2 L9 19 L4.6 19.4 L5 15 Z M13 7 L17 11" />
      </svg>
    );
  }
  if (mode === "eraser") {
    return (
      <svg {...P}>
        <path d="M13.6 5.4 L19.6 11.4 L11.8 19.2 L7.4 19.2 L4.4 16.2 C3.8 15.6, 3.8 14.6, 4.4 14 Z M8.6 9.4 L14.6 15.4 M11.8 19.2 H19.6" />
      </svg>
    );
  }
  if (mode === "laser") {
    return (
      <svg {...P}>
        <path d="M4.5 19.5 L13.2 10.8" />
        <path d="M16.6 4.2 L16.9 6.4 M20.2 7.4 L18 7.8 M19.5 3.9 L18.1 5.6" />
        <circle cx="15.4" cy="8.6" r="2.1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (mode === "text") {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M5.2 6.4 C9 5.8, 15 5.9, 18.8 6.3" />
        <path d="M12.1 6.2 C11.9 10.5, 12.2 15, 11.9 19.2" />
        <path d="M9.4 19.3 C10.9 19.1, 13.2 19.2, 14.6 19.4" />
      </svg>
    );
  }
  return mode === "select" ? (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 L18.5 12 L12.5 13.2 L15.5 19.5 L13 20.6 L10.2 14.2 L6 17.5 Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20 C9 17, 14 11, 19 6" />
      <path d="M13.5 5.5 L19 6 L18.5 11.5" />
    </svg>
  );
}

/** Doodle book-of-shapes for the Library slot (hand-drawn, no emoji). */
function LibraryGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.4 5.2 C7.4 4.6, 10 5, 12 6.4 C14 5, 16.6 4.6, 19.6 5.2 L19.4 18.6 C16.5 18.1, 14 18.4, 12 19.8 C10 18.4, 7.5 18.1, 4.6 18.6 Z" />
      <path d="M12 6.5 C12.1 10.8, 11.9 15.4, 12 19.6" />
      <path d="M6.9 8.6 C7.8 8.5, 8.7 8.5, 9.5 8.7 L9.4 11 C8.6 11.1, 7.7 11.1, 6.9 11 Z" />
      <path d="M15.8 8.4 C16.8 8.6, 17.2 9.5, 16.9 10.4 C16.5 11.3, 15.3 11.4, 14.8 10.7 C14.3 9.9, 14.8 8.4, 15.8 8.4 Z" />
      <path d="M7 14.2 C7.9 14.1, 8.8 14.1, 9.6 14.3" />
      <path d="M14.5 14.2 C15.5 14.1, 16.3 14.1, 17.1 14.3" />
    </svg>
  );
}

/** Doodle speech bubble with a + — the comment-pin tool. */
function CommentGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.8 6 C4.9 4.9, 19 4.8, 19.2 6.1 L19.1 14.8 C19 15.9, 12.6 15.8, 10.8 15.9 L6.9 19.2 L7.4 15.8 C5.6 15.8, 4.8 15.5, 4.8 14.7 Z" />
      <path d="M12 7.6 C12.1 9.2, 11.9 11.2, 12 13 M9.1 10.4 C10.8 10.3, 13.2 10.4, 14.9 10.3" />
    </svg>
  );
}

/** Doodle padlock for the tool-lock slot (open shackle when unlocked). */
function LockGlyph({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 11.2 C5.4 10.8, 18.7 10.6, 18.6 11.3 L18.4 19.6 C18.3 20.2, 5.8 20.3, 5.7 19.7 Z" />
      <path d={locked ? "M8.3 11 V8 C8.2 4.6, 15.8 4.5, 15.7 8 V11" : "M8.3 11 V8 C8.2 4.6, 15.4 4.4, 15.6 7.2"} />
    </svg>
  );
}

export function SimpleChrome() {
  const zenMode = useAppStore((s) => s.zenMode);
  const docId = useEditorStore((s) => s.docId);
  const docName = useEditorStore((s) => s.docName);
  const myRole = useEditorStore((s) => s.myRole);
  const tplModalOpen = useAppStore((s) => s.tplModalOpen);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const cam = useEditorStore((s) => s.cam);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const fitToView = useEditorStore((s) => s.fitToView);
  // Undo/redo availability spans BOTH histories (SVG content + diagram layer).
  const tool = useEditorStore((s) => s.tool);
  const drawSpec = useEditorStore((s) => s.drawSpec);
  const toolLocked = useEditorStore((s) => s.toolLocked);
  const hasDiagramSelection = useDiagramStore((s) =>
    s.diagramSelection.some((id) => s.nodes[id] || s.edges[id]),
  );
  const svgCanUndo = useEditorStore((s) => s.canUndo);
  const svgCanRedo = useEditorStore((s) => s.canRedo);
  const diaCanUndo = useDiagramHistory((s) => s.canUndo);
  const diaCanRedo = useDiagramHistory((s) => s.canRedo);
  const canUndo = svgCanUndo || diaCanUndo;
  const canRedo = svgCanRedo || diaCanRedo;

  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shapesOpen, setShapesOpen] = useState(false);
  const panelOpen = useAppStore((s) => s.simplePanelOpen);
  const setPanelOpen = useAppStore((s) => s.setSimplePanelOpen);
  const libraryOpen = useAppStore((s) => s.libraryOpen);
  const setLibraryOpen = useAppStore((s) => s.setLibraryOpen);
  // Comment tool — armed → the next canvas click drops a pin (Esc cancels).
  const commentMode = useCommentsStore((s) => s.commentMode);
  const openThreads = useCommentsStore(
    (s) => s.comments.filter((c) => !c.parent_id && !c.resolved).length,
  );

  // Excalidraw-style tool shortcuts: 1 = select cursor, 5/A = draw-arrow mode,
  // other digits add that island shape at the canvas center (R/O/D/N/S letter
  // alternates). Yields to (a) typing in any field, (b) modifier chords, and
  // (c) the canvas's type-to-edit — with exactly ONE node selected a printable
  // key renames it (Canvas.tsx), so a digit must NOT spawn another shape then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && !e.altKey && e.code === "KeyC") {
        // ⌘⇧C — copy selection (or board) to the clipboard as a PNG.
        e.preventDefault();
        copyPngToClipboard();
        return;
      }
      if (e.altKey && !meta && e.code === "KeyZ") {
        // ⌥Z — Zen mode: chrome away, just the board.
        e.preventDefault();
        useAppStore.getState().toggleZen();
        return;
      }
      if (meta || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        const app = useAppStore.getState();
        app.setShortcutsOpen(!app.shortcutsOpen);
        return;
      }
      // ⇧+letter belongs to the canvas (⇧H/⇧V flip) — never a tool switch.
      if (e.shiftKey && /^[a-z]$/i.test(e.key)) return;
      if (e.key === "q" || e.key === "Q") {
        // Excalidraw tool lock — like the digits, never yields to type-to-edit.
        e.preventDefault();
        const ed = useEditorStore.getState();
        const locked = !ed.toolLocked;
        ed.setToolLocked(locked);
        ed.setStatus(locked ? "Tool locked — stays armed after each draw (Q)." : "Tool unlocked.", "ok");
        return;
      }
      if (e.key === "l" || e.key === "L") {
        // Library browser — a tool key like Q, so it never yields to
        // type-to-edit (Canvas.tsx excludes it too).
        e.preventDefault();
        const app = useAppStore.getState();
        app.setLibraryOpen(!app.libraryOpen);
        return;
      }
      const ds = useDiagramStore.getState();
      // Letters yield to type-to-edit on a selected node (renaming). DIGITS
      // never do — they are the advertised tool keys and must keep working
      // right after an add leaves the new shape selected (Canvas.tsx skips
      // its type-to-edit for simple-mode digits for the same reason).
      const isDigit = /^[0-9]$/.test(e.key);
      if (!isDigit && ds.diagramSelection.length === 1 && ds.nodes[ds.diagramSelection[0]]) return;
      const idx = TOOL_KEYS[e.key.toLowerCase()];
      if (idx === undefined) return;
      e.preventDefault();
      const t = ISLAND[idx];
      if (t.kind === "mode") useEditorStore.getState().setTool(t.mode);
      // Shape keys ARM the draw tool (Excalidraw): next drag on the canvas
      // sizes the shape A→B, a click draws nothing. A finished draw drops
      // back to Select unless the tool lock (Q) is on — same contract as the
      // arrow tool; Esc / Select disarms either way.
      else useEditorStore.getState().armDrawTool({ kind: t.entry.kind, init: entryInit(t.entry) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Esc closes the floating Properties/AI panel — unless focus is in a field
  // (the chat composer / inspector inputs own their Esc).
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, setPanelOpen]);

  // Same Esc rule for the Library (its search field handles its own Esc:
  // first clears the query, second closes).
  useEffect(() => {
    if (!libraryOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      setLibraryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [libraryOpen, setLibraryOpen]);

  // Leaving the editor (or entering Present) with a draw/arrow tool armed
  // would strand a crosshair cursor with no visible mode button — reset to
  // select on unmount.
  useEffect(
    () => () => {
      const t = useEditorStore.getState().tool;
      if (t !== "select" && t !== "pan") useEditorStore.getState().setTool("select");
    },
    [],
  );

  // Live renames from collaborators — update the local title only (no PATCH:
  // the peer who renamed already persisted it).
  useEffect(() => {
    onCollabName((name) => {
      useEditorStore.setState({ docName: "· " + name });
      void useEditorStore.getState().refreshDocs();
    });
    return () => onCollabName(null);
  }, [docId]);

  const title = docName.replace(/^·\s*/, "") || "Untitled board";
  // Browser tab: just the board, then the product — short enough to read in
  // a crowded tab strip (it used to be the long marketing tagline).
  useEffect(() => {
    document.title = `${title} · Noddle`;
    return () => {
      document.title = "noddle draw";
    };
  }, [title]);
  const canSave = !!docId && myRole !== "viewer";

  // Inline rename: click → input, Enter or blur commits via PATCH (+ live
  // broadcast), Esc cancels; viewers can't.
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const beginRename = () => {
    if (!canSave) return;
    setDraftName(title);
    setEditingName(true);
  };
  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingName]);
  const commitRename = async () => {
    if (!editingName) return; // Enter already committed; this is the blur
    setEditingName(false);
    const name = draftName.trim();
    if (!docId || !name || name === title) return;
    try {
      await api.patchDoc(docId, { name });
      useEditorStore.setState({ docName: "· " + name });
      broadcastName(name);
      await useEditorStore.getState().refreshDocs();
    } catch {
      useEditorStore.getState().setStatus("Couldn't rename the board.", "error");
    }
  };


  if (zenMode) {
    return (
      <>
        <button
          type="button"
          className="simple-island simple-zen-exit"
          title="Exit zen mode (⌥Z)"
          onClick={() => useAppStore.getState().toggleZen()}
        >
          Exit zen mode
        </button>
        <ShortcutsDialog />
      </>
    );
  }

  return (
    <>
      <ShortcutsDialog />
      {/* ---- top-left: menu + title ---- */}
      <div className="simple-top-left">
        <div className="simple-menu-anchor" style={{ position: "relative" }}>
          {/* version history pops from the same corner as the menu it came from */}
          {historyOpen && docId && <HistoryPanel docId={docId} onClose={() => setHistoryOpen(false)} />}
          <button
            className="simple-island simple-sq"
            title="Menu"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ☰
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              {/* Disclosure pattern (not an ARIA menu): a plain list of native
                  buttons — Tab/Enter/Space work without arrow-key management,
                  so no role="menu"/menuitem and no aria-haspopup. */}
              <div
                className="menu-pop simple-menu"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setMenuOpen(false);
                }}
              >
                <SimpleFileMenu
                  title={title}
                  canSave={canSave}
                  onClose={() => setMenuOpen(false)}
                  onRename={beginRename}
                  onShare={() => setShareOpen(true)}
                  onGif={(scope) => useAppStore.getState().setGifExportScope(scope)}
                  onHistory={() => setHistoryOpen(true)}
                />
              </div>
            </>
          )}
        </div>
        {editingName ? (
          <input
            ref={nameInputRef}
            className="simple-island simple-title simple-title-input"
            value={draftName}
            aria-label="Board name"
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
              else if (e.key === "Escape") setEditingName(false);
            }}
          />
        ) : (
          <button
            type="button"
            className={`simple-island simple-title${canSave ? " renamable" : ""}`}
            title={canSave ? "Click to rename" : title}
            onClick={beginRename}
          >
            {title}
            {myRole === "viewer" && <span className="simple-viewer"> · view only</span>}
          </button>
        )}
      </div>

      {/* Excalidraw-style tool hint under the island (eraser only) */}
      {tool === "eraser" && (
        <div className="simple-tool-hint" aria-live="polite">
          Hold <kbd>⌥ Option</kbd> to revert the elements marked for deletion
        </div>
      )}

      {/* ---- top-center: tool island ---- */}
      <div className="simple-island simple-tools">
        <button
          className={`simple-tool${toolLocked ? " active" : ""}`}
          title={toolLocked ? "Tool locked — stays armed after each draw (Q)" : "Keep the tool armed after drawing (Q)"}
          aria-label="Lock tool — keyboard Q"
          aria-pressed={toolLocked}
          onClick={() => useEditorStore.getState().setToolLocked(!toolLocked)}
        >
          <LockGlyph locked={toolLocked} />
        </button>
        <span className="simple-sep" />
        {ISLAND.map((t, i) =>
          t.kind === "mode" ? (
            <button
              key={`mode:${t.mode}`}
              className={`simple-tool${tool === t.mode ? " active" : ""}`}
              title={`${t.label} (${keyHint(i)}) — ${MODE_TITLES[t.mode]}`}
              aria-label={`${t.label} — keyboard ${keyHint(i)}`}
              aria-pressed={tool === t.mode}
              onClick={() => useEditorStore.getState().setTool(t.mode)}
            >
              <ModeGlyph mode={t.mode} />
              <span className="simple-tool-key" aria-hidden="true">{cornerKey(i)}</span>
            </button>
          ) : (
            <button
              key={`${t.entry.kind}:${t.entry.label}`}
              className={`simple-tool${tool === "draw" && drawSpec?.kind === t.entry.kind ? " active" : ""}`}
              title={`${t.entry.label} (${keyHint(i)}) — then drag on the canvas to draw it at that size`}
              aria-label={`${t.entry.label} — keyboard ${keyHint(i)}`}
              aria-pressed={tool === "draw" && drawSpec?.kind === t.entry.kind}
              onClick={() =>
                useEditorStore.getState().armDrawTool({ kind: t.entry.kind, init: entryInit(t.entry) })
              }
            >
              <span className="simple-tool-glyph">
                <MiniGlyph entry={t.entry} mono />
              </span>
              <span className="simple-tool-key" aria-hidden="true">{cornerKey(i)}</span>
            </button>
          ),
        )}
        <span className="simple-sep" />
        <button
          className={`simple-tool${libraryOpen ? " active" : ""}`}
          title="Library (L)"
          aria-label="Library — keyboard L"
          aria-expanded={libraryOpen}
          onClick={() => setLibraryOpen(!libraryOpen)}
        >
          <LibraryGlyph />
        </button>
        <button
          className={`simple-tool simple-more${shapesOpen ? " active" : ""}`}
          title="All shapes & layers"
          aria-label="All shapes and layers"
          aria-expanded={shapesOpen}
          onClick={() => setShapesOpen((v) => !v)}
        >
          ⋯
        </button>
      </div>

      {/* ---- top-right: presence + comment tool + share + panel toggle ---- */}
      <div className="simple-top-right">
        <Presence />
        <button
          className={`simple-island simple-sq simple-comment${commentMode ? " active" : ""}`}
          disabled={!docId}
          title={
            commentMode
              ? "Picking a spot — click the board to pin the comment (Esc to cancel)"
              : "Add a comment (show/hide comments in ☰ → View)"
          }
          aria-label="Add a comment"
          aria-pressed={commentMode}
          onClick={() => useCommentsStore.getState().setCommentMode(!commentMode)}
        >
          <CommentGlyph />
          {openThreads > 0 && <span className="count">{openThreads}</span>}
        </button>
        <button
          className="btn btn-primary"
          disabled={!docId}
          title={docId ? "Share to co-edit" : "Board isn't attached to a document"}
          onClick={() => setShareOpen(true)}
        >
          <Icon name="share" size={15} /> Share
        </button>
        <button
          className={`simple-island simple-sq${panelOpen ? " active" : ""}`}
          title="Properties & AI-Noddle panel"
          aria-label="Properties and AI panel"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          ◧
        </button>
      </div>

      {/* ---- bottom-left: zoom + undo/redo islands ---- */}
      <div className="simple-bottom-left">
        <div className="simple-island simple-zoom">
          <button title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>−</button>
          <button className="pct" title="Fit to view" aria-label="Fit to view" onClick={fitToView}>
            {Math.round(cam.z * 100)}%
          </button>
          <button title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
        </div>
        <div className="simple-island simple-zoom">
          <button title="Undo (⌘Z)" aria-label="Undo" disabled={!canUndo} onClick={undo}>↶</button>
          <button title="Redo (⌘⇧Z)" aria-label="Redo" disabled={!canRedo} onClick={redo}>↷</button>
        </div>
      </div>

      {/* ---- Excalidraw-style style panel: LEFT, while the draw tool is armed
           OR a shape is selected — the simple stand-in for full Properties
           (the full Shapes/Layers panel wins the slot when it's open) ---- */}
      {(tool === "draw" || tool === "pen" || hasDiagramSelection) && !shapesOpen && <DrawStylePanel />}

      {/* ---- floating panels (CSS repositions .ed-panel under .editor.simple) ---- */}
      {shapesOpen && <LeftPanel />}
      {panelOpen && <RightPanel />}
      {libraryOpen && <LibraryPanel />}

      {shareOpen && docId && (
        <ShareDialog docId={docId} title={title} onClose={() => setShareOpen(false)} />
      )}
      {/* ☰ → Board → Templates… opens the picker */}
      {tplModalOpen && <TemplatesModal />}
    </>
  );
}
