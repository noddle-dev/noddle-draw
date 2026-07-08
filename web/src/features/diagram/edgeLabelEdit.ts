/**
 * features/diagram/edgeLabelEdit — inline label editing for a connector.
 *
 * Mirrors nodeTextEdit: an absolutely-positioned <input> over the edge midpoint
 * (in stage-pixel space), committing on Enter/blur, cancel on Escape. The label
 * is stored as a plain string and rendered as a React text node (never markup),
 * so no escaping is needed.
 */
import { contentToStage } from "../../editor-core";
import type { Vec } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";

export function beginEdgeLabelEdit(edgeId: string, midContent: Vec, blockId?: string): void {
  const refs = useEditorStore.getState().refs;
  if (!refs) return;
  const host = refs.host;
  const z = useEditorStore.getState().cam.z;
  const edge = useDiagramStore.getState().edges[edgeId];
  if (!edge) return;

  // blockId set → edit that multi-label block; else the legacy single label.
  const current = blockId
    ? (edge.labels?.find((l) => l.id === blockId)?.text ?? "")
    : (edge.label ?? "");

  const c = contentToStage(refs.content, host, midContent.x, midContent.y);

  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = current;
  inp.placeholder = "Label…";
  inp.className = "text-edit";
  const wScreen = Math.max(120 * z, 90);
  const fsScreen = 12 * z;
  inp.style.width = wScreen + "px";
  inp.style.height = fsScreen * 1.6 + "px";
  inp.style.left = c.x - wScreen / 2 + "px";
  inp.style.top = c.y - (fsScreen * 1.6) / 2 + "px";
  inp.style.fontSize = fsScreen + "px";
  inp.style.textAlign = "center";
  host.appendChild(inp);
  inp.focus();
  inp.select();

  useEditorStore
    .getState()
    .setStatus("Editing connector label · Enter to save · Esc to cancel.");

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit && inp.value !== current) {
      if (blockId) useDiagramStore.getState().setEdgeLabelText(edgeId, blockId, inp.value);
      else useDiagramStore.getState().setEdgeLabel(edgeId, inp.value);
      useEditorStore.getState().setStatus("Label updated.", "ok");
    } else if (!commit && blockId && current === "") {
      // Cancelled a brand-new empty block → drop it (no ghost).
      useDiagramStore.getState().setEdgeLabelText(edgeId, blockId, "");
    }
    inp.remove();
  };
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  });
}
