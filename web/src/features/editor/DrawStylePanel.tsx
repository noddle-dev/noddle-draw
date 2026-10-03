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
import type { DiagramEdge, DiagramNode, PenBrush } from "../../editor-core/diagram";
import { useDiagramStore } from "../../state/diagramStore";
import { arrangeSelection, flipSelection } from "../../state/arrange";
import { DEFAULT_BRUSH, useEditorStore } from "../../state/editorStore";

const STROKES = ["#2d3142", "#dc2626", "#16a34a", "#2563eb", "#eb6c36"];
/** A #rrggbb for <input type=color> (it rejects names / rgba / "transparent"). */
function toHex(v: string | undefined): string {
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000";
}

/**
 * The last swatch of every colour row: a rainbow well that opens the system
 * colour picker. When the current value is off-palette it shows THAT colour
 * and reads as selected, so a custom pick never looks unselected.
 */
function ColorWell({ value, presets, label, onPick }: {
  value: string | undefined;
  presets: string[];
  label: string;
  onPick: (c: string) => void;
}) {
  const v = (value ?? "").toLowerCase();
  const custom = !!v && v !== "transparent" && v !== "none" && !presets.some((p) => p.toLowerCase() === v);
  return (
    <label className={`ds-swatch ds-well${custom ? " active custom" : ""}`} title={`${label}: custom colour`}
      style={custom ? { background: value } : undefined}>
      <input type="color" value={toHex(value)} aria-label={`${label} custom colour`}
        onChange={(e) => onPick(e.target.value)} />
    </label>
  );
}

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
  const tool = useEditorStore((s) => s.tool);
  const allSelFreedraw = useDiagramStore((s) => {
    const ns = s.diagramSelection.map((id) => s.nodes[id]).filter(Boolean);
    return ns.length > 0 && ns.every((n) => n.kind === "freedraw");
  });
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
  // Pen armed, or only pen strokes selected → the pen's own short panel.
  if ((tool === "pen" && !firstSel) || (firstSel && allSelFreedraw)) {
    return <PenPanel />;
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
            {([
              ["back", "Send to back (⌘⇧[)", "M8 2.5 V10 M5 7 L8 10 L11 7 M3 13.5 H13"],
              ["backward", "Send backward (⌘[)", "M8 3 V12 M5 9 L8 12 L11 9"],
              ["forward", "Bring forward (⌘])", "M8 13 V4 M5 7 L8 4 L11 7"],
              ["front", "Bring to front (⌘⇧])", "M8 13.5 V6 M5 9 L8 6 L11 9 M3 2.5 H13"],
            ] as const).map(([dir, title, d]) => (
              <button key={dir} className="ds-opt" title={title} aria-label={title} onClick={() => arrangeSelection(dir)}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
              </button>
            ))}
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
            <button className="ds-opt" title="Flip horizontal (⇧H)" aria-label="Flip horizontal" onClick={() => flipSelection("h")}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2 V14 M6 4.5 L2.5 11.5 H6 Z M10 4.5 L13.5 11.5 H10 Z" /></svg>
            </button>
            <button className="ds-opt" title="Flip vertical (⇧V)" aria-label="Flip vertical" onClick={() => flipSelection("v")}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 8 H14 M4.5 6 L11.5 2.5 V6 Z M4.5 10 L11.5 13.5 V10 Z" /></svg>
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

/** Pen widths (px) — finer steps than shape borders, ink needs them. */
const PEN_WIDTHS: { v: number; label: string }[] = [
  { v: 1, label: "Fine" },
  { v: 2, label: "Medium" },
  { v: 4, label: "Bold" },
  { v: 7, label: "Marker" },
];

/**
 * Pen panel (Excalidraw freedraw): the three properties a basic pen has —
 * colour, thickness, opacity. With strokes selected it edits them live AND
 * becomes the pen's next style; with the pen armed it only sets the style.
 */
function PenPanel() {
  const pen = useEditorStore((s) => s.penStyle);
  const setPenStyle = useEditorStore((s) => s.setPenStyle);
  const first = useDiagramStore((s) => {
    const id = s.diagramSelection.find((x) => s.nodes[x]?.kind === "freedraw");
    return id ? s.nodes[id] : null;
  });
  const src = first
    ? { stroke: first.stroke, strokeWidth: first.strokeWidth, opacity: first.opacity, brush: { ...DEFAULT_BRUSH, ...first.pen } }
    : { ...pen, brush: { ...DEFAULT_BRUSH, ...pen.brush } };
  const apply = (patch: Partial<DiagramNode>) => {
    setPenStyle(patch as never);
    const ds = useDiagramStore.getState();
    ds.diagramSelection.filter((id) => ds.nodes[id]?.kind === "freedraw").forEach((id) => ds.updateNode(id, patch));
  };
  /** Brush settings merge into BOTH the pen style and every selected stroke. */
  const applyBrush = (patch: PenBrush) => {
    const brush = { ...src.brush, ...patch };
    setPenStyle({ brush });
    const ds = useDiagramStore.getState();
    ds.diagramSelection
      .filter((id) => ds.nodes[id]?.kind === "freedraw")
      .forEach((id) => ds.updateNode(id, { pen: { ...DEFAULT_BRUSH, ...ds.nodes[id].pen, ...patch } }));
  };
  const opacity = src.opacity ?? 1;
  const b = src.brush;
  return (
    <div className="draw-style" role="group" aria-label="Pen style">
      {/* Photoshop-basic brush controls: type, pressure (thick-thin) + taper,
          smoothing, hardness — plus colour / size / opacity below. */}
      <div className="ds-label">Brush</div>
      <div className="ds-row">
        {(["pen", "marker", "highlighter"] as const).map((t) => (
          <button key={t} className={`ds-opt ds-opt-wide${(b.type ?? "pen") === t ? " active" : ""}`}
            aria-label={`Brush ${t}`} title={{ pen: "Pen — ink that thins with speed", marker: "Marker — even, flat stroke", highlighter: "Highlighter — wide, see-through" }[t]}
            onClick={() => applyBrush({ type: t })}>
            {t === "pen" ? "Pen" : t === "marker" ? "Marker" : "Highlight"}
          </button>
        ))}
      </div>
      <div className="ds-label">Stroke</div>
      <div className="ds-row">
        {STROKES.map((c) => (
          <button key={c} className={`ds-swatch${src.stroke === c ? " active" : ""}`} style={{ background: c }}
            title={c} aria-label={`Pen colour ${c}`} onClick={() => apply({ stroke: c })} />
        ))}
        <ColorWell value={src.stroke} presets={STROKES} label="Pen" onPick={(c) => apply({ stroke: c })} />
      </div>
      <div className="ds-label">Stroke width</div>
      <div className="ds-row">
        {PEN_WIDTHS.map((w) => (
          <button key={w.v} className={`ds-opt${src.strokeWidth === w.v ? " active" : ""}`} title={`${w.label} (${w.v}px)`}
            aria-label={`Pen width ${w.label}`} onClick={() => apply({ strokeWidth: w.v })}>
            <svg viewBox="0 0 24 12" width="22" height="12" aria-hidden="true">
              <path d="M2 8 C7 2, 12 11, 22 4" fill="none" stroke="currentColor" strokeWidth={Math.min(6, w.v)} strokeLinecap="round" />
            </svg>
          </button>
        ))}
      </div>
      {(b.type ?? "pen") === "pen" && (
        <>
          <div className="ds-label">
            Pressure <span className="ds-val">{Math.round((b.thinning ?? 0) * 100)}%</span>
          </div>
          <div className="ds-row" style={{ alignItems: "center" }}>
            <input className="ds-slider" style={{ flex: 1 }} type="range" min={0} max={100} step={5}
              value={Math.round((b.thinning ?? 0) * 100)} aria-label="Pen pressure (thick-thin)"
              onChange={(e) => applyBrush({ thinning: Number(e.target.value) / 100 })} />
            <button className={`ds-opt${b.taper ? " active" : ""}`} title="Taper both ends" aria-label="Taper ends"
              aria-pressed={!!b.taper} onClick={() => applyBrush({ taper: !b.taper })}>
              <svg viewBox="0 0 24 12" width="20" height="12" aria-hidden="true">
                <path d="M2 6 Q12 0 22 6 Q12 12 2 6 Z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </>
      )}
      <div className="ds-label">
        Smoothing <span className="ds-val">{Math.round((b.smoothing ?? 0) * 100)}%</span>
      </div>
      <input className="ds-slider" type="range" min={0} max={100} step={5}
        value={Math.round((b.smoothing ?? 0) * 100)} aria-label="Pen smoothing"
        onChange={(e) => applyBrush({ smoothing: Number(e.target.value) / 100 })} />
      <div className="ds-label">Hardness</div>
      <div className="ds-row">
        {([[0, "Hard"], [0.4, "Medium"], [0.8, "Soft"]] as const).map(([v, label]) => (
          <button key={label} className={`ds-opt ds-opt-wide${(b.softness ?? 0) === v ? " active" : ""}`}
            aria-label={`Hardness ${label}`} onClick={() => applyBrush({ softness: v })}>
            {label}
          </button>
        ))}
      </div>
      <div className="ds-label">Opacity</div>
      <input className="ds-slider" type="range" min={10} max={100} step={10} value={Math.round(opacity * 100)}
        aria-label="Pen opacity"
        onChange={(e) => {
          const v = Number(e.target.value) / 100;
          apply({ opacity: v >= 1 ? undefined : v });
        }} />
      {first && (
        <>
          <div className="ds-label">Actions</div>
          <div className="ds-row">
            <button className="ds-opt" title="Delete" aria-label="Delete selection"
              onClick={() => useDiagramStore.getState().deleteSelectedDiagram()}>
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

  const applyEdge = (patch: Partial<DiagramEdge>) => {
    // The next connector is born with this style (Excalidraw remembers it).
    useEditorStore.getState().setEdgeStyle(patch);
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
        {([["straight", "Straight"], ["curved", "Curved"], ["elbow", "Elbow"]] as const).map(([v, label]) => (
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
