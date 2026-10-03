/** Built-in pack: Web wireframe (slate). Composite widgets are grouped. */
import { LIB_PALETTE } from "../palette";
import type { LibraryPack } from "../types";
import { box, item, text } from "./_kit";

const H = "slate" as const;
const G = { group: true };
const MUTED = LIB_PALETTE.slate.stroke;
const LINKC = LIB_PALETTE.link.stroke;
const body = { textAlign: "left" as const, bold: false, fontSize: 14 };

function browser() {
  const frame = box("rect", 0, 0, 480, 320, "", H, { paper: true });
  const bar = box("rect", 0, 0, 480, 40, "", H, { cornerRadius: 12 });
  const d1 = box("ellipse", 16, 12, 16, 16, "", "rose");
  const d2 = box("ellipse", 40, 12, 16, 16, "", "lemon");
  const d3 = box("ellipse", 64, 12, 16, 16, "", "mint");
  const url = box("rounded", 96, 8, 320, 24, "noddle.dev", H, { paper: true, fontSize: 12, bold: false, textColor: MUTED });
  const hint = text(24, 64, 432, 232, "Page content", { textColor: MUTED, bold: false });
  return item("ww-browser", "Browser Frame", ["window", "page", "chrome", "desktop", "screen"], [frame, bar, d1, d2, d3, url, hint], [], G);
}

function navBar() {
  const bar = box("rect", 0, 0, 560, 56, "", H, { paper: true });
  const logo = text(16, 12, 96, 32, "Brand", { fontSize: 18, textAlign: "left" });
  const l1 = text(236, 12, 64, 32, "Home", { fontSize: 14 });
  const l2 = text(304, 12, 64, 32, "Docs", { fontSize: 14 });
  const l3 = text(372, 12, 72, 32, "Pricing", { fontSize: 14 });
  const cta = box("rounded", 464, 12, 80, 32, "Sign in", "link", { solid: true, fontSize: 14, cornerRadius: 8 });
  return item("ww-navbar", "Nav Bar", ["header", "navigation", "menu", "topbar", "links"], [bar, logo, l1, l2, l3, cta], [], G);
}

function buttons() {
  const p = box("rounded", 0, 0, 140, 48, "Primary", "link", { solid: true });
  const s = box("rounded", 160, 0, 140, 48, "Secondary", H, { paper: true });
  const t = text(320, 0, 80, 48, "Cancel", { textColor: LINKC, underline: true });
  return item("ww-buttons", "Buttons", ["button", "cta", "primary", "secondary", "link"], [p, s, t], [], G);
}

function textInput() {
  const l = text(0, 0, 280, 24, "Email", { ...body, bold: true });
  const f = box("rounded", 0, 28, 280, 44, "you@example.com", H, { ...body, paper: true, cornerRadius: 8, textColor: MUTED });
  return item("ww-input", "Text Input", ["field", "form", "input", "textbox", "label"], [l, f], [], G);
}

function searchBar() {
  const f = box("rounded", 0, 0, 320, 48, "Search…", H, { ...body, paper: true, cornerRadius: 24, textColor: MUTED });
  const go = box("rounded", 256, 8, 56, 32, "Go", "link", { solid: true, fontSize: 14, cornerRadius: 16 });
  return item("ww-search", "Search Bar", ["search", "find", "query", "filter", "input"], [f, go], [], G);
}

function card() {
  const c = box("rect", 0, 0, 240, 280, "", H, { paper: true });
  const img = box("rect", 16, 16, 208, 120, "Image", H, { cornerRadius: 8, textColor: MUTED, bold: false });
  const t = text(16, 148, 208, 28, "Card title", { fontSize: 18, textAlign: "left" });
  const b = text(16, 176, 208, 44, "Short supporting text\nfor this card.", { ...body });
  const btn = box("rounded", 16, 228, 96, 36, "Action", "link", { solid: true, fontSize: 14, cornerRadius: 8 });
  return item("ww-card", "Card", ["card", "tile", "preview", "product", "article"], [c, img, t, b, btn], [], G);
}

