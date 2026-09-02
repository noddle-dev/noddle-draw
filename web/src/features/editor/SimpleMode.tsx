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

/** One island slot: a MODE (select cursor / draw-arrow) or a shape to add. */
type IslandItem =
  | { kind: "mode"; mode: "select" | "arrow"; label: string; letter?: string }
  | { kind: "shape"; entry: PaletteEntry; letter?: string };

/**
 * The island, in Excalidraw's digit order: 1 select, 2 rectangle, 3 diamond,
 * 4 ellipse, 5 arrow — then noddle's extras (rounded/note/sticky). Everything
 * else stays reachable through ⋯ (the full Shapes/Layers panel).
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
  return items.filter(Boolean) as IslandItem[];
})();

/** key (digit or letter) → ISLAND index. */
const TOOL_KEYS: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  ISLAND.forEach((t, i) => {
    m[String(i + 1)] = i;
    if (t.letter && m[t.letter] === undefined) m[t.letter] = i;
  });
  return m;
})();

/** The keyboard hint for a slot's tooltip ("2 · R"). */
const keyHint = (i: number): string => {
  const t = ISLAND[i];
  return t.letter ? `${i + 1} · ${t.letter.toUpperCase()}` : String(i + 1);
};

/** Doodle-style inline glyphs for the two mode slots (no emoji per repo rule). */
function ModeGlyph({ mode }: { mode: "select" | "arrow" }) {
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
      // taps stay consequence-free — see Canvas.startDrawShape). Sticky until
      // Esc / Select — same contract as the arrow tool.
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
      if (t === "arrow" || t === "draw") useEditorStore.getState().setTool("select");
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
        {ISLAND.map((t, i) =>
          t.kind === "mode" ? (
            <button
              key={`mode:${t.mode}`}
              className={`simple-tool${tool === t.mode ? " active" : ""}`}
              title={
                t.mode === "select"
                  ? `Select (${keyHint(i)}) — the normal cursor`
                  : `Arrow (${keyHint(i)}) — drag from any shape to draw a connector`
              }
              aria-label={`${t.label} — keyboard ${keyHint(i)}`}
              aria-pressed={tool === t.mode}
              onClick={() => useEditorStore.getState().setTool(t.mode)}
            >
              <ModeGlyph mode={t.mode} />
              <span className="simple-tool-key" aria-hidden="true">{i + 1}</span>
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
              <span className="simple-tool-key" aria-hidden="true">{i + 1}</span>
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
