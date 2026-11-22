/**
 * features/editor/SemanticOverview — the LIVE "what is this board?" read of
 * the active page: summary + computed overview, zones with their components,
 * and the end-to-end flows. Shared by the title-island SemanticPopover
 * (Overview tab) and the inspector's nothing-selected card.
 *
 * Everything is derived on the fly by editor-core's buildPageSemanticSummary
 * (a port of the MCP read_board_summary page pass) — nothing is stored, so
 * the overview has value on a board nobody ever annotated. Clicking a zone,
 * component chip or flow selects that object on the canvas and pans to it.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  buildPageSemanticSummary,
  titleCase,
  toSemanticMarkdown,
} from "../../editor-core/diagram/semantics";
import type {
  IconInfo,
  PageSemanticSummary,
  SemanticComponent,
  SemanticFlow,
  SemanticGroup,
} from "../../editor-core/diagram/semantics";
import type { Attachment } from "../../editor-core/diagram";
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";
import { usePagesStore } from "../../state/pagesStore";
import { iconDef } from "../diagram/icons";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

const iconInfo = (key: string): IconInfo | undefined => {
  const d = iconDef(key);
  return d ? { label: d.label, category: d.category } : undefined;
};

/** The live summary of the active page (deferred so drags never stall). */
export function useLiveSemanticSummary(): PageSemanticSummary {
  const nodes = useDeferredValue(useDiagramStore((s) => s.nodes));
  const edges = useDeferredValue(useDiagramStore((s) => s.edges));
  const boardMeta = usePagesStore((s) => s.metadata);
  const pageMeta = usePagesStore((s) => s.pages.find((p) => p.id === s.activeId)?.metadata);
  return useMemo(
    () => buildPageSemanticSummary(nodes, edges, boardMeta, pageMeta, { iconInfo }),
    [nodes, edges, boardMeta, pageMeta],
  );
}

/** Board + page name for the Markdown export. */
function exportNames(): { board: string; page?: string } {
  const board = useEditorStore.getState().docName.replace(/^·\s*/, "").trim() || "Untitled board";
  const ps = usePagesStore.getState();
  const page = ps.pages.find((p) => p.id === ps.activeId);
  return { board, page: ps.pages.length > 1 ? page?.name : undefined };
}

/** Select a node/edge and pan the camera to it when it's off-screen. */
export function focusDiagramObject(id: string): void {
  const ds = useDiagramStore.getState();
  const node = ds.nodes[id];
  const edge = node ? undefined : ds.edges[id];
  if (!node && !edge) return;
  ds.setDiagramSelection([id]);
  const at = (a: Attachment) => {
    if (a.kind === "free") return a.point;
    const n = ds.nodes[a.nodeId];
    return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
  };
  let c: { x: number; y: number } | null = null;
  if (node) c = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  else if (edge) {
    const p = at(edge.source);
    const q = at(edge.target);
    c = p && q ? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } : p ?? q;
  }
  const es = useEditorStore.getState();
  if (!c || !es.refs) return;
  const r = es.refs.host.getBoundingClientRect();
  const { cam } = es;
  const sx = c.x * cam.z + cam.x;
  const sy = c.y * cam.z + cam.y;
  const mx = r.width * 0.15;
  const my = r.height * 0.15;
  if (sx >= mx && sx <= r.width - mx && sy >= my && sy <= r.height - my) return;
  es.setCam({ ...cam, x: r.width / 2 - c.x * cam.z, y: r.height / 2 - c.y * cam.z });
}

/** Role → one of five quiet tones for the chip dot. */
function roleTone(role: string | undefined): string {
  switch (role) {
    case "database": case "datastore": case "storage": case "cache": case "table":
      return "data";
    case "service": case "compute": case "component": case "analytics": case "ml":
      return "compute";
    case "gateway": case "queue": case "focal": case "external": case "vpc":
      return "edge";
    case "security": case "alert": case "monitoring":
      return "guard";
    case "client": case "actor": case "source":
      return "client";
    default:
      return "plain";
  }
}

/* ------------------------------------------------------------------------ */
/* "Copy for AI"                                                             */
/* ------------------------------------------------------------------------ */

