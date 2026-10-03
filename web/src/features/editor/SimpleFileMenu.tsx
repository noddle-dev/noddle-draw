/**
 * features/editor/SimpleFileMenu — the editor's ☰ main menu, a real File
 * menu (Excalidraw/Figma grammar) instead of a handful of loose actions:
 *
 *   Board   — New, Templates…, Generate with AI, Open recent ▸ (this
 *             browser's boards), Import file…, Save, Make a copy, Rename
 *   Export  — area (Page / Fit content / Selection) + PNG / SVG / GIF… /
 *             Deck PNG / board JSON / Mermaid (inline group ▸)
 *   View    — Show grid, Snap to grid, Page backdrop,
 *             Show comments (live toggles — the menu stays open)
 *   then    — Present, Version history, Share…, Keyboard shortcuts
 *
 * Every action reuses the shared implementation (useExport, boardExports,
 * GifExportModal, HistoryPanel, shared importBoardFile) — this file only
 * arranges them. Sub-lists expand INLINE (accordion), not as
 * hover flyouts: keyboard- and touch-friendly with no pointer-path geometry.
 * Dialogs that must outlive the menu (GIF, history, share) are opened via
 * callbacks so SimpleChrome owns their state.
 */
import { useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { boardDiagram } from "../../state/pagesStore";
import { api } from "../../shared/api/client";
import { IMPORT_ACCEPT, importBoardFile } from "../../shared/api/importBoard";
import { useCommentsStore } from "../../state/commentsStore";
import { useDiagramStore } from "../../state/diagramStore";
import {
  copyPngToClipboard,
  loadPngScale,
  PNG_SCALES,
  savePngScale,
  useExport,
  type ExportScope,
} from "../toolbar/useExport";
import { exportBoardJson, exportMermaid } from "./boardExports";

type IconName =
  | "plus" | "clock" | "upload" | "save" | "copy" | "pencil" | "folder"
  | "download" | "play" | "history" | "share" | "grid" | "eye" | "chev" | "check" | "keys"
  | "spark";

export type { ExportScope };

/** Doodle line icons (hand-drawn strokes — repo rule: no emoji/glossy icons). */
function Ico({ name }: { name: IconName }) {
  const d: Record<IconName, ReactNode> = {
    plus: <path d="M12 5.2 C12.1 9, 11.9 15, 12 18.8 M5.2 12.1 C9 11.9, 15 12.1, 18.8 11.9" />,
    clock: (
      <>
        <path d="M12 4.2 C16.6 4.1, 19.9 7.6, 19.8 12 C19.7 16.5, 16.3 19.9, 11.9 19.8 C7.4 19.7, 4.2 16.3, 4.3 11.9 C4.4 7.6, 7.6 4.3, 12 4.2 Z" />
        <path d="M12 7.8 V12.2 L15 14" />
      </>
    ),
    upload: <path d="M12 15.5 V5 M8 8.6 L12 4.8 L16 8.7 M5 14.8 V18.6 C5 19.2, 19 19.3, 19 18.7 V14.7" />,
    save: <path d="M5.4 5 H16.2 L19 7.9 V18.8 C19 19.3, 5.1 19.2, 5.2 18.7 Z M8.3 5.2 V9.4 H15 V5.3 M8.2 19 V13.6 H15.8 V19" />,
    copy: <path d="M9 9 H18.6 V18.9 H9.1 Z M15 8.8 V5.2 H5.3 V15 H8.9" />,
    pencil: <path d="M5 19 L6 14.8 L15.6 5.3 C16.3 4.6, 18.7 7, 18.6 7.6 L9.1 17.9 Z M13.9 7 L16.9 10" />,
    folder: <path d="M4.6 7.4 C4.6 6.5, 9.6 6.4, 10.2 6.5 L11.8 8.3 H19.2 C19.6 8.3, 19.5 18.4, 19.2 18.6 H4.8 Z" />,
    download: <path d="M12 4.8 V15 M8 11.3 L12 15.2 L16 11.2 M5 15 V18.7 C5.1 19.2, 18.9 19.2, 19 18.7 V14.9" />,
    play: <path d="M8 5.6 C8.1 5.3, 18.3 11.6, 18.3 12 C18.2 12.4, 8.2 18.7, 8 18.4 Z" />,
    history: <path d="M5.2 12 C5.2 8, 8.4 4.9, 12.2 5 C16 5.1, 19 8.2, 18.9 12.1 C18.8 16, 15.8 19, 12 18.9 C9.6 18.9, 7.4 17.6, 6.3 15.6 M5 7.2 V11.9 H9.6 M12 8.6 V12.3 L14.6 13.8" />,
    share: <path d="M16.8 8.3 C18.3 8.3, 18.4 5.4, 16.9 5.4 C15.3 5.3, 15.3 8.3, 16.8 8.3 Z M7.2 13.4 C8.8 13.5, 8.8 10.5, 7.2 10.5 C5.6 10.5, 5.6 13.4, 7.2 13.4 Z M16.9 18.6 C18.4 18.6, 18.4 15.7, 16.9 15.7 C15.3 15.6, 15.3 18.6, 16.9 18.6 Z M8.6 11.2 L15.4 7.4 M8.6 12.8 L15.5 16.6" />,
    grid: <path d="M5 5 H10.6 V10.6 H5 Z M13.4 5 H19 V10.6 H13.4 Z M5 13.4 H10.6 V19 H5 Z M13.4 13.4 H19 V19 H13.4 Z" />,
    eye: (
      <>
        <path d="M3.8 12.2 C6.2 8.4, 9 6.6, 12.1 6.6 C15.3 6.7, 17.9 8.5, 20.2 12 C17.9 15.6, 15.2 17.4, 12 17.4 C8.9 17.3, 6.1 15.6, 3.8 12.2 Z" />
        <path d="M12 9.6 C13.5 9.5, 14.5 10.6, 14.4 12.1 C14.3 13.5, 13.3 14.5, 11.9 14.4 C10.5 14.3, 9.5 13.3, 9.6 11.9 C9.7 10.6, 10.6 9.6, 12 9.6 Z" />
      </>
    ),
    check: <path d="M5.4 12.6 C6.9 14, 8.4 15.6, 9.8 17.4 C12.4 13.2, 15.3 9.6, 18.8 6.6" />,
    chev: <path d="M9.5 7 L14.6 12 L9.5 17" />,
    spark: <path d="M12 4.5 C12.6 8.6, 13.6 10.6, 19.5 12 C13.6 13.4, 12.6 15.4, 12 19.5 C11.4 15.4, 10.4 13.4, 4.5 12 C10.4 10.6, 11.4 8.6, 12 4.5 Z" />,
    keys: <path d="M4 7.2 C4 6.6, 20 6.5, 20 7.2 L19.9 16.9 C19.9 17.5, 4.1 17.5, 4.1 16.9 Z M7 10.2 H8 M10.5 10.2 H11.5 M14 10.2 H15 M17 10.2 H17.2 M7.6 14 C10.4 13.9, 13.6 14.1, 16.4 14" />,
  };
  return (
    <svg className="fm-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d[name]}
    </svg>
  );
}

export function SimpleFileMenu({
  title,
  canSave,
  onClose,
  onRename,
  onShare,
  onGif,
  onHistory,
}: {
  title: string;
  canSave: boolean;
  onClose: () => void;
  onRename: () => void;
  onShare: () => void;
  onGif: (scope: ExportScope) => void;
  onHistory: () => void;
}) {
  const docId = useEditorStore((s) => s.docId);
  const docs = useEditorStore((s) => s.docs);
  const dirty = useEditorStore((s) => s.dirty);
  const { exportSvg, exportPng, exportDeckPng } = useExport();
  const [open, setOpen] = useState<"recent" | "export" | "view" | null>(null);
  // PNG output scale (1×/2×/4×) — shared by PNG, Deck PNG and Copy as PNG,
  // remembered across reloads.
  const [pngScale, setPngScale] = useState<number>(loadPngScale);
  const pickScale = (v: number) => {
    setPngScale(v);
    savePngScale(v);
  };
  const [scope, setScope] = useState<ExportScope>("page");
  const hasSelection = useDiagramStore((s) => s.diagramSelection.length > 0);
  // A stale "selection" choice must not survive the selection being cleared.
  const area: ExportScope = scope === "selection" && !hasSelection ? "page" : scope;
  const gridOn = useAppStore((s) => s.gridOn);
  const snapOn = useAppStore((s) => s.snapOn);
  const pageBackdrop = useAppStore((s) => s.pageBackdrop);
  const commentsVisible = useCommentsStore((s) => s.commentsVisible);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const recent = docs
    .filter((d) => d.id !== docId)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 6);
  const toggle = (k: "recent" | "export" | "view") => {
    if (k === "recent") void useEditorStore.getState().refreshDocs();
    setOpen((v) => (v === k ? null : k));
  };

  /** Leaving this board: flush unsaved edits first (autosave may lag). */
  const leaveTo = async (id: string) => {
    const ed = useEditorStore.getState();
    if (canSave && ed.dirty) await ed.save({ quiet: true });
    onClose();
    useAppStore.getState().openInEditor(id);
  };

  /** Create-type actions share one error path. */
  const run = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useEditorStore.getState().setStatus(`Couldn't ${what}: ${msg}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const newBoard = () =>
    run("create a board", async () => {
      const meta = await api.create({ name: "Untitled board", diagram: { nodes: [], edges: [] } });
      await leaveTo(meta.id);
    });
  const makeCopy = () =>
    run("copy the board", async () => {
      const meta = await api.create({
        name: `${title} (copy)`,
        diagram: boardDiagram() as never,
      });
      await leaveTo(meta.id);
    });
  const importFile = (file: File | null) => {
    if (!file) return;
    void run("import that file", async () => {
      const meta = await importBoardFile(file);
      await leaveTo(meta.id);
    });
  };

  /** A row: runs `fn` and closes the menu (unless `keep`). */
  const row = (
    label: string,
    icon: IconName,
    fn: () => void,
    opts?: { disabled?: boolean; hint?: string; keep?: boolean; expanded?: boolean },
  ) => (
    <button
      type="button"
      className={`menu-row fm-row${opts?.expanded !== undefined ? " fm-parent" : ""}`}
      disabled={opts?.disabled || busy}
      aria-expanded={opts?.expanded}
      onClick={() => {
        if (!opts?.keep && opts?.expanded === undefined) onClose();
        fn();
      }}
    >
      <Ico name={icon} />
      <span className="fm-label">{label}</span>
      {opts?.hint && <span className="fm-hint">{opts.hint}</span>}
      {opts?.expanded !== undefined && (
        <span className={`fm-chev${opts.expanded ? " open" : ""}`}><Ico name="chev" /></span>
      )}
    </button>
  );
  const sub = (label: string, fn: () => void, opts?: { active?: boolean; hint?: string }) => (
    <button type="button" className={`menu-row fm-sub${opts?.active ? " active" : ""}`} disabled={busy} onClick={fn}>
      <span className="fm-label">{label}</span>
      {opts?.hint && <span className="fm-hint">{opts.hint}</span>}
    </button>
  );
  /** A live on/off setting: flips in place, the menu stays open. */
  const check = (label: string, on: boolean, fn: () => void, hint?: string) => (
    <button type="button" aria-pressed={on} className="menu-row fm-sub fm-check" onClick={fn} title={hint}>
      <span className={`fm-box${on ? " on" : ""}`}>{on && <Ico name="check" />}</span>
      <span className="fm-label">{label}</span>
    </button>
  );
  const scopeHint = { page: "page", fit: "fit content", selection: "selection" }[area];

  return (
    <div className="menu-body fm">
      <div className="fm-section">Board</div>
      {row("New board", "plus", () => void newBoard(), { keep: true })}
      {row("Templates…", "grid", () => useAppStore.getState().setTplModal(true))}
      {row("Generate with AI", "spark", () => useAppStore.getState().startNewWithAI())}
      {row("Open recent", "clock", () => toggle("recent"), { expanded: open === "recent", hint: "this browser" })}
      {open === "recent" && (
        <div className="fm-subs">
          {recent.length === 0 && <div className="fm-empty">No other boards on this browser yet</div>}
          {recent.map((d) => sub(d.name || "Untitled board", () => void leaveTo(d.id)))}
        </div>
      )}
      {row("Import file…", "upload", () => fileRef.current?.click(), { keep: true, hint: ".json .drawio .mmd" })}
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_ACCEPT}
        hidden
        onChange={(e) => {
          importFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      {row("Save", "save", () => void useEditorStore.getState().save(), {
        disabled: !canSave,
        hint: canSave ? (dirty ? "⌘S" : "Saved") : "view only",
      })}
      {row("Make a copy", "copy", () => void makeCopy(), { disabled: !docId, keep: true })}
      {row("Rename", "pencil", onRename, { disabled: !canSave })}

      <div className="simple-menu-sep" />
      {row("Export", "download", () => toggle("export"), { expanded: open === "export" })}
      {open === "export" && (
        <div className="fm-subs">
          {/* Framing (draw.io-style): applies to PNG, SVG and GIF below. */}
          <div className="export-scope" role="radiogroup" aria-label="Export area">
            {([
              ["page", "Page"],
              ["fit", "Fit content"],
              ["selection", "Selection"],
            ] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                role="radio"
                aria-checked={area === val}
                className={`export-scope-chip${area === val ? " active" : ""}`}
                disabled={val === "selection" && !hasSelection}
                title={val === "selection" && !hasSelection ? "Select shapes first" : undefined}
                onClick={() => setScope(val)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* PNG output scale — applies to PNG, Deck PNG and Copy as PNG. */}
          <div className="export-scope" role="radiogroup" aria-label="PNG scale">
            {PNG_SCALES.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={pngScale === v}
                className={`export-scope-chip${pngScale === v ? " active" : ""}`}
                onClick={() => pickScale(v)}
              >
                {v}×
              </button>
            ))}
          </div>
          {sub("PNG image", () => { onClose(); void exportPng(area, pngScale); }, { hint: `${scopeHint} · ${pngScale}×` })}
          {sub("SVG vector", () => { onClose(); exportSvg(area); }, { hint: scopeHint })}
          {sub("Animated GIF…", () => { onClose(); onGif(area); }, { hint: scopeHint })}
          {sub("Copy as PNG", () => { onClose(); copyPngToClipboard(); }, { hint: "⌘⇧C" })}
          {sub("Deck PNG", () => { onClose(); void exportDeckPng(pngScale); }, { hint: "one per page" })}
          {sub("Board file (.json)", () => { onClose(); exportBoardJson(title); }, { hint: "re-importable" })}
          {sub("Mermaid (.mmd)", () => { onClose(); exportMermaid(title); }, { hint: "structure" })}
        </div>
      )}

      {row("View", "eye", () => toggle("view"), { expanded: open === "view" })}
      {open === "view" && (
        <div className="fm-subs">
          {check("Show grid", gridOn, () => useAppStore.getState().toggleGrid())}
          {check("Snap to grid", snapOn, () => useAppStore.getState().toggleSnap())}
          {check("Page backdrop", pageBackdrop, () => useAppStore.getState().togglePageBackdrop(),
            "The white page behind your shapes. Off = an infinite canvas")}
          {check("Show comments", commentsVisible, () => useCommentsStore.getState().toggleCommentsVisible())}
          {check("Zen mode (⌥Z)", false, () => { onClose(); useAppStore.getState().toggleZen(); },
            "Hide every toolbar — just the board")}
        </div>
      )}

      <div className="simple-menu-sep" />
      {row("Present", "play", () => useAppStore.getState().setPresenting(true), { disabled: !docId })}
      {row("Version history", "history", onHistory, { disabled: !docId })}
      {row("Share…", "share", onShare, { disabled: !docId })}
      {row("Keyboard shortcuts", "keys", () => useAppStore.getState().setShortcutsOpen(true), { hint: "?" })}
    </div>
  );
}
