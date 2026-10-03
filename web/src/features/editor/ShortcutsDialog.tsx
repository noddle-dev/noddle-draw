/**
 * features/editor/ShortcutsDialog — the "?" keyboard-shortcuts sheet
 * (Excalidraw help dialog). Pure presentation: every key listed here is
 * handled in Canvas.tsx / SimpleMode.tsx — keep the two in sync.
 */
import { useEffect } from "react";
import { useAppStore } from "../../state/appStore";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Tools",
    rows: [
      ["H", "Hand (pan)"], ["1 · V", "Select"], ["2 · R", "Rectangle"], ["3 · T", "Text"],
      ["4 · O", "Ellipse"], ["5 · A", "Arrow"], ["6 · D", "Diamond"], ["P", "Pen"],
      ["E", "Eraser"], ["K", "Laser pointer"], ["L", "Library"], ["Q", "Keep tool active"],
    ],
  },
  {
    title: "Edit",
    rows: [
      ["⌘ Z", "Undo"], ["⌘ ⇧ Z", "Redo"], ["⌘ C / ⌘ V", "Copy / paste"], ["⌘ D", "Duplicate"],
      ["⌘ ⌥ C", "Copy styles"], ["⌘ ⌥ V", "Paste styles"], ["⌘ A", "Select all"],
      ["⌘ G / ⌘ ⇧ G", "Group / ungroup"], ["Del", "Delete"], ["Enter / type", "Edit label"],
    ],
  },
  {
    title: "Arrange",
    rows: [
      ["⌘ ]", "Bring forward"], ["⌘ [", "Send backward"], ["⌘ ⇧ ]", "Bring to front"],
      ["⌘ ⇧ [", "Send to back"], ["⇧ H", "Flip horizontal"], ["⇧ V", "Flip vertical"],
      ["⌘ B / I / U", "Bold / italic / underline"], ["⌘ ⇧ . / ,", "Bigger / smaller text"],
    ],
  },
  {
    title: "View",
    rows: [
      ["Space drag", "Pan the canvas"], ["⌘ + / ⌘ −", "Zoom"], ["⌘ 0 · ⇧ 1", "Fit to view"],
      ["⌥ Z", "Zen mode"], ["⌘ ⇧ C", "Copy as PNG"], ["⌘ S", "Save now"], ["?", "This sheet"],
    ],
  },
];

export function ShortcutsDialog() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const close = () => useAppStore.getState().setShortcutsOpen(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div className="kbd-dialog-backdrop" onPointerDown={close}>
      <div
        className="kbd-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="kbd-dialog-head">
          <span>Keyboard shortcuts</span>
          <button type="button" className="kbd-dialog-x" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4 L12 12 M12 4 L4 12" /></svg>
          </button>
        </div>
        <div className="kbd-dialog-grid">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h4>{g.title}</h4>
              {g.rows.map(([k, label]) => (
                <div className="kbd-dialog-row" key={k + label}>
                  <span>{label}</span>
                  <span className="kbd-dialog-keys">
                    {k.split(" ").map((part, i) =>
                      part === "/" || part === "·" ? <i key={i}>{part}</i> : <kbd key={i}>{part}</kbd>,
                    )}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
