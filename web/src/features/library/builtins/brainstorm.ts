/** Built-in pack: Brainstorm & retro (lemon). */
import type { LibraryPack } from "../types";
import type { LibHue } from "./_kit";
import { box, item, link, text } from "./_kit";

const H = "lemon" as const;
const G = { group: true };
export const sticky = (x: number, y: number, label: string, hue: LibHue = H, s = 120) =>
  box("sticky", x, y, s, s, label, hue, { wrap: true });

function stickySet() {
  const hues: LibHue[] = ["lemon", "rose", "mint", "sky", "lilac", "ember"];
  const n = hues.map((h, i) => sticky((i % 3) * 136, Math.floor(i / 3) * 136, "Idea", h));
  return item("bs-stickies", "Sticky Notes (6 Colours)", ["sticky", "post-it", "note", "idea", "colours"], n);
}

function columns(id: string, name: string, tags: string[], cols: [string, LibHue][]) {
  const nodes = cols.flatMap(([label, hue], i) => {
    const x = i * 192;
    return [
      box("rounded", x, 0, 176, 48, label, hue, { solid: true, fontSize: 18 }),
      box("rect", x, 64, 176, 208, "", hue, { paper: true, strokeDash: "dashed" }),
      sticky(x + 28, 92, "Add a note", hue),
    ];
  });
  return item(id, name, tags, nodes, [], G);
}

function startStopContinue() {
  return columns("bs-ssc", "Start / Stop / Continue", ["retro", "retrospective", "start", "stop", "continue"], [
    ["Start", "mint"],
    ["Stop", "rose"],
    ["Continue", "sky"],
  ]);
}

function madSadGlad() {
  return columns("bs-msg", "Mad / Sad / Glad", ["retro", "feelings", "mad", "sad", "glad", "emotions"], [
    ["Mad", "rose"],
    ["Sad", "sky"],
    ["Glad", "mint"],
  ]);
}

function matrix() {
  const top = text(0, 0, 400, 28, "↑ Impact", { textAlign: "left" });
  const q = [
    box("rect", 0, 32, 200, 160, "Quick wins", "mint", { cornerRadius: 0, fontSize: 18 }),
    box("rect", 200, 32, 200, 160, "Big bets", H, { cornerRadius: 0, fontSize: 18 }),
    box("rect", 0, 192, 200, 160, "Fill-ins", H, { paper: true, cornerRadius: 0, fontSize: 18 }),
    box("rect", 200, 192, 200, 160, "Money pits", "rose", { cornerRadius: 0, fontSize: 18 }),
  ];
  const bottom = text(0, 356, 400, 28, "Effort →", { textAlign: "right" });
  return item("bs-matrix", "2×2 Matrix", ["matrix", "quadrant", "impact", "effort", "prioritize"], [top, ...q, bottom], [], G);
}

function dotVote() {
  const s = sticky(0, 0, "Dark mode", H, 140);
  const d = [12, 32, 52].map((x) => box("ellipse", x, 104, 16, 16, "", "rose", { solid: true }));
  return item("bs-dot-vote", "Dot Vote", ["vote", "dots", "prioritize", "poll", "rank"], [s, ...d], [], G);
}

function swot() {
  const q = [
    box("rect", 0, 0, 200, 152, "Strengths", "mint", { cornerRadius: 0, fontSize: 18 }),
    box("rect", 200, 0, 200, 152, "Weaknesses", "rose", { cornerRadius: 0, fontSize: 18 }),
    box("rect", 0, 152, 200, 152, "Opportunities", "sky", { cornerRadius: 0, fontSize: 18 }),
    box("rect", 200, 152, 200, 152, "Threats", "ember", { cornerRadius: 0, fontSize: 18 }),
  ];
  return item("bs-swot", "SWOT", ["swot", "strengths", "weaknesses", "opportunities", "threats", "analysis"], q, [], G);
}

function cluster() {
  const hub = box("ellipse", 148, 112, 120, 72, "Theme", "ember");
  const s = [
    sticky(0, 0, "Idea A", H, 96),
    sticky(320, 0, "Idea B", H, 96),
    sticky(0, 200, "Idea C", H, 96),
    sticky(320, 200, "Idea D", H, 96),
  ];
  return item(
    "bs-cluster",
    "Idea Cluster",
    ["cluster", "affinity", "group", "theme", "ideas"],
    [hub, ...s],
    s.map((n) => link(hub, n, { routing: "straight", head: "none", dash: "dashed" })),
  );
}

function parkingLot() {
  const f = box("rect", 0, 0, 280, 192, "", H, { paper: true, strokeDash: "dashed" });
  const t = text(16, 8, 248, 32, "Parking lot", { fontSize: 18, textAlign: "left" });
  const a = sticky(16, 52, "Later", H, 120);
  const b = sticky(144, 52, "Ask legal", H, 120);
  return item("bs-parking", "Parking Lot", ["parking lot", "later", "backlog", "off-topic", "hold"], [f, t, a, b], [], G);
}

function hmw() {
  const h = box("rounded", 0, 0, 424, 48, "How might we…?", H, { solid: true, fontSize: 18 });
  const s = [0, 152, 304].map((x, i) => sticky(x, 72, `Option ${i + 1}`, H));
  return item("bs-hmw", "How Might We", ["hmw", "question", "ideation", "design thinking", "prompt"], [h, ...s], [], G);
}

function prosCons() {
  const bullets = { textAlign: "left" as const, bold: false, fontSize: 16 };
  const nodes = [
    box("rounded", 0, 0, 200, 44, "Pros", "mint", { solid: true }),
    box("rect", 0, 56, 200, 144, "• Faster\n• Cheaper\n• Simpler", "mint", { ...bullets, paper: true }),
    box("rounded", 216, 0, 200, 44, "Cons", "rose", { solid: true }),
    box("rect", 216, 56, 200, 144, "• Risky\n• New tooling", "rose", { ...bullets, paper: true }),
  ];
  return item("bs-pros-cons", "Pros & Cons", ["pros", "cons", "tradeoff", "compare", "decision"], nodes, [], G);
}

export const BRAINSTORM_PACK: LibraryPack = {
  id: "brainstorm",
  name: "Brainstorm & Retro",
  blurb: "Stickies, retro columns, matrices and voting",
  hue: H,
  items: [stickySet(), startStopContinue(), madSadGlad(), matrix(), dotVote(), swot(), cluster(), parkingLot(), hmw(), prosCons()],
};
