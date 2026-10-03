/** Built-in pack: Mobile wireframe (lilac). Composite widgets are grouped. */
import { LIB_PALETTE } from "../palette";
import type { LibraryPack } from "../types";
import { box, item, text } from "./_kit";

const H = "lilac" as const;
const G = { group: true };
const MUTED = LIB_PALETTE.slate.stroke;
const body = { textAlign: "left" as const, bold: false, fontSize: 14 };

function phone() {
  const f = box("rounded", 0, 0, 240, 480, "", H, { paper: true, cornerRadius: 32 });
  const notch = box("rounded", 88, 12, 64, 16, "", H, { solid: true, cornerRadius: 8 });
  const home = box("rounded", 88, 456, 64, 8, "", H, { solid: true, cornerRadius: 4 });
  const hint = text(24, 48, 192, 392, "Screen", { textColor: MUTED, bold: false });
  return item("wm-phone", "Phone Frame", ["phone", "mobile", "device", "iphone", "android", "screen"], [f, notch, home, hint], [], G);
}

function statusBar() {
  const bar = box("rect", 0, 0, 240, 32, "", H, { cornerRadius: 0 });
  const t = text(12, 0, 80, 32, "9:41", { fontSize: 14, textAlign: "left" });
  const s = text(128, 0, 100, 32, "5G  100%", { fontSize: 12, textAlign: "right" });
  return item("wm-status", "Status Bar", ["status", "clock", "battery", "signal", "top"], [bar, t, s], [], G);
}

function tabBar() {
  const bar = box("rect", 0, 0, 240, 64, "", H, { paper: true, cornerRadius: 0 });
  const labels = ["Home", "Search", "Inbox", "Me"];
  const nodes = [bar];
  labels.forEach((l, i) => {
    nodes.push(box("ellipse", i * 60 + 22, 10, 16, 16, "", H, i === 0 ? { solid: true } : {}));
    nodes.push(text(i * 60, 32, 60, 24, l, { fontSize: 12, bold: i === 0, textColor: i === 0 ? LIB_PALETTE.lilac.stroke : MUTED }));
  });
  return item("wm-tabbar", "Bottom Tab Bar", ["tabs", "navigation", "bottom", "menu", "icons"], nodes, [], G);
}

function listRows() {
  const rows = [
    ["Anna Tran", "Seen 2m ago"],
    ["Bao Le", "Typing…"],
    ["Chi Pham", "Yesterday"],
  ];
  const nodes = rows.flatMap(([a, b], i) => [
    box("rect", 0, i * 64, 240, 64, "", H, { paper: true, cornerRadius: 0 }),
    box("ellipse", 12, i * 64 + 12, 40, 40, a[0], H, { fontSize: 14 }),
    text(64, i * 64 + 8, 140, 48, `${a}\n${b}`, { ...body }),
    text(208, i * 64 + 16, 24, 32, "›", { fontSize: 20, textColor: MUTED }),
  ]);
  return item("wm-list", "List Rows", ["list", "rows", "contacts", "inbox", "cells"], nodes, [], G);
}

function fab() {
  const a = box("ellipse", 0, 0, 56, 56, "+", "ember", { solid: true, fontSize: 28 });
  return item("wm-fab", "Floating Action Button", ["fab", "add", "plus", "action", "button"], [a]);
}

function bottomSheet() {
  const s = box("rounded", 0, 0, 240, 200, "", H, { paper: true, cornerRadius: 24 });
  const grab = box("rounded", 100, 8, 40, 8, "", H, { solid: true, cornerRadius: 4 });
  const t = text(16, 28, 208, 28, "Share board", { fontSize: 18, textAlign: "left" });
  const o = ["Copy link", "Invite people", "Export PNG"].map((l, i) => text(16, 64 + i * 36, 208, 32, l, { ...body }));
  return item("wm-sheet", "Bottom Sheet", ["sheet", "drawer", "actions", "menu", "panel"], [s, grab, t, ...o], [], G);
}

function login() {
  const f = box("rounded", 0, 0, 240, 360, "", H, { paper: true, cornerRadius: 24 });
  const t = text(24, 36, 192, 36, "Welcome back", { fontSize: 20 });
  const e = box("rounded", 24, 96, 192, 44, "Email", H, { ...body, paper: true, cornerRadius: 8, textColor: MUTED });
  const p = box("rounded", 24, 152, 192, 44, "Password", H, { ...body, paper: true, cornerRadius: 8, textColor: MUTED });
  const b = box("rounded", 24, 220, 192, 44, "Log in", H, { solid: true, cornerRadius: 8 });
  const l = text(24, 280, 192, 24, "Forgot password?", { fontSize: 14, textColor: LIB_PALETTE.link.stroke });
  return item("wm-login", "Login Screen", ["login", "sign in", "auth", "form", "password"], [f, t, e, p, b, l], [], G);
}

function onboarding() {
  const c = box("rounded", 0, 0, 240, 320, "", H, { paper: true, cornerRadius: 24 });
  const art = box("ellipse", 60, 24, 120, 120, "", H);
  const t = text(16, 160, 208, 28, "Plan together", { fontSize: 18 });
  const b = text(16, 192, 208, 44, "Invite your team and\nsketch ideas live.", { ...body, textAlign: "center" });
  const d = [0, 1, 2].map((i) => box("ellipse", 100 + i * 16, 244, 8, 8, "", H, i === 0 ? { solid: true } : {}));
  const btn = box("rounded", 16, 268, 208, 36, "Next", H, { solid: true, fontSize: 14, cornerRadius: 8 });
  return item("wm-onboarding", "Onboarding Card", ["onboarding", "welcome", "intro", "carousel", "walkthrough"], [c, art, t, b, ...d, btn], [], G);
}

function toast() {
  const t = box("rounded", 0, 0, 280, 48, "Saved to your board", "ink", { ...body, solid: true, textColor: LIB_PALETTE.ink.fill });
  const u = text(216, 8, 56, 32, "Undo", { fontSize: 14, textColor: LIB_PALETTE.lemon.fill });
  return item("wm-toast", "Toast", ["toast", "snackbar", "notification", "message", "feedback"], [t, u], [], G);
}

function appHeader() {
  const bar = box("rect", 0, 0, 240, 56, "", H, { paper: true, cornerRadius: 0 });
  const back = text(8, 12, 32, 32, "‹", { fontSize: 24 });
  const t = text(48, 12, 144, 32, "Boards", { fontSize: 18 });
  const add = box("ellipse", 200, 12, 32, 32, "+", H, { fontSize: 18 });
  return item("wm-header", "App Header", ["header", "app bar", "toolbar", "title", "back"], [bar, back, t, add], [], G);
}

export const WIREFRAME_MOBILE_PACK: LibraryPack = {
  id: "wireframe-mobile",
  name: "Mobile Wireframe",
  blurb: "Phone frame, bars, lists, sheets and onboarding",
  hue: H,
  items: [phone(), statusBar(), tabBar(), listRows(), fab(), bottomSheet(), login(), onboarding(), toast(), appHeader()],
};
