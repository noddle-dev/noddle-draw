/**
 * features/dashboard/Thumbnails — the little diagram previews used on doc cards
 * and template cards. Pure decorative SVG, parameterised by an accent colour.
 * No untrusted input.
 *
 * Template cards render a REAL mini-preview of the template's structure: we call
 * the template's own `build()` (the same node/edge graph the editor loads) and
 * scale it into a small viewBox so every card is genuinely recognisable rather
 * than a generic per-family placeholder. A hand-authored per-shape fallback is
 * kept for callers that pass no `build`.
 */
import type { DiagramEdge, DiagramNode } from "../../editor-core/diagram";

/** Minimal shape a template thumbnail needs (structural — see templates.ts). */
export interface ThumbTemplate {
  accent: string;
  shape: "flow" | "tree" | "erd" | "cloud" | "seq" | "retro" | "blank";
  /** Same builder the editor uses — when present the thumb mini-renders it. */
  build?: () => { nodes: DiagramNode[]; edges: DiagramEdge[] };
}

/** Recent / folder doc-card preview. */
export function DocThumb({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 220 118" width="100%" height="100%" style={{ display: "block" }}>
      <rect x="18" y="30" width="46" height="26" rx="6" fill="#fff" stroke={accent} strokeWidth="1.5" />
      <rect x="92" y="18" width="46" height="26" rx="6" fill="#fff" stroke="#d7dae0" strokeWidth="1.5" />
      <rect x="92" y="66" width="46" height="26" rx="6" fill="#fff" stroke="#d7dae0" strokeWidth="1.5" />
      <rect x="162" y="42" width="42" height="26" rx="6" fill={accent} opacity="0.14" />
      <rect x="162" y="42" width="42" height="26" rx="6" fill="none" stroke={accent} strokeWidth="1.5" />
      <path d="M64 43 H92 M138 31 H150 V54 M138 79 H150 V54 H162" fill="none" stroke="#c2c8d2" strokeWidth="1.5" />
    </svg>
  );
}

