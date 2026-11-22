/**
 * features/editor/SemanticOverview — the LIVE "what is this board?" read of
 * the active page: a hero narrative, three metric cards, the entry → hub →
 * sink pipeline, zones with their components and the end-to-end flows. Shared
 * by the title-island SemanticPopover (Overview tab) and the inspector's
 * nothing-selected card — the layout adapts to either width through a
 * container query on `.sov`.
 *
 * Everything is derived on the fly by editor-core's buildPageSemanticSummary
 * (a port of the MCP read_board_summary page pass) — nothing is stored, so
 * the overview has value on a board nobody ever annotated. Clicking a zone,
 * component chip or flow selects that object on the canvas and pans to it.
 * Self-contained on purpose (no imports from sibling editor panels) so the
 * file ports to the open-source edition unchanged.
 */
import { createContext, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ROLE_TONES,
  buildPageSemanticSummary,
  roleTone,
  titleCase,
  toSemanticMarkdown,
} from "../../editor-core/diagram/semantics";
import type {
  IconInfo,
  PageSemanticSummary,
  RoleTone,
  SemanticComponent,
  SemanticFlow,
  SemanticGroup,
} from "../../editor-core/diagram/semantics";
import type { Attachment } from "../../editor-core/diagram";
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";
import { usePagesStore } from "../../state/pagesStore";
import { iconDef } from "../diagram/icons";
import { RoleGlyph, SemanticTipCard } from "../diagram/SemanticBadge";
import type { SemanticTipContent } from "../diagram/SemanticBadge";

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

/** Clipboard write with the legacy execCommand fallback (http / old Safari). */
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

/* ------------------------------------------------------------------------ */
/* Icons — one 16px line set, currentColor                                    */
/* ------------------------------------------------------------------------ */

type IcoName =
  | "copy" | "warn" | "search" | "x" | "cube" | "frame" | "flow" | "chevron" | "cluster"
  | "target" | "route" | "enter" | "hub" | "sink" | "note" | "nest";

const ICO: Record<IcoName, ReactNode> = {
  copy: (
    <>
      <path d="M6 5.4 V4 a1.4 1.4 0 0 1 1.4 -1.4 H12 a1.4 1.4 0 0 1 1.4 1.4 V8.6 A1.4 1.4 0 0 1 12 10 H10.6" />
      <rect x="2.6" y="5.6" width="8" height="8" rx="1.5" />
      <path d="M6.6 7.5 Q6.85 9.35 8.7 9.6 Q6.85 9.85 6.6 11.7 Q6.35 9.85 4.5 9.6 Q6.35 9.35 6.6 7.5 Z" fill="currentColor" stroke="none" />
    </>
  ),
  warn: <path d="M8 2.6 L14 13 H2 Z M8 6.6 V9.6 M8 11.5 v.1" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 L13.4 13.4" />
    </>
  ),
  x: <path d="M4.4 4.4 L11.6 11.6 M11.6 4.4 L4.4 11.6" />,
  cube: (
    <>
      <path d="M8 1.9 L13.3 4.9 V11.1 L8 14.1 L2.7 11.1 V4.9 Z" />
      <path d="M2.9 5 L8 8 L13.1 5 M8 8 V14" />
    </>
  ),
  frame: (
    <>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2.4" strokeDasharray="2.4 2" />
      <rect x="5.2" y="6.3" width="5.6" height="3.6" rx="1" />
    </>
  ),
  flow: (
    <>
      <circle cx="3.3" cy="4.2" r="1.6" />
      <circle cx="12.7" cy="11.8" r="1.6" />
      <path d="M4.9 4.2 H7.2 a2 2 0 0 1 2 2 V9.8 a2 2 0 0 0 2 2" />
    </>
  ),
  chevron: <path d="M6 3.8 L10.2 8 L6 12.2" />,
  cluster: (
    <>
      <circle cx="5" cy="5.4" r="2" />
      <circle cx="11.2" cy="6.4" r="1.6" />
      <circle cx="7.6" cy="11.2" r="1.8" />
    </>
  ),
  target: (
    <>
      <circle cx="8" cy="8" r="4.6" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <path d="M8 1.6 V3.4 M8 12.6 V14.4 M1.6 8 H3.4 M12.6 8 H14.4" />
    </>
  ),
  route: (
    <>
      <circle cx="3.6" cy="3.8" r="1.6" />
      <circle cx="12.4" cy="12.6" r="1.6" />
      <path d="M5.2 3.8 H9.4 a2.2 2.2 0 0 1 0 4.4 H6.6 a2.2 2.2 0 0 0 0 4.4 H10.8" />
    </>
  ),
  enter: <path d="M2.6 8 H9.4 M6.8 5.4 L9.4 8 L6.8 10.6 M12.6 3.4 V12.6" />,
  hub: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 2.4 V6 M8 10 V13.6 M2.4 8 H6 M10 8 H13.6" />
    </>
  ),
  sink: <path d="M8 2.4 V9.6 M5.2 7 L8 9.8 L10.8 7 M3 13.2 H13" />,
  note: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 7.4 V10.8 M8 5.2 v.1" />
    </>
  ),
  nest: <path d="M4 3.4 V7.6 a2 2 0 0 0 2 2 H12 M9.8 7.4 L12 9.6 L9.8 11.8" />,
};

