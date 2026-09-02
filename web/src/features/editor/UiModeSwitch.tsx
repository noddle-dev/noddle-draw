/**
 * features/editor/UiModeSwitch — the prominent Full ↔ Simple layout toggle.
 *
 * One segmented control rendered in BOTH chromes (EditorTopbar in Full mode,
 * the top-right island cluster in Simple mode), always showing both options so
 * the other layout is discoverable at a glance — the gradient ring makes it
 * read as a feature, not furniture. State lives in appStore.uiMode (persisted
 * per browser); the ☰ menu's "Switch to Full interface" row stays as a backup.
 */
import { useAppStore } from "../../state/appStore";

export function UiModeSwitch() {
  const uiMode = useAppStore((s) => s.uiMode);
  const setUiMode = useAppStore((s) => s.setUiMode);
  return (
    <div className="uimode-switch" role="group" aria-label="Interface layout">
      {/* Text in its own span so narrow screens can go icon-only (CSS). */}
      <button
        className={uiMode === "full" ? "active" : ""}
        title="Full interface — panels, topbar, everything"
        aria-label="Full interface"
        aria-pressed={uiMode === "full"}
        onClick={() => setUiMode("full")}
      >
        <span aria-hidden="true">◰</span>
        <span className="t"> Full</span>
      </button>
      <button
        className={uiMode === "simple" ? "active" : ""}
        title="Simple interface — a minimal floating toolbar over the canvas"
        aria-label="Simple interface"
        aria-pressed={uiMode === "simple"}
        onClick={() => setUiMode("simple")}
      >
        <span aria-hidden="true">◱</span>
        <span className="t"> Simple</span>
      </button>
    </div>
  );
}
