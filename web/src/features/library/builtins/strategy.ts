/** Built-in pack: Org, mind map & strategy (mint, with sky/slate for stages). */
import type { LibraryPack } from "../types";
import type { LibHue } from "./_kit";
import { box, item, link, text } from "./_kit";

const H = "mint" as const;
const G = { group: true };
const spoke = { routing: "straight" as const, head: "none" as const };

function orgChart() {
  const ceo = box("rounded", 160, 0, 160, 56, "CEO", "ember");
  const r = [
    ["Product", 0],
    ["Engineering", 170],
    ["Sales", 340],
  ].map(([l, x]) => box("rounded", x as number, 120, 140, 56, l as string, H));
  return item(
    "st-org",
    "Org Chart 1→3",
    ["org chart", "hierarchy", "reports", "team", "structure"],
    [ceo, ...r],
    r.map((n) => link(ceo, n, { from: "b", to: "t", head: "none" })),
  );
}

function teamTree() {
  const root = box("rounded", 220, 0, 120, 48, "Director", H, { solid: true });
  const a = box("rounded", 80, 96, 120, 48, "Lead A", H);
  const b = box("rounded", 360, 96, 120, 48, "Lead B", H);
  const m = [4, 164, 284, 444].map((x) => box("rounded", x, 192, 112, 44, "Member", H, { paper: true, fontSize: 14 }));
  const t = { from: "b" as const, to: "t" as const, head: "none" as const };
  return item(
    "st-team-tree",
    "Team Tree",
    ["org chart", "tree", "levels", "managers", "reports"],
    [root, a, b, ...m],
    [link(root, a, t), link(root, b, t), link(a, m[0], t), link(a, m[1], t), link(b, m[2], t), link(b, m[3], t)],
  );
}

function mindMap() {
  const hub = box("ellipse", 184, 144, 152, 72, "Central idea", "ember", { fontSize: 16 });
  const br = [
    [200, 0],
    [0, 88],
    [400, 88],
    [80, 272],
    [320, 272],
  ].map(([x, y], i) => box("rounded", x, y, 120, 48, `Branch ${i + 1}`, H, { fontSize: 14 }));
  return item(
    "st-mind-map",
    "Mind Map",
    ["mind map", "brainstorm", "hub", "branches", "radial"],
    [hub, ...br],
    br.map((n) => link(hub, n, spoke)),
  );
}

function timeline() {
  const line = box("rect", 0, 56, 560, 4, "", "slate", { solid: true, cornerRadius: 0, strokeWidth: 1 });
  const ms = [
    ["Kickoff\nJan", 40],
    ["Beta\nApr", 200],
    ["Launch\nJul", 360],
    ["Scale\nOct", 520],
  ] as const;
  const nodes = [line];
  ms.forEach(([l, x], i) => {
    nodes.push(box("ellipse", x - 12, 46, 24, 24, "", i === 2 ? "ember" : H, { solid: true }));
    nodes.push(text(x - 60, 80, 120, 40, l, { fontSize: 14 }));
  });
  return item("st-timeline", "Timeline Milestones", ["timeline", "milestones", "dates", "history", "phases"], nodes, [], G);
}

function nowNextLater() {
  const cols: [string, LibHue][] = [
    ["Now", "mint"],
    ["Next", "sky"],
    ["Later", "slate"],
  ];
  const nodes = cols.flatMap(([l, h], i) => {
    const x = i * 196;
    return [
      box("rounded", x, 0, 180, 44, l, h, { solid: true, fontSize: 18 }),
      box("rounded", x, 60, 180, 56, "Initiative", h, { fontSize: 14 }),
      box("rounded", x, 132, 180, 56, "Initiative", h, { fontSize: 14 }),
    ];
  });
  return item("st-now-next-later", "Now / Next / Later", ["roadmap", "now", "next", "later", "lanes", "planning"], nodes, [], G);
}

function journey() {
  const steps = ["Discover", "Sign up", "Use", "Share"];
  const n = steps.map((s, i) => box("chevron", i * 148, 0, 140, 64, s, i === 0 ? "sky" : H, { fontSize: 14 }));
  return item("st-journey", "User Journey", ["journey", "steps", "funnel", "stages", "customer"], n, [], G);
}

function pyramid() {
  const layers = ["Vision", "Strategy", "Tactics", "Tasks"];
  const n = layers.map((l, i) => {
    const w = 120 + i * 80;
    return box("rounded", (360 - w) / 2, i * 56, w, 52, l, i === 0 ? "ember" : H, { fontSize: 14 });
  });
  return item("st-pyramid", "Pyramid", ["pyramid", "hierarchy", "levels", "layers", "maslow"], n, [], G);
}

function venn() {
  const o = { opacity: 0.75, fontSize: 18 };
  const n = [
    box("ellipse", 0, 0, 160, 160, "A", H, o),
    box("ellipse", 100, 0, 160, 160, "B", "sky", o),
    box("ellipse", 52, 88, 160, 160, "C", "lemon", o),
  ];
  return item("st-venn", "3-Circle Venn", ["venn", "overlap", "intersection", "sets", "circles"], n, [], G);
}

function okr() {
  const o = box("rounded", 0, 0, 440, 56, "Objective: delight new users", H, { solid: true });
  const kr = [0, 152, 304].map((x, i) => box("rounded", x, 104, 136, 64, `KR ${i + 1}`, H));
  return item(
    "st-okr",
    "OKR Tree",
    ["okr", "objective", "key results", "goals", "targets"],
    [o, ...kr],
    kr.map((k) => link(o, k, { from: "b", to: "t" })),
  );
}

function pdca() {
  const plan = box("rounded", 120, 0, 120, 56, "Plan", H);
  const doo = box("rounded", 240, 100, 120, 56, "Do", H);
  const check = box("rounded", 120, 200, 120, 56, "Check", H);
  const act = box("rounded", 0, 100, 120, 56, "Act", H);
  const mid = text(130, 112, 100, 32, "PDCA", { fontSize: 18 });
  return item(
    "st-cycle",
    "Cycle (PDCA)",
    ["cycle", "loop", "pdca", "continuous improvement", "iteration"],
    [plan, doo, check, act, mid],
    [
      link(plan, doo, { from: "r", to: "t" }),
      link(doo, check, { from: "b", to: "r" }),
      link(check, act, { from: "l", to: "b" }),
      link(act, plan, { from: "t", to: "l" }),
    ],
  );
}

export const STRATEGY_PACK: LibraryPack = {
  id: "strategy",
  name: "Org, Mind Map & Strategy",
  blurb: "Org charts, mind maps, timelines, roadmaps and frameworks",
  hue: H,
  items: [orgChart(), teamTree(), mindMap(), timeline(), nowNextLater(), journey(), pyramid(), venn(), okr(), pdca()],
};
