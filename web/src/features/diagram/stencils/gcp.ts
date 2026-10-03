/**
 * features/diagram/stencils/gcp — Google Cloud stencil glyphs.
 *
 * ⚠️ ORIGINAL artwork: every glyph below is hand-built from primitive
 * geometry (circles, rounded rects, polygons) to EVOKE the flat, four-colour
 * look of Google Cloud's product icons — no official path data is copied.
 *
 * Style rules (keep new icons consistent):
 *   • style "glyph" (no tile), FILLED solid blocks, crisp geometry;
 *   • palette = Google blue/red/yellow/green + their light/dark shades and an
 *     occasional grey — 2–4 colours per icon, a left/right light-dark split
 *     for depth where a shape is symmetric;
 *   • the glyph spans ~1.5..22.5 of the 0..24 box (≈85–90%) so every icon has
 *     the same optical size; details ≥1.4 units so they survive at 24px;
 *   • white is used only for knock-out detail sitting ON a coloured block.
 */
import type { IconDef, IconPart } from "../icons";

// ---- palette ---------------------------------------------------------------
const B = "#4285F4"; // blue
const BD = "#1A73E8"; // blue, dark
const BL = "#669DF6"; // blue, light
const BXL = "#AECBFA"; // blue, extra light
const R = "#EA4335"; // red
const RD = "#C5221F"; // red, dark
const Y = "#FBBC04"; // yellow
const G = "#34A853"; // green
const YD = "#E37400"; // yellow, dark (amber)
const GR = "#5F6368"; // grey
const W = "#FFFFFF"; // knock-out detail

// ---- geometry helpers (all output plain path data in the 0..24 box) --------
const n = (v: number) => String(Math.round(v * 100) / 100);

/** Filled circle. */
const circle = (cx: number, cy: number, r: number) =>
  `M${n(cx - r)} ${n(cy)} a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0 a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0 Z`;

/** Ring (outer + reverse-wound inner → hole under the nonzero rule). */
const ring = (cx: number, cy: number, ro: number, ri: number) =>
  circle(cx, cy, ro) +
  ` M${n(cx - ri)} ${n(cy)} a${n(ri)} ${n(ri)} 0 1 1 ${n(2 * ri)} 0 a${n(ri)} ${n(ri)} 0 1 1 ${n(-2 * ri)} 0 Z`;

/** Rounded rectangle. */
const rr = (x: number, y: number, w: number, h: number, r = 0) => {
  const k = Math.min(r, w / 2, h / 2);
  if (k <= 0) return `M${n(x)} ${n(y)} h${n(w)} v${n(h)} h${n(-w)} Z`;
  return (
    `M${n(x + k)} ${n(y)} H${n(x + w - k)} a${n(k)} ${n(k)} 0 0 1 ${n(k)} ${n(k)} ` +
    `V${n(y + h - k)} a${n(k)} ${n(k)} 0 0 1 ${n(-k)} ${n(k)} H${n(x + k)} ` +
    `a${n(k)} ${n(k)} 0 0 1 ${n(-k)} ${n(-k)} V${n(y + k)} a${n(k)} ${n(k)} 0 0 1 ${n(k)} ${n(-k)} Z`
  );
};

type Pt = [number, number];
const poly = (pts: Pt[]) => `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(" L")} Z`;

const rad = (deg: number) => (deg * Math.PI) / 180;
const polar = (cx: number, cy: number, r: number, deg: number): Pt => [
  cx + r * Math.cos(rad(deg)),
  cy + r * Math.sin(rad(deg)),
];

/** Regular hexagon, pointy-top (vertex at -90°). */
const hexPts = (cx: number, cy: number, r: number): Pt[] =>
  [-90, -30, 30, 90, 150, 210].map((a) => polar(cx, cy, r, a));

