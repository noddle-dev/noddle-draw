/**
 * features/editor/PropertiesInspector — the right-panel "Properties" tab.
 *
 * Reflects whichever selection is live and wires edits to the REAL stores:
 *   • a diagram node  → diagramStore.updateNode (name/pos/size/fill/stroke/width)
 *   • a diagram edge  → diagramStore.updateEdge / setEdgeLabel (label/route/color)
 *   • an uploaded-SVG object → attribute edits via editorStore begin/commit
 *   • nothing selected → the LIVE board overview first (SemanticOverview:
 *     computed summary, zones, flows; "Edit metadata" toggles the board/page
 *     form) + page settings (grid/snap real) + a diagram theme that recolours
 *     every node/edge.
 * Single nodes/edges also get a "Semantics" section (object `meta` — see
 * SemanticFields.ObjectMetaEditor), collapsed unless the object already
 * carries meaningful meta.
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { esc, localName } from "../../editor-core";
import { SPEED_SLIDER_MAX, speedToSlider, sliderToSpeed } from "../../editor-core/diagram";
import type { ArrowHead, EdgeDash, FlowIntensity, NodeKind } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";
import { usePagesStore } from "../../state/pagesStore";
import { labelOverflows } from "../diagram/textWrap";
import {
  EDGE_SWATCHES,
  THEMES,
} from "./data";
import { BoardSemanticsForm, ObjectMetaEditor } from "./SemanticFields";
import { CopyForAIButton, SemanticOverview, useLiveSemanticSummary } from "./SemanticOverview";
import { hasSemanticMeta } from "../../editor-core/diagram/semantics";
import type { ObjectMeta } from "../../editor-core/diagram";
import { SparkMark } from "../diagram/SemanticBadge";

// Partial: only the common kinds get a bespoke glyph/label; the rest fall back
// (◆ / the kind name) — keeps this in sync-free with the expanding NodeKind set.
const NODE_GLYPH: Partial<Record<NodeKind, string>> = { rect: "▭", rounded: "▢", ellipse: "◯", diamond: "◇", sticky: "▧", text: "T" };
const NODE_LABEL: Partial<Record<NodeKind, string>> = { rect: "Rectangle", rounded: "Rounded", ellipse: "Ellipse", diamond: "Diamond", sticky: "Sticky note", text: "Text" };

function normColor(c: string): string {
  if (!c || c === "none" || c.startsWith("url")) return "#000000";
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
    return c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c;
  }
  return "#000000";
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

function Swatches({ colors, value, onPick }: { colors: string[]; value: string; onPick: (c: string) => void }) {
  // Any color outside the preset list is "custom" — the picker well shows it
  // and stays ring-selected, so a picked color never looks unselected.
  const isCustom = !colors.some((c) => c.toLowerCase() === value.toLowerCase());
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
      <label
        className={`swatch custom${isCustom ? " sel" : ""}`}
        title="Custom color…"
        style={isCustom ? { background: value } : undefined}
      >
        <input
          type="color"
          value={normColor(value)}
          aria-label="Custom color"
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
    </div>
  );
}

/** Dark-leaning palette for label text (default #1a1d23 + accents + white). */

/**
 * Text-formatting group (font size stepper + B/I/U toggles + align + color).
 * Presentation-only: it receives RESOLVED values and a `set(patch)` sink, so
 * the SAME group drives single-select (updateNode) and multi-select (apply to
 * every selected node). Toggle clicks flip the passed boolean, so in multi mode
 * `bold` = "all bold" and the click sets every node to the opposite.
 */
/**
 * Collapsible group — the compact accordion that keeps the inspector short:
 * only the section being worked in is open, everything else is one line.
 * Local state on purpose (not per-node): flipping between shapes keeps your
 * working section open.
 */
function Section({
  title,
  defaultOpen = false,
  children,
  icon,
  badge,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  /** Optional mark before the title (the Semantics section's spark). */
  icon?: ReactNode;
  /** Optional count pill after the title. */
  badge?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`prop-sec${open ? " open" : ""}`}>
      <button type="button" className="prop-sec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {icon}
        {title}
        {badge}
      </button>
      {open && <div className="prop-sec-body">{children}</div>}
    </div>
  );
}

/** Header marks for an object's "Semantics" section: the spark, plus how many
 * fields are filled in (so a collapsed section still says it holds something). */
