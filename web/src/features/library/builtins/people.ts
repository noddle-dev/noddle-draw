/** Built-in pack: People & roles (rose). Actor labels sit BELOW the figure. */
import { LIB_PALETTE } from "../palette";
import type { LibraryPack } from "../types";
import type { LibHue } from "./_kit";
import { box, item, link, text } from "./_kit";

const H = "rose" as const;
const G = { group: true };
const MUTED = LIB_PALETTE.slate.stroke;
const body = { textAlign: "left" as const, bold: false, fontSize: 14 };

/** Stick figure at (x,y) with a caption under it — 120 wide column. */
export function figure(x: number, y: number, label: string, hue: LibHue = H) {
  return [box("actor", x + 28, y, 64, 96, "", hue), text(x, y + 100, 120, 24, label)];
}

function actor() {
  return item("pp-actor", "Actor", ["user", "person", "stick figure", "human", "uml"], figure(0, 0, "User"), [], G);
}

function roles() {
  const nodes = [...figure(0, 0, "User"), ...figure(128, 0, "Admin", "ember"), ...figure(256, 0, "Customer")];
  return item("pp-roles", "User / Admin / Customer", ["roles", "actors", "personas", "admin", "customer"], nodes, [], G);
}

function team() {
  const f = box("rounded", 0, 0, 272, 136, "", H, { paper: true });
  const a = box("ellipse", 24, 16, 64, 64, "AN", H);
  const b = box("ellipse", 104, 16, 64, 64, "BT", "lemon");
  const c = box("ellipse", 184, 16, 64, 64, "CH", "mint");
  const t = text(16, 92, 240, 32, "Design team", { fontSize: 18 });
  return item("pp-team", "Team of 3", ["team", "group", "squad", "members", "crew"], [f, a, b, c, t], [], G);
}

function avatar() {
  const a = box("ellipse", 0, 0, 80, 80, "KN", H, { fontSize: 22 });
  const s = box("ellipse", 60, 60, 20, 20, "", "mint", { solid: true });
  return item("pp-avatar", "Avatar", ["avatar", "profile", "initials", "online", "user"], [a, s], [], G);
}

function speaking() {
  const p = box("actor", 0, 56, 64, 96, "", H);
  const b = box("callout", 72, 0, 200, 88, "Can we ship\nby Friday?", H, { paper: true });
  return item("pp-speaking", "Person + Speech Bubble", ["speech", "quote", "says", "talk", "comment"], [p, b], [], G);
}

function persona() {
  const c = box("rect", 0, 0, 300, 204, "", H, { paper: true });
  const av = box("ellipse", 16, 16, 64, 64, "MT", H, { fontSize: 18 });
  const n = text(96, 16, 188, 28, "Mai Tran", { fontSize: 18, textAlign: "left" });
  const r = text(96, 44, 188, 24, "Product manager, 32", { ...body, textColor: MUTED });
  const g = text(16, 96, 268, 92, "Goals: ship faster\nPains: messy handoffs\nUses: chat, docs, boards", { ...body });
  return item("pp-persona", "Persona Card", ["persona", "profile", "user research", "customer", "archetype"], [c, av, n, r, g], [], G);
}

function handoff() {
  const [a, al] = figure(0, 0, "Customer");
  const [b, bl] = figure(240, 0, "Support");
  return item(
    "pp-handoff",
    "Customer ↔ Support",
    ["conversation", "support", "help", "interaction", "service"],
    [a, al, b, bl],
    [link(a, b, { routing: "straight", label: "asks", tail: "arrow" })],
  );
}

function badges() {
  const o = box("rounded", 0, 0, 96, 36, "Owner", H, { solid: true, cornerRadius: 18, fontSize: 14 });
  const e = box("rounded", 112, 0, 96, 36, "Editor", H, { cornerRadius: 18, fontSize: 14 });
  const v = box("rounded", 224, 0, 96, 36, "Viewer", H, { paper: true, cornerRadius: 18, fontSize: 14 });
  return item("pp-badges", "Role Badges", ["role", "badge", "permission", "owner", "editor", "viewer"], [o, e, v], [], G);
}

function audience() {
  const nodes = [0, 48, 96, 144, 192].map((x) => box("actor", x, 0, 40, 64, "", H));
  nodes.push(text(0, 72, 232, 24, "Audience"));
  return item("pp-audience", "Audience", ["crowd", "users", "people", "market", "segment"], nodes, [], G);
}

function nameCard() {
  const c = box("rounded", 0, 0, 220, 72, "", H, { paper: true });
  const a = box("ellipse", 12, 8, 56, 56, "LV", H);
  const t = text(80, 8, 128, 56, "Lan Vo\nHead of Ops", { ...body, bold: true });
  return item("pp-name-card", "Name Card", ["name", "contact", "employee", "title", "profile"], [c, a, t], [], G);
}

export const PEOPLE_PACK: LibraryPack = {
  id: "people",
  name: "People & Roles",
  blurb: "Actors, teams, avatars and persona cards",
  hue: H,
  items: [actor(), roles(), team(), avatar(), speaking(), persona(), handoff(), badges(), audience(), nameCard()],
};