/** Annular wedge from a0→a1 degrees (0 = right, clockwise, y-down). */
const sector = (cx: number, cy: number, ro: number, ri: number, a0: number, a1: number) => {
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = polar(cx, cy, ro, a0);
  const [x1, y1] = polar(cx, cy, ro, a1);
  const [x2, y2] = polar(cx, cy, ri, a1);
  const [x3, y3] = polar(cx, cy, ri, a0);
  return (
    `M${n(x0)} ${n(y0)} A${n(ro)} ${n(ro)} 0 ${large} 1 ${n(x1)} ${n(y1)} ` +
    `L${n(x2)} ${n(y2)} A${n(ri)} ${n(ri)} 0 ${large} 0 ${n(x3)} ${n(y3)} Z`
  );
};

const fill = (d: string, color: string): IconPart => ({ d, fill: color });
const line = (d: string, color: string, sw: number): IconPart => ({ d, stroke: color, sw });

/** Database cylinder split into a light-left / dark-right body + top face. */
const cylinder = (cx: number, top: number, bottom: number, rx: number, ry: number, left: string, right: string, face: string): IconPart[] => [
  fill(
    `M${n(cx - rx)} ${n(top)} V${n(bottom)} a${n(rx)} ${n(ry)} 0 0 0 ${n(rx)} ${n(ry)} V${n(top + ry)} a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(-ry)} Z`,
    left,
  ),
  fill(
    `M${n(cx + rx)} ${n(top)} V${n(bottom)} a${n(rx)} ${n(ry)} 0 0 1 ${n(-rx)} ${n(ry)} V${n(top + ry)} a${n(rx)} ${n(ry)} 0 0 0 ${n(rx)} ${n(-ry)} Z`,
    right,
  ),
  fill(
    `M${n(cx - rx)} ${n(top)} a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0 a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0 Z`,
    face,
  ),
];

/** Upward chevron band ("^") with apex at (12, a). */
const band = (a: number, drop: number, t: number): Pt[] => [
  [2.5, a + drop],
  [12, a],
  [21.5, a + drop],
  [21.5, a + drop + t],
  [12, a + t],
  [2.5, a + drop + t],
];

/** Horizontal arrow: capsule shaft + triangular head. */
const arrow = (x0: number, x1: number, y: number, head: number, color: string, t = 3.2): IconPart[] => [
  fill(rr(x0, y - t / 2, x1 - x0 + 0.6, t, t / 2), color),
  fill(poly([[x1, y - head * 0.82], [x1 + head, y], [x1, y + head * 0.82]]), color),
];

const icon = (key: string, label: string, abbrev: string, accent: string, parts: IconPart[]): IconDef => ({
  key,
  label,
  group: "gcp",
  accent,
  abbrev,
  motif: [],
  style: "glyph",
  parts,
});

