/**
 * features/toolbar — top bar: tool switch, undo/redo, delete/front/back, upload,
 * export SVG/PNG, save. Ported from the toolbar/actions section of editor.js and
 * the header markup of index.html. All state goes through the store.
 */
import { useRef, type ChangeEvent } from "react";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { Button, IconButton } from "../../shared/ui";
import { useExport } from "./useExport";

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const selectionCount = useEditorStore((s) => s.selection.length);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const bringToFront = useEditorStore((s) => s.bringToFront);
  const sendToBack = useEditorStore((s) => s.sendToBack);
  const docId = useEditorStore((s) => s.docId);
  const docName = useEditorStore((s) => s.docName);
  const contentRev = useEditorStore((s) => s.contentRev);
  const uploadFile = useEditorStore((s) => s.uploadFile);
  const save = useEditorStore((s) => s.save);
  const diagramMode = useDiagramStore((s) => s.diagramMode);
  const setDiagramMode = useDiagramStore((s) => s.setDiagramMode);

  const { exportSvg, exportPng } = useExport();

  const hasContent = contentRev > 0;
  const noSelection = selectionCount === 0;

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void uploadFile(f);
    e.target.value = ""; // allow re-uploading the same file
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">◆</span> noddle
        <span className="tag">react</span>
        {/* docName is derived from server meta; React escapes it on render */}
        <span className="doc-name">{docName}</span>
      </div>

      <div className="toolbar">
        <IconButton
          active={tool === "select"}
          title="Select / move (V)"
          onClick={() => setTool("select")}
        >
          ▚ Select
        </IconButton>
        <IconButton
          active={tool === "pan"}
          title="Pan canvas (H / hold Space)"
          onClick={() => setTool("pan")}
        >
          ✥ Pan
        </IconButton>
        <span className="sep" />
        <IconButton title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>
          ↶
        </IconButton>
        <IconButton title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={redo}>
          ↷
        </IconButton>
        <span className="sep" />
        <IconButton
          title="Delete (Del)"
          disabled={noSelection}
          onClick={deleteSelection}
        >
          🗑 Delete
        </IconButton>
        <IconButton
          title="Bring to front"
          disabled={noSelection}
          onClick={bringToFront}
        >
          ⤒ Front
        </IconButton>
        <IconButton
          title="Send to back"
          disabled={noSelection}
          onClick={sendToBack}
        >
          ⤓ Back
        </IconButton>
        <span className="sep" />
        <IconButton
          active={diagramMode}
          title="Diagram mode (shapes + connectors)"
          onClick={() => setDiagramMode(!diagramMode)}
        >
          ◇ Diagram
        </IconButton>
      </div>

      <div className="actions">
        <label className="btn upload">
          ⬆ Upload SVG
          <input
            ref={fileInputRef}
            type="file"
            accept=".svg,image/svg+xml"
            hidden
            onChange={onFileChange}
          />
        </label>
        <Button disabled={!hasContent} onClick={exportSvg}>
          ⇩ SVG
        </Button>
        <Button disabled={!hasContent} onClick={() => exportPng()}>
          ⇩ PNG
        </Button>
        <Button variant="primary" disabled={!docId} onClick={() => void save()}>
          💾 Save
        </Button>
      </div>
    </header>
  );
}
