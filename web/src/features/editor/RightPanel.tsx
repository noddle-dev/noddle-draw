/**
 * features/editor/RightPanel — Properties / Claude tabs, floated on the right
 * over the canvas (appStore.simplePanelOpen, toggled by the ◧ island).
 */
import { useAppStore } from "../../state/appStore";
import { PropertiesInspector } from "./PropertiesInspector";
import { ClaudeChat } from "./ClaudeChat";

export function RightPanel() {
  const rightTab = useAppStore((s) => s.rightTab);
  const setRightTab = useAppStore((s) => s.setRightTab);

  return (
    <div className="ed-panel right">
      <div className="ed-tabs bordered">
        <button className={`ed-tab${rightTab === "props" ? " active" : ""}`} onClick={() => setRightTab("props")}>Properties</button>
        <button className={`ed-tab${rightTab === "claude" ? " active" : ""}`} onClick={() => setRightTab("claude")}>
          ✦ AI-Noddle <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)", display: "inline-block" }} />
        </button>
        {/* its own × — the ◧ toggle top-right is easy to miss */}
        <button
          className="ed-panel-close"
          title="Close panel (Esc)"
          aria-label="Close panel"
          onClick={() => useAppStore.getState().setSimplePanelOpen(false)}
        >
          ×
        </button>
      </div>
      {rightTab === "props"
        ? <div className="scroll-y" style={{ flex: 1 }}><PropertiesInspector /></div>
        : <ClaudeChat />}
    </div>
  );
}