function Ico({ name, size = 14, sw = 1.5 }: { name: IcoName; size?: number; sw?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICO[name]}
    </svg>
  );
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
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  };
  const label = state === "ok" ? (compact ? "Copied" : "Copied Markdown") : state === "fail" ? "Copy failed" : "Copy for AI";
  return (
    <button
      type="button"
      className={`sov-copy${state === "ok" ? " done" : ""}${state === "fail" ? " fail" : ""}${compact ? " compact" : ""}`}
      title="Copy the overview, zones and flows as Markdown — ready to paste into an AI chat or docs"
      onClick={onCopy}
      aria-live="polite"
    >
      <span className="sov-copy-ic" aria-hidden="true">
        {state === "ok" ? (
          <svg className="sov-check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.6 8.4 L6.6 11.3 L12.4 4.9" />
          </svg>
        ) : (
          <Ico name={state === "fail" ? "warn" : "copy"} size={14} sw={1.4} />
        )}
      </span>
      <span className="sov-copy-t">
        <span>{label}</span>
        {/* holds the idle width so the compact button never jumps */}
        {compact && <span className="ghost" aria-hidden="true">Copy for AI</span>}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* Filter + hover-card plumbing                                               */
/* ------------------------------------------------------------------------ */

/** The active (lower-cased) filter query, for match highlighting. */
const QueryCtx = createContext("");

function Hl({ text }: { text: string }) {
  const q = useContext(QueryCtx);
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="sov-hl">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

const has = (q: string, ...parts: Array<string | undefined>) => parts.some((p) => !!p && p.toLowerCase().includes(q));
const compMatches = (c: SemanticComponent, q: string) =>
  has(q, c.label, c.role, c.tech, c.description, c.kind, ...c.tags, ...c.details);
const flowMatches = (f: SemanticFlow, q: string) => has(q, f.sourceLabel, f.targetLabel, f.viaLabel);

interface TipApi {
  show: (c: SemanticComponent, el: HTMLElement) => void;
  hide: () => void;
}
const TipCtx = createContext<TipApi | null>(null);

/** One shared hover card for every chip (the same glass card a node shows on
 * the canvas). Opens after a short rest, closes on leave / scroll / click. */
function useChipTip() {
  const [tip, setTip] = useState<{ c: SemanticComponent; rect: DOMRect } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setTip(null);
  }, []);
  const show = useCallback((c: SemanticComponent, el: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (el.isConnected) setTip({ c, rect: el.getBoundingClientRect() });
    }, 320);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!tip) return;
    const off = () => setTip(null);
    window.addEventListener("scroll", off, true);
    window.addEventListener("resize", off);
    return () => {
      window.removeEventListener("scroll", off, true);
      window.removeEventListener("resize", off);
    };
  }, [tip]);
  const api = useMemo<TipApi>(() => ({ show, hide }), [show, hide]);
  return { api, tip };
}

