/**
 * editor-core/diagram/semanticNarrative — turns a PageSemanticSummary into
 * words: the 2–3 sentence live overview and the "Copy for AI" Markdown.
 * Pure TypeScript; only TYPES come from ./semanticSummary (no runtime cycle).
 */
import type { PageSemanticSummary, SemanticComponent } from "./semanticSummary";

function oneLine(text: unknown, cap = 80): string {
  const s = String(text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return s.length <= cap ? s : s.slice(0, cap - 1) + "…";
}

function titleCaseWord(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function listText(items: string[], max = 3): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** 2–3 sentences from the graph alone — used when no human summary exists
 * (and shown next to it when one does). */
export function synthesizeOverview(s: PageSemanticSummary, byId: Map<string, SemanticComponent>): string {
  const nComp = s.components.length;
  const nFlow = s.flows.length;
  const nZone = s.groups.length;
  if (nComp === 0 && nZone === 0) {
    if (s.annotations.length) return `This page holds ${plural(s.annotations.length, "text label")} and no diagram components yet.`;
    return s.nodeCount ? "This page holds only decorative strokes — no diagram components yet." : "This page is empty.";
  }
  const cat = (s.page?.category || s.board?.category || "").trim();
  const noun = cat ? `${titleCaseWord(cat)} diagram` : "Diagram";
  const topZones = s.groups.filter((g) => !g.parentId && g.label).map((g) => g.label);
  const zonePart = nZone
    ? ` across ${plural(nZone, "zone")}${topZones.length ? ` (${listText(topZones, 3)})` : ""}`
    : "";
  const flowPart = nFlow ? `, connected by ${plural(nFlow, "flow")}` : ", with no connectors yet";
  const sentences = [`${noun} of ${plural(nComp, "component")}${zonePart}${flowPart}.`];

  const names = (ids: string[]) => ids.map((id) => byId.get(id)?.label).filter((x): x is string => !!x);
  const parts: string[] = [];
  const entries = names(s.entryIds);
  const hubs = s.hubIds.map((id) => {
    const c = byId.get(id)!;
    return `${c.label} (${c.inDegree + c.outDegree} links)`;
  });
  const sinks = names(s.sinkIds);
  if (entries.length) parts.push(`starts at ${listText(entries, 3)}`);
  if (hubs.length) parts.push(`routes through ${listText(hubs, 2)}`);
  if (sinks.length) parts.push(`lands in ${listText(sinks, 3)}`);
  if (parts.length) {
    const last = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
    sentences.push(`The flow ${last}.`);
  }

  const roleCounts = new Map<string, number>();
  for (const c of s.components) {
    // palette-derived roles are guesses — fine as a hint, too noisy to narrate
    if (!c.role || c.roleSource === "color" || c.role === "label" || c.role === "note") continue;
    roleCounts.set(c.role, (roleCounts.get(c.role) ?? 0) + 1);
  }
  const mix = [...roleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (mix.length >= 2 || (mix.length === 1 && mix[0][1] >= 2)) {
    sentences.push(`Building blocks: ${mix.map(([r, n]) => `${n} ${r}`).join(", ")}.`);
  }
  return sentences.join(" ");
}

/* ------------------------------------------------------------------------ */
/* Markdown export ("Copy for AI")                                            */
/* ------------------------------------------------------------------------ */

function mdEscape(s: string): string {
  return s.replace(/([\\`*_<>|])/g, "\\$1");
}

export function toSemanticMarkdown(boardName: string, pageName: string | undefined, s: PageSemanticSummary): string {
  const out: string[] = [];
  const title = oneLine(boardName, 200) || "Untitled board";
  out.push(`# ${mdEscape(title)}`);
  if (pageName) out.push(`_Page: ${mdEscape(oneLine(pageName, 120))}_`);
  out.push("");

  out.push("## Summary");
  if (s.board?.summary?.trim()) out.push(s.board.summary.trim(), "");
  if (s.page?.summary?.trim()) out.push(`**This page:** ${s.page.summary.trim()}`, "");
  out.push(`**Overview (computed from the diagram):** ${s.autoSummary}`, "");

  const facts: string[] = [];
  const cat = s.page?.category || s.board?.category;
  if (cat) facts.push(`- **Category:** ${mdEscape(cat)}`);
  if (s.board?.domain) facts.push(`- **Domain:** ${mdEscape(s.board.domain)}`);
  const tags = [...(s.board?.tags ?? []), ...(s.page?.tags ?? [])];
  if (tags.length) facts.push(`- **Tags:** ${tags.map(mdEscape).join(", ")}`);
  if (s.board?.owner) facts.push(`- **Owner:** ${mdEscape(s.board.owner)}`);
  for (const l of s.board?.links ?? []) facts.push(`- **Link:** [${mdEscape(l.label)}](${l.url})`);
  facts.push(`- **Size:** ${plural(s.components.length, "component")}, ${plural(s.groups.length, "zone")}, ${plural(s.flows.length, "flow")}`);
  out.push(...facts, "");

  const comp = new Map(s.components.map((c) => [c.id, c]));
  const compLine = (c: SemanticComponent) => {
    const bits: string[] = [];
    if (c.role) bits.push(c.role);
    if (c.tags.length) bits.push(c.tags.join(", "));
    if (c.tech) bits.push(c.tech);
    const notes = [...(c.description ? [c.description] : []), ...c.details];
    const extra = notes.length ? ` — ${notes.map(mdEscape).join("; ")}` : "";
    return `${mdEscape(c.label)}${bits.length ? ` _(${bits.map(mdEscape).join(" · ")})_` : ""}${extra}`;
  };

  if (s.groups.length || s.components.length) {
    out.push("## Zones & components");
    const byGroup = new Map(s.groups.map((g) => [g.id, g]));
    const render = (gid: string, depth: number) => {
      const g = byGroup.get(gid);
      if (!g) return;
      const pad = "  ".repeat(depth);
      out.push(`${pad}- **${mdEscape(g.label || "Untitled zone")}** _(${mdEscape(g.role)})_`);
      for (const m of g.memberIds) {
        const c = comp.get(m);
        if (c) out.push(`${pad}  - ${compLine(c)}`);
      }
      for (const child of g.childGroupIds) render(child, depth + 1);
    };
    for (const g of s.groups) if (!g.parentId && g.source === "frame") render(g.id, 0);
    for (const g of s.groups) if (g.source === "meta") {
      out.push(`- **${mdEscape(g.label)}** _(group)_`);
      for (const m of g.memberIds) {
        const c = comp.get(m);
        if (c) out.push(`  - ${compLine(c)}`);
      }
    }
    if (s.ungroupedIds.length) {
      out.push(s.groups.length ? "- **Ungrouped**" : "");
      const pad = s.groups.length ? "  " : "";
      for (const id of s.ungroupedIds) {
        const c = comp.get(id);
        if (c) out.push(`${pad}- ${compLine(c)}`);
      }
    }
    out.push("");
  }

  if (s.flows.length) {
    out.push(`## Flows (${s.flows.length})`);
    s.flows.forEach((f, i) => out.push(`${i + 1}. ${mdEscape(f.text)}`));
    out.push("");
  }
  if (s.annotations.length) {
    out.push("## Annotations");
    for (const a of s.annotations.slice(0, 30)) out.push(`- ${mdEscape(a.text)}`);
    out.push("");
  }
  if (s.page?.notes?.trim()) out.push("## Notes", s.page.notes.trim(), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
