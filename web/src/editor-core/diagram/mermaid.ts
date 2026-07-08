/**
 * editor-core/diagram/mermaid — export a page's nodes/edges as a Mermaid
 * flowchart definition (the PORTABLE, PR-reviewable text form of a board).
 *
 * Pure TypeScript, no React/DOM — mirrors the rest of editor-core. Lossy by
 * design: Mermaid has no absolute geometry, so only structure (nodes, labels,
 * links, arrow direction, dashed-ness) survives; layout is Mermaid's job.
 */
import type { DiagramEdge, DiagramNode } from "./types";

/** Mermaid node id: alphanumeric, stable, collision-free. */
function mid(id: string, taken: Map<string, string>): string {
  const cached = taken.get(id);
  if (cached) return cached;
  let base = id.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(base)) base = "n" + base;
  let candidate = base;
  let i = 2;
  const used = new Set(taken.values());
  while (used.has(candidate)) candidate = `${base}_${i++}`;
  taken.set(id, candidate);
  return candidate;
}

function label(text: string): string {
  // Mermaid labels: quote to survive spaces/punctuation; strip newlines.
  const clean = text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return clean ? `"${clean}"` : '" "';
}

/** kind → Mermaid bracket pair. Unmapped kinds fall back to a rectangle. */
function brackets(kind: string): [string, string] {
  switch (kind) {
    case "rounded":
    case "terminator":
      return ["(", ")"];
    case "ellipse":
      return ["([", "])"];
    case "diamond":
      return ["{", "}"];
    case "cylinder":
      return ["[(", ")]"];
    case "hexagon":
      return ["{{", "}}"];
    case "parallelogram":
      return ["[/", "/]"];
    default:
      return ["[", "]"];
  }
}

export function diagramToMermaid(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): string {
  const ids = new Map<string, string>();
  const lines: string[] = ["flowchart TD"];
  for (const n of nodes) {
    const [open, close] = brackets(n.kind);
    lines.push(`  ${mid(n.id, ids)}${open}${label(n.text || n.kind)}${close}`);
  }
  for (const e of edges) {
    if (e.source.kind === "free" || e.target.kind === "free") continue;
    const a = mid(e.source.nodeId, ids);
    const b = mid(e.target.nodeId, ids);
    const arrow = e.dash === "dashed" || e.dash === "dotted"
      ? (e.endArrow ? "-.->" : "-.-")
      : (e.endArrow ? "-->" : "---");
    const lbl = e.label ? `|${label(e.label)}|` : "";
    lines.push(`  ${a} ${arrow}${lbl} ${b}`);
  }
  return lines.join("\n") + "\n";
}