const inferred = (c: SemanticComponent) => !!c.role && !!c.roleSource && c.roleSource !== "meta";

function chipTip(c: SemanticComponent): SemanticTipContent {
  const captions = c.details.join(" · ");
  const extras: Array<{ key: string; value: string }> = [];
  if (c.description && captions) extras.push({ key: "captions", value: captions });
  if (c.tags.length) extras.push({ key: "badges", value: c.tags.join(", ") });
  if (c.inDegree + c.outDegree > 0) extras.push({ key: "links", value: `${c.inDegree} in · ${c.outDegree} out` });
  return {
    title: c.label,
    role: c.role,
    roleNote: inferred(c) ? "inferred" : undefined,
    tech: c.tech,
    text: c.description || captions || undefined,
    extras,
    hint: "Click to focus on the canvas",
  };
}

/* ------------------------------------------------------------------------ */
/* Pieces                                                                    */
/* ------------------------------------------------------------------------ */

function CompChip({ c }: { c: SemanticComponent }) {
  const tip = useContext(TipCtx);
  const tone = roleTone(c.role);
  const hint = [c.role && `${titleCase(c.role)}${inferred(c) ? " (inferred)" : ""}`, c.tech, c.description, ...c.details]
    .filter(Boolean)
    .join(" · ");
  const rich = !!tip && !!(c.role || c.tech || c.description || c.details.length || c.tags.length);
  return (
    <button
      type="button"
      className={`sov-chip t-${tone}`}
      // the hover card replaces the native tooltip; assistive tech keeps the full hint
      title={rich ? undefined : hint || c.kind}
      aria-label={hint ? `${c.label} — ${hint}` : undefined}
      onPointerEnter={(e) => {
        if (rich && e.pointerType === "mouse") tip?.show(c, e.currentTarget);
      }}
      onPointerLeave={() => tip?.hide()}
      onClick={() => {
        tip?.hide();
        focusDiagramObject(c.id);
      }}
    >
      {tone === "plain" ? (
        <span className="sov-dot" aria-hidden="true" />
      ) : (
        <span className="sov-glyph" aria-hidden="true"><RoleGlyph tone={tone} /></span>
      )}
      <span className="sov-chip-t"><Hl text={c.label} /></span>
      {c.tech && <span className="sov-tech">{c.tech}</span>}
      {c.tags.slice(0, 2).map((t) => (
        <span key={t} className="sov-tag">{t}</span>
      ))}
    </button>
  );
}

const CHIP_CAP = 24;
const FLOW_CAP = 12;
/** Components + flows beyond which the instant filter appears. */
const FILTER_MIN = 6;
const ZONE_HUES = 6;

