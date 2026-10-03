/** Built-in pack: Callouts & annotations (ember, with rose/mint for semantics). */
import type { LibraryPack } from "../types";
import { box, CLEAR, item, link, text } from "./_kit";

const H = "ember" as const;
const G = { group: true };
const body = { textAlign: "left" as const, bold: false, fontSize: 16 };

function speech() {
  const a = box("callout", 0, 0, 200, 100, "Say something", H, { fontSize: 18 });
  return item("co-speech", "Speech Bubble", ["speech", "bubble", "quote", "dialog", "chat"], [a]);
}

function thought() {
  const c = box("cloud", 32, 0, 180, 104, "Hmm…", H, { fontSize: 18 });
  const d1 = box("ellipse", 16, 108, 20, 20, "", H);
  const d2 = box("ellipse", 0, 132, 12, 12, "", H);
  return item("co-thought", "Thought Cloud", ["thought", "think", "idea", "cloud", "dream"], [c, d1, d2], [], G);
}

function numbers() {
  const n = [1, 2, 3, 4, 5].map((i) => box("ellipse", (i - 1) * 48, 0, 36, 36, String(i), H, { solid: true }));
  return item("co-numbers", "Numbered Badges 1–5", ["number", "badge", "step", "marker", "count"], n);
}

function highlight() {
  const r = box("rect", 0, 16, 240, 120, "", H, { fill: CLEAR, strokeDash: "dashed", strokeWidth: 3 });
  const t = box("rounded", 16, 0, 96, 32, "Focus", H, { solid: true, fontSize: 14, cornerRadius: 16 });
  return item("co-highlight", "Highlight Box", ["highlight", "focus", "frame", "emphasis", "zone"], [r, t], [], G);
}

function noteArrow() {
  const n = box("note", 0, 0, 160, 80, "Check this", "lemon");
  return item(
    "co-note-arrow",
    "Note + Arrow",
    ["note", "pointer", "comment", "arrow", "annotate"],
    [n],
    [link(n, { x: 260, y: 108 }, { from: "r", routing: "straight" })],
  );
}

function warning() {
  const b = box("rounded", 0, 0, 360, 56, "", "rose");
  const i = box("triangle", 12, 12, 36, 32, "!", "rose", { solid: true, fontSize: 14 });
  const t = text(60, 0, 288, 56, "Rate limit: 100 requests/min", { ...body, bold: true });
  return item("co-warning", "Warning Banner", ["warning", "alert", "caution", "error", "danger"], [b, i, t], [], G);
}

function tip() {
  const b = box("rounded", 0, 0, 360, 56, "", "mint");
  const i = box("ellipse", 12, 10, 36, 36, "i", "mint", { solid: true });
  const t = text(60, 0, 288, 56, "Tip: press Space to pan", { ...body, bold: true });
  return item("co-tip", "Tip Banner", ["tip", "hint", "info", "help", "advice"], [b, i, t], [], G);
}

function tags() {
  const a = box("banner", 0, 0, 112, 40, "TODO", H, { solid: true, fontSize: 14 });
  const b = box("banner", 128, 0, 112, 40, "WIP", "lemon", { fontSize: 14 });
  const c = box("banner", 256, 0, 112, 40, "DONE", "mint", { fontSize: 14 });
  return item("co-tags", "Status Tags", ["todo", "wip", "done", "label", "status", "tag"], [a, b, c]);
}

function starburst() {
  const a = box("star", 0, 0, 120, 120, "NEW", H, { solid: true, fontSize: 18 });
  return item("co-starburst", "Starburst", ["star", "burst", "new", "sale", "badge", "wow"], [a]);
}

function steps() {
  const labels = ["Open the board", "Pick a shape", "Share the link"];
  const nodes = labels.flatMap((l, i) => [
    box("ellipse", 0, i * 48, 32, 32, String(i + 1), H, { solid: true, fontSize: 14 }),
    text(44, i * 48, 200, 32, l, { ...body }),
  ]);
  return item("co-steps", "Numbered Steps", ["steps", "instructions", "how to", "list", "guide"], nodes, [], G);
}

function brace() {
  const b = box("braceRight", 0, 0, 24, 120, "", H);
  const t = text(36, 44, 140, 32, "Group label", { ...body, bold: true });
  return item("co-brace", "Brace Label", ["brace", "bracket", "group", "span", "range"], [b, t], [], G);
}

function pointer() {
  const a = box("arrowRight", 0, 0, 132, 60, "Look here", H, { fontSize: 14 });
  return item("co-pointer", "Block Arrow", ["arrow", "pointer", "direction", "next", "look"], [a]);
}

export const CALLOUTS_PACK: LibraryPack = {
  id: "callouts",
  name: "Callouts & Annotations",
  blurb: "Bubbles, badges, banners and pointers to mark up a board",
  hue: H,
  items: [speech(), thought(), numbers(), highlight(), noteArrow(), warning(), tip(), tags(), starburst(), steps(), brace(), pointer()],
};
