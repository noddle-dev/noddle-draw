/**
 * features/templates/templates — REAL template definitions.
 *
 * Each template builds an editable board (noddle diagram nodes/edges). Picking
 * one creates a real document via POST /api/documents/new and navigates to its
 * /d/{id} URL — from there everything is the normal live-editable board.
 */
import type { DiagramEdge, DiagramNode, NodeKind } from "../../editor-core/diagram";
import { api } from "../../shared/api/client";
import { rememberBoard, useAppStore } from "../../state/appStore";

export interface TemplateDef {
  id: string;
  name: string;
  count: string;
  cat: string;
  accent: string;
  soft: string;
  shape: "flow" | "tree" | "erd" | "cloud" | "seq" | "retro" | "blank";
  build: () => { nodes: DiagramNode[]; edges: DiagramEdge[] };
}

export const TPL_CATS = ["All", "Retro", "Flowchart", "Org chart", "ERD", "Cloud", "Sequence"];

/** Category order used for the "For you" carousel rows (excludes the "All" pseudo-cat). */
export const TPL_CAT_ORDER = ["Flowchart", "Cloud", "ERD", "Org chart", "Sequence", "Retro"];

/** Curated ids surfaced in the "Recommended" / "Popular" carousel rows. */
export const RECOMMENDED_IDS = ["t1", "t13", "t7", "t18", "t2"];
export const POPULAR_IDS = ["t4", "r1", "t3", "t9", "t19", "t11"];

let seq = 0;
const nid = () => `n${++seq}`;

function node(
  kind: NodeKind,
  x: number,
  y: number,
  text: string,
  opts: Partial<DiagramNode> = {},
): DiagramNode {
  return {
    id: nid(),
    kind,
    x,
    y,
    w: 150,
    h: 70,
    text,
    fill: "#eef4ff",
    stroke: "#2563eb",
    // Bolder default look (Lucid-style): thicker border + bold label. Callers
    // can still override per node. Node text color stays the readable default.
    strokeWidth: 2.5,
    bold: true,
    ...opts,
  };
}

function edge(
  source: DiagramNode,
  target: DiagramNode,
  label?: string,
  opts: Partial<DiagramEdge> = {},
): DiagramEdge {
  return {
    id: `e${++seq}`,
    source: { kind: "floating", nodeId: source.id },
    target: { kind: "floating", nodeId: target.id },
    routing: "elbow",
    stroke: "#475569",
    strokeWidth: 2,
    endArrow: true,
    startArrow: false,
    animated: false,
    label,
    ...opts,
  };
}

function approvalFlow() {
  seq = 0;
  const start = node("ellipse", 620, 80, "Start", { w: 130, h: 60 });
  const submit = node("rounded", 610, 220, "Submit request");
  const review = node("diamond", 600, 380, "Manager approves?", { w: 170, h: 100 });
  const approved = node("rounded", 380, 560, "Provision access", { fill: "#f0fdf4", stroke: "#16a34a" });
  const rejected = node("rounded", 840, 560, "Notify requester", { fill: "#fef2f2", stroke: "#dc2626" });
  const end = node("ellipse", 620, 720, "End", { w: 130, h: 60 });
  return {
    nodes: [start, submit, review, approved, rejected, end],
    edges: [
      edge(start, submit),
      edge(submit, review),
      edge(review, approved, "yes"),
      edge(review, rejected, "no"),
      edge(approved, end),
      edge(rejected, end),
    ],
  };
}

function orgChart() {
  seq = 0;
  const head = node("rounded", 620, 100, "Head of Design", { fill: "#f4f0ff", stroke: "#7c3aed" });
  const lead1 = node("rounded", 300, 300, "Brand Lead", { stroke: "#7c3aed" });
  const lead2 = node("rounded", 620, 300, "Product Lead", { stroke: "#7c3aed" });
  const lead3 = node("rounded", 940, 300, "Research Lead", { stroke: "#7c3aed" });
  const m1 = node("rect", 480, 480, "Designer");
  const m2 = node("rect", 760, 480, "Designer");
  return {
    nodes: [head, lead1, lead2, lead3, m1, m2],
    edges: [
      edge(head, lead1),
      edge(head, lead2),
      edge(head, lead3),
      edge(lead2, m1),
      edge(lead2, m2),
    ],
  };
}

