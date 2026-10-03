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
import type { DiagramNode, NodeFontFamily, PenBrush } from "../../editor-core/diagram";
import { FONT_STACKS, LABEL_INK } from "../diagram/typography";
import { useDiagramStore } from "../../state/diagramStore";
import { groupSelected, groupState, ungroupSelected } from "../../state/grouping";
import { arrangeSelection, flipSelection } from "../../state/arrange";
import { DEFAULT_BRUSH, DRAW_STYLE_DEFAULTS, useEditorStore } from "../../state/editorStore";

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

/** Stroke + matching pastel fill — built from the STROKES/FILLS above so a
 * preset always lands on swatches the rows can show as selected. */
const STYLE_PAIRS: { name: string; stroke: string; fill: string }[] = [
  { name: "Ink", stroke: "#2d3142", fill: "#ffffff" },
  { name: "Red", stroke: "#dc2626", fill: "#fee2e2" },
  { name: "Green", stroke: "#16a34a", fill: "#dcfce7" },
  { name: "Blue", stroke: "#2563eb", fill: "#dbeafe" },
  { name: "Ember", stroke: "#eb6c36", fill: "#fef9c3" },
];

const FILLS: { v: string; label: string }[] = [
  { v: "transparent", label: "Transparent" },
  { v: "#ffffff", label: "White" },
  { v: "#fee2e2", label: "Soft red" },
  { v: "#dcfce7", label: "Soft green" },
  { v: "#dbeafe", label: "Soft blue" },
  { v: "#fef9c3", label: "Soft yellow" },
];

/** Excalidraw-style S/M/L/XL — M is the renderer default (14px). */
const FONT_SIZES = [
  { v: 12, label: "S" },
  { v: 14, label: "M" },
  { v: 20, label: "L" },
  { v: 28, label: "XL" },
];
/** The three typeface TOKENS — stacks resolve in typography.ts. */
const FAMILIES: { v: NodeFontFamily; label: string }[] = [
  { v: "sans", label: "Sans" },
  { v: "serif", label: "Serif" },
  { v: "mono", label: "Mono" },
];

/** Doodle text-align glyph: three lines flush to one side. */
function AlignGlyph({ align }: { align: "left" | "center" | "right" }) {
  const rows = [12, 8, 10];
  const x = (w: number) => (align === "left" ? 2 : align === "right" ? 14 - w : 8 - w / 2);
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      {rows.map((w, i) => (
        <path key={i} d={`M${x(w)} ${4 + i * 4} h${w}`} />
      ))}
    </svg>
  );
}

