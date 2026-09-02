/**
 * features/editor/DrawStylePanel — the Excalidraw-style left panel shown in
 * Simple mode while the DRAW tool is armed. Every control writes the shared
 * editorStore.drawStyle (persisted per browser, stamped on each new shape by
 * Canvas.startDrawShape) AND live-patches the currently selected diagram
 * nodes, so it works both as "style for what I'm about to draw" and "restyle
 * what I just drew".
 *
 * Field mapping (noddle node model): Stroke → stroke, Background → fill,
 * Stroke width → strokeWidth, Stroke style → strokeDash, Sloppiness → sketch,
 * Edges → cornerRadius, Opacity → opacity (1 ⇒ field removed).
 */
import type { DiagramNode } from "../../editor-core/diagram";
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";

const STROKES = ["#2d3142", "#dc2626", "#16a34a", "#2563eb", "#eb6c36"];
const FILLS: { v: string; label: string }[] = [
  { v: "transparent", label: "Transparent" },
  { v: "#ffffff", label: "White" },
  { v: "#fee2e2", label: "Soft red" },
  { v: "#dcfce7", label: "Soft green" },
  { v: "#dbeafe", label: "Soft blue" },
  { v: "#fef9c3", label: "Soft yellow" },
];

export function DrawStylePanel() {
  const style = useEditorStore((s) => s.drawStyle);
  const setDrawStyle = useEditorStore((s) => s.setDrawStyle);
  // With a selection, the panel MIRRORS the first selected node (Excalidraw)
  // and every control live-patches the whole selection; without one it edits
  // the pending draw style.
  const firstSel = useDiagramStore((s) => {
    const id = s.diagramSelection.find((x) => s.nodes[x]);
    return id ? s.nodes[id] : null;
  });
  const selCount = useDiagramStore(
    (s) => s.diagramSelection.filter((x) => s.nodes[x]).length,
  );
  // Arrow/connector variant: an EDGE selection (with no nodes) swaps the
  // panel to edge fields — same spot, same grammar, the Excalidraw arrow bar.
  const hasSelEdge = useDiagramStore((s) =>
    s.diagramSelection.some((x) => s.edges[x]),
  );

  /** Selection-only patch (animation etc.) — never saved into drawStyle. */
  const applySelection = (patch: Partial<DiagramNode>) => {
    const ds = useDiagramStore.getState();
    ds.diagramSelection.filter((id) => ds.nodes[id]).forEach((id) => ds.updateNode(id, patch));
  };

  /** Update the pending style AND any selected nodes (Excalidraw behavior). */
  const apply = (patch: Partial<DiagramNode>) => {
    setDrawStyle(patch);
    const ds = useDiagramStore.getState();
    ds.diagramSelection.filter((id) => ds.nodes[id]).forEach((id) => ds.updateNode(id, patch));
  };

  if (!firstSel && hasSelEdge) {
    return <EdgeQuickPanel />;
  }

  const src: Partial<DiagramNode> = firstSel ?? style;
  const stroke = src.stroke ?? "#2d3142";
  const fill = src.fill ?? "transparent";
  const width = src.strokeWidth ?? 2;
  const dash = src.strokeDash ?? "solid";
  const sketchy = src.sketch === true;
  // Drawn shapes default to a soft 3px radius; "rounded" means the big 12px.
  const round = (src.cornerRadius ?? 3) >= 8;
  const opacity = src.opacity ?? 1;

  return (
    <div className="draw-style" role="group" aria-label="Draw style">
      <div className="ds-label">Stroke</div>
      <div className="ds-row">
        {STROKES.map((c) => (
          <button
            key={c}
            className={`ds-swatch${stroke === c ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            aria-label={`Stroke ${c}`}
            onClick={() => apply({ stroke: c })}
          />
        ))}
      </div>

      <div className="ds-label">Background</div>
      <div className="ds-row">
        {FILLS.map((f) => (
          <button
            key={f.v}
            className={`ds-swatch${fill === f.v ? " active" : ""}${f.v === "transparent" ? " checker" : ""}`}
            style={f.v === "transparent" ? undefined : { background: f.v }}
            title={f.label}
            aria-label={`Background ${f.label}`}
            onClick={() => apply({ fill: f.v })}
          />
        ))}
      </div>

      <div className="ds-label">Stroke width</div>
      <div className="ds-row">
        {[2, 3, 5].map((w) => (
          <button
            key={w}
            className={`ds-opt${width === w ? " active" : ""}`}
            title={`${w}px`}
            aria-label={`Stroke width ${w}`}
            onClick={() => apply({ strokeWidth: w })}
          >
            <span style={{ width: 16, height: w, background: "currentColor", borderRadius: 2 }} />
          </button>
        ))}
      </div>

      <div className="ds-label">Stroke style</div>
      <div className="ds-row">
        {([
          ["solid", "———"],
          ["dashed", "– – –"],
          ["dotted", "· · ·"],
        ] as const).map(([v, glyph]) => (
          <button
            key={v}
            className={`ds-opt${dash === v ? " active" : ""}`}
            title={v}
            aria-label={`Stroke ${v}`}
            onClick={() => apply({ strokeDash: v === "solid" ? undefined : v })}
          >
            {glyph}
          </button>
        ))}
      </div>

      <div className="ds-label">Sloppiness</div>
      <div className="ds-row">
        <button
          className={`ds-opt${!sketchy ? " active" : ""}`}
          title="Clean lines"
          aria-label="Clean lines"
          onClick={() => apply({ sketch: undefined })}
        >
          <svg viewBox="0 0 24 12" width="22" height="11" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 8 C 8 4, 16 4, 22 6" /></svg>
        </button>
        <button
          className={`ds-opt${sketchy ? " active" : ""}`}
          title="Hand-drawn"
          aria-label="Hand-drawn"
          onClick={() => apply({ sketch: true })}
        >
          <svg viewBox="0 0 24 12" width="22" height="11" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 8 q 4 -6 7 -2 t 6 -1 t 7 1" /></svg>
        </button>
      </div>

      <div className="ds-label">Edges</div>
      <div className="ds-row">
        <button
          className={`ds-opt${!round ? " active" : ""}`}
          title="Sharp corners"
          aria-label="Sharp corners"
          onClick={() => apply({ cornerRadius: 0 })}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 13 V3 H13" /></svg>
        </button>
        <button
          className={`ds-opt${round ? " active" : ""}`}
          title="Rounded corners"
          aria-label="Rounded corners"
          onClick={() => apply({ cornerRadius: 12 })}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 13 V8 a5 5 0 0 1 5-5 H13" /></svg>
        </button>
      </div>

      <div className="ds-label">Opacity</div>
      <input
        className="ds-slider"
        type="range"
        min={10}
        max={100}
        step={10}
        value={Math.round(opacity * 100)}
        aria-label="Opacity"
        onChange={(e) => {
          const v = Number(e.target.value) / 100;
          apply({ opacity: v >= 1 ? undefined : v }); // 1 ⇒ field removed
        }}
      />

      {selCount > 0 && (
        <>
          <div className="ds-label">Animation</div>
          <div className="ds-row">
            {([undefined, "pulse", "glow", "breathe", "wobble"] as const).map((a) => (
              <button
                key={a ?? "none"}
                className={`ds-opt${(firstSel?.anim ?? undefined) === a ? " active" : ""}`}
                title={a ? { pulse: "Rhythmic scale", glow: "Breathing glow", breathe: "Steady fade", wobble: "Gentle wobble" }[a] : "No animation"}
                aria-label={a ? `Animation ${a}` : "No animation"}
                onClick={() => applySelection({ anim: a })}
              >
                {a ? a.charAt(0).toUpperCase() + a.slice(1) : "None"}
              </button>
            ))}
          </div>
          {firstSel?.anim && (
            <div className="ds-row" style={{ marginTop: 5 }}>
              {([[0.5, "Slow"], [1, "Normal"], [2, "Fast"]] as const).map(([v, label]) => (
                <button
                  key={v}
                  className={`ds-opt${(firstSel?.animSpeed ?? 1) === v ? " active" : ""}`}
                  title={`${label} (${v}\u00d7)`}
                  aria-label={`Animation speed ${label}`}
                  onClick={() => applySelection({ animSpeed: v })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="ds-label">Layers</div>
          <div className="ds-row">
            <button
              className="ds-opt"
              title="Send to back"
              aria-label="Send to back"
              onClick={() => {
                const ds = useDiagramStore.getState();
                ds.sendNodesToBack(ds.diagramSelection.filter((id) => ds.nodes[id]));
              }}
            >
              ⤓
            </button>
            <button
              className="ds-opt"
              title="Bring to front"
              aria-label="Bring to front"
              onClick={() => {
                const ds = useDiagramStore.getState();
                ds.bringNodesToFront(ds.diagramSelection.filter((id) => ds.nodes[id]));
              }}
            >
              ⤒
            </button>
          </div>
          <div className="ds-label">Actions</div>
          <div className="ds-row">
            <button
              className="ds-opt"
              title="Duplicate"
              aria-label="Duplicate selection"
              onClick={() => useDiagramStore.getState().duplicateSelection()}
            >
              ⧉
            </button>
            <button
              className="ds-opt"
              title="Delete"
              aria-label="Delete selection"
              onClick={() => useDiagramStore.getState().deleteSelectedDiagram()}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2.5 4.5 h11 M6.5 2.5 h3 M4 4.5 l.8 9 a1 1 0 0 0 1 .9 h4.4 a1 1 0 0 0 1-.9 l.8-9 M6.5 7 v4.5 M9.5 7 v4.5" />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Quick style bar for a selected CONNECTOR — stroke, width, dash, routing,
 * end head, plus delete. Live-patches every selected edge. */
function EdgeQuickPanel() {
  const firstEdge = useDiagramStore((s) => {
    const id = s.diagramSelection.find((x) => s.edges[x]);
    return id ? s.edges[id] : null;
  });
  if (!firstEdge) return null;

  const applyEdge = (patch: Record<string, unknown>) => {
    const ds = useDiagramStore.getState();
    ds.diagramSelection
      .filter((id) => ds.edges[id])
      .forEach((id) => ds.updateEdge(id, patch));
  };

  const heads = ["none", "arrow", "triangle", "circle", "diamond"] as const;
  const headGlyph: Record<string, string> = {
    none: "\u2014", arrow: "\u25b6", triangle: "\u25b7", circle: "\u25cf", diamond: "\u25c6",
  };
  const endHead = firstEdge.endHead ?? (firstEdge.endArrow ? "arrow" : "none");

  return (
    <div className="draw-style" role="group" aria-label="Connector style">
      <div className="ds-label">Stroke</div>
      <div className="ds-row">
        {STROKES.map((c) => (
          <button
            key={c}
            className={`ds-swatch${firstEdge.stroke === c ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            aria-label={`Stroke ${c}`}
            onClick={() => applyEdge({ stroke: c })}
          />
        ))}
      </div>

      <div className="ds-label">Stroke width</div>
      <div className="ds-row">
        {[2, 3, 5].map((w) => (
          <button
            key={w}
            className={`ds-opt${firstEdge.strokeWidth === w ? " active" : ""}`}
            title={`${w}px`}
            aria-label={`Stroke width ${w}`}
            onClick={() => applyEdge({ strokeWidth: w })}
          >
            <span style={{ width: 16, height: w, background: "currentColor", borderRadius: 2 }} />
          </button>
        ))}
      </div>

      <div className="ds-label">Stroke style</div>
      <div className="ds-row">
        {([["solid", "\u2014\u2014"], ["dashed", "\u2013 \u2013"], ["dotted", "\u00b7 \u00b7 \u00b7"]] as const).map(([v, glyph]) => (
          <button
            key={v}
            className={`ds-opt${(firstEdge.dash ?? "solid") === v ? " active" : ""}`}
            title={v}
            aria-label={`Stroke ${v}`}
            onClick={() => applyEdge({ dash: v === "solid" ? undefined : v })}
          >
            {glyph}
          </button>
        ))}
      </div>

      <div className="ds-label">Line</div>
      <div className="ds-row">
        {([["straight", "Straight"], ["elbow", "Elbow"]] as const).map(([v, label]) => (
          <button
            key={v}
            className={`ds-opt${firstEdge.routing === v ? " active" : ""}`}
            title={label}
            aria-label={`${label} routing`}
            onClick={() => applyEdge({ routing: v })}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="ds-label">End head</div>
      <div className="ds-row">
        {heads.map((h) => (
          <button
            key={h}
            className={`ds-opt${endHead === h ? " active" : ""}`}
            title={h}
            aria-label={`End head ${h}`}
            onClick={() => applyEdge({ endHead: h, endArrow: h !== "none" })}
          >
            {headGlyph[h]}
          </button>
        ))}
      </div>

      <div className="ds-label">Actions</div>
      <div className="ds-row">
        <button
          className="ds-opt"
          title="Delete"
          aria-label="Delete connector"
          onClick={() => useDiagramStore.getState().deleteSelectedDiagram()}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2.5 4.5 h11 M6.5 2.5 h3 M4 4.5 l.8 9 a1 1 0 0 0 1 .9 h4.4 a1 1 0 0 0 1-.9 l.8-9 M6.5 7 v4.5 M9.5 7 v4.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
