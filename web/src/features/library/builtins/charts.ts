/** Built-in pack: Data & charts (mint). Charts are built from plain shapes. */
import { LIB_PALETTE } from "../palette";
import type { LibraryPack } from "../types";
import { box, item, link, text } from "./_kit";

const H = "mint" as const;
const G = { group: true };
const MUTED = LIB_PALETTE.slate.stroke;
const UP = LIB_PALETTE.mint.stroke;
const small = { fontSize: 12, bold: false, textColor: MUTED };

function barChart() {
  const base = box("rect", 0, 200, 280, 4, "", "slate", { solid: true, cornerRadius: 0, strokeWidth: 1 });
  const hs = [80, 140, 108, 180];
  const nodes = [base];
  hs.forEach((h, i) => {
    const x = 16 + i * 64;
    nodes.push(box("rect", x, 200 - h, 40, h, "", i === 3 ? "ember" : H, { cornerRadius: 4 }));
    nodes.push(text(x - 8, 208, 56, 20, `Q${i + 1}`, small));
  });
  return item("ch-bar", "Bar Chart", ["bar", "column", "chart", "graph", "quarterly"], nodes, [], G);
}

function kpi() {
  const t = box("rounded", 0, 0, 200, 120, "", H, { paper: true });
  const l = text(16, 12, 168, 24, "Revenue", { ...small, fontSize: 14, textAlign: "left" });
  const v = text(16, 40, 168, 40, "$48.2k", { fontSize: 24, textAlign: "left" });
  const d = text(16, 84, 168, 24, "▲ 12% vs last month", { fontSize: 12, textAlign: "left", textColor: UP });
  return item("ch-kpi", "KPI Tile", ["kpi", "metric", "stat", "number", "dashboard"], [t, l, v, d], [], G);
}

function progress() {
  const l = text(0, 0, 200, 24, "Upload", { fontSize: 14, textAlign: "left" });
  const p = text(200, 0, 80, 24, "70%", { fontSize: 14, textAlign: "right" });
  const track = box("rounded", 0, 28, 280, 16, "", H, { paper: true, cornerRadius: 8 });
  const fill = box("rounded", 0, 28, 196, 16, "", H, { solid: true, cornerRadius: 8 });
  return item("ch-progress", "Progress Bar", ["progress", "percent", "loading", "completion", "meter"], [l, p, track, fill], [], G);
}

function funnel() {
  const rows: [string, number][] = [
    ["Visitors 10k", 320],
    ["Sign-ups 2.4k", 256],
    ["Trials 800", 192],
    ["Paid 120", 128],
  ];
  const n = rows.map(([label, w], i) =>
    box("rounded", (320 - w) / 2, i * 56, w, 48, label, i === 3 ? "ember" : H, { fontSize: 14 }),
  );
  return item("ch-funnel", "Funnel", ["funnel", "conversion", "pipeline", "stages", "drop-off"], n, [], G);
}

function donut() {
  const r = box("ring", 0, 0, 120, 120, "62%", H, { fontSize: 20 });
  const k1 = box("rect", 144, 32, 16, 16, "", H, { solid: true, cornerRadius: 4 });
  const t1 = text(168, 28, 120, 24, "Done 62%", { fontSize: 14, textAlign: "left", bold: false });
  const k2 = box("rect", 144, 72, 16, 16, "", "slate", { cornerRadius: 4 });
  const t2 = text(168, 68, 120, 24, "Left 38%", { fontSize: 14, textAlign: "left", bold: false });
  return item("ch-donut", "Donut + Legend", ["pie", "donut", "share", "percentage", "legend"], [r, k1, t1, k2, t2], [], G);
}

function gantt() {
  const nodes = ["W1", "W2", "W3", "W4"].map((w, i) => text(128 + i * 80, 0, 80, 24, w, small));
  const row = (y: number, label: string, x0: number, x1: number) => [
    text(0, y, 120, 32, label, { fontSize: 14, textAlign: "left" }),
    box("rect", 128, y, 320, 32, "", "slate", { paper: true, cornerRadius: 4, strokeWidth: 1 }),
    box("rounded", x0, y + 4, x1 - x0, 24, "", H, { solid: true, cornerRadius: 6 }),
  ];
  nodes.push(...row(32, "Design", 136, 280), ...row(72, "Build", 248, 400));
  nodes.push(box("diamond", 412, 76, 24, 24, "", "ember", { solid: true }));
  return item("ch-gantt", "Gantt Rows", ["gantt", "timeline", "schedule", "plan", "milestone"], nodes, [], G);
}

function metricTable() {
  const t = box("tableHeader", 0, 0, 320, 136, "", H, { paper: true });
  const rows = [
    ["Metric", "Value"],
    ["Users", "12,400"],
    ["Churn", "2.1%"],
    ["NPS", "62"],
  ];
  const nodes = [t];
  rows.forEach(([a, b], i) => {
    const y = i === 0 ? 0 : 40 + (i - 1) * 32;
    const h = i === 0 ? 40 : 32;
    const style = i === 0 ? { fontSize: 14 } : { fontSize: 14, bold: false };
    nodes.push(text(12, y, 148, h, a, { ...style, textAlign: "left" }));
    nodes.push(text(172, y, 136, h, b, { ...style, textAlign: "right" }));
  });
  return item("ch-table", "Table Header + Rows", ["table", "rows", "metrics", "data", "report"], nodes, [], G);
}

function sparkline() {
  const pts: [number, number][] = [
    [0, 80],
    [60, 56],
    [120, 68],
    [180, 28],
    [240, 8],
  ];
  const dots = pts.map(([x, y], i) => box("ellipse", x, y, 12, 12, "", i === pts.length - 1 ? "ember" : H, { solid: true }));
  const edges = dots.slice(1).map((d, i) =>
    link(dots[i], d, { routing: "straight", head: i === dots.length - 2 ? "arrow" : "none", stroke: UP }),
  );
  return item("ch-trend", "Trend Line", ["trend", "sparkline", "line chart", "growth", "up"], dots, edges);
}

function scorecard() {
  const n = [
    ["NPS\n62", H],
    ["CSAT\n4.6", H],
    ["Churn\n2.1%", "rose"],
  ].map(([l, h], i) => box("rounded", i * 144, 0, 128, 80, l, h as "mint" | "rose", { fontSize: 18 }));
  return item("ch-scorecard", "Scorecard", ["scorecard", "kpis", "metrics", "summary", "stats"], n, [], G);
}

function shareBar() {
  const nodes = [
    box("rect", 0, 0, 160, 32, "", H, { solid: true, cornerRadius: 0 }),
    box("rect", 160, 0, 96, 32, "", H, { cornerRadius: 0 }),
    box("rect", 256, 0, 64, 32, "", "slate", { cornerRadius: 0 }),
    text(0, 40, 160, 20, "Web 50%", small),
    text(160, 40, 96, 20, "iOS 30%", small),
    text(256, 40, 64, 20, "Other", small),
  ];
  return item("ch-share", "100% Stacked Bar", ["stacked", "share", "split", "mix", "proportion"], nodes, [], G);
}

export const CHARTS_PACK: LibraryPack = {
  id: "charts",
  name: "Data & Charts",
  blurb: "Bars, KPIs, funnels, progress and Gantt rows from plain shapes",
  hue: H,
  items: [barChart(), kpi(), progress(), funnel(), donut(), gantt(), metricTable(), sparkline(), scorecard(), shareBar()],
};