function ChipList({ ids, byId, cap = CHIP_CAP }: { ids: string[]; byId: Map<string, SemanticComponent>; cap?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? ids : ids.slice(0, cap);
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
  ids,
  parentLabel,
  byId,
  defaultOpen,
  forceOpen,
  hue,
}: {
  g: SemanticGroup;
  /** Members to list (already narrowed by the filter). */
  ids: string[];
  parentLabel?: string;
  byId: Map<string, SemanticComponent>;
  defaultOpen: boolean;
  /** A live filter opens every surviving zone. */
  forceOpen: boolean;
  hue: number;
}) {
  const [openState, setOpen] = useState(defaultOpen);
  const open = forceOpen || openState;
  // Chips mount on first open and then stay, so collapsing can animate.
  const mounted = useRef(open);
  if (open) mounted.current = true;
  const count = ids.length;
  const focus = () =>
    g.source === "frame" ? focusDiagramObject(g.id) : useDiagramStore.getState().setDiagramSelection(g.memberIds);
  const focusHint = g.source === "frame" ? "Focus this zone on the canvas" : "Select the group's components";
  return (
    <div className={`sov-zone h-${hue}${open ? " open" : ""}`} style={{ "--depth": Math.min(g.depth, 4) } as CSSProperties}>
      <div className="sov-zone-head">
        <button type="button" className="sov-zone-tog" aria-expanded={open} aria-label={open ? "Collapse zone" : "Expand zone"} onClick={() => setOpen(!open)}>
          <Ico name="chevron" size={12} sw={1.7} />
        </button>
        <span className="sov-zone-ic" aria-hidden="true"><Ico name={g.source === "frame" ? "frame" : "cluster"} size={13} sw={1.35} /></span>
        <button type="button" className="sov-zone-title" title={focusHint} onClick={focus}>
          <Hl text={g.label || "Untitled zone"} />
        </button>
        {g.role && g.role !== "zone" && <span className="sov-pill">{g.role}</span>}
        {parentLabel && (
          <span className="sov-in" title={`Nested in ${parentLabel}`}>
            <Ico name="nest" size={11} sw={1.4} />
            <span>{parentLabel}</span>
          </span>
        )}
        <span className="sov-zone-sp" />
        <button type="button" className="sov-zone-focus" title={focusHint} aria-label={`Focus zone ${g.label || "Untitled zone"}`} onClick={focus}>
          <Ico name="target" size={12} sw={1.4} />
          <span>Focus zone</span>
        </button>
        <span className="sov-count" title={`${count} component${count === 1 ? "" : "s"}`}>{count}</span>
      </div>
      <div className="sov-zone-body">
        <div className="sov-zone-in">
          {mounted.current && (count > 0 ? <ChipList ids={ids} byId={byId} /> : (
            <div className="sov-quiet">{g.childGroupIds.length ? `${g.childGroupIds.length} nested zone${g.childGroupIds.length === 1 ? "" : "s"}` : "No components"}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FlowEnd({ label, tone, zone }: { label: string; tone: RoleTone; zone: boolean }) {
  return (
    <span className={`sov-flow-end t-${tone}`}>
      <span className={`sov-dot${zone ? " ring" : ""}`} aria-hidden="true" />
      <span className="sov-flow-t"><Hl text={label} /></span>
    </span>
  );
}

function FlowRow({ f, byId, zoneIds }: { f: SemanticFlow; byId: Map<string, SemanticComponent>; zoneIds: Set<string> }) {
  const said = f.bidirectional
    ? `${f.sourceLabel} and ${f.targetLabel}, both ways`
    : `${f.sourceLabel} ${f.directed ? "to" : "linked with"} ${f.targetLabel}`;
  const readable = f.viaLabel ? `${said} — ${f.viaLabel}` : said;
  return (
    <li>
      <button
        type="button"
        className={`sov-flow${f.directed && !f.bidirectional ? " dir" : ""}`}
        title={readable}
        aria-label={readable}
        onClick={() => focusDiagramObject(f.id)}
      >
        <FlowEnd label={f.sourceLabel} tone={roleTone(byId.get(f.sourceId)?.role)} zone={zoneIds.has(f.sourceId)} />
        <span className="sov-wire" aria-hidden="true">
          <svg className="sov-wire-svg" width="100%" height="14" focusable="false">
            <line className="l" x1="0" y1="7" x2="100%" y2="7" />
            {f.bidirectional && <path d="M5.5 3.6 L0.5 7 L5.5 10.4" />}
            {!f.directed && <circle className="d" cx="0" cy="7" r="1.9" />}
            <svg x="100%" y="7" width="1" height="1" overflow="visible">
              {f.directed ? <path d="M-5.5 -3.4 L-0.5 0 L-5.5 3.4" /> : <circle className="d" r="1.9" />}
            </svg>
          </svg>
          {f.viaLabel && <span className="sov-via"><Hl text={f.viaLabel} /></span>}
        </span>
        <FlowEnd label={f.targetLabel} tone={roleTone(byId.get(f.targetId)?.role)} zone={zoneIds.has(f.targetId)} />
      </button>
    </li>
  );
}

function Section({ icon, title, count, children }: { icon: IcoName; title: string; count?: number; children: ReactNode }) {
  return (
    <section className="sov-sec">
      <div className="sov-sec-h">
        <span className="sov-sec-ic" aria-hidden="true"><Ico name={icon} size={12} sw={1.45} /></span>
        {title}
        {count != null && <span className="sov-sec-n">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function Metric({
  tone,
  icon,
  value,
  label,
  caption,
  children,
}: {
  tone: "comp" | "zone" | "flow";
  icon: IcoName;
  value: number;
  label: string;
  caption: string;
  /** The card's micro-bar. */
  children: ReactNode;
}) {
  return (
    <div className={`sov-metric m-${tone}`}>
      <div className="sov-metric-top">
        <span className="sov-metric-n">{value}</span>
        <span className="sov-metric-ic" aria-hidden="true"><Ico name={icon} size={13} sw={1.4} /></span>
      </div>
      <div className="sov-metric-k">{label}</div>
      {children}
      <div className="sov-metric-sub">{caption}</div>
    </div>
  );
}

/** The synthesized paragraph, cut back into its sentences (overview / flow
 * path / building blocks) so each can carry its own weight. */
function narrativeLines(text: string): string[] {
  const cuts = [". The flow ", ". Building blocks: "]
    .map((m) => text.indexOf(m))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const out: string[] = [];
  let start = 0;
  for (const i of cuts) {
    out.push(text.slice(start, i + 1));
    start = i + 2;
  }
  out.push(text.slice(start));
  return out.filter(Boolean);
}

const TONE_NOUN: Record<RoleTone, string> = {
  client: "clients & sources",
  edge: "gateways & queues",
  compute: "services",
  data: "data stores",
  guard: "security & ops",
  plain: "unclassified",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------------ */
/* The overview                                                              */
/* ------------------------------------------------------------------------ */

export function SemanticOverview({ summary }: { summary: PageSemanticSummary }) {
  const s = summary;
  const [query, setQuery] = useState("");
  const [allFlows, setAllFlows] = useState(false);
  const { api: tipApi, tip } = useChipTip();
  const byId = useMemo(() => new Map(s.components.map((c) => [c.id, c])), [s.components]);
  const groupLabel = useMemo(() => new Map(s.groups.map((g) => [g.id, g.label || "Untitled zone"])), [s.groups]);
  const zoneIds = useMemo(() => new Set(s.groups.map((g) => g.id)), [s.groups]);
  // Every top-level zone gets its own accent; nested zones wear their root's.
  const hueOf = useMemo(() => {
    const out = new Map<string, number>();
    let next = 0;
    for (const g of s.groups) {
      const parent = g.parentId ? out.get(g.parentId) : undefined;
      out.set(g.id, parent ?? next++ % ZONE_HUES);
    }
    return out;
  }, [s.groups]);

  const cat = s.page?.category || s.board?.category;
  const tags = [...new Set([...(s.board?.tags ?? []), ...(s.page?.tags ?? [])])];
  const human = s.board?.summary?.trim();
  const pageNote = s.page?.summary?.trim();
  const [lead, ...moreLines] = narrativeLines(s.autoSummary);
  const hasGraph = s.components.length + s.groups.length + s.flows.length > 0;
  // Zones with direct members start open (nested-only wrappers stay folded);
  // a board with a crowd of zones starts all-folded so the list stays scannable.
  const crowded = s.groups.length > 10;

  // ---- metric cards ---------------------------------------------------------
  const mix = useMemo(() => {
    const n = new Map<RoleTone, number>();
    for (const c of s.components) {
      const t = roleTone(c.role);
      n.set(t, (n.get(t) ?? 0) + 1);
    }
    return ROLE_TONES.filter((t) => n.has(t)).map((t) => ({ tone: t, n: n.get(t)! }));
  }, [s.components]);
  const roleKinds = useMemo(() => new Set(s.components.map((c) => c.role).filter(Boolean)).size, [s.components]);
  const topZones = s.groups.filter((g) => !g.parentId).length;
  const nestedZones = s.groups.length - topZones;
  const labelled = s.flows.filter((f) => !!f.viaLabel).length;
  const twoWay = s.flows.filter((f) => f.bidirectional).length;

  // ---- topology pipeline ----------------------------------------------------
  const stepwise = cat === "flowchart" || cat === "timeline" || cat === "org";
  const steps = ([
    { key: "entry", label: stepwise ? "Starts at" : "Entry points", note: "nothing flows in", ids: s.entryIds },
    { key: "hub", label: stepwise ? "Key junctions" : "Core hubs", note: "most connected", ids: s.hubIds },
    { key: "sink", label: stepwise ? "Ends at" : "Data sinks", note: "where flows land", ids: s.sinkIds },
  ] as const).filter((st) => st.ids.length > 0);

  // ---- instant filter -------------------------------------------------------
  const canFilter = s.components.length + s.flows.length > FILTER_MIN;
  const q = canFilter ? query.trim().toLowerCase() : "";
  const view = useMemo(() => {
    if (!q) {
      return {
        zones: s.groups.map((g) => ({ g, ids: g.memberIds })),
        ungrouped: s.ungroupedIds,
        flat: s.components.map((c) => c.id),
        flows: s.flows,
        hits: 0,
      };
    }
    const hit = (id: string) => {
      const c = byId.get(id);
      return !!c && compMatches(c, q);
    };
    const zones: Array<{ g: SemanticGroup; ids: string[] }> = [];
    let named = 0;
    for (const g of s.groups) {
      // a zone matched by name keeps all of its members
      const whole = has(q, g.label, g.role);
      const ids = whole ? g.memberIds : g.memberIds.filter(hit);
      if (whole) named++;
      if (whole || ids.length) zones.push({ g, ids });
    }
    const flat = s.components.filter((c) => compMatches(c, q)).map((c) => c.id);
    const flows = s.flows.filter((f) => flowMatches(f, q));
    return { zones, ungrouped: s.ungroupedIds.filter(hit), flat, flows, hits: flat.length + flows.length + named };
  }, [s, q, byId]);
  const noHits = !!q && view.zones.length === 0 && view.ungrouped.length === 0 && view.flat.length === 0 && view.flows.length === 0;
  const shownFlows = allFlows || q ? view.flows : view.flows.slice(0, FLOW_CAP);

  return (
    <TipCtx.Provider value={tipApi}>
      <QueryCtx.Provider value={q}>
        <div className="sov">
          {/* ---- hero narrative ---- */}
          <div className="sov-hero">
            <div className="sov-hero-top">
              <span className="sov-live" title="Computed from the shapes and connectors on this page — it updates as you draw">
                <i className="sov-live-dot" aria-hidden="true" />
                Live synthesis
              </span>
              {(cat || s.board?.domain || tags.length > 0) && (
                <div className="sov-hero-pills">
                  {cat && <span className="sov-hp cat">{titleCase(cat)}</span>}
                  {s.board?.domain && <span className="sov-hp dom">{s.board.domain}</span>}
                  {tags.slice(0, 6).map((t) => <span key={t} className="sov-hp tag">#{t}</span>)}
                  {tags.length > 6 && <span className="sov-hp tag">+{tags.length - 6}</span>}
                </div>
              )}
            </div>
            {human && <p className="sov-human">{human}</p>}
            {pageNote && (
              <p className="sov-page">
                <span className="sov-page-k">This page</span>
                {pageNote}
              </p>
            )}
            <div className={`sov-auto${human || pageNote ? " sub" : ""}`}>
              <p className="sov-lead">{lead}</p>
              {moreLines.map((line) => (
                <p key={line} className="sov-line">
                  <span className="sov-line-ic" aria-hidden="true"><Ico name={line.startsWith("The flow") ? "route" : "cube"} size={12} sw={1.4} /></span>
                  <span>{line}</span>
                </p>
              ))}
            </div>
          </div>

          {/* ---- metric bento ---- */}
          {hasGraph && (
            <div className="sov-bento">
              <Metric
                tone="comp"
                icon="cube"
                value={s.components.length}
                label="Components"
                caption={roleKinds ? plural(roleKinds, "role") : "No roles yet"}
              >
                <div className="sov-mix" role="img" aria-label={mix.length ? `Role mix: ${mix.map((m) => `${m.n} ${TONE_NOUN[m.tone]}`).join(", ")}` : "No components"}>
                  {mix.map((m) => (
                    <i key={m.tone} className={`t-${m.tone}`} style={{ flexGrow: m.n }} title={`${m.n} ${TONE_NOUN[m.tone]}`} />
                  ))}
                </div>
              </Metric>
              <Metric
                tone="zone"
                icon="frame"
                value={s.groups.length}
                label="Zones"
                caption={!s.groups.length ? "No zones yet" : nestedZones ? `${topZones} top-level · ${nestedZones} nested` : "All top-level"}
              >
                <div className="sov-mix" aria-hidden="true">
                  {topZones > 0 && <i className="a" style={{ flexGrow: topZones }} />}
                  {nestedZones > 0 && <i className="b" style={{ flexGrow: nestedZones }} />}
                </div>
              </Metric>
              <Metric
                tone="flow"
                icon="flow"
                value={s.flows.length}
                label="Flows"
                caption={!s.flows.length ? "No connectors yet" : [labelled ? `${labelled} labelled` : "Unlabelled", twoWay ? `${twoWay} two-way` : ""].filter(Boolean).join(" · ")}
              >
                <div className="sov-mix" aria-hidden="true">
                  {labelled > 0 && <i className="a" style={{ flexGrow: labelled }} />}
                  {s.flows.length - labelled > 0 && <i className="b" style={{ flexGrow: s.flows.length - labelled }} />}
                </div>
              </Metric>
            </div>
          )}

          {/* ---- topology pipeline ---- */}
          {steps.length > 0 && (
            <div className="sov-topo">
              <div className="sov-sec-h">
                <span className="sov-sec-ic" aria-hidden="true"><Ico name="route" size={12} sw={1.45} /></span>
                {stepwise ? "Path" : "Topology"}
              </div>
              <ol className="sov-steps">
                {steps.map((st, i) => (
                  <li key={st.key} className={`sov-step s-${st.key}${steps[i + 1] ? ` n-${steps[i + 1].key}` : ""}`}>
                    <span className="sov-step-node" aria-hidden="true">
                      <Ico name={st.key === "entry" ? "enter" : st.key === "hub" ? "hub" : "sink"} size={11} sw={1.6} />
                    </span>
                    <div className="sov-step-main">
                      <div className="sov-step-k">
                        {st.label}
                        <span className="sov-step-n">{st.ids.length}</span>
                        <span className="sov-step-note">{st.note}</span>
                      </div>
                      <ChipList ids={st.ids} byId={byId} cap={6} />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* ---- instant filter ---- */}
          {canFilter && (
            <div className="sov-filter-wrap">
              <label className={`sov-filter${q ? " on" : ""}`}>
                <Ico name="search" size={14} sw={1.5} />
                <input
                  type="text"
                  data-sov-filter=""
                  value={query}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="Filter components, zones, or flows…"
                  aria-label="Filter components, zones, or flows"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Esc clears a typed filter first; a second Esc closes the host.
                    if (e.key === "Escape" && query) {
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                />
                {q && <span className="sov-filter-n" aria-live="polite">{plural(view.hits, "match", "matches")}</span>}
                {query && (
                  <button type="button" className="sov-filter-x" aria-label="Clear filter" title="Clear (Esc)" onClick={() => setQuery("")}>
                    <Ico name="x" size={11} sw={1.7} />
                  </button>
                )}
              </label>
            </div>
          )}

          {noHits && (
            <div className="sov-empty">
              <span className="sov-empty-ic" aria-hidden="true"><Ico name="search" size={16} sw={1.4} /></span>
              <div className="sov-empty-t">Nothing matches “{query.trim()}”</div>
              <div className="sov-empty-d">Try a component name, a role like “database”, or a protocol.</div>
              <button type="button" className="sov-more" onClick={() => setQuery("")}>Clear filter</button>
            </div>
          )}

          {/* ---- zones & components ---- */}
          {s.groups.length > 0 ? (
            (view.zones.length > 0 || view.ungrouped.length > 0) && (
              <Section icon="frame" title="Zones & groups" count={view.zones.length}>
                <div className="sov-zones">
                  {view.zones.map(({ g, ids }) => (
                    <ZoneCard
                      key={g.id}
                      g={g}
                      ids={ids}
                      byId={byId}
                      hue={hueOf.get(g.id) ?? 0}
                      forceOpen={!!q}
                      defaultOpen={!crowded && g.memberIds.length > 0}
                      parentLabel={g.parentId ? groupLabel.get(g.parentId) : undefined}
                    />
                  ))}
                  {view.ungrouped.length > 0 && (
                    <div className="sov-zone open sov-ungrouped">
                      <div className="sov-zone-head">
                        <span className="sov-zone-ic" aria-hidden="true"><Ico name="cluster" size={13} sw={1.35} /></span>
                        <span className="sov-zone-title static">Ungrouped components</span>
                        <span className="sov-zone-sp" />
                        <span className="sov-count">{view.ungrouped.length}</span>
                      </div>
                      <div className="sov-zone-body">
                        <div className="sov-zone-in"><ChipList ids={view.ungrouped} byId={byId} /></div>
                      </div>
                    </div>
                  )}
                </div>
              </Section>
            )
          ) : view.flat.length > 0 ? (
            <Section icon="cube" title="Components" count={view.flat.length}>
              <ChipList ids={view.flat} byId={byId} />
            </Section>
          ) : null}

          {/* ---- flows ---- */}
          {view.flows.length > 0 && (
            <Section icon="flow" title="Semantic flows" count={view.flows.length}>
              <ol className="sov-flows">
                {shownFlows.map((f) => <FlowRow key={f.id} f={f} byId={byId} zoneIds={zoneIds} />)}
              </ol>
              {view.flows.length > shownFlows.length && (
                <button type="button" className="sov-more wide" onClick={() => setAllFlows(true)}>
                  Show {view.flows.length - shownFlows.length} more flow{view.flows.length - shownFlows.length === 1 ? "" : "s"}
                </button>
              )}
            </Section>
          )}

          {(s.annotations.length > 0 || s.decorations > 0) && (
            <div className="sov-foot">
              <Ico name="note" size={12} sw={1.4} />
              <span>
                {s.annotations.length > 0 && plural(s.annotations.length, "text label")}
                {s.annotations.length > 0 && s.decorations > 0 && " · "}
                {s.decorations > 0 && `${plural(s.decorations, "decorative shape")} skipped`}
              </span>
            </div>
          )}
        </div>
        {tip && <SemanticTipCard rect={tip.rect} content={chipTip(tip.c)} />}
      </QueryCtx.Provider>
    </TipCtx.Provider>
  );
}
