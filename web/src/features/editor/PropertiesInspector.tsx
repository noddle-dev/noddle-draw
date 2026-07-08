/**
 * features/editor/PropertiesInspector — the right-panel "Properties" tab.
 *
 * Reflects whichever selection is live and wires edits to the REAL stores:
 *   • a diagram node  → diagramStore.updateNode (name/pos/size/fill/stroke/width)
 *   • a diagram edge  → diagramStore.updateEdge / setEdgeLabel (label/route/color)
 *   • an uploaded-SVG object → attribute edits via editorStore begin/commit
 *   • nothing selected → page settings (grid/snap real) + a diagram theme that
 *     recolours every node/edge.
 */
import { useEffect, useMemo, useState } from "react";
import { esc, localName } from "../../editor-core";
import { SPEED_SLIDER_MAX, speedToSlider, sliderToSpeed } from "../../editor-core/diagram";
import type { ArrowHead, DiagramNode, EdgeDash, FlowIntensity, FlowSpeed, NodeAnim, NodeKind, NodeStrokeDash, TextAlign } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";
import { labelOverflows } from "../diagram/textWrap";
import {
  EDGE_SWATCHES,
  FILL_SWATCHES,
  STROKE_SWATCHES,
  THEMES,
} from "./data";

// Partial: only the common kinds get a bespoke glyph/label; the rest fall back
// (◆ / the kind name) — keeps this in sync-free with the expanding NodeKind set.
const NODE_GLYPH: Partial<Record<NodeKind, string>> = { rect: "▭", rounded: "▢", ellipse: "◯", diamond: "◇", sticky: "▧" };
const NODE_LABEL: Partial<Record<NodeKind, string>> = { rect: "Rectangle", rounded: "Rounded", ellipse: "Ellipse", diamond: "Diamond", sticky: "Sticky note" };

function normColor(c: string): string {
  if (!c || c === "none" || c.startsWith("url")) return "#000000";
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
    return c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c;
  }
  return "#000000";
}

