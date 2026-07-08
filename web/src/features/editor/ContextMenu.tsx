/**
 * features/editor/ContextMenu — right-click menu on diagram objects.
 *
 * Right-click a node/edge (or a multi-selection) →
 *   ✦ Enrich with AI   — inline prompt applied ONLY to the selected ids
 *   ✦ Smart group      — semantic auto-grouping of the whole board
 *   ⬆/⬇ Front / Back   — z-order among diagram nodes
 *   ✕ Delete           — delete the selection
 * All AI actions ride the same non-blocking chat queue (per-board session).
 */
import { useState } from "react";
import { useAppStore } from "../../state/appStore";
import { useDiagramStore } from "../../state/diagramStore";
import { askClaudeEditSelection, askClaudeGroupBy } from "./claudeEdit";

export interface CtxMenuState {
  x: number;
  y: number;
  ids: string[];
}

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: CtxMenuState;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const nodeIds = menu.ids.filter((id) => nodes[id]);
  // Exactly one edge selected → offer "add a connected shape" at either end.
  const soleEdgeId = menu.ids.length === 1 && edges[menu.ids[0]] ? menu.ids[0] : null;

  const addShape = (which: "source" | "target") => {
    if (!soleEdgeId) return;
    const id = useDiagramStore.getState().addNodeFromEdge(soleEdgeId, which);
    if (id) useDiagramStore.getState().setDiagramSelection([id]);
    onClose();
  };

  const enrich = () => {
    if (!prompt.trim()) return;
    useAppStore.getState().setRightTab("claude");
    askClaudeEditSelection(prompt, menu.ids);
    onClose();
  };
  const groupBy = () => {
    useAppStore.getState().setRightTab("claude");
    askClaudeGroupBy();
    onClose();
  };
  const front = () => {
    useDiagramStore.getState().bringNodesToFront(nodeIds);
    onClose();
  };
  const back = () => {
    useDiagramStore.getState().sendNodesToBack(nodeIds);
    onClose();
  };
  const copy = () => {
    const ds = useDiagramStore.getState();
    ds.setDiagramSelection(menu.ids);
    ds.copySelection();
    onClose();
  };
  const duplicate = () => {
    const ds = useDiagramStore.getState();
    ds.setDiagramSelection(menu.ids);
    ds.duplicateSelection();
    onClose();
  };
  const remove = () => {
    useDiagramStore.getState().setDiagramSelection(menu.ids);
    useDiagramStore.getState().deleteSelectedDiagram();
    onClose();
  };

  return (
    <>
      <div className="menu-backdrop" style={{ zIndex: 95 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="menu-pop ctx-menu"
        style={{ left: menu.x, top: menu.y, right: "auto", position: "fixed", zIndex: 96, width: 280 }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="menu-body">
          <div style={{ padding: "6px 8px 8px" }}>
            <div className="props-label" style={{ marginBottom: 6 }}>
              ✦ Enrich {menu.ids.length} object(s) with AI
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="text-input"
                style={{ flex: 1, fontSize: 12 }}
                autoFocus
                placeholder="e.g.: change color to orange, add an icon, rename it…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") enrich(); }}
              />
              <button className="chat-send" style={{ width: 32, height: 32 }} onClick={enrich}>↑</button>
            </div>
          </div>
          <div className="menu-row" onClick={groupBy}>
            <span className="ico">✦</span><span style={{ flex: 1 }}>Smart group (whole board)</span>
          </div>
          {soleEdgeId && (
            <>
              <div className="menu-row" onClick={() => addShape("target")}>
                <span className="ico">＋</span><span style={{ flex: 1 }}>Add shape at arrow tip</span>
              </div>
              <div className="menu-row" onClick={() => addShape("source")}>
                <span className="ico">＋</span><span style={{ flex: 1 }}>Add shape at arrow start</span>
              </div>
            </>
          )}
          <div className="menu-row" onClick={copy}>
            <span className="ico">⧉</span><span style={{ flex: 1 }}>Copy</span>
            <span className="muted" style={{ fontSize: 11 }}>⌘C</span>
          </div>
          <div className="menu-row" onClick={duplicate}>
            <span className="ico">⊕</span><span style={{ flex: 1 }}>Duplicate</span>
            <span className="muted" style={{ fontSize: 11 }}>⌘D</span>
          </div>
          {nodeIds.length > 0 && (
            <>
              <div className="menu-row" onClick={front}>
                <span className="ico">⬆</span><span style={{ flex: 1 }}>Bring to front</span>
              </div>
              <div className="menu-row" onClick={back}>
                <span className="ico">⬇</span><span style={{ flex: 1 }}>Send to back</span>
              </div>
            </>
          )}
          <div className="menu-row" style={{ color: "var(--danger)" }} onClick={remove}>
            <span className="ico">✕</span><span style={{ flex: 1 }}>Delete</span>
          </div>
        </div>
      </div>
    </>
  );
}