function modal() {
  const bg = box("rect", 0, 0, 440, 300, "", H, { opacity: 0.7, cornerRadius: 0 });
  const dlg = box("rect", 60, 40, 320, 220, "", H, { paper: true });
  const t = text(80, 56, 248, 32, "Delete board?", { fontSize: 18, textAlign: "left" });
  const x = text(340, 52, 28, 28, "×", { fontSize: 20, textColor: MUTED });
  const b = text(80, 96, 280, 48, "This can't be undone.", { ...body });
  const cancel = box("rounded", 160, 196, 96, 40, "Cancel", H, { paper: true, fontSize: 14, cornerRadius: 8 });
  const del = box("rounded", 268, 196, 96, 40, "Delete", "rose", { solid: true, fontSize: 14, cornerRadius: 8 });
  return item("ww-modal", "Modal Dialog", ["dialog", "popup", "confirm", "overlay", "alert"], [bg, dlg, t, x, b, cancel, del], [], G);
}

function table() {
  const grid = box("table", 0, 0, 420, 120, "", H, { paper: true });
  const head = box("rect", 0, 0, 420, 40, "", H, { cornerRadius: 0 });
  const cells: string[][] = [
    ["Name", "Status", "Owner"],
    ["Roadmap", "Active", "Linh"],
    ["Launch", "Draft", "Minh"],
  ];
  const nodes = [grid, head];
  cells.forEach((row, r) =>
    row.forEach((c, i) =>
      nodes.push(text(i * 140 + 12, r * 40 + 4, 120, 32, c, r === 0 ? { fontSize: 14, textAlign: "left" } : body)),
    ),
  );
  return item("ww-table", "Data Table", ["table", "grid", "rows", "columns", "list"], nodes, [], G);
}

function tabs() {
  const t1 = text(0, 0, 112, 40, "Overview", { fontSize: 14, textColor: LINKC });
  const t2 = text(112, 0, 112, 40, "Activity", { fontSize: 14, textColor: MUTED });
  const t3 = text(224, 0, 112, 40, "Settings", { fontSize: 14, textColor: MUTED });
  const rule = box("rect", 0, 40, 400, 4, "", H, { cornerRadius: 0, strokeWidth: 1 });
  const active = box("rect", 0, 40, 112, 4, "", "link", { solid: true, cornerRadius: 0, strokeWidth: 1 });
  return item("ww-tabs", "Tabs", ["tabs", "segmented", "navigation", "sections", "switch"], [t1, t2, t3, rule, active], [], G);
}

function toggles() {
  const tr = box("rounded", 0, 4, 48, 24, "", "mint", { solid: true, cornerRadius: 12 });
  const knob = box("ellipse", 26, 6, 20, 20, "", H, { paper: true });
  const tl = text(60, 0, 140, 32, "Notifications", { ...body });
  const cb = box("rect", 4, 48, 24, 24, "✓", "link", { solid: true, cornerRadius: 4, fontSize: 14 });
  const cl = text(60, 44, 140, 32, "Remember me", { ...body });
  const rb = box("ring", 4, 92, 24, 24, "", H);
  const rl = text(60, 88, 140, 32, "Monthly", { ...body });
  return item("ww-toggles", "Toggle & Checkbox", ["switch", "checkbox", "radio", "option", "form"], [tr, knob, tl, cb, cl, rb, rl], [], G);
}

function avatarRow() {
  const nodes = [
    box("ellipse", 0, 0, 40, 40, "AL", "sky", { fontSize: 14 }),
    box("ellipse", 28, 0, 40, 40, "MN", "mint", { fontSize: 14 }),
    box("ellipse", 56, 0, 40, 40, "TK", "lilac", { fontSize: 14 }),
    box("ellipse", 84, 0, 40, 40, "+4", H, { fontSize: 14 }),
    text(136, 4, 120, 32, "6 members", { ...body, textColor: MUTED }),
  ];
  return item("ww-avatars", "Avatar Row", ["avatars", "members", "people", "facepile", "team"], nodes, [], G);
}

function footer() {
  const bar = box("rect", 0, 0, 560, 96, "", H, { cornerRadius: 0 });
  const c1 = text(24, 16, 140, 64, "Product\nFeatures\nPricing", { ...body });
  const c2 = text(184, 16, 140, 64, "Company\nAbout\nCareers", { ...body });
  const c3 = text(344, 16, 192, 64, "© 2026 Brand", { ...body, textAlign: "right", textColor: MUTED });
  return item("ww-footer", "Footer", ["footer", "links", "bottom", "sitemap", "copyright"], [bar, c1, c2, c3], [], G);
}

export const WIREFRAME_WEB_PACK: LibraryPack = {
  id: "wireframe-web",
  name: "Web Wireframe",
  blurb: "Browser frame, nav, forms, cards, modals and tables",
  hue: H,
  items: [browser(), navBar(), buttons(), textInput(), searchBar(), card(), modal(), table(), tabs(), toggles(), avatarRow(), footer()],
};