export function DrawStylePanel() {
  const style = useEditorStore((s) => s.drawStyle);
  const armedInit = useEditorStore((s) => (s.tool === "draw" ? s.drawSpec?.init : undefined));
  const tool = useEditorStore((s) => s.tool);
  const allSelFreedraw = useDiagramStore((s) => {
    const ns = s.diagramSelection.map((id) => s.nodes[id]).filter(Boolean);
    return ns.length > 0 && ns.every((n) => n.kind === "freedraw");
  });
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
  const grpNodes = useDiagramStore((s) => s.nodes);
  const grpSel = useDiagramStore((s) => s.diagramSelection);
  const grp = groupState(grpNodes, grpSel);
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

  // No selection: show EXACTLY what the next drawn shape will wear — the
  // same merge Canvas.startDrawShape stamps (defaults < armed entry < picks).
  const src: Partial<DiagramNode> = firstSel ?? { ...DRAW_STYLE_DEFAULTS, ...armedInit, ...style };
  const stroke = src.stroke ?? "#2d3142";
  const fill = src.fill ?? "transparent";
  const width = src.strokeWidth ?? 2;
  const dash = src.strokeDash ?? "solid";
  const sketchy = src.sketch === true;
  // "Rounded" = the big 12px (the house default); legacy shapes carry 0–3px.
  const round = (src.cornerRadius ?? 3) >= 8;
  const opacity = src.opacity ?? 1;
  const fontSize = src.fontSize ?? 14;
  const family = src.fontFamily ?? "sans";
  const align = src.textAlign ?? "center";
  const textColor = src.textColor ?? LABEL_INK;

  return (
    <div className="draw-style" role="group" aria-label="Draw style">
      {/* Selection bar — grouping lives at the TOP so it is seen the moment
          several shapes are picked (it used to sit below the fold). */}
      {(grp.canGroup || grp.canUngroup) && (
        <div className="ds-selbar">
          <span className="ds-selcount">
            {grp.wholeGroup ? "Group" : `${selCount} selected`}
          </span>
          {grp.canGroup && (
            <button className="ds-opt ds-opt-wide" title="Group (⌘G) — move them as one" aria-label="Group selection" onClick={groupSelected}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 2.5 h3 M10.5 2.5 h3 v3 M13.5 10.5 v3 h-3 M5.5 13.5 h-3 v-3 M2.5 5.5 v-3" /><path d="M5 5 h3.5 v3.5 H5 Z M8 8 h3 v3 H8 Z" /></svg> Group
            </button>
          )}
          {grp.canUngroup && (
            <button className="ds-opt ds-opt-wide" title="Ungroup (⌘⇧G)" aria-label="Ungroup selection" onClick={ungroupSelected}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 2.5 h4 v4 h-4 Z M9.5 9.5 h4 v4 h-4 Z" /><path d="M8.5 3.5 h4 M3.5 8.5 v4" strokeDasharray="1.6 1.8" /></svg> Ungroup
            </button>
          )}
        </div>
      )}
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
        <ColorWell value={stroke} presets={STROKES} label="Stroke" onPick={(c) => apply({ stroke: c })} />
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
        <ColorWell value={fill} presets={FILLS.map((f) => f.v)} label="Background" onPick={(c) => apply({ fill: c })} />
      </div>

      {/* One-click harmonised pairs (stroke + its own pastel fill) — moved
          here from the Properties inspector so the whole look sits in one
          place, right under the two colour rows it combines. */}
      <div className="ds-label">Style</div>
      <div className="ds-row ds-presets">
        {STYLE_PAIRS.map((p) => {
          const on = stroke.toLowerCase() === p.stroke && fill.toLowerCase() === p.fill;
          return (
            <button
              key={p.name}
              className={`ds-preset${on ? " active" : ""}`}
              title={p.name}
              aria-label={`Style ${p.name}`}
              style={{ background: p.fill, borderColor: p.stroke }}
              onClick={() => apply({ stroke: p.stroke, fill: p.fill })}
            >
              <span style={{ background: p.stroke }} />
            </button>
          );
        })}
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
          onClick={() => apply({ sketch: false })}
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

      {/* Text — the label of the selected shape(s) / the next shape or text
          label drawn. Picks are stored EXPLICITLY (never "undefined = back to
          default"): DRAW_STYLE_DEFAULTS is not the renderer default, so a
          removed key would snap back to the house style instead. */}
      <div className="ds-label">Font size</div>
      <div className="ds-row">
        {FONT_SIZES.map((f) => (
          <button
            key={f.v}
            className={`ds-opt${fontSize === f.v ? " active" : ""}`}
            title={`${f.label} (${f.v}px)`}
            aria-label={`Font size ${f.label}`}
            onClick={() => apply({ fontSize: f.v })}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="ds-label">Font family</div>
      <div className="ds-row">
        {FAMILIES.map((f) => (
          <button
            key={f.v}
            className={`ds-opt${family === f.v ? " active" : ""}`}
            style={{ fontFamily: FONT_STACKS[f.v] }}
            title={f.label}
            aria-label={`Font ${f.label}`}
            onClick={() => apply({ fontFamily: f.v })}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="ds-label">Text style</div>
      <div className="ds-row">
        <button
          className={`ds-opt${src.bold ? " active" : ""}`}
          style={{ fontWeight: 800 }}
          title="Bold (⌘B)"
          aria-label="Bold"
          aria-pressed={!!src.bold}
          onClick={() => apply({ bold: !src.bold })}
        >
          B
        </button>
        <button
          className={`ds-opt${src.italic ? " active" : ""}`}
          style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }}
          title="Italic (⌘I)"
          aria-label="Italic"
          aria-pressed={!!src.italic}
          onClick={() => apply({ italic: !src.italic })}
        >
          I
        </button>
        <button
          className={`ds-opt${src.underline ? " active" : ""}`}
          style={{ textDecoration: "underline" }}
          title="Underline (⌘U)"
          aria-label="Underline"
          aria-pressed={!!src.underline}
          onClick={() => apply({ underline: !src.underline })}
        >
          U
        </button>
      </div>

      <div className="ds-label">Text align</div>
      <div className="ds-row">
        {(["left", "center", "right"] as const).map((a) => (
          <button
            key={a}
            className={`ds-opt${align === a ? " active" : ""}`}
            title={`Align ${a}`}
            aria-label={`Align ${a}`}
            onClick={() => apply({ textAlign: a })}
          >
            <AlignGlyph align={a} />
          </button>
        ))}
      </div>

      <div className="ds-label">Text color</div>
      <div className="ds-row">
        {STROKES.map((c) => (
          <button
            key={c}
            className={`ds-swatch${textColor === c ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            aria-label={`Text color ${c}`}
            onClick={() => apply({ textColor: c })}
          />
        ))}
        <ColorWell value={textColor} presets={STROKES} label="Text" onPick={(c) => apply({ textColor: c })} />
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
          {selCount >= 2 && (
            <>
              <div className="ds-label">Align</div>
              <div className="ds-row" data-testid="ds-align">
                {([
                  ["left", "Align left", "M2.5 2 V14 M5 4.5 H12 V7 H5 Z M5 9.5 H9.5 V12 H5 Z"],
                  ["centerH", "Align horizontal centers", "M8 2 V14 M4 4.5 H12 V7 H4 Z M5.5 9.5 H10.5 V12 H5.5 Z"],
                  ["right", "Align right", "M13.5 2 V14 M4 4.5 H11 V7 H4 Z M6.5 9.5 H11 V12 H6.5 Z"],
                  ["top", "Align top", "M2 2.5 H14 M4.5 5 V12 H7 V5 Z M9.5 5 V9.5 H12 V5 Z"],
                  ["middleV", "Align vertical centers", "M2 8 H14 M4.5 4 V12 H7 V4 Z M9.5 5.5 V10.5 H12 V5.5 Z"],
                  ["bottom", "Align bottom", "M2 13.5 H14 M4.5 4 V11 H7 V4 Z M9.5 6.5 V11 H12 V6.5 Z"],
                ] as const).map(([mode, title, d]) => (
                  <button key={mode} className="ds-opt" title={title} aria-label={title}
                    onClick={() => useDiagramStore.getState().alignSelection(mode)}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
                  </button>
                ))}
              </div>
              {selCount >= 3 && (
                <div className="ds-row" style={{ marginTop: 5 }}>
                  <button className="ds-opt" title="Distribute horizontally" aria-label="Distribute horizontally"
                    onClick={() => useDiagramStore.getState().alignSelection("distH")}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 2.5 V13.5 M14 2.5 V13.5 M6.5 5 H9.5 V11 H6.5 Z" /></svg>
                  </button>
                  <button className="ds-opt" title="Distribute vertically" aria-label="Distribute vertically"
                    onClick={() => useDiagramStore.getState().alignSelection("distV")}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 2 H13.5 M2.5 14 H13.5 M5 6.5 H11 V9.5 H5 Z" /></svg>
                  </button>
                </div>
              )}
            </>
          )}
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

  const applyEdge = (patch: Record<string, unknown>) => {
    const ds = useDiagramStore.getState();
    ds.diagramSelection
      .filter((id) => ds.edges[id])
      .forEach((id) => ds.updateEdge(id, patch));
    // New arrows are born with the last style the user picked.
    useEditorStore.getState().setEdgeStyle(patch);
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
        <ColorWell value={firstEdge.stroke} presets={STROKES} label="Arrow stroke" onPick={(c) => applyEdge({ stroke: c })} />
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

      <div className="ds-label">Arrow type</div>
      <div className="ds-row">
        <button
          className={`ds-opt${firstEdge.routing === "straight" ? " active" : ""}`}
          title="Sharp"
          aria-label="Sharp (straight) routing"
          onClick={() => applyEdge({ routing: "straight" })}
        >
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 16 L16 4 M10.5 4 H16 V9.5" />
          </svg>
        </button>
        <button
          className={`ds-opt${firstEdge.routing === "curved" ? " active" : ""}`}
          title="Curved"
          aria-label="Curved routing"
          onClick={() => applyEdge({ routing: "curved" })}
        >
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 16 C4 9, 9 5, 15.5 5 M11.5 2.5 L15.5 5 L12 8.5" />
          </svg>
        </button>
        <button
          className={`ds-opt${firstEdge.routing === "elbow" ? " active" : ""}`}
          title="Elbow"
          aria-label="Elbow routing"
          onClick={() => applyEdge({ routing: "elbow" })}
        >
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 16 V9 H14 V4 M10.5 4 H14 V7.5" />
          </svg>
        </button>
      </div>

      <div className="ds-label">Arrowheads</div>
      <div className="ds-row ds-heads">
        <span className="ds-sub">Start</span>
        {heads.map((h) => {
          const startHead = firstEdge.startHead ?? (firstEdge.startArrow ? "arrow" : "none");
          return (
            <button
              key={`s-${h}`}
              className={`ds-opt${startHead === h ? " active" : ""}`}
              title={h}
              aria-label={`Start head ${h}`}
              onClick={() => applyEdge({ startHead: h, startArrow: h !== "none" })}
            >
              {headGlyph[h]}
            </button>
          );
        })}
      </div>
      <div className="ds-row ds-heads" style={{ marginTop: 5 }}>
        <span className="ds-sub">End</span>
        {heads.map((h) => (
          <button
            key={`e-${h}`}
            className={`ds-opt${endHead === h ? " active" : ""}`}
            title={h}
            aria-label={`End head ${h}`}
            onClick={() => applyEdge({ endHead: h, endArrow: h !== "none" })}
          >
            {headGlyph[h]}
          </button>
        ))}
      </div>

      {/* Quick flow animation (the Properties inspector has the full set:
          intensity etc.). None clears `animated`; a style turns it on. */}
      <div className="ds-label">Animation</div>
      <div className="ds-row">
        {([[null, "None"], ["dash", "Dash"], ["dots", "Dots"], ["beam", "Beam"], ["pulse", "Pulse"]] as const).map(([v, label]) => {
          const on = v === null ? !firstEdge.animated : firstEdge.animated && (firstEdge.flowStyle ?? "dash") === v;
          return (
            <button
              key={label}
              className={`ds-opt${on ? " active" : ""}`}
              title={v ? `${label} flow` : "No animation"}
              aria-label={v ? `Animation ${label}` : "No animation"}
              onClick={() => applyEdge(v === null ? { animated: false } : { animated: true, flowStyle: v })}
            >
              {label}
            </button>
          );
        })}
      </div>
      {firstEdge.animated && (
        <div className="ds-row" style={{ marginTop: 5 }}>
          {([[0.5, "Slow"], [1, "Normal"], [2, "Fast"]] as const).map(([v, label]) => (
            <button
              key={v}
              className={`ds-opt${(firstEdge.flowSpeed ?? 1) === v ? " active" : ""}`}
              title={`${label} (${v}\u00d7)`}
              aria-label={`Flow speed ${label}`}
              onClick={() => applyEdge({ flowSpeed: v })}
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
          aria-label="Send connector to back"
          onClick={() => {
            const ds = useDiagramStore.getState();
            const zs = [
              ...Object.values(ds.nodes).map((n) => n.z ?? 0),
              ...Object.values(ds.edges).map((ed) => ed.z ?? 0),
            ];
            const base = Math.min(...zs, 0) - 1;
            ds.diagramSelection
              .filter((id) => ds.edges[id])
              .forEach((id, i) => ds.updateEdge(id, { z: base - i }));
          }}
        >
          ⤓
        </button>
        <button
          className="ds-opt"
          title="Bring to front"
          aria-label="Bring connector to front"
          onClick={() => {
            const ds = useDiagramStore.getState();
            const zs = [
              ...Object.values(ds.nodes).map((n) => n.z ?? 0),
              ...Object.values(ds.edges).map((ed) => ed.z ?? 0),
            ];
            const base = Math.max(...zs, 0) + 1;
            ds.diagramSelection
              .filter((id) => ds.edges[id])
              .forEach((id, i) => ds.updateEdge(id, { z: base + i }));
          }}
        >
          ⤒
        </button>
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
