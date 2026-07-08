/**
 * features/documents — list stored documents; open on click. Ported from
 * refreshDocs()/openDoc() in editor.js. All I/O goes through shared/api via the
 * store actions (openDoc/refreshDocs/deleteDoc).
 *
 * Document names come from the server (originally the uploaded filename). React
 * renders them as text children (auto-escaped); we still run them through esc()
 * to preserve the carried XSS invariant explicitly.
 */
import { esc } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";

export function DocumentsPanel() {
  const docs = useEditorStore((s) => s.docs);
  const activeId = useEditorStore((s) => s.docId);
  const openDoc = useEditorStore((s) => s.openDoc);

  if (docs.length === 0) {
    return <p className="muted">Backend offline or no documents yet.</p>;
  }

  return (
    <ul className="doc-list">
      {docs.map((d) => (
        <li
          key={d.id}
          className={d.id === activeId ? "active" : undefined}
          title={new Date(d.updated_at * 1000).toLocaleString()}
          onClick={() => void openDoc(d.id)}
        >
          {esc(d.name)}
        </li>
      ))}
    </ul>
  );
}
