/**
 * features/diagram/ShapePalette — the diagram feature's SHARED shape module:
 *
 *  • `shapeElement(node)` — the pure SVG for every NodeKind (paths/polygons
 *    sized to the node's x/y/w/h, no external deps). Used by NodeView to render
 *    a live node and by `MiniGlyph` to render a palette preview, so there is a
 *    single source of truth for shape geometry. Unknown kind → rect fallback.
 *  • `SHAPE_SECTIONS` — the Lucid-style palette catalog (Basic / Flowchart /
 *    AWS / Databricks-Data), consumed by the editor's LeftPanel Shapes tab.
 *  • `MiniGlyph` — a tiny SVG preview of a catalog entry for the palette cells.
 *  • `inUseEntries(nodes)` — distinct catalog entries present on the board (for
 *    the "In use" section).
 *
 * PURE presentation: no store imports, no side effects — just node → SVG.
 */
import type { DiagramNode, NodeKind } from "../../editor-core/diagram";
import { SHAPE_DEFS } from "../../editor-core/diagram/shapeDefs";
import { ICONS, iconDef, type IconDef } from "./icons";
import { SHAPE_RENDERERS } from "./shapes";

/** A colored tile + white line-glyph for an `icon`-kind node. */
function IconBadge({
  def,
  x,
  y,
  w,
  h,
}: {
  def: IconDef;
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const bs = Math.min(w * 0.62, h * 0.52); // badge side
  const bx = x + (w - bs) / 2;
  const by = y + Math.max(8, h * 0.12);
  const r = Math.max(4, bs * 0.2);
  const s = bs / 24; // motif authored in a 0..24 box
  const sw = 1.9 / s; // ~1.9 content units after the scale (matches node strokes)
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={bx} y={by} width={bs} height={bs} rx={r} ry={r} fill={def.accent} />
      <g
        transform={`translate(${bx} ${by}) scale(${s})`}
        fill="none"
        stroke="#ffffff"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {def.motif.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </g>
  );
}

/**
 * Render the shape for a single node. Additive: the original four kinds are
 * untouched; the flowchart family + icon tiles are new; any unknown kind falls
 * through to a plain rectangle so old/foreign boards still render.
 */
/**
 * Static border dash pattern for a node outline, scaled by stroke width — mirrors
 * the edge dash formula (EdgeView.staticDashArray) so shapes and connectors match.
 * Rendered as an INLINE `stroke-dasharray` attribute so it survives DOM-clone bake.
 */
function nodeDashArray(dash: DiagramNode["strokeDash"], sw: number): string | undefined {
  if (dash === "dashed") return `${Math.max(4, sw * 3)} ${Math.max(3, sw * 2)}`;
  if (dash === "dotted") return `${Math.max(1, sw)} ${Math.max(2, sw * 1.8)}`;
  return undefined;
}

export function shapeElement(node: DiagramNode) {
  const { x, y, w, h, fill, stroke, strokeWidth, kind } = node;
  // Inline strokeDasharray (undefined → omitted, i.e. solid). Applied to every
  // switch-rendered outline via `common`, so old boards stay solid by default.
  const dashArr = nodeDashArray(node.strokeDash, strokeWidth);
  const common = { fill, stroke, strokeWidth, strokeDasharray: dashArr };
  const line = { stroke, strokeWidth, strokeDasharray: dashArr };

  // New catalog kinds (shapes/* registry) resolve here first; the switch below
  // keeps rendering the original kinds. Registry misses fall through.
  const registered = SHAPE_RENDERERS[kind];
  if (registered) return registered(node);

  switch (kind) {
    case "ellipse":
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;

    case "diamond": {
      const pts = [
        `${x + w / 2},${y}`,
        `${x + w},${y + h / 2}`,
        `${x + w / 2},${y + h}`,
        `${x},${y + h / 2}`,
      ].join(" ");
      return <polygon points={pts} {...common} />;
    }

    case "rounded": {
      const r = node.cornerRadius ?? 8;
      return <rect x={x} y={y} width={w} height={h} rx={r} ry={r} {...common} />;
    }

    // ---- Extra geometric shapes -------------------------------------------
    case "triangle": {
      const pts = `${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`;
      return <polygon points={pts} {...common} strokeLinejoin="round" />;
    }

    case "pentagon": {
      const cx = x + w / 2;
      const pts = [
        `${cx},${y}`,
        `${x + w},${y + h * 0.38}`,
        `${x + w * 0.82},${y + h}`,
        `${x + w * 0.18},${y + h}`,
        `${x},${y + h * 0.38}`,
      ].join(" ");
      return <polygon points={pts} {...common} strokeLinejoin="round" />;
    }

    case "star": {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      const inner = 0.42;
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5; // start at top
        const rr = i % 2 === 0 ? 1 : inner;
        pts.push(`${cx + Math.cos(ang) * rx * rr},${cy + Math.sin(ang) * ry * rr}`);
      }
      return <polygon points={pts.join(" ")} {...common} strokeLinejoin="round" />;
    }

    case "cross": {
      // Plus sign: an axis-aligned cross with a configurable arm thickness.
      const t = Math.min(w, h) * 0.34; // arm thickness
      const cx = x + w / 2;
      const cy = y + h / 2;
      const pts = [
        `${cx - t / 2},${y}`,
        `${cx + t / 2},${y}`,
        `${cx + t / 2},${cy - t / 2}`,
        `${x + w},${cy - t / 2}`,
        `${x + w},${cy + t / 2}`,
        `${cx + t / 2},${cy + t / 2}`,
        `${cx + t / 2},${y + h}`,
        `${cx - t / 2},${y + h}`,
        `${cx - t / 2},${cy + t / 2}`,
        `${x},${cy + t / 2}`,
        `${x},${cy - t / 2}`,
        `${cx - t / 2},${cy - t / 2}`,
      ].join(" ");
      return <polygon points={pts} {...common} strokeLinejoin="round" />;
    }

    case "cloud": {
      // A puffy speech-of-clouds outline built from arcs over the AABB.
      const d = `M ${x + w * 0.25} ${y + h * 0.85}
        C ${x + w * 0.02} ${y + h * 0.85} ${x + w * 0.02} ${y + h * 0.5} ${x + w * 0.2} ${y + h * 0.47}
        C ${x + w * 0.16} ${y + h * 0.18} ${x + w * 0.5} ${y + h * 0.1} ${x + w * 0.56} ${y + h * 0.32}
        C ${x + w * 0.66} ${y + h * 0.08} ${x + w * 0.95} ${y + h * 0.16} ${x + w * 0.86} ${y + h * 0.42}
        C ${x + w * 1.02} ${y + h * 0.46} ${x + w * 1.0} ${y + h * 0.85} ${x + w * 0.78} ${y + h * 0.85}
        Z`;
      return <path d={d} {...common} strokeLinejoin="round" />;
    }

    case "callout": {
      // Rounded speech bubble with a downward tail on the lower-left.
      const r = Math.min(w, h) * 0.14;
      const bodyH = h * 0.78; // body above the tail
      const by = y + bodyH;
      const tailX = x + w * 0.24;
      const body = `M ${x + r} ${y}
        H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r}
        V ${by - r} A ${r} ${r} 0 0 1 ${x + w - r} ${by}
        H ${tailX + w * 0.12} L ${tailX} ${y + h} L ${tailX + w * 0.02} ${by}
        H ${x + r} A ${r} ${r} 0 0 1 ${x} ${by - r}
        V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
      return <path d={body} {...common} strokeLinejoin="round" />;
    }

    // ---- Flowchart family --------------------------------------------------
    case "process": {
      const bar = Math.min(14, w * 0.12);
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} {...common} />
          <line x1={x + bar} y1={y} x2={x + bar} y2={y + h} {...line} />
          <line x1={x + w - bar} y1={y} x2={x + w - bar} y2={y + h} {...line} />
        </g>
      );
    }

    case "terminator":
      return <rect x={x} y={y} width={w} height={h} rx={h / 2} ry={h / 2} {...common} />;

    case "document": {
      const wave = h * 0.16;
      const by = y + h - wave;
      const d = `M ${x} ${y} H ${x + w} V ${by} C ${x + w * 0.72} ${by + wave * 1.6} ${x + w * 0.28} ${by - wave * 1.6} ${x} ${by} Z`;
      return <path d={d} {...common} />;
    }

    case "parallelogram": {
      const sk = w * 0.2;
      const pts = `${x + sk},${y} ${x + w},${y} ${x + w - sk},${y + h} ${x},${y + h}`;
      return <polygon points={pts} {...common} />;
    }

    case "cylinder": {
      const ry = Math.min(h * 0.16, 16);
      const body = `M ${x} ${y + ry} C ${x} ${y} ${x + w} ${y} ${x + w} ${y + ry} L ${x + w} ${y + h - ry} C ${x + w} ${y + h} ${x} ${y + h} ${x} ${y + h - ry} Z`;
      const cap = `M ${x} ${y + ry} C ${x} ${y + 2 * ry} ${x + w} ${y + 2 * ry} ${x + w} ${y + ry}`;
      return (
        <g>
          <path d={body} {...common} />
          <path d={cap} fill="none" {...line} />
        </g>
      );
    }

    case "hexagon": {
      const cut = Math.min(w * 0.2, 26);
      const pts = `${x + cut},${y} ${x + w - cut},${y} ${x + w},${y + h / 2} ${x + w - cut},${y + h} ${x + cut},${y + h} ${x},${y + h / 2}`;
      return <polygon points={pts} {...common} />;
    }

    case "manualInput": {
      const sl = h * 0.28;
      const pts = `${x},${y + sl} ${x + w},${y} ${x + w},${y + h} ${x},${y + h}`;
      return <polygon points={pts} {...common} />;
    }

    case "delay": {
      const r = h / 2;
      const d = `M ${x} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x} Z`;
      return <path d={d} {...common} />;
    }

    case "display": {
      const r = h / 2;
      const d = `M ${x} ${y + h / 2} L ${x + w * 0.2} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x + w * 0.2} ${y + h} Z`;
      return <path d={d} {...common} />;
    }

    case "card": {
      const cut = Math.min(w * 0.18, h * 0.35, 24);
      const pts = `${x + cut},${y} ${x + w},${y} ${x + w},${y + h} ${x},${y + h} ${x},${y + cut}`;
      return <polygon points={pts} {...common} />;
    }

    case "internalStorage": {
      const inx = Math.min(w * 0.2, 20);
      const iny = Math.min(h * 0.28, 20);
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} {...common} />
          <line x1={x} y1={y + iny} x2={x + w} y2={y + iny} {...line} />
          <line x1={x + inx} y1={y} x2={x + inx} y2={y + h} {...line} />
        </g>
      );
    }

    case "note": {
      const f = Math.min(w * 0.24, h * 0.4, 22);
      const body = `M ${x} ${y} H ${x + w - f} L ${x + w} ${y + f} V ${y + h} H ${x} Z`;
      const fold = `M ${x + w - f} ${y} V ${y + f} H ${x + w}`;
      return (
        <g>
          <path d={body} {...common} />
          <path d={fold} fill="none" {...line} />
        </g>
      );
    }

    case "sticky": {
      // Flat square sticky note with a soft drop shadow + a subtle peeled
      // corner — the classic retro/brainstorm card.
      const f = Math.min(w, h) * 0.16;
      return (
        <g>
          <rect x={x + 2} y={y + 4} width={w} height={h} fill="rgba(0,0,0,0.10)" />
          <path
            d={`M ${x} ${y} H ${x + w} V ${y + h - f} L ${x + w - f} ${y + h} H ${x} Z`}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <path
            d={`M ${x + w - f} ${y + h} V ${y + h - f} H ${x + w}`}
            fill="rgba(0,0,0,0.08)"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        </g>
      );
    }

    case "actor": {
      const acx = x + w / 2;
      const headR = Math.min(w, h) * 0.14;
      const headCy = y + headR + h * 0.06;
      const bodyTop = headCy + headR;
      const bodyBot = y + h * 0.68;
      const armY = bodyTop + (bodyBot - bodyTop) * 0.25;
      const legBot = y + h * 0.96;
      const spread = w * 0.26;
      return (
        <g fill="none" {...line} strokeLinecap="round">
          <circle cx={acx} cy={headCy} r={headR} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <line x1={acx} y1={bodyTop} x2={acx} y2={bodyBot} />
          <line x1={acx - spread} y1={armY} x2={acx + spread} y2={armY} />
          <line x1={acx} y1={bodyBot} x2={acx - spread} y2={legBot} />
          <line x1={acx} y1={bodyBot} x2={acx + spread} y2={legBot} />
        </g>
      );
    }

    case "icon": {
      const def = iconDef(node.iconKey);
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} rx={12} ry={12} {...common} />
          {def && <IconBadge def={def} x={x} y={y} w={w} h={h} />}
        </g>
      );
    }

    case "image": {
      // Uploaded raster stretched to the node box (preserveAspectRatio="none"
      // keeps the visual identical to the rect geometry that ports/perimeter
      // routing use). Optional frame drawn only when the user sets a stroke.
      if (!node.imageHref) {
        // Missing/stripped href (e.g. foreign board): dashed placeholder.
        return (
          <rect x={x} y={y} width={w} height={h} fill="#f1f3f7"
            stroke="#9aa1ad" strokeWidth={1.5} strokeDasharray="6 4" />
        );
      }
      return (
        <g>
          <image
            href={node.imageHref}
            x={x} y={y} width={w} height={h}
            preserveAspectRatio="none"
          />
          {strokeWidth > 0 && (
            <rect x={x} y={y} width={w} height={h} fill="none" {...line} />
          )}
        </g>
      );
    }

    case "rect":
    default: {
      // Plain rect gains OPTIONAL rounding when cornerRadius is set (absent →
      // sharp corners, the legacy look).
      const r = node.cornerRadius;
      return <rect x={x} y={y} width={w} height={h} rx={r} ry={r} {...common} />;
    }
  }
}

// ---------------------------------------------------------------------------
// Palette catalog
// ---------------------------------------------------------------------------

export interface PaletteEntry {
  kind: NodeKind;
  /** Panel label + search key. */
  label: string;
  /** Text shown on the drag ghost. */
  glyph: string;
  /** For icon entries: the icons.ts registry key. */
  iconKey?: string;
  /** Optional fill/stroke override applied when the node is created (sticky colors). */
  fill?: string;
  stroke?: string;
  /** Optional default text on create. */
  text?: string;
}

export interface PaletteSection {
  name: string;
  entries: PaletteEntry[];
}

const BASIC: PaletteEntry[] = [
  { kind: "rect", label: "Rectangle", glyph: "▭" },
  { kind: "rounded", label: "Rounded", glyph: "▢" },
  { kind: "ellipse", label: "Ellipse", glyph: "◯" },
  { kind: "diamond", label: "Diamond", glyph: "◇" },
];

/** Palette entries for a shapeDefs group (keeps the data catalog the single
 * source for label/glyph so a new row auto-appears in the palette). */
function defEntries(group: string): PaletteEntry[] {
  return SHAPE_DEFS.filter((d) => d.group === group).map((d) => ({
    kind: d.kind,
    label: d.label,
    glyph: d.glyph,
  }));
}

// "Shapes" = the geometric group (triangle/pentagon/…/heart/banner). The four
// legacy kinds star/cross/cloud/callout live in the geometric group in the
// catalog too, so this is a superset of the old hand-listed set.
const SHAPES: PaletteEntry[] = defEntries("geometric");

// Flowchart = the catalog's flowchart group + Decision (diamond, a basic kind
// but the canonical decision node) + Actor (misc). Order: decision first.
const FLOWCHART: PaletteEntry[] = [
  { kind: "diamond", label: "Decision", glyph: "◆" },
  ...defEntries("flowchart"),
  { kind: "actor", label: "Actor", glyph: "☻" },
];

const ARROWS: PaletteEntry[] = defEntries("arrows");
const UML: PaletteEntry[] = defEntries("uml");

function iconEntries(group: IconDef["group"]): PaletteEntry[] {
  return Object.values(ICONS)
    .filter((i) => i.group === group)
    .map((i) => ({
      kind: "icon" as NodeKind,
      label: i.label,
      glyph: i.abbrev,
      iconKey: i.key,
    }));
}

// Colored sticky notes for retro / brainstorm boards.
const STICKY_COLORS: { name: string; fill: string; stroke: string }[] = [
  { name: "Yellow", fill: "#fff3bf", stroke: "#f0c000" },
  { name: "Green", fill: "#d3f9d8", stroke: "#37b24d" },
  { name: "Blue", fill: "#d0ebff", stroke: "#1c7ed6" },
  { name: "Pink", fill: "#ffdeeb", stroke: "#e64980" },
  { name: "Orange", fill: "#ffe8cc", stroke: "#f76707" },
  { name: "Purple", fill: "#e5dbff", stroke: "#7048e8" },
];
const STICKIES: PaletteEntry[] = STICKY_COLORS.map((c) => ({
  kind: "sticky" as NodeKind,
  label: `${c.name} note`,
  glyph: "▧",
  fill: c.fill,
  stroke: c.stroke,
}));

export const SHAPE_SECTIONS: PaletteSection[] = [
  { name: "Basic", entries: BASIC },
  { name: "Shapes", entries: SHAPES },
  { name: "Sticky notes", entries: STICKIES },
  { name: "Flowchart", entries: FLOWCHART },
  { name: "Arrows", entries: ARROWS },
  { name: "UML", entries: UML },
  { name: "AWS", entries: iconEntries("aws") },
  { name: "GCP", entries: iconEntries("gcp") },
  { name: "Azure", entries: iconEntries("azure") },
  { name: "Databricks / Data", entries: iconEntries("data") },
  { name: "Network", entries: iconEntries("network") },
];

/** Toggleable stencil libraries (#19) — section name → picker label. The
 * non-library sections (Basic/Shapes/…) are always on. */
export const STENCIL_LIBRARIES: { section: string; label: string }[] = [
  { section: "AWS", label: "AWS" },
  { section: "GCP", label: "GCP" },
  { section: "Azure", label: "Azure" },
  { section: "Databricks / Data", label: "Data" },
  { section: "Network", label: "Network" },
];

const ALL_ENTRIES: PaletteEntry[] = SHAPE_SECTIONS.flatMap((s) => s.entries);

/** Stable key for grouping "in use" (icon nodes distinguished by iconKey). */
function paletteKey(kind: NodeKind, iconKey?: string): string {
  return kind === "icon" ? `icon:${iconKey ?? ""}` : kind;
}

/** Distinct catalog entries present on the board (for the "In use" section). */
export function inUseEntries(nodes: DiagramNode[]): PaletteEntry[] {
  const seen = new Set<string>();
  const out: PaletteEntry[] = [];
  for (const n of nodes) {
    const k = paletteKey(n.kind, n.iconKey);
    if (seen.has(k)) continue;
    seen.add(k);
    const match = ALL_ENTRIES.find((e) => paletteKey(e.kind, e.iconKey) === k);
    out.push(
      match ?? { kind: n.kind, label: n.kind, glyph: "▭", iconKey: n.iconKey },
    );
  }
  return out;
}

/** A tiny SVG preview of a catalog entry, used inside a palette cell. */
export function MiniGlyph({ entry }: { entry: PaletteEntry }) {
  const node: DiagramNode =
    entry.kind === "icon"
      ? {
          id: "_m",
          kind: "icon",
          iconKey: entry.iconKey,
          x: 9,
          y: 1,
          w: 26,
          h: 30,
          text: "",
          fill: "#ffffff",
          stroke: "#d5d9e0",
          strokeWidth: 1,
        }
      : {
          id: "_m",
          kind: entry.kind,
          x: 6,
          y: 5,
          w: 32,
          h: 22,
          text: "",
          // Honor the entry's own colors (e.g. the 6 sticky-note colors) so the
          // palette preview matches what gets added; fall back to a neutral tile.
          fill: entry.fill ?? "#eef4ff",
          stroke: entry.stroke ?? "#5b6472",
          strokeWidth: 1.5,
        };
  return (
    <svg viewBox="0 0 44 32" width="100%" height="100%" style={{ display: "block" }} aria-hidden="true">
      {shapeElement(node)}
    </svg>
  );
}
