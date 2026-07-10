/**
 * features/editor/ShortcutsModal — the keyboard-shortcut cheat sheet.
 *
 * A read-only reference of every editor binding, grouped by task. Opened by
 * the topbar "?" button or the `?` key; closed by Esc / clicking the backdrop.
 * Keep the rows in sync with the handlers in features/canvas/Canvas.tsx.
 */
import { useEffect } from "react";
import { useAppStore } from "../../state/appStore";

/** ⌘ on macOS, Ctrl elsewhere — matches what the handlers actually accept. */
const MOD =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform)
    ? "⌘"
    : "Ctrl";

type Row = { keys: string[]; label: string };
type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Essentials",
    rows: [
      { keys: [MOD, "Z"], label: "Undo" },
      { keys: [MOD, "⇧", "Z"], label: "Redo" },
      { keys: [MOD, "A"], label: "Select everything" },
      { keys: ["Del"], label: "Delete selection" },
      { keys: [MOD, "D"], label: "Duplicate in place" },
      { keys: [MOD, "C"], label: "Copy" },
      { keys: [MOD, "X"], label: "Cut" },
      { keys: [MOD, "V"], label: "Paste" },
    ],
  },
  {
    title: "Arrange & format",
    rows: [
      { keys: [MOD, "G"], label: "Group selection" },
      { keys: [MOD, "⇧", "G"], label: "Ungroup" },
      { keys: [MOD, "B"], label: "Bold label" },
      { keys: [MOD, "I"], label: "Italic label" },
      { keys: [MOD, "U"], label: "Underline label" },
      { keys: [MOD, "⇧", "."], label: "Grow font size" },
      { keys: [MOD, "⇧", ","], label: "Shrink font size" },
    ],
  },
  {
    title: "View",
    rows: [
      { keys: ["["], label: "Toggle left panel" },
      { keys: ["]"], label: "Toggle right panel" },
      { keys: ["\\"], label: "Focus mode (just the canvas)" },
      { keys: [MOD, "+"], label: "Zoom in" },
      { keys: [MOD, "−"], label: "Zoom out" },
      { keys: [MOD, "0"], label: "Fit board to view" },
      { keys: ["⇧", "1"], label: "Fit board to view" },
    ],
  },
  {
    title: "Canvas",
    rows: [
      { keys: ["V"], label: "Select tool" },
      { keys: ["H"], label: "Pan tool" },
      { keys: ["Space", "drag"], label: "Pan the board" },
      { keys: ["type"], label: "Edit a selected shape's label" },
      { keys: ["dbl-click"], label: "Add a text element on empty canvas" },
      { keys: ["drag border"], label: "Draw a connector from a shape" },
      { keys: ["Esc"], label: "Clear selection · exit focus mode" },
    ],
  },
];

export function ShortcutsModal() {
  const close = () => useAppStore.getState().setShortcutsOpen(false);

  // Esc closes even when focus is on a button inside the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="gen-overlay" onClick={close}>
      <div
        className="gen-modal shortcuts-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <div className="shortcuts-head">
          <div className="t">⌨ Keyboard shortcuts</div>
          <button className="icon-btn" title="Close (Esc)" onClick={close}>✕</button>
        </div>
        <div className="shortcuts-grid">
          {GROUPS.map((g) => (
            <div key={g.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{g.title}</div>
              {g.rows.map((r) => (
                <div key={r.label} className="shortcuts-row">
                  <span className="shortcuts-label">{r.label}</span>
                  <span className="shortcuts-keys">
                    {r.keys.map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="shortcuts-foot">
          {MOD === "Ctrl" ? "Ctrl" : "⌘"} is Ctrl on Windows/Linux · press{" "}
          <kbd>?</kbd> any time to reopen this.
        </div>
      </div>
    </div>
  );
}