const SEMANTICS_ICON = <span className="sem-sec-mark" aria-hidden="true"><SparkMark size={11} /></span>;
function semanticsBadge(meta: ObjectMeta | undefined): ReactNode {
  if (!hasSemanticMeta(meta)) return null;
  const n = Object.keys(meta ?? {}).length;
  return <span className="sem-sec-count" title={`${n} semantic field${n === 1 ? "" : "s"} set`}>{n}</span>;
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
/** Hint pointing at the left style panel — the ONE place for colours,
 * strokes, text style, animation, layers and actions (no duplicates here). */
function StyleHint() {
  return (
    <div className="prop-hint props-style-hint">
      Colours, stroke, text style, animation and layers are in the style panel on the left.
    </div>
  );
}

/* ---------- one diagram node ----------
 * Only what the left style panel does NOT have: the name, exact
 * position/size and text wrapping. Everything else lives on the left. */
function NodeProps({ id }: { id: string }) {
  const node = useDiagramStore((s) => s.nodes[id]);
  const updateNode = useDiagramStore((s) => s.updateNode);
  const setDiagramSelection = useDiagramStore((s) => s.setDiagramSelection);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const readOnly = useEditorStore((s) => s.myRole === "viewer");
  if (!node) return null;
  const isInk = node.kind === "freedraw";

  return (
    <div className="props2">
      <div className="props-head">
        <span className="g" style={{ background: isInk ? "#f1f0ff" : node.fill, color: node.stroke }}>{NODE_GLYPH[node.kind] ?? "◆"}</span>
        <div className="body">
          {isInk ? (
            <div className="props-name" style={{ fontWeight: 600 }}>Pen stroke</div>
          ) : (
            <input className="props-name" value={node.text} placeholder="Label" onChange={(e) => updateNode(id, { text: e.target.value })} />
          )}
          <div className="props-type">{isInk ? "freehand ink" : NODE_LABEL[node.kind] ?? node.kind}</div>
        </div>
        <button className="props-close" aria-label="Deselect" onClick={() => setDiagramSelection([])}>✕</button>
      </div>

      <Section title="Position & size" defaultOpen>
        <div className="xy-grid">
          <NumField label="X" value={node.x} onCommit={(n) => updateNode(id, { x: n })} />
          <NumField label="Y" value={node.y} onCommit={(n) => updateNode(id, { y: n })} />
          <NumField label="W" value={node.w} min={isInk ? 4 : 20} onCommit={(n) => updateNode(id, { w: n })} />
          <NumField label="H" value={node.h} min={isInk ? 4 : 20} onCommit={(n) => updateNode(id, { h: n })} />
          {/* OSS: shapes rotate around their centre (drag the ⟳ handle, or type). */}
          <NumField
            label="∠°"
            value={node.rotation ?? 0}
            onCommit={(n) => {
              const deg = ((n % 360) + 360) % 360;
              updateNode(id, { rotation: deg === 0 ? undefined : deg });
            }}
          />
        </div>
      </Section>

      {!isInk && (
        <div className="prop-row">
          <span className="lbl" title="Excel-style wrap: long labels break into lines that fit the shape">Wrap text</span>
          <button className={`switch${node.wrap ? " on" : ""}`} onClick={() => updateNode(id, { wrap: !node.wrap })}>
            <span className="knob" />
          </button>
        </div>
      )}
      {!isInk && !node.wrap && labelOverflows(node) && (
        <div className="prop-hint">Text overflows the shape — turn on Wrap text.</div>
      )}

      {!isInk && (
        <Section title="Semantics" defaultOpen={hasSemanticMeta(node.meta)} icon={SEMANTICS_ICON} badge={semanticsBadge(node.meta)}>
          <ObjectMetaEditor
            kind="node"
            meta={node.meta}
            readOnly={readOnly}
            onChange={(meta) => updateNode(id, { meta })}
          />
        </Section>
      )}

      <StyleHint />

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
  const updateEdge0 = useDiagramStore((s) => s.updateEdge);
  // Style edits are REMEMBERED — the next drawn arrow is born with them
  // (editorStore.edgeStyle keeps only style fields; labels/z never stick).
  const updateEdge = (eid: string, patch: Parameters<typeof updateEdge0>[1]) => {
    updateEdge0(eid, patch);
    useEditorStore.getState().setEdgeStyle(patch);
  };
  const setEdgeLabel = useDiagramStore((s) => s.setEdgeLabel);
  const toggleAnimated = useDiagramStore((s) => s.toggleEdgeAnimated);
  const deleteSelected = useDiagramStore((s) => s.deleteSelectedDiagram);
  const setDiagramSelection = useDiagramStore((s) => s.setDiagramSelection);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const readOnly = useEditorStore((s) => s.myRole === "viewer");
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
      <input className="text-input" style={{ marginBottom: 12 }} placeholder="Add label…" value={edge.label ?? ""} onChange={(e) => setEdgeLabel(id, e.target.value)} />

      <Section title="Line" defaultOpen>
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
      </Section>

      <Section title="Endpoints">
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
      </Section>

      <Section title="Semantics" defaultOpen={hasSemanticMeta(edge.meta)} icon={SEMANTICS_ICON} badge={semanticsBadge(edge.meta)}>
        <ObjectMetaEditor
          kind="edge"
          meta={edge.meta}
          readOnly={readOnly}
          // Not the style-remembering wrapper: meta must never stick to the
          // next drawn arrow.
          onChange={(meta) => updateEdge0(id, { meta })}
        />
      </Section>

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

/* ---------- no selection: board overview + page settings ---------- */

/** Doodle spot art for the empty state — sketchy shapes + a cursor, in the
 * house ember/ink palette (inline SVG per the no-glossy-icons rule). */
function BoardDoodle() {
  return (
    <svg viewBox="0 0 96 60" width="96" height="60" fill="none" aria-hidden="true">
      <rect x="8" y="12" width="30" height="20" rx="4" stroke="#2d3142" strokeWidth="1.8" />
      <ellipse cx="70" cy="20" rx="15" ry="10" stroke="#eb6c36" strokeWidth="1.8" />
      <path d="M38 22 C48 22, 48 20, 55 20" stroke="#4f5d75" strokeWidth="1.6" strokeDasharray="3 3" />
      <path d="M22 40 q 14 12 34 2" stroke="#4f5d75" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M62 38 L74 52 L67 51 L70 58" stroke="#2d3142" strokeWidth="1.8" strokeLinejoin="round" fill="#fff" />
    </svg>
  );
}

/** One shortcut row for the cheat-sheet. */
function Kbd({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="kbd-row">
      <span className="kbd-keys">
        {keys.split(" ").map((k) => (
          <kbd key={k}>{k}</kbd>
        ))}
      </span>
      <span className="kbd-what">{label}</span>
    </div>
  );
}

function PageSettings() {
  const gridOn = useAppStore((s) => s.gridOn);
  const snapOn = useAppStore((s) => s.snapOn);
  const toggleGrid = useAppStore((s) => s.toggleGrid);
  const toggleSnap = useAppStore((s) => s.toggleSnap);
  const pageBackdrop = useAppStore((s) => s.pageBackdrop);
  const togglePageBackdrop = useAppStore((s) => s.togglePageBackdrop);
  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const autoRouteAllEdges = useDiagramStore((s) => s.autoRouteAllEdges);
  const pageCount = usePagesStore((s) => s.pages.length);
  const edgeCount = Object.keys(edges).length;

  const applyTheme = (themeId: string) => {
    const t = THEMES.find((x) => x.id === themeId);
    if (!t) return;
    const ds = useDiagramStore.getState();
    Object.keys(nodes).forEach((id) => ds.updateNode(id, { fill: t.fill, stroke: t.stroke }));
    Object.keys(edges).forEach((id) => ds.updateEdge(id, { stroke: t.stroke }));
  };

  const nodeCount = Object.keys(nodes).length;

  return (
    <div className="props2">
      {/* A board with content opens on its live semantic overview; an empty
          one keeps the warm hello. */}
      {nodeCount === 0 && (
        <div className="board-hello">
          <BoardDoodle />
          <div className="t">Nothing selected</div>
          <div className="d">Click a shape to style it — meanwhile, here's your board.</div>
          <div className="stat-chips">
            <span className="stat"><b>{nodeCount}</b> shapes</span>
            <span className="stat"><b>{edgeCount}</b> connectors</span>
            <span className="stat"><b>{pageCount}</b> {pageCount === 1 ? "page" : "pages"}</span>
          </div>
        </div>
      )}

      <BoardOverviewCard empty={nodeCount === 0} />

      <div className="props-label">Page</div>
      <div className="prop-row">
        <span className="lbl">Show grid</span>
        <button className={`switch${gridOn ? " on" : ""}`} onClick={toggleGrid}><span className="knob" /></button>
      </div>
      <div className="prop-row">
        <span className="lbl">Snap to grid</span>
        <button className={`switch${snapOn ? " on" : ""}`} onClick={toggleSnap}><span className="knob" /></button>
      </div>
      <div className="prop-row">
        <span className="lbl" title="The white page behind your shapes. Off = an infinite Excalidraw-style canvas (no page rectangle)">
          Page backdrop
        </span>
        <button className={`switch${pageBackdrop ? " on" : ""}`} onClick={togglePageBackdrop}><span className="knob" /></button>
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
      <div className="theme-grid">
        {THEMES.map((th) => (
          <button
            key={th.id}
            className="theme-card"
            title={`Recolor every shape with the ${th.name} palette`}
            onClick={() => applyTheme(th.id)}
          >
            <span className="sw" style={{ background: th.swatch }} />
            <span className="nm">{th.name}</span>
          </button>
        ))}
      </div>

      <div className="props-label" style={{ marginTop: 8 }}>Shortcuts</div>
      <div className="kbd-sheet">
        <Kbd keys="V" label="Select" />
        <Kbd keys="H" label="Pan" />
        <Kbd keys="1–9" label="Tools (island)" />
        <Kbd keys="⌘Z" label="Undo" />
        <Kbd keys="⌘0" label="Fit to view" />
        <Kbd keys="Del" label="Delete selection" />
        <Kbd keys="Space drag" label="Pan the canvas" />
        <Kbd keys="⌘V" label="Paste an image" />
      </div>
    </div>
  );
}

/** Nothing selected: the LIVE semantic overview of the whole page first
 * (zones, components, flows — computed, so it has value on any board), with
 * a metadata toggle for the board/page summary, category and tags. An empty
 * page opens straight on the metadata form. The card bleeds a few px into the
 * panel padding so the overview gets every pixel of the ~300px inspector. */
function BoardOverviewCard({ empty }: { empty: boolean }) {
  const readOnly = useEditorStore((s) => s.myRole === "viewer");
  const [editing, setEditing] = useState(false);
  const summary = useLiveSemanticSummary();
  const showForm = editing || empty;
  const editLabel = editing ? "Back to the overview" : readOnly ? "View metadata" : "Edit metadata";
  return (
    <div className={`sov-card${showForm ? " editing" : ""}`}>
      <div className="sov-card-head">
        <span className="sem-jewel" aria-hidden="true"><SparkMark size={13} /></span>
        <div className="sov-card-titles">
          <span className="sov-card-t">{empty ? "Board semantics" : editing ? "Metadata" : "Overview"}</span>
          <span className="sov-card-sub">
            {showForm ? (
              "Board & page"
            ) : (
              <>
                <i className="sov-live-dot" aria-hidden="true" />
                Live
              </>
            )}
          </span>
        </div>
        {!empty && <CopyForAIButton summary={summary} compact />}
        {!empty && (
          <button
            type="button"
            className={`sov-edit${editing ? " on" : ""}`}
            aria-pressed={editing}
            aria-label={editLabel}
            title={editLabel}
            onClick={() => setEditing(!editing)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {editing ? (
                <path d="M3.6 8.4 L6.6 11.3 L12.4 4.9" strokeWidth="1.8" />
              ) : (
                <>
                  <path d="M2.4 4.6 H8.2 M11.8 4.6 H13.6 M2.4 11.4 H4.2 M7.8 11.4 H13.6" />
                  <circle cx="10" cy="4.6" r="1.8" />
                  <circle cx="6" cy="11.4" r="1.8" />
                </>
              )}
            </svg>
          </button>
        )}
      </div>
      <div className="sov-card-body">
        {showForm ? <BoardSemanticsForm readOnly={readOnly} /> : <SemanticOverview summary={summary} />}
      </div>
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
  const allGrouped =
    selNodes.length > 1 &&
    !!nodes[selNodes[0]].groupId &&
    selNodes.every((id) => nodes[id].groupId === nodes[selNodes[0]].groupId);
  const allWrap = selNodes.length > 0 && selNodes.every((id) => nodes[id].wrap);
  const texty = selNodes.filter((id) => nodes[id].kind !== "freedraw");

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
        <button className="props-close" aria-label="Deselect" onClick={() => setDiagramSelection([])}>✕</button>
      </div>
      {texty.length > 0 && (
        <div className="prop-row">
          <span className="lbl">Wrap text</span>
          <button
            className={`switch${allWrap ? " on" : ""}`}
            onClick={() => {
              const ds = useDiagramStore.getState();
              texty.forEach((id) => ds.updateNode(id, { wrap: !allWrap }));
            }}
          >
            <span className="knob" />
          </button>
        </div>
      )}
      <div className="prop-hint props-style-hint">
        Style, align, distribute, group, layers and flip are in the style panel on the left.
        Drag a corner of the selection frame to scale everything together.
      </div>
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