export function CopyForAIButton({ summary, compact = false }: { summary: PageSemanticSummary; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onCopy = async () => {
    const { board, page } = exportNames();
    const ok = await copyText(toSemanticMarkdown(board, page, summary));
    setState(ok ? "ok" : "fail");
    useEditorStore.getState().setStatus(ok ? "Copied the board overview as Markdown" : "Couldn't copy to the clipboard", ok ? "ok" : "error");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button
      type="button"
      className={`sov-copy${state === "ok" ? " done" : ""}${compact ? " compact" : ""}`}
      title="Copy the overview, zones and flows as Markdown — ready to paste into an AI chat or docs"
      onClick={onCopy}
      aria-live="polite"
    >
      {state === "ok" ? "Copied!" : state === "fail" ? "Copy failed" : "Copy for AI"}
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* Pieces                                                                    */
/* ------------------------------------------------------------------------ */

function CompChip({ c }: { c: SemanticComponent }) {
  const hint = [c.role && `${titleCase(c.role)}${c.roleSource && c.roleSource !== "meta" ? " (inferred)" : ""}`, c.tech, c.description, ...c.details]
    .filter(Boolean)
    .join(" · ");
  return (
    <button type="button" className="sov-chip" title={hint || c.kind} onClick={() => focusDiagramObject(c.id)}>
      <span className={`sov-dot t-${roleTone(c.role)}`} aria-hidden="true" />
      <span className="sov-chip-t">{c.label}</span>
      {c.tags.map((t) => (
        <span key={t} className="sov-tag">{t}</span>
      ))}
    </button>
  );
}

const CHIP_CAP = 24;

function ChipList({ ids, byId }: { ids: string[]; byId: Map<string, SemanticComponent> }) {
  const [all, setAll] = useState(false);
  const shown = all ? ids : ids.slice(0, CHIP_CAP);
  return (
    <div className="sov-chips">
      {shown.map((id) => {
        const c = byId.get(id);
        return c ? <CompChip key={id} c={c} /> : null;
      })}
      {ids.length > shown.length && (
        <button type="button" className="sov-more" onClick={() => setAll(true)}>+{ids.length - shown.length} more</button>
      )}
    </div>
  );
}

function ZoneCard({
  g,
  parentLabel,
  byId,
  defaultOpen,
}: {
  g: SemanticGroup;
  parentLabel?: string;
  byId: Map<string, SemanticComponent>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const count = g.memberIds.length;
  return (
    <div className={`sov-zone${open ? " open" : ""}`} style={{ marginLeft: Math.min(g.depth, 4) * 10 }}>
      <div className="sov-zone-head">
        <button type="button" className="sov-zone-tog" aria-expanded={open} aria-label={open ? "Collapse zone" : "Expand zone"} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s ease" }}>
            <path d="M4.4 2.6 L8 6.1 L4.5 9.5" />
          </svg>
        </button>
        <button
          type="button"
          className="sov-zone-title"
          title={g.source === "frame" ? "Select this zone on the canvas" : "Select the group's components"}
          onClick={() => (g.source === "frame" ? focusDiagramObject(g.id) : useDiagramStore.getState().setDiagramSelection(g.memberIds))}
        >
          {g.label || "Untitled zone"}
        </button>
        {g.role && g.role !== "zone" && <span className="sov-pill">{g.role}</span>}
        {parentLabel && <span className="sov-in" title={`Nested in ${parentLabel}`}>in {parentLabel}</span>}
        <span className="sov-count">{count}</span>
      </div>
      {open && (count > 0 ? <ChipList ids={g.memberIds} byId={byId} /> : (
        <div className="sov-quiet">{g.childGroupIds.length ? `${g.childGroupIds.length} nested zone${g.childGroupIds.length === 1 ? "" : "s"}` : "No components"}</div>
      ))}
    </div>
  );
}

function FlowRow({ f }: { f: SemanticFlow }) {
  return (
    <li>
      <button type="button" className="sov-flow" title={f.text} onClick={() => focusDiagramObject(f.id)}>
        <span className="sov-flow-end">{f.sourceLabel}</span>
        <span className="sov-flow-mid" aria-hidden="true">
          {f.bidirectional ? "◀" : ""}──{f.viaLabel ? <span className="sov-via">{f.viaLabel}</span> : null}──{f.directed ? "▶" : ""}
        </span>
        <span className="sov-flow-end">{f.targetLabel}</span>
      </button>
    </li>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="sov-sec">
      <div className="sov-sec-h">
        {title}
        {count != null && <span className="sov-sec-n">{count}</span>}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* The overview                                                              */
/* ------------------------------------------------------------------------ */

export function SemanticOverview({ summary }: { summary: PageSemanticSummary }) {
  const s = summary;
  const byId = useMemo(() => new Map(s.components.map((c) => [c.id, c])), [s.components]);
  const groupLabel = useMemo(() => new Map(s.groups.map((g) => [g.id, g.label || "Untitled zone"])), [s.groups]);
  const cat = s.page?.category || s.board?.category;
  const tags = [...new Set([...(s.board?.tags ?? []), ...(s.page?.tags ?? [])])];
  // Zones with direct members start open (nested-only wrappers stay folded);
  // a board with a crowd of zones starts all-folded so the list stays scannable.
  const crowded = s.groups.length > 10;
  const keyRoles: Array<[string, string[]]> = [
    ["Entry", s.entryIds],
    ["Hubs", s.hubIds],
    ["Lands in", s.sinkIds],
  ];
  const hasKeys = keyRoles.some(([, ids]) => ids.length > 0);

  return (
    <div className="sov">
      <div className="sov-summary">
        {s.board?.summary?.trim() && <p className="sov-human">{s.board.summary.trim()}</p>}
        {s.page?.summary?.trim() && <p className="sov-page"><b>This page:</b> {s.page.summary.trim()}</p>}
        <div className="sov-auto">
          <span className="sov-auto-k">Live overview</span>
          <p>{s.autoSummary}</p>
        </div>
        <div className="sov-stats">
          <span className="sov-stat"><b>{s.components.length}</b> components</span>
          <span className="sov-stat"><b>{s.groups.length}</b> zones</span>
          <span className="sov-stat"><b>{s.flows.length}</b> flows</span>
          {cat && <span className="sov-stat accent">{titleCase(cat)}</span>}
          {s.board?.domain && <span className="sov-stat">{s.board.domain}</span>}
          {tags.map((t) => <span key={t} className="sov-stat tag">#{t}</span>)}
        </div>
      </div>

      {hasKeys && (
        <div className="sov-keys">
          {keyRoles.map(([k, ids]) => ids.length > 0 && (
            <div key={k} className="sov-key">
              <span className="sov-key-k">{k}</span>
              <ChipList ids={ids.slice(0, 6)} byId={byId} />
            </div>
          ))}
        </div>
      )}

      {s.groups.length > 0 ? (
        <Section title="Zones & groups" count={s.groups.length}>
          <div className="sov-zones">
            {s.groups.map((g) => (
              <ZoneCard key={g.id} g={g} byId={byId} defaultOpen={!crowded && g.memberIds.length > 0} parentLabel={g.parentId ? groupLabel.get(g.parentId) : undefined} />
            ))}
            {s.ungroupedIds.length > 0 && (
              <div className="sov-zone open sov-ungrouped">
                <div className="sov-zone-head"><span className="sov-zone-title static">Ungrouped components</span><span className="sov-count">{s.ungroupedIds.length}</span></div>
                <ChipList ids={s.ungroupedIds} byId={byId} />
              </div>
            )}
          </div>
        </Section>
      ) : s.components.length > 0 ? (
        <Section title="Components" count={s.components.length}>
          <ChipList ids={s.components.map((c) => c.id)} byId={byId} />
        </Section>
      ) : null}

      {s.flows.length > 0 && (
        <Section title="Semantic flows" count={s.flows.length}>
          <ol className="sov-flows">
            {s.flows.map((f) => <FlowRow key={f.id} f={f} />)}
          </ol>
        </Section>
      )}

      {(s.annotations.length > 0 || s.decorations > 0) && (
        <div className="sov-foot">
          {s.annotations.length > 0 && `${s.annotations.length} text label${s.annotations.length === 1 ? "" : "s"}`}
          {s.annotations.length > 0 && s.decorations > 0 && " · "}
          {s.decorations > 0 && `${s.decorations} decorative shape${s.decorations === 1 ? "" : "s"} skipped`}
        </div>
      )}
    </div>
  );
}
