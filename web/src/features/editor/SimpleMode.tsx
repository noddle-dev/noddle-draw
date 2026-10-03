/**
 * features/editor/SimpleMode — the "Simple" editor chrome (appStore.uiMode).
 *
 * Excalidraw-style spatial hierarchy over the UNCHANGED canvas engine:
 *   • top-left     — ☰ menu island (new board, templates, save, export,
 *                    present, → Full UI) + read-only board title;
 *   • top-center   — floating tool island: the essential shapes (click to arm
 *                    the draw tool — drag on the canvas sizes the shape)
 *                    plus ⋯ which opens the full Shapes/Layers panel floating;
 *   • top-right    — presence avatars, Share, and a toggle for the floating
 *                    Properties/AI panel;
 *   • bottom-left  — zoom island (−/%/+, % fits) + undo/redo island. The
 *                    canvas's own bottom-right zoom widget is CSS-hidden.
 * EditorScreen mounts this INSTEAD of EditorTopbar/LeftPanel/RightPanel, so
 * Full mode renders exactly what it always did.
 */
import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramHistory } from "../../state/diagramHistory";
import { onCollabName } from "../../state/collabStore";
import { SHAPE_SECTIONS, MiniGlyph, type PaletteEntry } from "../diagram";
import { useExport } from "../toolbar/useExport";
import { Icon } from "../../shared/ui";
import { entryInit, LeftPanel } from "./LeftPanel";
import { useDiagramStore } from "../../state/diagramStore";
import { ShareDialog, Presence } from "./EditorTopbar";
import { UiModeSwitch } from "./UiModeSwitch";
import { DrawStylePanel } from "./DrawStylePanel";
import { RightPanel } from "./RightPanel";
import { TemplatesModal } from "../templates/TemplatesModal";
import { createBoard } from "../templates/templates";

/** One island slot: a MODE (select cursor / draw-arrow / pen …) or a shape to add. */
type IslandMode = "select" | "arrow" | "pen" | "eraser" | "laser";
type IslandItem = (
  | { kind: "mode"; mode: IslandMode; label: string; letter?: string }
  | { kind: "shape"; entry: PaletteEntry; letter?: string }
) & {
  /** Digit shortcut (1–9) — only the core tools; extras are letter-only so
   * adding a tool never renumbers the ones people already know. */
  digit?: number;
};

/**
 * The island, in Excalidraw's digit order: 1 select, 2 rectangle, 3 diamond,
 * 4 ellipse, 5 arrow — then noddle's extras (rounded/note/sticky). Everything
 * else stays reachable through ⋯ (the full Shapes/Layers panel). P pen,
 * E eraser and K laser follow as letter-only extras.
 */
