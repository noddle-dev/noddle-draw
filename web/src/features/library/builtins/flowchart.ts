/** Built-in pack: Flowchart (sky). */
import type { LibraryPack } from "../types";
import { box, item, link, text } from "./_kit";

const H = "sky" as const;

function startEnd() {
  const a = box("terminator", 0, 0, 140, 56, "Start", H);
  const b = box("terminator", 176, 0, 140, 56, "End", H);
  return item("fc-start-end", "Start / End", ["terminator", "pill", "begin", "finish", "oval"], [a, b]);
}

function processStep() {
  const a = box("rounded", 0, 0, 176, 72, "Process step", H, { fontSize: 18 });
  return item("fc-process", "Process", ["step", "action", "task", "box"], [a]);
}

function decision() {
  const d = box("diamond", 0, 0, 160, 96, "Approved?", H);
  const yes = box("rounded", 20, 152, 120, 56, "Continue", H);
  const no = box("rounded", 216, 20, 120, 56, "Revise", H);
  return item(
    "fc-decision",
    "Decision",
    ["if", "branch", "condition", "yes", "no", "diamond"],
    [d, yes, no],
    [link(d, yes, { from: "b", to: "t", label: "Yes" }), link(d, no, { from: "r", to: "l", label: "No" })],
  );
}

function inputOutput() {
  const i = box("parallelogram", 0, 0, 180, 64, "Read input", H);
  const p = box("rounded", 228, 0, 160, 64, "Transform", H);
  const o = box("parallelogram", 436, 0, 180, 64, "Show result", H);
  return item(
    "fc-io",
    "Input / Output",
    ["data", "parallelogram", "read", "write", "io"],
    [i, p, o],
    [link(i, p, { from: "r", to: "l" }), link(p, o, { from: "r", to: "l" })],
  );
}

function loopBack() {
  const a = box("rounded", 20, 0, 160, 64, "Try step", H);
  const d = box("diamond", 20, 112, 160, 96, "Done?", H);
  const end = box("terminator", 40, 256, 120, 56, "Finish", H);
  return item(
    "fc-loop",
    "Loop Back",
    ["loop", "retry", "repeat", "cycle", "while"],
    [a, d, end],
    [
      link(a, d, { from: "b", to: "t" }),
      link(d, end, { from: "b", to: "t", label: "Yes" }),
      link(d, a, { from: "r", to: "r", label: "No" }),
    ],
  );
}

function subProcess() {
  const a = box("process", 0, 0, 188, 72, "Sub-process", H, { fontSize: 18 });
  return item("fc-subprocess", "Sub-process", ["predefined", "subroutine", "function", "call"], [a]);
}

function swimlane() {
  const l1 = box("rect", 0, 0, 96, 128, "Customer", H, { solid: true, cornerRadius: 0 });
  const b1 = box("rect", 96, 0, 432, 128, "", H, { paper: true, cornerRadius: 0 });
  const l2 = box("rect", 0, 128, 96, 128, "Team", H, { solid: true, cornerRadius: 0 });
  const b2 = box("rect", 96, 128, 432, 128, "", H, { paper: true, cornerRadius: 0 });
  const s1 = box("rounded", 136, 36, 144, 56, "Place order", H);
  const s2 = box("rounded", 344, 164, 144, 56, "Ship order", H);
  return item(
    "fc-swimlane",
    "Swimlane (2 Lanes)",
    ["lanes", "pool", "cross-functional", "handoff", "roles"],
    [l1, b1, l2, b2, s1, s2],
    [link(s1, s2, { from: "r", to: "t" })],
  );
}

function connectors() {
  const a = box("ellipse", 0, 16, 40, 40, "A", H, { solid: true });
  const b = box("offPage", 72, 0, 64, 72, "P2", H);
  return item("fc-connector", "Connectors", ["connector", "dot", "on-page", "off-page", "jump"], [a, b]);
}

function annotation() {
  const br = box("bracketLeft", 0, 0, 24, 88, "", H);
  const t = text(32, 0, 176, 88, "Annotation: why\nthis step exists", {
    textAlign: "left",
    bold: false,
    fontSize: 16,
  });
  return item("fc-annotation", "Annotation", ["comment", "note", "bracket", "explain"], [br, t], [], { group: true });
}

function chain() {
  const a = box("rounded", 0, 0, 140, 64, "Step 1", H);
  const b = box("rounded", 188, 0, 140, 64, "Step 2", H);
  const c = box("rounded", 376, 0, 140, 64, "Step 3", H);
  return item(
    "fc-chain",
    "3-Step Chain",
    ["sequence", "steps", "pipeline", "linear", "process"],
    [a, b, c],
    [link(a, b, { from: "r", to: "l" }), link(b, c, { from: "r", to: "l" })],
  );
}

function documents() {
  const a = box("document", 0, 0, 150, 84, "Document", H);
  const b = box("multiDocument", 184, 0, 150, 84, "Files", H);
  return item("fc-documents", "Documents", ["document", "report", "file", "paper", "multi"], [a, b]);
}

function approval() {
  const s = box("terminator", 36, 0, 136, 52, "Request", H);
  const d = box("diamond", 24, 96, 160, 96, "OK?", H);
  const ok = box("rounded", 0, 240, 96, 52, "Approve", H);
  const no = box("rounded", 112, 240, 96, 52, "Reject", "ember");
  return item(
    "fc-approval",
    "Approval Flow",
    ["approve", "reject", "review", "gate", "sign-off"],
    [s, d, ok, no],
    [link(s, d, { from: "b", to: "t" }), link(d, ok, { label: "Yes" }), link(d, no, { label: "No" })],
  );
}

export const FLOWCHART_PACK: LibraryPack = {
  id: "flowchart",
  name: "Flowchart",
  blurb: "Start/end, steps, decisions, loops and lanes",
  hue: H,
  items: [
    startEnd(),
    processStep(),
    decision(),
    inputOutput(),
    loopBack(),
    subProcess(),
    swimlane(),
    connectors(),
    annotation(),
    chain(),
    documents(),
    approval(),
  ],
};
