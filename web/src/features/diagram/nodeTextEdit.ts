/**
 * features/diagram/nodeTextEdit — inline text editing for a diagram node.
 *
 * An absolutely-positioned <textarea> over the node's label on screen —
 * multi-line on purpose: **Enter inserts a line break** (the Excel/Lucid
 * expectation), ⌘/Ctrl+Enter or clicking away commits, Escape cancels.
 * Text is stored as a plain string in the store and rendered as React text
 * nodes (never injected as markup), so no escaping is needed.
 */
import { contentToStage } from "../../editor-core";
import type { DiagramNode } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";

export function beginNodeTextEdit(
  node: DiagramNode,
  opts?: {
    /** Type-to-edit: seed the editor with the first typed character,
     * REPLACING the current label (Lucid behavior), caret at the end. */
    seed?: string;
  },
): void {
  const refs = useEditorStore.getState().refs;
  if (!refs) return;
  const host = refs.host;
  const z = useEditorStore.getState().cam.z;

  // The label anchor in content space — must match NodeView's label position:
  // icon tiles caption the BOTTOM band (badge fills the top), everything else
  // is vertically centered. Otherwise the edit box floats over the glyph.
  const labelCy = node.kind === "icon" ? node.y + node.h * 0.87 : node.y + node.h / 2;
  const c = contentToStage(refs.content, host, node.x + node.w / 2, labelCy);

  // The editor is BORDERLESS chrome over the shape — hide the SVG label
  // underneath so the text doesn't render twice while typing.
  const svgLabel = host.querySelector<SVGTextElement>(
    `[data-diagram-node="${node.id}"] text`,
  );
  if (svgLabel) svgLabel.style.visibility = "hidden";

  const inp = document.createElement("textarea");
  inp.value = opts?.seed ?? node.text;
  inp.className = "text-edit in-shape";
  inp.rows = 1;
  inp.wrap = "off";
  const fsScreen = (node.fontSize ?? 14) * z;
  const lineH = fsScreen * 1.3;
  const wScreen = Math.max(node.w * z * 0.9, 80);
  const sizeToContent = () => {
    const linesN = inp.value.split("\n").length;
    const hScreen = Math.max(lineH * linesN + 8, lineH + 8);
    inp.style.height = hScreen + "px";
    inp.style.top = c.y - hScreen / 2 + "px";
  };
  inp.style.width = wScreen + "px";
  inp.style.left = c.x - wScreen / 2 + "px";
  inp.style.fontSize = fsScreen + "px";
  inp.style.lineHeight = lineH + "px";
  inp.style.textAlign = "center";
  inp.style.resize = "none";
  inp.style.overflow = "hidden";
  inp.style.whiteSpace = "pre";
  // Look like the label itself, not a form field.
  inp.style.color = node.textColor ?? "#1a1d23";
  inp.style.fontWeight = node.bold ? "700" : "400";
  inp.style.fontStyle = node.italic ? "italic" : "normal";
  if (node.sketch) {
    inp.style.fontFamily = '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive';
  }
  sizeToContent();
  host.appendChild(inp);
  inp.focus();
  if (opts?.seed) {
    inp.setSelectionRange(inp.value.length, inp.value.length); // keep typing
  } else {
    inp.select();
  }

  useEditorStore
    .getState()
    .setStatus("Editing text · Enter = new line · ⌘/Ctrl+Enter or click away to save · Esc cancels.");

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (svgLabel) svgLabel.style.visibility = "";
    // A TEXT element with nothing in it is invisible and unfindable — treat
    // an empty commit (or a cancelled brand-new one) as "never mind".
    if (node.kind === "text" && (commit ? inp.value : node.text).trim() === "") {
      const ds = useDiagramStore.getState();
      ds.setDiagramSelection([node.id]);
      ds.deleteSelectedDiagram();
      inp.remove();
      return;
    }
    if (commit && inp.value !== node.text) {
      useDiagramStore.getState().setNodeText(node.id, inp.value);
      useEditorStore.getState().setStatus("Text updated.", "ok");
    }
    inp.remove();
  };
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("input", sizeToContent);
  inp.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    const meta = ev.metaKey || ev.ctrlKey;
    if (ev.key === "Enter" && meta) {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    } else if (meta && !ev.shiftKey && ["b", "i", "u"].includes(ev.key.toLowerCase())) {
      // format WHILE typing — applies to the node being edited
      ev.preventDefault();
      const ds = useDiagramStore.getState();
      const n = ds.nodes[node.id];
      if (!n) return;
      const k = ev.key.toLowerCase();
      ds.updateNode(
        node.id,
        k === "b" ? { bold: !n.bold } : k === "i" ? { italic: !n.italic } : { underline: !n.underline },
      );
    } else if (meta && ev.shiftKey && [">", ".", "<", ","].includes(ev.key)) {
      ev.preventDefault();
      const ds = useDiagramStore.getState();
      const n = ds.nodes[node.id];
      if (!n) return;
      const delta = ev.key === ">" || ev.key === "." ? 1 : -1;
      ds.updateNode(node.id, {
        fontSize: Math.min(200, Math.max(6, (n.fontSize ?? 14) + delta)),
      });
    }
    // plain Enter falls through → the textarea inserts a line break
  });
}