/** Segmented Slow/Normal/Fast control for the shared FlowSpeed multiplier. */
function SpeedSeg({ value, onPick }: { value: FlowSpeed; onPick: (v: FlowSpeed) => void }) {
  const OPTS: { v: FlowSpeed; label: string; title: string }[] = [
    { v: 0.5, label: "Slow", title: "Slow (0.5×)" },
    { v: 1, label: "Normal", title: "Normal (1×)" },
    { v: 2, label: "Fast", title: "Fast (2×)" },
  ];
  return (
    <div className="seg" data-testid="anim-speed">
      {OPTS.map((o) => (
        <button key={o.v} className={value === o.v ? "active" : ""} title={o.title} onClick={() => onPick(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Effective head: explicit value wins, else derive from the legacy boolean. */
function endpointHead(explicit: ArrowHead | undefined, legacy: boolean): ArrowHead {
  return explicit ?? (legacy ? "arrow" : "none");
}

/** Segmented picker for an edge endpoint decoration (arrowhead). */
const HEAD_OPTS: { v: ArrowHead; glyph: string; title: string }[] = [
  { v: "none", glyph: "—", title: "No head" },
  { v: "arrow", glyph: "▶", title: "Solid arrow" },
  { v: "triangle", glyph: "▷", title: "Hollow triangle" },
  { v: "circle", glyph: "●", title: "Dot" },
  { v: "diamond", glyph: "◆", title: "Diamond" },
];
function HeadSeg({ value, onPick }: { value: ArrowHead; onPick: (v: ArrowHead) => void }) {
  return (
    <div className="seg">
      {HEAD_OPTS.map((o) => (
        <button key={o.v} className={value === o.v ? "active" : ""} title={o.title} onClick={() => onPick(o.v)}>
          {o.glyph}
        </button>
      ))}
    </div>
  );
}

/** Segmented picker for the static line dash pattern. */
function DashSeg({ value, onPick }: { value: EdgeDash; onPick: (v: EdgeDash) => void }) {
  const OPTS: { v: EdgeDash; label: string; title: string }[] = [
    { v: "solid", label: "Solid", title: "Solid line" },
    { v: "dashed", label: "Dashed", title: "Dashed line" },
    { v: "dotted", label: "Dotted", title: "Dotted line" },
  ];
  return (
    <div className="seg">
      {OPTS.map((o) => (
        <button key={o.v} className={value === o.v ? "active" : ""} title={o.title} onClick={() => onPick(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One-click node style presets (fill+stroke), Lucid "Styles" row. */
const STYLE_PRESETS: { name: string; fill: string; stroke: string; dashed?: boolean }[] = [
  { name: "Pink", fill: "#fce7f3", stroke: "#ec4899" },
  { name: "Blue", fill: "#eff6ff", stroke: "#2563eb" },
  { name: "Purple", fill: "#f4f0ff", stroke: "#7c3aed" },
  { name: "Yellow", fill: "#fffbeb", stroke: "#d97706" },
  { name: "Green", fill: "#f0fdf4", stroke: "#16a34a" },
  { name: "Red", fill: "#fef2f2", stroke: "#dc2626", dashed: true },
  { name: "Plain", fill: "#ffffff", stroke: "#1a1d23" },
];

function StylePresets({ fill, stroke, onPick }: { fill?: string; stroke?: string; onPick: (p: { fill: string; stroke: string }) => void }) {
  return (
    <div className="style-presets">
      {STYLE_PRESETS.map((p) => {
        const selected = (fill ?? "").toLowerCase() === p.fill.toLowerCase() && (stroke ?? "").toLowerCase() === p.stroke.toLowerCase();
        return (
          <button
            key={p.name}
            className={`style-swatch${selected ? " sel" : ""}`}
            title={p.name}
            style={{ background: p.fill, borderColor: p.stroke, borderStyle: p.dashed ? "dashed" : "solid" }}
            onClick={() => onPick({ fill: p.fill, stroke: p.stroke })}
          >
            <span className="bar" style={{ background: p.stroke }} />
          </button>
        );
      })}
    </div>
  );
}

function Swatches({ colors, value, onPick }: { colors: string[]; value: string; onPick: (c: string) => void }) {
  return (
    <div className="swatches">
      {colors.map((c) => (
        <button
          key={c}
          className={`swatch${value.toLowerCase() === c.toLowerCase() ? " sel" : ""}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

/** Dark-leaning palette for label text (default #1a1d23 + accents + white). */
const TEXT_SWATCHES = ["#1a1d23", "#2563eb", "#7c3aed", "#16a34a", "#d97706", "#dc2626", "#6b7280", "#ffffff"];

/** Segmented left/center/right control for a node label's horizontal alignment. */
function TextAlignSeg({ value, onPick }: { value: TextAlign; onPick: (v: TextAlign) => void }) {
  const OPTS: { v: TextAlign; glyph: string; title: string }[] = [
    { v: "left", glyph: "⇤", title: "Align left" },
    { v: "center", glyph: "≡", title: "Align center" },
    { v: "right", glyph: "⇥", title: "Align right" },
  ];
  return (
    <div className="seg">
      {OPTS.map((o) => (
        <button key={o.v} className={value === o.v ? "active" : ""} title={o.title} onClick={() => onPick(o.v)}>
          {o.glyph}
        </button>
      ))}
    </div>
  );
}

/**
 * Direct-entry font-size field between the −/+ steppers: type a value,
 * commit on Enter/blur (buffered, so half-typed numbers never clamp mid-key).
 */
function FontSizeInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [buf, setBuf] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setBuf(String(value));
  }, [value, focused]);
  const commit = () => {
    const n = Math.round(Number(buf));
    if (Number.isFinite(n) && n > 0) onCommit(Math.min(200, Math.max(6, n)));
    else setBuf(String(value));
  };
  return (
    <input
      className="fs-val fs-input"
      type="number"
      min={6}
      max={200}
      value={buf}
      onFocus={() => setFocused(true)}
      onChange={(e) => setBuf(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/**
 * Text-formatting group (font size stepper + B/I/U toggles + align + color).
 * Presentation-only: it receives RESOLVED values and a `set(patch)` sink, so
 * the SAME group drives single-select (updateNode) and multi-select (apply to
 * every selected node). Toggle clicks flip the passed boolean, so in multi mode
 * `bold` = "all bold" and the click sets every node to the opposite.
 */
function NodeTextGroup({
  fontSize, bold, italic, underline, textColor, textAlign, wrap, set,
}: {
  fontSize: number; bold: boolean; italic: boolean; underline: boolean;
  textColor: string; textAlign: TextAlign; wrap: boolean;
  set: (patch: Partial<DiagramNode>) => void;
}) {
  const fs = Math.round(fontSize);
  return (
    <>
      <div className="props-label">Text</div>
      <div className="prop-row">
        <span className="lbl">Font size</span>
        <div className="fs-step">
          <button className="fs-btn" title="Smaller (⌘⇧,)" onClick={() => set({ fontSize: Math.max(6, fs - 1) })}>−</button>
          <FontSizeInput value={fs} onCommit={(n) => set({ fontSize: n })} />
          <button className="fs-btn" title="Larger (⌘⇧.)" onClick={() => set({ fontSize: Math.min(200, fs + 1) })}>+</button>
        </div>
      </div>
      <div className="prop-row">
        <span className="lbl">Format</span>
        <div className="text-style-btns">
          <button className={`tsb${bold ? " active" : ""}`} title="Bold" style={{ fontWeight: 700 }} onClick={() => set({ bold: !bold })}>B</button>
          <button className={`tsb${italic ? " active" : ""}`} title="Italic" style={{ fontStyle: "italic" }} onClick={() => set({ italic: !italic })}>I</button>
          <button className={`tsb${underline ? " active" : ""}`} title="Underline" style={{ textDecoration: "underline" }} onClick={() => set({ underline: !underline })}>U</button>
        </div>
      </div>
      <div className="prop-row"><span className="lbl">Align</span><TextAlignSeg value={textAlign} onPick={(v) => set({ textAlign: v })} /></div>
      <div className="prop-row">
        <span className="lbl">↩ Wrap text</span>
        <button
          className={`switch${wrap ? " on" : ""}`}
          title="Excel-style wrap: long labels break into lines that fit the shape (Enter in the editor always makes a new line)"
          onClick={() => set({ wrap: !wrap })}
        >
          <span className="knob" />
        </button>
      </div>
      <div className="prop-row"><span className="lbl">Text color</span><Swatches colors={TEXT_SWATCHES} value={textColor} onPick={(c) => set({ textColor: c })} /></div>
    </>
  );
}

/**
 * Style additions (opacity slider + optional corner radius + border dash).
 * Same presentational contract as NodeTextGroup — resolved values + a set sink.
 */
function NodeStyleExtras({
  opacity, cornerRadius, strokeDash, showCorner, set,
}: {
  opacity: number; cornerRadius: number; strokeDash: NodeStrokeDash; showCorner: boolean;
  set: (patch: Partial<DiagramNode>) => void;
}) {
  return (
    <>
      <div className="prop-row">
        <span className="lbl">Opacity</span>
        <div className="with-num">
          <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => set({ opacity: +e.target.value })} />
          <span className="num">{Math.round(opacity * 100)}%</span>
        </div>
      </div>
      {showCorner && (
        <div className="prop-row">
          <span className="lbl">Corner radius</span>
          <div className="with-num">
            <input type="range" min={0} max={40} step={1} value={cornerRadius} onChange={(e) => set({ cornerRadius: +e.target.value })} />
            <span className="num">{cornerRadius}</span>
          </div>
        </div>
      )}
      <div className="props-label">Border dash</div>
      <DashSeg value={strokeDash} onPick={(d) => set({ strokeDash: d })} />
    </>
  );
}

/**
 * A number field that keeps a LOCAL editing buffer instead of binding straight
 * to the store value. Binding directly (value={Math.round(node.x)} +
 * per-keystroke updateNode) made typing impossible — select-all/replace didn't
 * stick and each key concatenated onto the rounded live value (e.g. "130" →
 * "333130"). Here the user types freely; we commit a clamped number on change
 * (so drags/arrows still feel live) and re-sync from the prop when not focused.
 */
function NumField({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  onCommit: (n: number) => void;
}) {
  const [buf, setBuf] = useState(String(Math.round(value)));
  const [focused, setFocused] = useState(false);
  // Keep the buffer in sync with external changes (drag/resize) while idle.
  useEffect(() => {
    if (!focused) setBuf(String(Math.round(value)));
  }, [value, focused]);

  const commit = (raw: string) => {
    const n = parseFloat(raw);
    if (Number.isNaN(n)) return;
    onCommit(min != null ? Math.max(min, n) : n);
  };

  return (
    <div className="xy-cell">
      <span className="k">{label}</span>
      <input
        type="number"
        value={buf}
        onFocus={(e) => { setFocused(true); e.target.select(); }}
        onBlur={() => { setFocused(false); commit(buf); }}
        onChange={(e) => { setBuf(e.target.value); commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

/* ---------- diagram node ---------- */
function NodeProps({ id }: { id: string }) {
  const node = useDiagramStore((s) => s.nodes[id]);
  const updateNode = useDiagramStore((s) => s.updateNode);
  const addNode = useDiagramStore((s) => s.addNode);
  const deleteSelected = useDiagramStore((s) => s.deleteSelectedDiagram);
  const setDiagramSelection = useDiagramStore((s) => s.setDiagramSelection);
  const setRightTab = useAppStore((s) => s.setRightTab);
  if (!node) return null;

  const duplicate = () => {
    const newId = addNode(node.kind, { x: node.x + node.w / 2 + 30, y: node.y + node.h / 2 + 30 });
    useDiagramStore.getState().updateNode(newId, {
      text: node.text + " copy", fill: node.fill, stroke: node.stroke, strokeWidth: node.strokeWidth, w: node.w, h: node.h,
    });
  };

  return (
    <div className="props2">
      <div className="props-head">
        <span className="g" style={{ background: node.fill, color: node.stroke }}>{NODE_GLYPH[node.kind] ?? "◆"}</span>
        <div className="body">
          <input className="props-name" value={node.text} onChange={(e) => updateNode(id, { text: e.target.value })} />
          <div className="props-type">{NODE_LABEL[node.kind] ?? node.kind}</div>
        </div>
        <button className="props-close" onClick={() => setDiagramSelection([])}>✕</button>
      </div>

      <div className="props-label">Position &amp; size</div>
      <div className="xy-grid">
        <NumField label="X" value={node.x} onCommit={(n) => updateNode(id, { x: n })} />
        <NumField label="Y" value={node.y} onCommit={(n) => updateNode(id, { y: n })} />
        <NumField label="W" value={node.w} min={20} onCommit={(n) => updateNode(id, { w: n })} />
        <NumField label="H" value={node.h} min={20} onCommit={(n) => updateNode(id, { h: n })} />
      </div>

      <div className="props-label">Styles</div>
      <StylePresets fill={node.fill} stroke={node.stroke} onPick={(p) => updateNode(id, p)} />
      <div className="prop-row" style={{ marginTop: 10 }}><span className="lbl">Fill</span><Swatches colors={FILL_SWATCHES} value={node.fill} onPick={(c) => updateNode(id, { fill: c })} /></div>
      <div className="prop-row"><span className="lbl">Border</span><Swatches colors={STROKE_SWATCHES} value={node.stroke} onPick={(c) => updateNode(id, { stroke: c })} /></div>
      <div className="prop-row">
        <span className="lbl">Border width</span>
        <div className="with-num">
          <input type="range" min={0} max={6} step={0.5} value={node.strokeWidth} onChange={(e) => updateNode(id, { strokeWidth: +e.target.value })} />
          <span className="num">{node.strokeWidth}</span>
        </div>
      </div>
      <NodeStyleExtras
        opacity={node.opacity ?? 1}
        cornerRadius={node.cornerRadius ?? (node.kind === "rounded" ? 8 : 0)}
        strokeDash={node.strokeDash ?? "solid"}
        showCorner={node.kind === "rect" || node.kind === "rounded"}
        set={(patch) => updateNode(id, patch)}
      />

      <NodeTextGroup
        fontSize={node.fontSize ?? 14}
        bold={!!node.bold}
        italic={!!node.italic}
        underline={!!node.underline}
        textColor={node.textColor ?? "#1a1d23"}
        textAlign={node.textAlign ?? "center"}
        wrap={!!node.wrap}
        set={(patch) => updateNode(id, patch)}
      />
      {!node.wrap && labelOverflows(node) && (
        <div className="prop-hint">
          Text overflows the shape —{" "}
          <button className="btn btn-ghost" onClick={() => updateNode(id, { wrap: true })}>
            ↩ Wrap text
          </button>
        </div>
      )}

      <div className="props-label">Animation</div>
      <div className="seg" data-testid="node-anim">
        {([undefined, "pulse", "glow", "breathe", "wobble"] as (NodeAnim | undefined)[]).map((a) => (
          <button
            key={a ?? "none"}
            className={(node.anim ?? undefined) === a ? "active" : ""}
            title={
              a
                ? { pulse: "Rhythmic scale up/down", glow: "Breathing glow", breathe: "Steady fade", wobble: "Gentle wobble" }[a]
                : "No animation"
            }
            onClick={() => updateNode(id, { anim: a })}
          >
            {a ? a.charAt(0).toUpperCase() + a.slice(1) : "None"}
          </button>
        ))}
      </div>
      {node.anim && (
        <>
          <div className="props-label">Speed</div>
          <SpeedSeg value={node.animSpeed ?? 1} onPick={(v) => updateNode(id, { animSpeed: v })} />
        </>
      )}

      <div className="prop-row">
        <span className="lbl">✎ Hand-drawn stroke (sketch)</span>
        <button
          className={`switch${node.sketch ? " on" : ""}`}
          onClick={() => updateNode(id, { sketch: !node.sketch })}
        >
          <span className="knob" />
        </button>
      </div>

      <div className="props-label" style={{ marginTop: 4 }}>Arrange</div>
      <div className="arrange">
        <button className="btn" onClick={duplicate}>⧉ Duplicate</button>
        <button className="btn btn-danger" onClick={deleteSelected}>✕ Delete</button>
      </div>

      <div className="ask-claude" onClick={() => setRightTab("claude")}>
        <span className="spark">✦</span>
        <span className="txt">Ask AI-Noddle about this shape →</span>
      </div>
    </div>
  );
}

/* ---------- diagram edge ---------- */
function EdgeProps({ id }: { id: string }) {
  const edge = useDiagramStore((s) => s.edges[id]);
  const updateEdge = useDiagramStore((s) => s.updateEdge);
  const setEdgeLabel = useDiagramStore((s) => s.setEdgeLabel);
  const toggleAnimated = useDiagramStore((s) => s.toggleEdgeAnimated);
  const deleteSelected = useDiagramStore((s) => s.deleteSelectedDiagram);
  const setDiagramSelection = useDiagramStore((s) => s.setDiagramSelection);
  const setRightTab = useAppStore((s) => s.setRightTab);
  if (!edge) return null;

  return (
    <div className="props2">
      <div className="props-head">
        <span className="g" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>⇢</span>
        <div className="body">
          <div style={{ fontWeight: 600, fontSize: 13.5 }} className="ellip">{edge.label || "Connector"}</div>
          <div className="props-type">Connector</div>
        </div>
        <button className="props-close" onClick={() => setDiagramSelection([])}>✕</button>
      </div>

      <div className="props-label">Label</div>
      <input className="text-input" style={{ marginBottom: 16 }} placeholder="Add label…" value={edge.label ?? ""} onChange={(e) => setEdgeLabel(id, e.target.value)} />

      <div className="props-label">Line style</div>
      <div className="seg">
        <button className={edge.routing === "straight" ? "active" : ""} onClick={() => updateEdge(id, { routing: "straight" })}>Straight</button>
        <button className={edge.routing === "elbow" ? "active" : ""} onClick={() => updateEdge(id, { routing: "elbow" })}>Elbow</button>
        <button className={edge.animated ? "active" : ""} onClick={() => toggleAnimated(id)}>Animated</button>
      </div>
      {edge.animated && (
        <>
          <div className="props-label">Flow style</div>
          <div className="seg">
            {(["dash", "dots", "beam", "pulse"] as const).map((fs) => (
              <button
                key={fs}
                className={(edge.flowStyle ?? "dash") === fs ? "active" : ""}
                title={{ dash: "Running dashes", dots: "Moving dots", beam: "Sweeping beam", pulse: "Blinking" }[fs]}
                onClick={() => updateEdge(id, { flowStyle: fs })}
              >
                {{ dash: "Dash", dots: "Dots", beam: "Beam", pulse: "Pulse" }[fs]}
              </button>
            ))}
          </div>
          <div className="props-label">Speed</div>
          <div className="with-num">
            <input
              type="range"
              min={1}
              max={SPEED_SLIDER_MAX}
              step={1}
              value={speedToSlider(edge.flowSpeed)}
              onChange={(e) => updateEdge(id, { flowSpeed: sliderToSpeed(+e.target.value) })}
            />
            <span className="num">{speedToSlider(edge.flowSpeed)}</span>
          </div>
          <div className="props-label">Intensity</div>
          <div className="seg" data-testid="flow-intensity">
            {(["subtle", "normal", "strong"] as FlowIntensity[]).map((fi) => (
              <button
                key={fi}
                className={(edge.flowIntensity ?? "normal") === fi ? "active" : ""}
                title={{ subtle: "Subtle", normal: "Normal", strong: "Strong, pronounced" }[fi]}
                onClick={() => updateEdge(id, { flowIntensity: fi })}
              >
                {fi.charAt(0).toUpperCase() + fi.slice(1)}
              </button>
            ))}
          </div>
        </>
      )}
      {edge.routing === "elbow" && edge.waypoints && edge.waypoints.length > 0 && (
        <button
          className="btn btn-block"
          style={{ margin: "-8px 0 14px" }}
          title="Clear the custom route and let the system re-route automatically"
          onClick={() => updateEdge(id, { waypoints: undefined })}
        >
          ⟲ Auto route
        </button>
      )}

      <div className="prop-row"><span className="lbl">Color</span><Swatches colors={EDGE_SWATCHES} value={edge.stroke} onPick={(c) => updateEdge(id, { stroke: c })} /></div>

      <div className="prop-row">
        <span className="lbl">Width</span>
        <div className="with-num">
          <input
            type="range"
            min={1}
            max={10}
            step={0.5}
            value={edge.strokeWidth}
            onChange={(e) => updateEdge(id, { strokeWidth: +e.target.value })}
          />
          <span className="num">{edge.strokeWidth}</span>
        </div>
      </div>

      <div className="props-label">Dash</div>
      <DashSeg value={edge.dash ?? "solid"} onPick={(d) => updateEdge(id, { dash: d })} />

      <div className="props-label">Start head</div>
      <HeadSeg
        value={endpointHead(edge.startHead, edge.startArrow)}
        onPick={(h) => updateEdge(id, { startHead: h, startArrow: h !== "none" })}
      />
      <div className="props-label">End head</div>
      <HeadSeg
        value={endpointHead(edge.endHead, edge.endArrow)}
        onPick={(h) => updateEdge(id, { endHead: h, endArrow: h !== "none" })}
      />

      <button className="btn btn-danger btn-block" style={{ margin: "8px 0 14px" }} onClick={deleteSelected}>✕ Delete connector</button>
      <div className="ask-claude" onClick={() => setRightTab("claude")}>
        <span className="spark">✦</span>
        <span className="txt">Ask AI-Noddle to re-route this →</span>
      </div>
    </div>
  );
}

/* ---------- uploaded SVG object ---------- */
function SvgObjectProps() {
  const selection = useEditorStore((s) => s.selection);
  const contentRev = useEditorStore((s) => s.contentRev);
  const beginAction = useEditorStore((s) => s.beginAction);
  const commitAction = useEditorStore((s) => s.commitAction);
  const setSelection = useEditorStore((s) => s.setSelection);
  const el = selection[0];

  const props = useMemo(() => {
    if (!el) return null;
    const g = (attr: string, dflt: string) =>
      el.getAttribute(attr) || (el.style as CSSStyleDeclaration).getPropertyValue(attr) || dflt;
    return {
      fillRaw: g("fill", ""), strokeRaw: g("stroke", ""),
      fill: normColor(g("fill", "#000000")), stroke: normColor(g("stroke", "#000000")),
      strokeWidth: parseFloat(g("stroke-width", "1")) || 0,
      opacity: g("opacity", "1"), id: el.id, tag: localName(el),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, contentRev]);
  if (!el || !props) return null;

  const setAttr = (attr: string, val: string) => { beginAction(); el.setAttribute(attr, val); commitAction(); };

  return (
    <div className="props2">
      <div className="props-head">
        <span className="g" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>◈</span>
        <div className="body">
          <div style={{ fontWeight: 600, fontSize: 13.5 }} className="ellip">{esc(props.id) || esc(props.tag)}</div>
          <div className="props-type">&lt;{esc(props.tag)}&gt;</div>
        </div>
        <button className="props-close" onClick={() => setSelection([])}>✕</button>
      </div>

      <div className="props-label">Fill</div>
      <div className="color-input" style={{ marginBottom: 14 }}>
        <input type="color" value={props.fill} onChange={(e) => setAttr("fill", e.target.value)} />
        <input type="text" defaultValue={props.fillRaw} key={`fill-${props.id}-${contentRev}`} onBlur={(e) => setAttr("fill", e.target.value)} />
      </div>
      <div className="props-label">Stroke</div>
      <div className="color-input" style={{ marginBottom: 14 }}>
        <input type="color" value={props.stroke} onChange={(e) => setAttr("stroke", e.target.value)} />
        <input type="text" defaultValue={props.strokeRaw} key={`stroke-${props.id}-${contentRev}`} onBlur={(e) => setAttr("stroke", e.target.value)} />
      </div>
      <div className="prop-row">
        <span className="lbl">Stroke width</span>
        <input type="number" min={0} step={0.5} style={{ width: 72, border: "1px solid var(--border-strong)", borderRadius: 6, padding: "5px 8px" }} defaultValue={props.strokeWidth} key={`sw-${props.id}-${contentRev}`} onBlur={(e) => setAttr("stroke-width", e.target.value)} />
      </div>
      <div className="prop-row">
        <span className="lbl">Opacity</span>
        <div className="with-num">
          <input type="range" min={0} max={1} step={0.05} defaultValue={props.opacity} key={`op-${props.id}-${contentRev}`} onChange={(e) => setAttr("opacity", e.target.value)} />
        </div>
      </div>
      <div className="props-empty" style={{ marginTop: 8 }}>{esc(props.id)} · &lt;{esc(props.tag)}&gt;</div>
    </div>
  );
}

/* ---------- no selection: page settings ---------- */
function PageSettings() {
  const gridOn = useAppStore((s) => s.gridOn);
  const snapOn = useAppStore((s) => s.snapOn);
  const toggleGrid = useAppStore((s) => s.toggleGrid);
  const toggleSnap = useAppStore((s) => s.toggleSnap);
  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const autoRouteAllEdges = useDiagramStore((s) => s.autoRouteAllEdges);
  const edgeCount = Object.keys(edges).length;

  const applyTheme = (themeId: string) => {
    const t = THEMES.find((x) => x.id === themeId);
    if (!t) return;
    const ds = useDiagramStore.getState();
    Object.keys(nodes).forEach((id) => ds.updateNode(id, { fill: t.fill, stroke: t.stroke }));
    Object.keys(edges).forEach((id) => ds.updateEdge(id, { stroke: t.stroke }));
  };

  return (
    <div className="props2">
      <div className="props-empty">Select a shape or connector on the canvas — or in Layers — to edit its properties.</div>
      <div className="props-label">Page</div>
      <div className="prop-row">
        <span className="lbl">Show grid</span>
        <button className={`switch${gridOn ? " on" : ""}`} onClick={toggleGrid}><span className="knob" /></button>
      </div>
      <div className="prop-row">
        <span className="lbl">Snap to grid</span>
        <button className={`switch${snapOn ? " on" : ""}`} onClick={toggleSnap}><span className="knob" /></button>
      </div>
      {edgeCount > 0 && (
        <>
          <div className="props-label" style={{ marginTop: 8 }}>Connectors</div>
          <button
            className="btn btn-block"
            title="Untangle: clear the custom route on every connector so the system re-routes them, avoiding overlaps"
            onClick={autoRouteAllEdges}
          >
            ⟲ Auto-untangle
          </button>
        </>
      )}
      <div className="props-label" style={{ marginTop: 8 }}>Diagram theme</div>
      {THEMES.map((th) => (
        <button key={th.id} className="theme-row" onClick={() => applyTheme(th.id)}>
          <span className="sw" style={{ background: th.swatch }} />
          <span className="nm">{th.name}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- multiple diagram objects selected ---------- */
function MultiSelectProps({ ids }: { ids: string[] }) {
  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const setDiagramSelection = useDiagramStore((s) => s.setDiagramSelection);

  const selNodes = ids.filter((id) => nodes[id]);
  const selEdges = ids.filter((id) => edges[id]);

  // Apply a fill/stroke to every selected object (edges take stroke only).
  const applyStyle = (p: { fill: string; stroke: string }) => {
    const ds = useDiagramStore.getState();
    selNodes.forEach((id) => ds.updateNode(id, p));
    selEdges.forEach((id) => ds.updateEdge(id, { stroke: p.stroke }));
  };
  const applyFill = (c: string) => {
    const ds = useDiagramStore.getState();
    selNodes.forEach((id) => ds.updateNode(id, { fill: c }));
  };
  const applyStroke = (c: string) => {
    const ds = useDiagramStore.getState();
    selNodes.forEach((id) => ds.updateNode(id, { stroke: c }));
    selEdges.forEach((id) => ds.updateEdge(id, { stroke: c }));
  };

  // Show the shared value only when every object agrees (else "mixed" → blank).
  const common = <T,>(vals: T[]): T | undefined =>
    vals.length && vals.every((v) => v === vals[0]) ? vals[0] : undefined;
  const commonFill = common(selNodes.map((id) => nodes[id].fill));
  const commonStroke = common([
    ...selNodes.map((id) => nodes[id].stroke),
    ...selEdges.map((id) => edges[id].stroke),
  ]);

  // Node text/style formatting applied to EVERY selected node (edges ignore it).
  const setAllNodes = (patch: Partial<DiagramNode>) => {
    const ds = useDiagramStore.getState();
    selNodes.forEach((id) => ds.updateNode(id, patch));
  };
  // "All-agree" resolution so a shared value shows and mixed values fall back to
  // the default (never silently rewriting the majority when nothing was touched).
  const commonFontSize = common(selNodes.map((id) => nodes[id].fontSize ?? 14)) ?? 14;
  const commonTextColor = common(selNodes.map((id) => nodes[id].textColor ?? "#1a1d23")) ?? "";
  const commonAlign = common(selNodes.map((id) => nodes[id].textAlign ?? "center")) ?? "center";
  const commonOpacity = common(selNodes.map((id) => nodes[id].opacity ?? 1)) ?? 1;
  const commonCorner = common(selNodes.map((id) => nodes[id].cornerRadius ?? (nodes[id].kind === "rounded" ? 8 : 0))) ?? 0;
  const commonDash = common(selNodes.map((id) => nodes[id].strokeDash ?? "solid")) ?? "solid";
  const allBold = selNodes.length > 0 && selNodes.every((id) => nodes[id].bold);
  const allItalic = selNodes.length > 0 && selNodes.every((id) => nodes[id].italic);
  const allUnderline = selNodes.length > 0 && selNodes.every((id) => nodes[id].underline);
  const allWrap = selNodes.length > 0 && selNodes.every((id) => nodes[id].wrap);
  const allRoundable = selNodes.length > 0 && selNodes.every((id) => nodes[id].kind === "rect" || nodes[id].kind === "rounded");

  // Sketch is a node-only flag. "On" when every selected node already sketches;
  // clicking flips the whole selection to the opposite of that state.
  const allSketch = selNodes.length > 0 && selNodes.every((id) => nodes[id].sketch);
  const toggleSketch = () => {
    const ds = useDiagramStore.getState();
    selNodes.forEach((id) => ds.updateNode(id, { sketch: !allSketch }));
  };

  // "Ungroup" when every selected node already shares one group.
  const allGrouped =
    selNodes.length > 1 &&
    !!nodes[selNodes[0]].groupId &&
    selNodes.every((id) => nodes[id].groupId === nodes[selNodes[0]].groupId);

  return (
    <div className="props2">
      <div className="props-head">
        <span className="g" style={{ background: "#eef1f6", color: "#1a1d23" }}>❖</span>
        <div className="body">
          <div className="props-name" style={{ fontWeight: 600 }}>{ids.length} objects</div>
          <div className="props-type">
            {selNodes.length} shape · {selEdges.length} connector
            {allGrouped ? " · grouped" : ""}
          </div>
        </div>
        <button className="props-close" onClick={() => setDiagramSelection([])}>✕</button>
      </div>

      {selNodes.length > 1 && (
        <>
          <div className="props-label">Align shapes</div>
          <div className="seg align-seg" data-testid="align-h">
            <button title="Align left edges" onClick={() => useDiagramStore.getState().alignSelection("left")}>⇤</button>
            <button title="Align horizontal centers" onClick={() => useDiagramStore.getState().alignSelection("centerH")}>⇹</button>
            <button title="Align right edges" onClick={() => useDiagramStore.getState().alignSelection("right")}>⇥</button>
            <button title="Align top edges" onClick={() => useDiagramStore.getState().alignSelection("top")}>⤒</button>
            <button title="Align vertical middles" onClick={() => useDiagramStore.getState().alignSelection("middleV")}>⇳</button>
            <button title="Align bottom edges" onClick={() => useDiagramStore.getState().alignSelection("bottom")}>⤓</button>
          </div>
          {selNodes.length > 2 && (
            <div className="seg align-seg" data-testid="align-dist">
              <button title="Distribute evenly, left to right" onClick={() => useDiagramStore.getState().alignSelection("distH")}>⋯ Even ↔</button>
              <button title="Distribute evenly, top to bottom" onClick={() => useDiagramStore.getState().alignSelection("distV")}>⋮ Even ↕</button>
            </div>
          )}
        </>
      )}

      {selNodes.length > 1 && (
        <div className="prop-row">
          <span className="lbl">Group</span>
          {allGrouped ? (
            <button
              className="btn"
              title="Ungroup (⌘⇧G) — the shapes select and move independently again"
              onClick={() => useDiagramStore.getState().ungroupSelection()}
            >
              Ungroup
            </button>
          ) : (
            <button
              className="btn"
              title="Group (⌘G) — clicking any member selects and drags the whole group"
              onClick={() => useDiagramStore.getState().groupSelection()}
            >
              ⧉ Group
            </button>
          )}
        </div>
      )}

      <div className="props-label">Styles</div>
      <StylePresets fill={commonFill} stroke={commonStroke} onPick={applyStyle} />
      <div className="prop-row" style={{ marginTop: 10 }}><span className="lbl">Fill</span><Swatches colors={FILL_SWATCHES} value={commonFill ?? ""} onPick={applyFill} /></div>
      <div className="prop-row"><span className="lbl">Border</span><Swatches colors={STROKE_SWATCHES} value={commonStroke ?? ""} onPick={applyStroke} /></div>

      {selNodes.length > 0 && (
        <>
          <NodeStyleExtras
            opacity={commonOpacity}
            cornerRadius={commonCorner}
            strokeDash={commonDash as NodeStrokeDash}
            showCorner={allRoundable}
            set={setAllNodes}
          />
          <NodeTextGroup
            fontSize={commonFontSize}
            bold={allBold}
            italic={allItalic}
            underline={allUnderline}
            textColor={commonTextColor}
            textAlign={commonAlign as TextAlign}
            wrap={allWrap}
            set={setAllNodes}
          />
        </>
      )}

      {selNodes.length > 0 && (
        <div className="prop-row">
          <span className="lbl">✎ Hand-drawn stroke (sketch)</span>
          <button className={`switch${allSketch ? " on" : ""}`} onClick={toggleSketch}>
            <span className="knob" />
          </button>
        </div>
      )}
    </div>
  );
}

export function PropertiesInspector() {
  const diagramSelection = useDiagramStore((s) => s.diagramSelection);
  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const svgSelection = useEditorStore((s) => s.selection);

  if (diagramSelection.length === 1) {
    const id = diagramSelection[0];
    if (nodes[id]) return <NodeProps id={id} />;
    if (edges[id]) return <EdgeProps id={id} />;
  }
  if (diagramSelection.length > 1) return <MultiSelectProps ids={diagramSelection} />;
  if (svgSelection.length === 1) return <SvgObjectProps />;
  if (svgSelection.length > 1) {
    return <div className="props2"><div className="props-empty">{svgSelection.length} objects selected.</div></div>;
  }
  return <PageSettings />;
}