/** A single node of the mini-render, drawn by kind at content coords. */
function MiniNode({ n, sw }: { n: DiagramNode; sw: number }) {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const common = { fill: n.fill, stroke: n.stroke, strokeWidth: sw } as const;
  switch (n.kind) {
    case "ellipse":
      return <ellipse cx={cx} cy={cy} rx={n.w / 2} ry={n.h / 2} {...common} />;
    case "diamond":
      return (
        <polygon
          points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`}
          {...common}
        />
      );
    default:
      return (
        <rect
          x={n.x}
          y={n.y}
          width={n.w}
          height={n.h}
          rx={Math.min(16, n.h / 3)}
          {...common}
        />
      );
  }
}

/**
 * Scale a template's real node/edge graph into a small, clean preview. Edges are
 * drawn as straight connectors between node centres (enough to read the shape of
 * a flow/tree/ERD/sequence); stroke widths track the board's extent so they stay
 * ~1px on the card in both themes (the thumb sits on the template's light soft bg).
 */
function MiniDiagram({ nodes, edges }: { nodes: DiagramNode[]; edges: DiagramEdge[] }) {
  if (!nodes.length) return null;
  const pad = 26;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const ox = minX - pad;
  const oy = minY - pad;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const sw = Math.max(w, h) / 150;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const center = (id: string | undefined) => {
    const n = id ? byId.get(id) : undefined;
    return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
  };

  return (
    <svg
      viewBox={`${ox} ${oy} ${w} ${h}`}
      width="88%"
      height="88%"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block" }}
    >
      <g fill="none" stroke="#94a3b8" strokeWidth={sw} strokeLinecap="round">
        {edges.map((e) => {
          const a = center("nodeId" in e.source ? e.source.nodeId : undefined);
          const b = center("nodeId" in e.target ? e.target.nodeId : undefined);
          if (!a || !b) return null;
          return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
      {nodes.map((n) => (
        <MiniNode key={n.id} n={n} sw={sw} />
      ))}
    </svg>
  );
}

/** Template-card preview — real mini-render of `build()`, else per-family fallback. */
export function TemplateThumb({ tpl }: { tpl: ThumbTemplate }) {
  const a = tpl.accent;
  if (tpl.shape === "blank") return null;
  if (tpl.build) {
    const { nodes, edges } = tpl.build();
    return <MiniDiagram nodes={nodes} edges={edges} />;
  }
  switch (tpl.shape) {
    case "retro":
      return (
        <svg viewBox="0 0 200 120" width="80%" style={{ display: "block" }}>
          {/* brand title banner */}
          <rect x={16} y={6} width={168} height={15} rx={5} fill="#ede9fe" stroke="#7c3aed" strokeWidth="1.4" />
          <circle cx={26} cy={13.5} r={2.6} fill="#7c3aed" />
          <rect x={34} y={11} width={74} height={5} rx={2.5} fill="#7c3aed" opacity="0.5" />
          {[
            { x: 20, zone: "#f0fdf4", head: "#bbf7d0", fill: "#dcfce7", stroke: "#16a34a" },
            { x: 77, zone: "#fef2f2", head: "#fecaca", fill: "#fee2e2", stroke: "#dc2626" },
            { x: 134, zone: "#eff6ff", head: "#bfdbfe", fill: "#dbeafe", stroke: "#2563eb" },
          ].map((c) => (
            <g key={c.x}>
              {/* soft column zone */}
              <rect x={c.x - 3} y={28} width={52} height={84} rx={7} fill={c.zone} />
              {/* header chip */}
              <rect x={c.x} y={31} width={46} height={13} rx={4} fill={c.head} stroke={c.stroke} strokeWidth="1" />
              {/* two sticky cards with a folded corner */}
              {[49, 79].map((cy) => (
                <g key={cy}>
                  <rect x={c.x + 2} y={cy} width={42} height={26} rx={3} fill={c.fill} stroke={c.stroke} strokeWidth="1.3" />
                  <path d={`M${c.x + 38} ${cy + 26} h6 v-6 z`} fill={c.stroke} opacity="0.28" />
                </g>
              ))}
            </g>
          ))}
        </svg>
      );
    case "flow":
      return (
        <svg viewBox="0 0 200 120" width="80%" style={{ display: "block" }}>
          <g fill="none" stroke={a} strokeWidth="2"><path d="M78 34 H92 M118 40 V58 H70 V72 M118 40 H150 V72" /></g>
          <rect x="34" y="22" width="44" height="24" rx="6" fill="#fff" stroke={a} strokeWidth="2" />
          <path d="M92 34 l14 -12 l14 12 l-14 12z" fill="#fff" stroke={a} strokeWidth="2" />
          <rect x="46" y="72" width="48" height="24" rx="6" fill={a} opacity="0.16" />
          <rect x="128" y="72" width="48" height="24" rx="6" fill="#fff" stroke={a} strokeWidth="2" />
        </svg>
      );
    case "tree":
      return (
        <svg viewBox="0 0 200 120" width="80%" style={{ display: "block" }}>
          <g fill="none" stroke={a} strokeWidth="2"><path d="M100 42 V56 M54 72 V60 H146 V72 M100 60 V72" /></g>
          <rect x="76" y="18" width="48" height="24" rx="6" fill={a} opacity="0.16" />
          <rect x="30" y="72" width="48" height="24" rx="6" fill="#fff" stroke={a} strokeWidth="2" />
          <rect x="76" y="72" width="48" height="24" rx="6" fill="#fff" stroke={a} strokeWidth="2" />
          <rect x="122" y="72" width="48" height="24" rx="6" fill="#fff" stroke={a} strokeWidth="2" />
        </svg>
      );
    case "erd":
      return (
        <svg viewBox="0 0 200 120" width="80%" style={{ display: "block" }}>
          <path d="M78 40 H122" stroke={a} strokeWidth="2" fill="none" />
          <g><rect x="28" y="26" width="50" height="46" rx="5" fill="#fff" stroke={a} strokeWidth="2" /><path d="M28 40 H78" stroke={a} strokeWidth="1.4" /><path d="M28 54 H78" stroke="#d7dae0" strokeWidth="1.2" /></g>
          <g><rect x="122" y="34" width="50" height="46" rx="5" fill="#fff" stroke={a} strokeWidth="2" /><path d="M122 48 H172" stroke={a} strokeWidth="1.4" /><path d="M122 62 H172" stroke="#d7dae0" strokeWidth="1.2" /></g>
        </svg>
      );
    case "cloud":
      return (
        <svg viewBox="0 0 200 120" width="80%" style={{ display: "block" }}>
          <rect x="30" y="20" width="140" height="82" rx="10" fill="none" stroke={a} strokeWidth="1.6" strokeDasharray="5 4" />
          <g fill="none" stroke={a} strokeWidth="2"><path d="M74 52 H92 M108 52 H126" /></g>
          <rect x="46" y="40" width="28" height="26" rx="6" fill="#fff" stroke={a} strokeWidth="2" />
          <rect x="86" y="40" width="28" height="26" rx="6" fill={a} opacity="0.16" />
          <rect x="126" y="40" width="28" height="26" rx="6" fill="#fff" stroke={a} strokeWidth="2" />
          <path d="M60 78 q40 -6 80 0" fill="none" stroke="#c2c8d2" strokeWidth="1.6" />
        </svg>
      );
    case "seq":
      return (
        <svg viewBox="0 0 200 120" width="80%" style={{ display: "block" }}>
          <g stroke="#d7dae0" strokeWidth="1.4"><path d="M56 30 V100 M100 30 V100 M144 30 V100" /></g>
          <g fill={a} opacity="0.16"><rect x="40" y="18" width="32" height="16" rx="4" /><rect x="84" y="18" width="32" height="16" rx="4" /><rect x="128" y="18" width="32" height="16" rx="4" /></g>
          <g fill="none" stroke={a} strokeWidth="2"><path d="M56 50 H100" /><path d="M100 70 H144" /><path d="M144 88 H56" /></g>
        </svg>
      );
  }
}