const ISLAND: IslandItem[] = (() => {
  const section = (name: string) =>
    SHAPE_SECTIONS.find((s) => s.name === name)?.entries ?? [];
  const basic = section("Basic");
  const byKind = (k: string) => basic.find((e) => e.kind === k);
  const note = section("Flowchart").find((e) => e.kind === "note");
  const sticky = section("Sticky notes")[0];
  const items: (IslandItem | null | undefined)[] = [
    { kind: "mode", mode: "select", label: "Select", letter: "v" },
    byKind("rect") && { kind: "shape", entry: byKind("rect")!, letter: "r" },
    byKind("diamond") && { kind: "shape", entry: byKind("diamond")!, letter: "d" },
    byKind("ellipse") && { kind: "shape", entry: byKind("ellipse")!, letter: "o" },
    { kind: "mode", mode: "arrow", label: "Arrow", letter: "a" },
    byKind("rounded") && { kind: "shape", entry: byKind("rounded")! },
    note && { kind: "shape", entry: note, letter: "n" },
    sticky && { kind: "shape", entry: sticky, letter: "s" },
  ];
  const numbered = (items.filter(Boolean) as IslandItem[]).map((t, i) => ({ ...t, digit: i + 1 }));
  return [
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
  arrow: "drag from any shape to draw a connector",
  pen: "draw freehand",
  eraser: "sweep over objects to erase them",
  laser: "point at things — the trail fades, nothing is saved",
};

/** Doodle-style inline glyphs for the two mode slots (no emoji per repo rule). */
function ModeGlyph({ mode }: { mode: IslandMode }) {
  const P = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
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
  const docId = useEditorStore((s) => s.docId);
  const docName = useEditorStore((s) => s.docName);
  const myRole = useEditorStore((s) => s.myRole);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const cam = useEditorStore((s) => s.cam);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const fitToView = useEditorStore((s) => s.fitToView);
  // Undo/redo availability spans BOTH histories (same rule as the full topbar).
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

  const tplModalOpen = useAppStore((s) => s.tplModalOpen);
  const { exportSvg, exportPng } = useExport();

  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  // Excalidraw-style tool shortcuts: 1 = select cursor, 5/A = draw-arrow mode,
  // other digits arm that island shape's draw tool (R/O/D/N/S letter
  // alternates). Yields to (a) typing in any field, (b) modifier chords, and
  // (c) the canvas's type-to-edit — with exactly ONE node selected a printable
  // key renames it (Canvas.tsx), so a digit must NOT spawn another shape then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
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
      // Shape keys ARM the draw tool (Excalidraw): the next drag on the
      // canvas sizes the shape A→B; a plain click draws NOTHING (accidental
      // taps stay consequence-free — see Canvas.startDrawShape). A finished
      // draw drops back to Select unless the tool lock (Q) is on.
      else useEditorStore.getState().armDrawTool({ kind: t.entry.kind, init: entryInit(t.entry) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Leaving Simple mode with a draw/arrow tool armed would strand a crosshair
  // cursor with no visible mode button — reset to select on unmount.
  useEffect(
    () => () => {
      const t = useEditorStore.getState().tool;
      if (t !== "select" && t !== "pan") useEditorStore.getState().setTool("select");
    },
    [],
  );

  // Live renames from collaborators — in Full mode EditorTopbar owns this
  // listener; here it is unmounted, so Simple mode registers the same one.
  useEffect(() => {
    onCollabName((name) => {
      useEditorStore.setState({ docName: "· " + name });
      void useEditorStore.getState().refreshDocs();
    });
    return () => onCollabName(null);
  }, [docId]);

  const title = docName.replace(/^·\s*/, "") || "Untitled board";
  const canSave = !!docId && myRole !== "viewer";

  // Real <button>s so the menu is keyboard-operable (Tab/Enter/Space) and
  // disabled rows are announced as such.
  const menuRow = (
    label: string,
    onClick: () => void,
    opts?: { disabled?: boolean; ico?: string },
  ) => (
    <button
      type="button"
      className="menu-row"
      disabled={opts?.disabled}
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
    >
      {opts?.ico && <span className="ico">{opts.ico}</span>}
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
    </button>
  );

  return (
    <>
      {/* ---- top-left: menu + title ---- */}
      <div className="simple-top-left">
        <div style={{ position: "relative" }}>
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
                <div className="menu-body">
                  {menuRow("New board", () => void createBoard(), { ico: "＋" })}
                  {menuRow("Templates…", () => useAppStore.getState().setTplModal(true), { ico: "▦" })}
                  {menuRow("Save", () => void useEditorStore.getState().save(), {
                    disabled: !canSave,
                    ico: "✓",
                  })}
                  {menuRow("Export SVG", () => exportSvg(), { ico: "⬡" })}
                  {menuRow("Export PNG", () => void exportPng(), { ico: "▧" })}
                  {menuRow("Present", () => useAppStore.getState().setPresenting(true), {
                    disabled: !docId,
                    ico: "▶",
                  })}
                  {menuRow("Keyboard shortcuts", () => useAppStore.getState().setShortcutsOpen(true), { ico: "?" })}
                  <div className="simple-menu-sep" />
                  {menuRow("Switch to Full interface", () => useAppStore.getState().setUiMode("full"), { ico: "◰" })}
                </div>
              </div>
            </>
          )}
        </div>
        <span className="simple-island simple-title" title={title}>
          {title}
          {myRole === "viewer" && <span className="simple-viewer"> · view only</span>}
        </span>
      </div>

      {/* ---- top-center: tool island ---- */}
      <div className="simple-island simple-tools">
        <button
          className={`simple-tool${toolLocked ? " active" : ""}`}
          title={toolLocked ? "Tool locked — stays armed after each draw (Q)" : "Keep the tool armed after drawing (Q)"}
          aria-label="Tool lock"
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
                <MiniGlyph entry={t.entry} />
              </span>
              <span className="simple-tool-key" aria-hidden="true">{cornerKey(i)}</span>
            </button>
          ),
        )}
        <span className="simple-sep" />
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

      {/* ---- top-right: presence + share + panel toggle + layout switch
           (the switch stays LAST — same right-edge anchor as the Full topbar,
           so toggling never moves it under the cursor) ---- */}
      <div className="simple-top-right">
        <Presence />
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
          onClick={() => setPanelOpen((v) => !v)}
        >
          ◧
        </button>
        <UiModeSwitch />
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
      {(tool === "draw" || hasDiagramSelection) && !shapesOpen && <DrawStylePanel />}

      {/* ---- floating panels (CSS repositions .ed-panel under .editor.simple) ---- */}
      {shapesOpen && <LeftPanel />}
      {panelOpen && <RightPanel />}

      {shareOpen && docId && (
        <ShareDialog docId={docId} title={title} onClose={() => setShareOpen(false)} />
      )}
      {/* In Full mode EditorTopbar renders this modal; here it is unmounted,
          so the Templates… menu row needs its own mount. */}
      {tplModalOpen && <TemplatesModal />}
    </>
  );
}
