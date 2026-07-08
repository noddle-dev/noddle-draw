/**
 * features/properties — fill / stroke / stroke-width / opacity inspector for a
 * single selected object. Ported from renderProps()/normColor() in editor.js.
 *
 * SECURITY: attribute values (fill, stroke, id, tag) come from an uploaded SVG.
 * The vanilla version injected them into innerHTML, so esc() guarded the color
 * text inputs' `value` and the id/tag readout. In JSX these become controlled
 * input values / text children (React-escaped), but per the ADR invariant we
 * pass id/tag through esc() explicitly, and treat the raw attribute strings as
 * plain values fed to inputs (never as markup).
 */
import { useMemo } from "react";
import { esc, localName } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";

/** Normalise a color to a #rrggbb the <input type=color> can display. */
function normColor(c: string): string {
  if (!c || c === "none" || c.startsWith("url")) return "#000000";
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
    return c.length === 4
      ? "#" + [...c.slice(1)].map((x) => x + x).join("")
      : c;
  }
  return "#000000"; // named/other colours fall back for the swatch only
}

export function PropertiesPanel() {
  const selection = useEditorStore((s) => s.selection);
  const contentRev = useEditorStore((s) => s.contentRev);
  const beginAction = useEditorStore((s) => s.beginAction);
  const commitAction = useEditorStore((s) => s.commitAction);

  // Read attributes off the live element; recompute when selection/content change.
  const el = selection.length === 1 ? selection[0] : null;
  const props = useMemo(() => {
    if (!el) return null;
    const g = (attr: string, dflt: string): string =>
      el.getAttribute(attr) ||
      ((el.style as CSSStyleDeclaration).getPropertyValue(attr) || "") ||
      dflt;
    return {
      fillRaw: g("fill", ""),
      strokeRaw: g("stroke", ""),
      fill: normColor(g("fill", "#000000")),
      stroke: normColor(g("stroke", "#000000")),
      strokeWidth: parseFloat(g("stroke-width", "1")) || 0,
      opacity: g("opacity", "1"),
      id: el.id,
      tag: localName(el),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, contentRev]);

  if (selection.length !== 1 || !el || !props) {
    return (
      <p className="muted">
        {selection.length
          ? `${selection.length} objects selected.`
          : "Select an object to edit."}
      </p>
    );
  }

  const setAttr = (attr: string, val: string) => {
    beginAction();
    el.setAttribute(attr, val);
    commitAction();
  };

  return (
    <div className="props">
      <div className="row">
        <label>Fill</label>
        <div className="swatch-row">
          <input
            type="color"
            value={props.fill}
            onChange={(e) => setAttr("fill", e.target.value)}
          />
          <input
            type="text"
            defaultValue={props.fillRaw}
            key={`fill-${props.id}-${contentRev}`}
            onBlur={(e) => setAttr("fill", e.target.value)}
          />
        </div>
      </div>

      <div className="row">
        <label>Stroke</label>
        <div className="swatch-row">
          <input
            type="color"
            value={props.stroke}
            onChange={(e) => setAttr("stroke", e.target.value)}
          />
          <input
            type="text"
            defaultValue={props.strokeRaw}
            key={`stroke-${props.id}-${contentRev}`}
            onBlur={(e) => setAttr("stroke", e.target.value)}
          />
        </div>
      </div>

      <div className="row">
        <label>Stroke width</label>
        <input
          type="number"
          min={0}
          step={0.5}
          defaultValue={props.strokeWidth}
          key={`sw-${props.id}-${contentRev}`}
          onBlur={(e) => setAttr("stroke-width", e.target.value)}
        />
      </div>

      <div className="row">
        <label>Opacity</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          defaultValue={props.opacity}
          key={`op-${props.id}-${contentRev}`}
          onChange={(e) => setAttr("opacity", e.target.value)}
        />
      </div>

      <div className="row">
        <label>ID</label>
        {/* untrusted id/tag → esc() before display (ADR invariant) */}
        <span className="muted">
          {esc(props.id)} · {esc(props.tag)}
        </span>
      </div>
    </div>
  );
}