function erd() {
  seq = 0;
  const cust = node("rect", 260, 220, "Customer", { w: 180, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const acct = node("rect", 660, 220, "Account", { w: 180, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const card = node("rect", 1060, 220, "Card", { w: 180, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const txn = node("rect", 660, 520, "Transaction", { w: 180, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  return {
    nodes: [cust, acct, card, txn],
    edges: [
      edge(cust, acct, "1..n", { routing: "straight" }),
      edge(acct, card, "1..n", { routing: "straight" }),
      edge(acct, txn, "1..n", { routing: "straight" }),
    ],
  };
}

function cloudArch() {
  seq = 0;
  const user = node("ellipse", 160, 400, "User", { w: 120, h: 70 });
  const cdn = node("rounded", 440, 400, "CDN / WAF", { fill: "#f0fdf4", stroke: "#16a34a" });
  const api_ = node("rounded", 740, 260, "API Gateway", { fill: "#f0fdf4", stroke: "#16a34a" });
  const app = node("rounded", 1040, 260, "App Service", { fill: "#f0fdf4", stroke: "#16a34a" });
  const stat = node("rounded", 740, 540, "Static assets", { fill: "#f0fdf4", stroke: "#16a34a" });
  const db = node("rect", 1340, 260, "Database", { w: 140, h: 80, fill: "#fffbeb", stroke: "#d97706" });
  return {
    nodes: [user, cdn, api_, app, stat, db],
    edges: [
      edge(user, cdn),
      edge(cdn, api_, "api"),
      edge(cdn, stat, "assets"),
      edge(api_, app),
      edge(app, db, "", { animated: true }),
    ],
  };
}

function apiSequence() {
  seq = 0;
  const client = node("rect", 260, 120, "Client", { w: 140, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const server = node("rect", 660, 120, "API", { w: 140, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const dbase = node("rect", 1060, 120, "DB", { w: 140, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const req = node("rounded", 440, 320, "POST /login", { w: 170, h: 60 });
  const query = node("rounded", 850, 320, "SELECT user", { w: 170, h: 60 });
  const resp = node("rounded", 440, 520, "200 + token", { w: 170, h: 60, fill: "#f0fdf4", stroke: "#16a34a" });
  return {
    nodes: [client, server, dbase, req, query, resp],
    edges: [
      edge(client, req),
      edge(req, server),
      edge(server, query),
      edge(query, dbase),
      edge(server, resp),
      edge(resp, client),
    ],
  };
}

/* ---------- Sprint retro boards ----------
 *
 * Design system for all four retro boards (kept visually consistent):
 *   • a full-width brand TITLE banner on top,
 *   • one soft "zone" background per column (pushed FIRST so it sits behind),
 *   • a deeper-tint header chip with an emoji, 1–2 pastel starter sticky notes,
 *   • a light footer legend with facilitation hints.
 *
 * Palette = accessible Tailwind-ish pastel pairs. Column semantics drive the
 * hue: positive/keep = green, negative/stop = red, reflective = blue,
 * action/neutral = amber, learning = indigo, aspiration = rose. Sticky fills
 * are light (100) with a readable darker (600) stroke so the centered dark
 * node text stays high-contrast; header chips use the 200 tint, zones the 50.
 */
interface RetroColor {
  zone: string; // 50  — faint column background
  head: string; // 200 — header chip fill
  fill: string; // 100 — sticky note fill
  stroke: string; // 600 — border + accent (readable on the light fills)
}

const RC: Record<string, RetroColor> = {
  green: { zone: "#f0fdf4", head: "#bbf7d0", fill: "#dcfce7", stroke: "#16a34a" },
  red: { zone: "#fef2f2", head: "#fecaca", fill: "#fee2e2", stroke: "#dc2626" },
  blue: { zone: "#eff6ff", head: "#bfdbfe", fill: "#dbeafe", stroke: "#2563eb" },
  amber: { zone: "#fffbeb", head: "#fde68a", fill: "#fef3c7", stroke: "#d97706" },
  indigo: { zone: "#eef2ff", head: "#c7d2fe", fill: "#e0e7ff", stroke: "#4f46e5" },
  rose: { zone: "#fff1f2", head: "#fecdd3", fill: "#ffe4e6", stroke: "#e11d48" },
};

const COL_W = 300;
const COL_GAP = 44;
const BOARD_X = 100;
const retroCX = (i: number) => BOARD_X + i * (COL_W + COL_GAP);

interface RetroCol {
  title: string; // includes a leading emoji (rendered inside the header chip)
  color: RetroColor;
  prompts: string[]; // 1–2 starter sticky notes
}

function retroBoard(title: string, columns: RetroCol[]) {
  seq = 0;
  const n = columns.length;
  const boardW = n * COL_W + (n - 1) * COL_GAP;

  const zones: DiagramNode[] = []; // behind everything (pushed first)
  const fronts: DiagramNode[] = []; // headers + sticky notes (on top of zones)

  columns.forEach((col, i) => {
    const cx = retroCX(i);
    zones.push(
      node("rounded", cx - 14, 150, "", {
        w: COL_W + 28,
        h: 690,
        fill: col.color.zone,
        stroke: col.color.head,
        strokeWidth: 1.5,
      }),
    );
    fronts.push(
      node("rounded", cx, 168, col.title, {
        w: COL_W,
        h: 60,
        fill: col.color.head,
        stroke: col.color.stroke,
        strokeWidth: 2,
      }),
    );
    col.prompts.slice(0, 2).forEach((p, k) => {
      fronts.push(
        node("sticky", cx + 12, 254 + k * 170, p, {
          w: COL_W - 24,
          h: 148,
          fill: col.color.fill,
          stroke: col.color.stroke,
          strokeWidth: 1.5,
        }),
      );
    });
  });

  // Full-width brand banner (blue→purple identity) + facilitation footer.
  const banner = node("rounded", BOARD_X, 40, title, {
    w: boardW,
    h: 80,
    fill: "#ede9fe",
    stroke: "#7c3aed",
    strokeWidth: 2.5,
  });
  const footer = node(
    "note",
    BOARD_X,
    862,
    "🌿 Drag and drop to add stickies · one color per person · group & vote on ideas at the end of the session",
    { w: boardW, h: 56, fill: "#f8fafc", stroke: "#94a3b8", strokeWidth: 1.5 },
  );

  return { nodes: [...zones, banner, footer, ...fronts], edges: [] as DiagramEdge[] };
}

const startStopContinue = () =>
  retroBoard("🔄  Sprint Retro · Start / Stop / Continue", [
    {
      title: "▶  Start",
      color: RC.indigo,
      prompts: ["Something the team should start doing next sprint…", "A new idea to try out…"],
    },
    {
      title: "■  Stop",
      color: RC.red,
      prompts: ["Something getting in the way that should stop…", "A habit that's no longer effective…"],
    },
    {
      title: "➜  Continue",
      color: RC.green,
      prompts: ["Something that's working well and should continue…", "Something the team is proud of and wants to keep…"],
    },
  ]);

const madSadGlad = () =>
  retroBoard("🎭  Sprint Retro · Mad / Sad / Glad", [
    {
      title: "😠  Mad",
      color: RC.red,
      prompts: ["Something that frustrated you…", "A recurring obstacle…"],
    },
    {
      title: "😢  Sad",
      color: RC.blue,
      prompts: ["Something you regret…", "An expectation that wasn't met…"],
    },
    {
      title: "😀  Glad",
      color: RC.green,
      prompts: ["Something that made you happy…", "A success worth celebrating…"],
    },
  ]);

const fourLs = () =>
  retroBoard("🍀  Sprint Retro · 4 Ls", [
    { title: "💚  Liked", color: RC.green, prompts: ["Something you liked about this sprint…"] },
    { title: "📘  Learned", color: RC.indigo, prompts: ["A lesson learned…"] },
    { title: "🧩  Lacked", color: RC.amber, prompts: ["Something that was missing or insufficient…"] },
    { title: "🌱  Longed for", color: RC.rose, prompts: ["Something the team wishes it had…"] },
  ]);

const wentWell = () =>
  retroBoard("🚀  Sprint Retro · Went well / Didn't / Actions", [
    {
      title: "✅  Went well",
      color: RC.green,
      prompts: ["Something that went smoothly…", "Something the team did well…"],
    },
    {
      title: "⚠️  Didn't go well",
      color: RC.red,
      prompts: ["Something that didn't go as expected…", "A problem encountered…"],
    },
    {
      title: "🎯  Action items",
      color: RC.amber,
      prompts: ["A specific action for next sprint…", "Who owns it? When is it due?"],
    },
  ]);

/* ---------- Additional flowchart boards ---------- */
function onboardingFlow() {
  seq = 0;
  const start = node("ellipse", 620, 60, "Sign up", { w: 130, h: 60 });
  const verify = node("rounded", 610, 200, "Verify email");
  const profile = node("rounded", 610, 330, "Complete profile");
  const check = node("diamond", 600, 470, "Team invited?", { w: 170, h: 100 });
  const invite = node("rounded", 360, 650, "Send invites", { fill: "#f0fdf4", stroke: "#16a34a" });
  const done = node("ellipse", 640, 660, "Dashboard", { w: 140, h: 60 });
  return {
    nodes: [start, verify, profile, check, invite, done],
    edges: [
      edge(start, verify),
      edge(verify, profile),
      edge(profile, check),
      edge(check, invite, "yes"),
      edge(check, done, "no"),
      edge(invite, done),
    ],
  };
}

function deployFlow() {
  seq = 0;
  const commit = node("rounded", 120, 200, "Push commit");
  const build = node("rounded", 340, 200, "CI build");
  const test = node("diamond", 560, 175, "Tests pass?", { w: 170, h: 100 });
  const deploy = node("rounded", 820, 120, "Deploy prod", { fill: "#f0fdf4", stroke: "#16a34a" });
  const notify = node("rounded", 820, 300, "Notify author", { fill: "#fef2f2", stroke: "#dc2626" });
  const done = node("ellipse", 1080, 200, "Live", { w: 120, h: 60 });
  return {
    nodes: [commit, build, test, deploy, notify, done],
    edges: [
      edge(commit, build),
      edge(build, test),
      edge(test, deploy, "yes"),
      edge(test, notify, "no"),
      edge(deploy, done),
    ],
  };
}

function bugTriageFlow() {
  seq = 0;
  const report = node("ellipse", 120, 240, "Bug reported", { w: 150, h: 60 });
  const triage = node("diamond", 330, 215, "Reproducible?", { w: 170, h: 100 });
  const close = node("rounded", 330, 420, "Close · need info", { fill: "#fef2f2", stroke: "#dc2626" });
  const assign = node("rounded", 600, 240, "Assign owner");
  const fix = node("rounded", 820, 240, "Fix & PR");
  const verify = node("rounded", 1040, 240, "QA verify", { fill: "#f0fdf4", stroke: "#16a34a" });
  return {
    nodes: [report, triage, close, assign, fix, verify],
    edges: [
      edge(report, triage),
      edge(triage, close, "no"),
      edge(triage, assign, "yes"),
      edge(assign, fix),
      edge(fix, verify),
    ],
  };
}

function supportFlow() {
  seq = 0;
  const ticket = node("ellipse", 120, 240, "New ticket", { w: 140, h: 60 });
  const tier1 = node("rounded", 320, 240, "Tier 1 support");
  const solved = node("diamond", 540, 215, "Resolved?", { w: 160, h: 100 });
  const close = node("rounded", 780, 120, "Close ticket", { fill: "#f0fdf4", stroke: "#16a34a" });
  const escalate = node("rounded", 780, 380, "Escalate Tier 2", { fill: "#fffbeb", stroke: "#d97706" });
  return {
    nodes: [ticket, tier1, solved, close, escalate],
    edges: [
      edge(ticket, tier1),
      edge(tier1, solved),
      edge(solved, close, "yes"),
      edge(solved, escalate, "no"),
    ],
  };
}

/* ---------- Additional org charts ---------- */
function engineeringOrg() {
  seq = 0;
  const cto = node("rounded", 620, 80, "CTO", { fill: "#f4f0ff", stroke: "#7c3aed" });
  const be = node("rounded", 300, 280, "Backend Lead", { stroke: "#7c3aed" });
  const fe = node("rounded", 620, 280, "Frontend Lead", { stroke: "#7c3aed" });
  const infra = node("rounded", 940, 280, "Platform Lead", { stroke: "#7c3aed" });
  const e1 = node("rect", 200, 470, "Engineer");
  const e2 = node("rect", 400, 470, "Engineer");
  const e3 = node("rect", 620, 470, "Engineer");
  const e4 = node("rect", 940, 470, "SRE");
  return {
    nodes: [cto, be, fe, infra, e1, e2, e3, e4],
    edges: [
      edge(cto, be),
      edge(cto, fe),
      edge(cto, infra),
      edge(be, e1),
      edge(be, e2),
      edge(fe, e3),
      edge(infra, e4),
    ],
  };
}

function companyOrg() {
  seq = 0;
  const ceo = node("rounded", 620, 80, "CEO", { fill: "#f4f0ff", stroke: "#7c3aed" });
  const eng = node("rounded", 300, 300, "VP Engineering", { stroke: "#7c3aed" });
  const sales = node("rounded", 620, 300, "VP Sales", { stroke: "#7c3aed" });
  const ops = node("rounded", 940, 300, "VP Operations", { stroke: "#7c3aed" });
  const t1 = node("rect", 300, 500, "Team");
  const t2 = node("rect", 620, 500, "Team");
  const t3 = node("rect", 940, 500, "Team");
  return {
    nodes: [ceo, eng, sales, ops, t1, t2, t3],
    edges: [
      edge(ceo, eng),
      edge(ceo, sales),
      edge(ceo, ops),
      edge(eng, t1),
      edge(sales, t2),
      edge(ops, t3),
    ],
  };
}

/* ---------- Additional ERDs ---------- */
function ecommerceErd() {
  seq = 0;
  const cust = node("rect", 200, 200, "Customer", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const order = node("rect", 560, 200, "Order", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const item = node("rect", 560, 460, "OrderItem", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const prod = node("rect", 920, 460, "Product", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  return {
    nodes: [cust, order, item, prod],
    edges: [
      edge(cust, order, "1..n", { routing: "straight" }),
      edge(order, item, "1..n", { routing: "straight" }),
      edge(prod, item, "1..n", { routing: "straight" }),
    ],
  };
}

function blogErd() {
  seq = 0;
  const user = node("rect", 200, 220, "User", { w: 160, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const post = node("rect", 540, 220, "Post", { w: 160, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const comment = node("rect", 880, 130, "Comment", { w: 160, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const tag = node("rect", 880, 320, "Tag", { w: 160, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  return {
    nodes: [user, post, comment, tag],
    edges: [
      edge(user, post, "1..n", { routing: "straight" }),
      edge(post, comment, "1..n", { routing: "straight" }),
      edge(post, tag, "n..n", { routing: "straight" }),
    ],
  };
}

function saasErd() {
  seq = 0;
  const acct = node("rect", 200, 220, "Account", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const user = node("rect", 560, 120, "User", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const sub = node("rect", 560, 340, "Subscription", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  const inv = node("rect", 920, 340, "Invoice", { w: 170, h: 90, fill: "#ecfeff", stroke: "#0891b2" });
  return {
    nodes: [acct, user, sub, inv],
    edges: [
      edge(acct, user, "1..n", { routing: "straight" }),
      edge(acct, sub, "1..1", { routing: "straight" }),
      edge(sub, inv, "1..n", { routing: "straight" }),
    ],
  };
}

/* ---------- Additional cloud architectures ---------- */
function microservicesArch() {
  seq = 0;
  const gw = node("rounded", 160, 300, "API Gateway", { fill: "#f0fdf4", stroke: "#16a34a" });
  const auth = node("rounded", 460, 140, "Auth svc", { fill: "#f0fdf4", stroke: "#16a34a" });
  const orders = node("rounded", 460, 300, "Orders svc", { fill: "#f0fdf4", stroke: "#16a34a" });
  const pay = node("rounded", 460, 460, "Payments svc", { fill: "#f0fdf4", stroke: "#16a34a" });
  const bus = node("rounded", 780, 300, "Event bus", { fill: "#ede9fe", stroke: "#7c3aed" });
  const db = node("rect", 1060, 300, "Data store", { w: 150, h: 80, fill: "#fffbeb", stroke: "#d97706" });
  return {
    nodes: [gw, auth, orders, pay, bus, db],
    edges: [
      edge(gw, auth),
      edge(gw, orders),
      edge(gw, pay),
      edge(orders, bus, "", { animated: true }),
      edge(pay, bus, "", { animated: true }),
      edge(bus, db),
    ],
  };
}

function serverlessArch() {
  seq = 0;
  const user = node("ellipse", 140, 300, "Client", { w: 120, h: 70 });
  const api = node("rounded", 400, 300, "API Gateway", { fill: "#f0fdf4", stroke: "#16a34a" });
  const fn1 = node("rounded", 680, 180, "Lambda: read", { fill: "#f0fdf4", stroke: "#16a34a" });
  const fn2 = node("rounded", 680, 420, "Lambda: write", { fill: "#f0fdf4", stroke: "#16a34a" });
  const table = node("rect", 980, 300, "DynamoDB", { w: 150, h: 80, fill: "#fffbeb", stroke: "#d97706" });
  return {
    nodes: [user, api, fn1, fn2, table],
    edges: [
      edge(user, api),
      edge(api, fn1),
      edge(api, fn2),
      edge(fn1, table),
      edge(fn2, table, "", { animated: true }),
    ],
  };
}

function threeTierArch() {
  seq = 0;
  const web = node("rounded", 200, 300, "Web tier", { fill: "#f0fdf4", stroke: "#16a34a" });
  const lb = node("rounded", 460, 300, "Load balancer", { fill: "#f0fdf4", stroke: "#16a34a" });
  const app1 = node("rounded", 740, 180, "App server", { fill: "#f0fdf4", stroke: "#16a34a" });
  const app2 = node("rounded", 740, 420, "App server", { fill: "#f0fdf4", stroke: "#16a34a" });
  const db = node("rect", 1040, 300, "Database", { w: 150, h: 80, fill: "#fffbeb", stroke: "#d97706" });
  return {
    nodes: [web, lb, app1, app2, db],
    edges: [
      edge(web, lb),
      edge(lb, app1),
      edge(lb, app2),
      edge(app1, db),
      edge(app2, db),
    ],
  };
}

function dataPipeline() {
  seq = 0;
  const src = node("rect", 140, 300, "Sources", { w: 150, h: 80, fill: "#fffbeb", stroke: "#d97706" });
  const ingest = node("rounded", 400, 300, "Ingest", { fill: "#f0fdf4", stroke: "#16a34a" });
  const transform = node("rounded", 660, 300, "Transform", { fill: "#f0fdf4", stroke: "#16a34a" });
  const warehouse = node("rect", 920, 300, "Warehouse", { w: 160, h: 80, fill: "#fffbeb", stroke: "#d97706" });
  const bi = node("rounded", 1200, 300, "Dashboards", { fill: "#ede9fe", stroke: "#7c3aed" });
  return {
    nodes: [src, ingest, transform, warehouse, bi],
    edges: [
      edge(src, ingest),
      edge(ingest, transform, "", { animated: true }),
      edge(transform, warehouse),
      edge(warehouse, bi),
    ],
  };
}

/* ---------- Additional sequence boards ---------- */
function authSequence() {
  seq = 0;
  const user = node("rect", 200, 120, "User", { w: 140, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const app = node("rect", 600, 120, "App", { w: 140, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const idp = node("rect", 1000, 120, "Identity provider", { w: 190, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const s1 = node("rounded", 380, 300, "Login", { w: 170, h: 56 });
  const s2 = node("rounded", 780, 300, "Redirect + code", { w: 200, h: 56 });
  const s3 = node("rounded", 380, 480, "Session token", { w: 200, h: 56, fill: "#f0fdf4", stroke: "#16a34a" });
  return {
    nodes: [user, app, idp, s1, s2, s3],
    edges: [
      edge(user, s1),
      edge(s1, app),
      edge(app, s2),
      edge(s2, idp),
      edge(idp, s3),
      edge(s3, user),
    ],
  };
}

function checkoutSequence() {
  seq = 0;
  const buyer = node("rect", 200, 120, "Buyer", { w: 140, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const shop = node("rect", 600, 120, "Shop", { w: 140, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const psp = node("rect", 1000, 120, "Payment PSP", { w: 170, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const s1 = node("rounded", 380, 300, "Add to cart", { w: 180, h: 56 });
  const s2 = node("rounded", 780, 300, "Charge card", { w: 180, h: 56 });
  const s3 = node("rounded", 380, 480, "Order confirmed", { w: 210, h: 56, fill: "#f0fdf4", stroke: "#16a34a" });
  return {
    nodes: [buyer, shop, psp, s1, s2, s3],
    edges: [
      edge(buyer, s1),
      edge(s1, shop),
      edge(shop, s2),
      edge(s2, psp),
      edge(psp, s3),
      edge(s3, buyer),
    ],
  };
}

function webhookSequence() {
  seq = 0;
  const src = node("rect", 200, 120, "Provider", { w: 150, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const app = node("rect", 640, 120, "Our API", { w: 150, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const queue = node("rect", 1080, 120, "Worker queue", { w: 180, h: 60, fill: "#fffbeb", stroke: "#d97706" });
  const s1 = node("rounded", 420, 300, "POST webhook", { w: 190, h: 56 });
  const s2 = node("rounded", 860, 300, "Enqueue job", { w: 180, h: 56 });
  const s3 = node("rounded", 420, 480, "200 OK", { w: 150, h: 56, fill: "#f0fdf4", stroke: "#16a34a" });
  return {
    nodes: [src, app, queue, s1, s2, s3],
    edges: [
      edge(src, s1),
      edge(s1, app),
      edge(app, s2),
      edge(s2, queue),
      edge(app, s3),
      edge(s3, src),
    ],
  };
}

/* ---------- Additional retro boards ---------- */
const sailboat = () =>
  retroBoard("⛵  Sprint Retro · Sailboat", [
    { title: "💨  Wind (helps)", color: RC.green, prompts: ["What pushed the team forward…"] },
    { title: "⚓  Anchors (slows)", color: RC.red, prompts: ["What held the team back…"] },
    { title: "🪨  Rocks (risks)", color: RC.amber, prompts: ["Risks on the horizon…"] },
    { title: "🏝️  Island (goal)", color: RC.blue, prompts: ["Where the team wants to be…"] },
  ]);

const starfish = () =>
  retroBoard("⭐  Sprint Retro · Starfish", [
    { title: "➕  More of", color: RC.green, prompts: ["Do more of this…"] },
    { title: "➖  Less of", color: RC.amber, prompts: ["Do less of this…"] },
    { title: "▶  Start", color: RC.indigo, prompts: ["Start doing…"] },
    { title: "■  Stop", color: RC.red, prompts: ["Stop doing…"] },
    { title: "➜  Keep", color: RC.blue, prompts: ["Keep doing…"] },
  ]);

export const TEMPLATES: TemplateDef[] = [
  { id: "t1", name: "Approval flowchart", count: "6 shapes", cat: "Flowchart", accent: "#2563eb", soft: "#eef4ff", shape: "flow", build: approvalFlow },
  { id: "t2", name: "Team org chart", count: "6 shapes", cat: "Org chart", accent: "#7c3aed", soft: "#f4f0ff", shape: "tree", build: orgChart },
  { id: "t3", name: "Database ERD", count: "4 tables", cat: "ERD", accent: "#0891b2", soft: "#ecfeff", shape: "erd", build: erd },
  { id: "t4", name: "Cloud architecture", count: "6 shapes", cat: "Cloud", accent: "#16a34a", soft: "#f0fdf4", shape: "cloud", build: cloudArch },
  { id: "t5", name: "API sequence", count: "6 shapes", cat: "Sequence", accent: "#d97706", soft: "#fffbeb", shape: "seq", build: apiSequence },
  { id: "t6", name: "Onboarding flow", count: "6 shapes", cat: "Flowchart", accent: "#2563eb", soft: "#eef4ff", shape: "flow", build: onboardingFlow },
  { id: "t7", name: "Microservices map", count: "6 shapes", cat: "Cloud", accent: "#16a34a", soft: "#f0fdf4", shape: "cloud", build: microservicesArch },
  { id: "t8", name: "Reporting hierarchy", count: "6 shapes", cat: "Org chart", accent: "#7c3aed", soft: "#f4f0ff", shape: "tree", build: orgChart },
  { id: "t9", name: "CI/CD pipeline", count: "6 shapes", cat: "Flowchart", accent: "#2563eb", soft: "#eef4ff", shape: "flow", build: deployFlow },
  { id: "t10", name: "Bug triage", count: "6 shapes", cat: "Flowchart", accent: "#2563eb", soft: "#eef4ff", shape: "flow", build: bugTriageFlow },
  { id: "t11", name: "Engineering org", count: "8 shapes", cat: "Org chart", accent: "#7c3aed", soft: "#f4f0ff", shape: "tree", build: engineeringOrg },
  { id: "t12", name: "Company org chart", count: "7 shapes", cat: "Org chart", accent: "#7c3aed", soft: "#f4f0ff", shape: "tree", build: companyOrg },
  { id: "t13", name: "E-commerce ERD", count: "4 tables", cat: "ERD", accent: "#0891b2", soft: "#ecfeff", shape: "erd", build: ecommerceErd },
  { id: "t14", name: "Blog ERD", count: "4 tables", cat: "ERD", accent: "#0891b2", soft: "#ecfeff", shape: "erd", build: blogErd },
  { id: "t15", name: "SaaS billing ERD", count: "4 tables", cat: "ERD", accent: "#0891b2", soft: "#ecfeff", shape: "erd", build: saasErd },
  { id: "t16", name: "Serverless app", count: "5 shapes", cat: "Cloud", accent: "#16a34a", soft: "#f0fdf4", shape: "cloud", build: serverlessArch },
  { id: "t17", name: "Three-tier web", count: "5 shapes", cat: "Cloud", accent: "#16a34a", soft: "#f0fdf4", shape: "cloud", build: threeTierArch },
  { id: "t18", name: "OAuth login sequence", count: "6 shapes", cat: "Sequence", accent: "#d97706", soft: "#fffbeb", shape: "seq", build: authSequence },
  { id: "t19", name: "Checkout sequence", count: "6 shapes", cat: "Sequence", accent: "#d97706", soft: "#fffbeb", shape: "seq", build: checkoutSequence },
  { id: "t20", name: "Webhook handling", count: "6 shapes", cat: "Sequence", accent: "#d97706", soft: "#fffbeb", shape: "seq", build: webhookSequence },
  { id: "t21", name: "Support escalation", count: "5 shapes", cat: "Flowchart", accent: "#2563eb", soft: "#eef4ff", shape: "flow", build: supportFlow },
  { id: "t22", name: "Data pipeline", count: "5 shapes", cat: "Cloud", accent: "#16a34a", soft: "#f0fdf4", shape: "cloud", build: dataPipeline },
  { id: "r1", name: "Retro · Start / Stop / Continue", count: "3 columns", cat: "Retro", accent: "#37b24d", soft: "#ebfbee", shape: "retro", build: startStopContinue },
  { id: "r2", name: "Retro · Mad / Sad / Glad", count: "3 columns", cat: "Retro", accent: "#e64980", soft: "#fff0f6", shape: "retro", build: madSadGlad },
  { id: "r3", name: "Retro · 4 Ls", count: "4 columns", cat: "Retro", accent: "#1c7ed6", soft: "#e7f5ff", shape: "retro", build: fourLs },
  { id: "r4", name: "Retro · Went well / Didn't / Actions", count: "3 columns", cat: "Retro", accent: "#f0c000", soft: "#fff9db", shape: "retro", build: wentWell },
  { id: "r5", name: "Retro · Sailboat", count: "4 columns", cat: "Retro", accent: "#1c7ed6", soft: "#e7f5ff", shape: "retro", build: sailboat },
  { id: "r6", name: "Retro · Starfish", count: "5 columns", cat: "Retro", accent: "#37b24d", soft: "#ebfbee", shape: "retro", build: starfish },
];

/** Create a real document from a template (or blank) → open at /d/{id}.
 * Blank boards still ship an empty diagram so they are multi-page boards
 * (page bar) from the first moment, not svg-only docs. */
export async function createBoard(tpl?: TemplateDef, name?: string): Promise<void> {
  const diagram = tpl ? tpl.build() : { nodes: [], edges: [] };
  const meta = await api.create({
    name: name ?? (tpl ? tpl.name : "Untitled board"),
    diagram,
  });
  rememberBoard(meta.id, meta.name);
  useAppStore.getState().openInEditor(meta.id);
}
