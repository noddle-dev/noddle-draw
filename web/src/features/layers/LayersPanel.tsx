/**
 * features/layers — the Layers panel. Ported from buildLayers() in editor.js.
 *
 * SECURITY: element ids and tag names come from an uploaded SVG (untrusted). In
 * the vanilla app they were injected via innerHTML, so esc() was mandatory.
 * Here React renders them as JSX text children, which React auto-escapes — but
 * we still pass them through esc() explicitly to preserve the carried invariant
 * from the ADR ("esc() untrusted values before render") and keep the security
 * boundary obvious to reviewers.
 */
import { esc } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";
import { useLayers } from "./useLayers";

export function LayersPanel() {
  const rows = useLayers();
  const setSelection = useEditorStore((s) => s.setSelection);
  const beginAction = useEditorStore((s) => s.beginAction);
  const commitAction = useEditorStore((s) => s.commitAction);

  const toggleVisibility = (el: SVGGraphicsElement, hidden: boolean) => {
    beginAction();
    el.setAttribute("display", hidden ? "inline" : "none");
    commitAction();
  };

  if (rows.length === 0) {
    return <p className="muted">No objects yet.</p>;
  }

  return (
    <ul className="layer-list">
      {rows.map((row) => (
        <li
          key={row.id}
          className={row.selected ? "selected" : undefined}
          onClick={() => setSelection([row.el])}
        >
          <span
            className="vis"
            onClick={(e) => {
              e.stopPropagation();
              toggleVisibility(row.el, row.hidden);
            }}
          >
            {row.hidden ? "🙈" : "👁"}
          </span>
          {/* esc() on untrusted id/tag — defense-in-depth over React escaping */}
          <span className="name">{esc(row.id)}</span>
          <span className="tagname">{esc(row.tag)}</span>
        </li>
      ))}
    </ul>
  );
}