// ---- the set ----------------------------------------------------------------
export const GCP_ICONS: IconDef[] = [
  // ===== Compute ===========================================================
  icon("gcp-gce", "Compute Engine", "GCE", B, [
    // pins (under the body), one colour per side
    ...[8.4, 12, 15.6].flatMap((v) => [
      fill(rr(v - 0.9, 1.6, 1.8, 4.4, 0.7), BL),
      fill(rr(v - 0.9, 18, 1.8, 4.4, 0.7), BL),
      fill(rr(1.6, v - 0.9, 4.4, 1.8, 0.7), BL),
      fill(rr(18, v - 0.9, 4.4, 1.8, 0.7), BL),
    ]),
    fill(rr(4.6, 4.6, 7.4, 14.8, 1.8), B),
    fill(rr(10, 4.6, 9.4, 14.8, 1.8), BD),
    fill(rr(10, 4.6, 2, 14.8, 0), BD),
    fill(rr(8.4, 8.4, 7.2, 7.2, 1), Y),
    fill(rr(10.4, 10.4, 3.2, 3.2, 0.5), YD),
  ]),
  icon("gcp-gke", "Kubernetes Engine", "GKE", B, (() => {
    const h = hexPts(12, 12, 10.9);
    const spokes = [-90, -30, 30, 90, 150, 210]
      .map((a) => {
        const [x0, y0] = polar(12, 12, 2, a);
        const [x1, y1] = polar(12, 12, 7.6, a);
        return `M${n(x0)} ${n(y0)} L${n(x1)} ${n(y1)}`;
      })
      .join(" ");
    return [
      fill(poly([h[0], h[3], h[4], h[5]]), B),
      fill(poly([h[0], h[1], h[2], h[3]]), BD),
      line(spokes, W, 1.5),
      fill(ring(12, 12, 5.5, 3.8), W),
      fill(circle(12, 12, 1.9), Y),
    ];
  })()),
  icon("gcp-run", "Cloud Run", "RUN", B, [
    fill(poly([[2.2, 3.5], [7.4, 3.5], [14.8, 12], [9.6, 12]]), B),
    fill(poly([[9.6, 12], [14.8, 12], [7.4, 20.5], [2.2, 20.5]]), BD),
    fill(poly([[9.4, 3.5], [14.6, 3.5], [22, 12], [16.8, 12]]), R),
    fill(poly([[16.8, 12], [22, 12], [14.6, 20.5], [9.4, 20.5]]), RD),
  ]),
  icon("gcp-func", "Cloud Functions", "FN", B, [
    line("M8.4 3.6 L3 12 L8.4 20.4", B, 3.2),
    line("M15.6 3.6 L21 12 L15.6 20.4", BD, 3.2),
    fill(circle(12, 12, 2.6), Y),
  ]),
  icon("gcp-appengine", "App Engine", "GAE", B, (() => {
    // 8-tooth gear (engine), dark right half for depth, yellow hub
    const pts: Pt[] = [];
    for (let k = 0; k < 8; k++) {
      const a = k * 45 - 90;
      pts.push(polar(12, 12, 7.8, a - 15), polar(12, 12, 10.6, a - 9), polar(12, 12, 10.6, a + 9), polar(12, 12, 7.8, a + 15));
    }
    return [
      fill(poly(pts), B),
      fill(sector(12, 12, 7.9, 4.4, -90, 90), BD),
      fill(ring(12, 12, 4.6, 3.4), W),
      fill(circle(12, 12, 3.4), Y),
    ];
  })()),

  // ===== Storage & databases ===============================================
  icon("gcp-gcs", "Cloud Storage", "GCS", B, [
    fill(rr(2, 2.6, 20, 5.4, 1.3), BL),
    fill(rr(2, 9.3, 20, 5.4, 1.3), B),
    fill(rr(2, 16, 20, 5.4, 1.3), BD),
    ...[5.3, 12, 18.7].map((y) => line(`M5.2 ${y} H10`, W, 1.5)),
    ...[5.3, 12, 18.7].map((y) => fill(circle(17.8, y, 1.05), W)),
  ]),
  icon("gcp-sql", "Cloud SQL", "SQL", B, [
    ...cylinder(12, 5.2, 18.8, 8.6, 3.2, B, BD, BXL),
    line("M3.4 10.6 a8.6 3.2 0 0 0 17.2 0", W, 1.2),
    line("M3.4 15 a8.6 3.2 0 0 0 17.2 0", W, 1.2),
  ]),
  icon("gcp-spanner", "Spanner", "SPAN", B, [
    fill("M12 1.8 A10.2 10.2 0 0 0 12 22.2 Z", B),
    fill("M12 1.8 A10.2 10.2 0 0 1 12 22.2 Z", BD),
    line("M12 1.8 a4.6 10.2 0 1 0 0 20.4 a4.6 10.2 0 1 0 0 -20.4 M1.8 12 H22.2", W, 1.3),
    fill(circle(18.6, 18.4, 3.4), G),
    { d: circle(18.6, 18.4, 3.4), stroke: W, sw: 1.2 },
  ]),
  icon("gcp-firestore", "Firestore", "FS", Y, [
    fill(poly(band(13, 5.6, 3.6)), B),
    fill(poly(band(7.4, 5.6, 3.6)), R),
    fill(poly(band(1.8, 5.6, 3.6)), Y),
  ]),
  icon("gcp-bigtable", "Bigtable", "BT", B, [
    ...[2, 9.1, 16.2].map((x) => fill(rr(x, 2, 5.8, 5.8, 1), B)),
    ...[2, 9.1, 16.2].flatMap((x) =>
      [9.1, 16.2].map((y) => fill(rr(x, y, 5.8, 5.8, 1), x === 9.1 && y === 9.1 ? Y : BXL)),
    ),
  ]),
  icon("gcp-memorystore", "Memorystore", "MEM", B, [
    fill(rr(2.6, 16, 8.2, 4.6, 0.6), Y),
    fill(rr(13.2, 16, 8.2, 4.6, 0.6), Y),
    fill(rr(1.6, 3.4, 10.4, 14, 1.6), B),
    fill(rr(10, 3.4, 12.4, 14, 1.6), BD),
    fill(rr(10, 3.4, 2, 14, 0), B),
    ...[4.4, 10.2, 16].map((x) => fill(rr(x, 6.4, 3.6, 8, 0.6), W)),
  ]),
  icon("gcp-artifact", "Artifact Registry", "AR", B, (() => {
    const h = hexPts(12, 12, 10.4);
    const c: Pt = [12, 12];
    return [
      fill(poly([h[0], h[1], c, h[5]]), BL),
      fill(poly([h[5], c, h[3], h[4]]), B),
      fill(poly([c, h[1], h[2], h[3]]), BD),
      fill(poly([[7.6, 4.3], [9.3, 3.3], [18.1, 8.4], [16.4, 9.4]]), Y),
    ];
  })()),

  // ===== Data analytics & AI ===============================================
  icon("gcp-bq", "BigQuery", "BQ", B, [
    line("M16.8 16.8 L21 21", BD, 3.8),
    fill(ring(10.4, 10.4, 8.6, 6.2), B),
    fill(rr(6.6, 10.6, 2, 3.8, 0.5), BL),
    fill(rr(9.4, 7, 2, 7.4, 0.5), Y),
    fill(rr(12.2, 9, 2, 5.4, 0.5), BL),
  ]),
  icon("gcp-pubsub", "Pub/Sub", "PS", B, [
    line("M12 12 L5 5.6 M12 12 L19 5.6 M12 12 V19.2", BL, 2),
    fill(circle(12, 12, 3.6), B),
    fill(circle(4.6, 5.2, 3), R),
    fill(circle(19.4, 5.2, 3), Y),
    fill(circle(12, 19.6, 3), G),
  ]),
  icon("gcp-dataflow", "Dataflow", "FLOW", B, [
    ...arrow(2, 12.8, 5, 4.6, BL),
    ...arrow(5.6, 17.4, 12, 4.6, B),
    ...arrow(2, 12.8, 19, 4.6, BD),
  ]),
  icon("gcp-dataproc", "Dataproc", "DPRC", B, [
    fill(poly(hexPts(12, 7.3, 5.4)), Y),
    fill(poly(hexPts(7, 16.4, 5.4)), B),
    fill(poly(hexPts(17, 16.4, 5.4)), BD),
    fill(circle(12, 7.3, 1.6), W),
    fill(circle(7, 16.4, 1.6), W),
    fill(circle(17, 16.4, 1.6), W),
  ]),
  icon("gcp-looker", "Looker", "LKR", B, [
    fill(sector(12, 12, 10.2, 5, -88, 12), B),
    fill(sector(12, 12, 10.2, 5, 16, 128), Y),
    fill(sector(12, 12, 10.2, 5, 132, 208), G),
    fill(sector(12, 12, 10.2, 5, 212, 268), R),
  ]),
  icon("gcp-vertex", "Vertex AI", "VRTX", B, [
    line("M4.4 4.4 L12 19.4", B, 3.2),
    line("M19.6 4.4 L12 19.4", BD, 3.2),
    fill(circle(4.4, 4.4, 2.8), R),
    fill(circle(19.6, 4.4, 2.8), Y),
    fill(circle(12, 19.4, 3), G),
    fill(circle(8.2, 11.9, 1.3), W),
    fill(circle(15.8, 11.9, 1.3), W),
  ]),
  icon("gcp-gemini", "Gemini", "GEM", B, [
    {
      d: "M12 1.6 C12.7 7.3 16.7 11.3 22.4 12 C16.7 12.7 12.7 16.7 12 22.4 C11.3 16.7 7.3 12.7 1.6 12 C7.3 11.3 11.3 7.3 12 1.6 Z",
      grad: [BL, BD],
    },
  ]),

  // ===== Networking ========================================================
  icon("gcp-vpc", "VPC", "VPC", B, [
    line("M3 8.2 V3 H8.2 M15.8 3 H21 V8.2 M21 15.8 V21 H15.8 M8.2 21 H3 V15.8", BD, 2.6),
    fill(circle(8.6, 13.6, 3.2), B),
    fill(circle(12.4, 10.6, 4.4), B),
    fill(circle(16, 14, 2.8), B),
    fill(rr(8.6, 13, 7.4, 3.8, 0), B),
    fill("M8.6 16.8 a3.2 3.2 0 0 1 -3.2 -3.2 H18.8 a2.8 2.8 0 0 1 -2.8 3.2 Z", BD),
  ]),
  icon("gcp-lb", "Load Balancing", "LB", B, [
    line("M7 12 C10.6 12 10.4 5.4 14.2 5.4 H16.2", R, 2.6),
    line("M7 12 H16.2", Y, 2.6),
    line("M7 12 C10.6 12 10.4 18.6 14.2 18.6 H16.2", G, 2.6),
    fill(poly([[15.8, 2.2], [21.6, 5.4], [15.8, 8.6]]), R),
    fill(poly([[15.8, 9], [21.6, 12], [15.8, 15]]), Y),
    fill(poly([[15.8, 15.4], [21.6, 18.6], [15.8, 21.8]]), G),
    fill(circle(5.2, 12, 3.4), B),
  ]),
  icon("gcp-cdn", "Cloud CDN", "CDN", B, [
    fill("M12 1.8 A10.2 10.2 0 0 0 12 22.2 Z", B),
    fill("M12 1.8 A10.2 10.2 0 0 1 12 22.2 Z", BD),
    fill(poly([[13.8, 4], [6.8, 13.4], [11.4, 13.4], [10, 20], [17.2, 10.4], [12.6, 10.4]]), Y),
  ]),
  icon("gcp-dns", "Cloud DNS", "DNS", B, [
    line("M12 6 V11.6 M4.6 15.4 V11.6 H19.4 V15.4 M12 11.6 V15.4", GR, 1.8),
    fill(circle(12, 5, 3.4), B),
    fill(rr(1.8, 15.6, 5.6, 5.6, 1.2), R),
    fill(rr(9.2, 15.6, 5.6, 5.6, 1.2), Y),
    fill(rr(16.6, 15.6, 5.6, 5.6, 1.2), G),
  ]),
  icon("gcp-apigee", "Apigee", "APIG", B, [
    line("M8.8 2.6 V6.6 M15.2 2.6 V6.6", GR, 2.4),
    line("M12 17 V21.6", BD, 3.2),
    fill("M4.8 6.4 H12 V18.2 A7.2 7.2 0 0 1 4.8 11 Z", B),
    fill("M12 6.4 H19.2 V11 A7.2 7.2 0 0 1 12 18.2 Z", BD),
    fill(circle(12, 11.4, 2), W),
  ]),

  // ===== Security & identity ===============================================
  icon("gcp-armor", "Cloud Armor", "ARM", B, [
    fill("M12 1.6 V22.4 C6.8 20.8 3 17 3 11.4 V5.1 Z", B),
    fill("M12 1.6 L21 5.1 V11.4 C21 17 17.2 20.8 12 22.4 Z", BD),
    line("M7.6 12.2 L10.8 15.2 L16.6 8.8", W, 2.3),
  ]),
  icon("gcp-iam", "IAM", "IAM", B, [
    fill(circle(9.6, 6.6, 4.4), B),
    fill("M1.8 21.8 C1.8 15.6 5.4 12.6 9.6 12.6 C13.8 12.6 17.4 15.6 17.4 21.8 Z", BD),
    { d: circle(17.6, 16.8, 4.8), fill: G, stroke: W, sw: 1.4 },
    line("M15.3 16.9 L17 18.6 L20 15.2", W, 1.6),
  ]),
  icon("gcp-secrets", "Secret Manager", "SEC", B, [
    line("M7.6 11 V7.4 a4.4 4.4 0 0 1 8.8 0 V11", GR, 2.6),
    fill("M5.6 10.4 H12 V22.2 H5.6 a2.2 2.2 0 0 1 -2.2 -2.2 V12.6 a2.2 2.2 0 0 1 2.2 -2.2 Z", B),
    fill("M12 10.4 H18.4 a2.2 2.2 0 0 1 2.2 2.2 V20 a2.2 2.2 0 0 1 -2.2 2.2 H12 Z", BD),
    fill(circle(12, 15, 2), Y),
    fill(rr(11.1, 15.4, 1.8, 3.8, 0.7), Y),
  ]),

  // ===== Operations, integration & dev tools ===============================
  icon("gcp-logging", "Cloud Logging", "LOG", B, [
    fill("M5.4 1.8 H14.6 L19.6 6.8 V20.4 a1.8 1.8 0 0 1 -1.8 1.8 H5.4 a1.8 1.8 0 0 1 -1.8 -1.8 V3.6 a1.8 1.8 0 0 1 1.8 -1.8 Z", B),
    fill("M14.6 1.8 V6.8 H19.6 Z", BXL),
    ...[10.6, 14.2, 17.8].map((y, i) => fill(circle(7.6, y, 1.1), [Y, R, G][i])),
    ...[10.6, 14.2, 17.8].map((y, i) => line(`M10.6 ${y} H${i === 2 ? 13.6 : 16}`, W, 1.6)),
  ]),
  icon("gcp-monitoring", "Cloud Monitoring", "MON", B, [
    line("M12 17 V21 M8 21.4 H16", GR, 2.2),
    fill(rr(1.8, 2.8, 20.4, 14.6, 1.8), B),
    fill("M1.8 12.8 L22.2 12.8 V15.6 a1.8 1.8 0 0 1 -1.8 1.8 H3.6 a1.8 1.8 0 0 1 -1.8 -1.8 Z", BD),
    line("M4.6 10.4 H8 L10.2 6.2 L13.4 14.4 L15.6 10.4 H19.4", W, 1.8),
  ]),
  icon("gcp-scheduler", "Cloud Scheduler", "SCHD", B, [
    fill(ring(12, 12, 10.2, 7.6), B),
    fill(sector(12, 12, 10.2, 7.6, -90, 0), Y),
    line("M12 12 V6.6 M12 12 L15.6 14.2", BD, 2.2),
    fill(circle(12, 12, 1.6), R),
  ]),
  icon("gcp-workflows", "Workflows", "WF", B, [
    line("M8.6 5.4 H12 V8 M16 12 H18.6 V15.4", GR, 1.8),
    fill(rr(1.8, 1.8, 7.2, 7.2, 1.4), B),
    fill(poly([[12, 7.6], [16.4, 12], [12, 16.4], [7.6, 12]]), Y),
    fill(circle(18.6, 18.6, 3.6), G),
  ]),
  icon("gcp-build", "Cloud Build", "BLD", B, [
    ...[2, 9.1, 16.2].map((x) => fill(rr(x, 16.2, 5.8, 5.8, 1), B)),
    fill(rr(5.55, 9.1, 5.8, 5.8, 1), BD),
    fill(rr(12.65, 9.1, 5.8, 5.8, 1), BD),
    fill(rr(9.1, 2, 5.8, 5.8, 1), Y),
  ]),
];
