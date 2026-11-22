/**
 * features/diagram/SemanticBadge — the quiet on-canvas hint that a node
 * carries semantic `meta` (role / description / tech / owner / url …).
 *
 *   • SemanticBadge — a small white disc at the node's top-right corner, ringed
 *     in the node's stroke colour, that lifts and scales when the node is
 *     hovered. With a valid http(s) `meta.url` it becomes a link mark: click
 *     opens the URL in a new tab and the pointerdown never reaches NodeView
 *     (no select / drag).
 *   • SemanticTooltip — a dark glass card portaled to <body> above (or below)
 *     the hovered node: role + tech badges, description, a key/value grid and
 *     the link footer.
 *   • SemanticTipCard / RoleGlyph / SparkMark — the shared card body and marks,
 *     reused by the editor's semantic overview so a chip there and a node here
 *     explain themselves the same way.
 *
 * Badge and tooltip are editor chrome: the badge carries data-editor-only="1"
 * so the SVG/PNG/GIF bake (editorStore.currentBoardSvg) and the offline MCP
 * capture strip it; the tooltip lives outside the SVG entirely. Pure rules
 * (what counts as meaningful, which nodes qualify, role → tone) live in
 * editor-core/diagram/semantics.ts.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DiagramNode } from "../../editor-core/diagram";
import { roleTone, summarizeMeta, titleCase } from "../../editor-core/diagram/semantics";
import type { RoleTone } from "../../editor-core/diagram/semantics";
import { useEditorStore } from "../../state/editorStore";

/* ------------------------------------------------------------------------ */
/* Shared marks                                                               */
/* ------------------------------------------------------------------------ */

/** One 12px line glyph per role tone (currentColor). */
export function RoleGlyph({ tone, size = 12 }: { tone: RoleTone; size?: number }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {tone === "data" && (
        <>
          <ellipse cx="6" cy="3.3" rx="3.6" ry="1.5" />
          <path d="M2.4 3.3 V8.7 C2.4 9.6 4 10.2 6 10.2 S9.6 9.6 9.6 8.7 V3.3" />
          <path d="M2.4 6 C2.4 6.9 4 7.5 6 7.5 S9.6 6.9 9.6 6" />
        </>
      )}
      {tone === "compute" && (
        <>
          <path d="M6 1.5 L9.9 3.75 V8.25 L6 10.5 L2.1 8.25 V3.75 Z" />
          <circle cx="6" cy="6" r="1.1" fill="currentColor" stroke="none" />
        </>
      )}
      {tone === "edge" && <path d="M1.9 2.9 V9.1 M4.2 6 H10.3 M7.9 3.6 L10.3 6 L7.9 8.4" />}
      {tone === "guard" && (
        <>
          <path d="M6 1.5 L9.7 2.9 V5.9 C9.7 8.1 8.2 9.7 6 10.5 C3.8 9.7 2.3 8.1 2.3 5.9 V2.9 Z" />
          <path d="M4.4 6 L5.6 7.2 L7.7 4.9" />
        </>
      )}
      {tone === "client" && (
        <>
          <circle cx="6" cy="4" r="2" />
          <path d="M2.3 10.3 C2.6 8.3 4.1 7.3 6 7.3 S9.4 8.3 9.7 10.3" />
        </>
      )}
      {tone === "plain" && <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="2" />}
    </svg>
  );
}

/** The semantics mark: a small graph whose hub is a four-point spark. */
export function SparkMark({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true">
      <path d="M7.6 7.7 L4.7 10.8 M10.7 8.2 L12.1 11.1 M5.4 12.1 L11.2 12.4" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" opacity=".8" />
      <path d="M9.5 1.9 Q9.95 5.05 13.1 5.5 Q9.95 5.95 9.5 9.1 Q9.05 5.95 5.9 5.5 Q9.05 5.05 9.5 1.9 Z" fill="currentColor" />
      <circle cx="3.8" cy="11.9" r="1.55" fill="currentColor" />
      <circle cx="12.6" cy="12.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* On-canvas badge                                                            */
/* ------------------------------------------------------------------------ */

const SIZE = 14;
const R = SIZE / 2;
const INSET = 3;
const MUTED = "#4f5d75";

function badgeColor(node: DiagramNode): string {
  const s = node.stroke;
  return s && s !== "none" && s !== "transparent" && !s.startsWith("url") ? s : MUTED;
}

export function SemanticBadge({ node, hovered }: { node: DiagramNode; hovered: boolean }) {
  const { url, role, text } = summarizeMeta(node.meta);
  const cx = node.x + node.w - R - INSET;
  const cy = node.y + R + INSET;
  const color = badgeColor(node);
  const stop = (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  const open = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };
  const tip = url ? `Open ${url}` : [role && titleCase(role), text].filter(Boolean).join(" — ") || "Has semantic notes";
  return (
    <g
      data-editor-only="1"
      data-semantic-badge={node.id}
      className={`node-sem-badge${url ? " link" : ""}${hovered ? " on" : ""}`}
      opacity={hovered ? 1 : 0.74}
      onPointerDown={url ? stop : undefined}
      onDoubleClick={url ? (e) => e.stopPropagation() : undefined}
      onClick={url ? open : undefined}
      style={{ cursor: url ? "pointer" : undefined, pointerEvents: url ? "all" : "none" }}
    >
      <title>{tip}</title>
      {/* soft contact shadow without an SVG filter (cheap on busy boards) */}
      <circle cx={cx} cy={cy + 1} r={R + 0.4} fill="#181836" opacity={0.13} />
      <circle className="nsb-disc" cx={cx} cy={cy} r={R} fill="#ffffff" stroke={color} strokeWidth={1} />
      {url ? (
        <path
          className="nsb-glyph"
          d={`M${cx - 2.2} ${cy + 2.2} L${cx + 2.2} ${cy - 2.2} M${cx - 1} ${cy - 2.3} H${cx + 2.3} V${cy + 1}`}
          fill="none"
          stroke={color}
          strokeWidth={1.3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <circle className="nsb-fill" cx={cx} cy={cy - 2.7} r={0.9} fill={color} />
          <path className="nsb-glyph" d={`M${cx} ${cy - 0.6} V${cy + 3}`} fill="none" stroke={color} strokeWidth={1.45} strokeLinecap="round" />
        </>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------------ */
/* Hover card                                                                 */
/* ------------------------------------------------------------------------ */

export interface SemanticTipContent {
  title?: string;
  role?: string;
  /** Quiet qualifier after the role, e.g. "inferred". */
  roleNote?: string;
  tech?: string;
  text?: string;
  /** Remaining key/value facts, display-ready. */
  extras?: Array<{ key: string; value: string }>;
  url?: string;
  /** Footer hint (how to act on the card's subject). */
  hint?: string;
}

type AnchorRect = Pick<DOMRect, "left" | "top" | "bottom" | "width">;

const TIP_HALF = 152; // half the card's max width + an 8px viewport margin
const TIP_CARET_MAX = 84;
const TIP_ROWS = 6;
const TIP_GUESS = 190; // card height assumed for the first (unmeasured) pass

function hostAndPath(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).replace(/\/$/, "");
    return { host: u.hostname.replace(/^www\./i, ""), path };
  } catch {
    return { host: url.replace(/^https?:\/\//i, ""), path: "" };
  }
}

/** The glass card itself, positioned against `rect` (viewport coords) and
 * portaled to <body>. Never interactive — it must not steal canvas pointers. */
export function SemanticTipCard({ content, rect }: { content: SemanticTipContent; rect: AnchorRect }) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Measured before paint, so a tall card flips under its anchor without a flash.
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0;
    if (h && h !== height) setHeight(h);
  });
  if (typeof document === "undefined") return null;
  const { title, role, roleNote, tech, text, url, hint } = content;
  const extras = content.extras ?? [];
  if (!title && !role && !tech && !text && !url && extras.length === 0) return null;
  const below = rect.top < (height || TIP_GUESS) + 18; // no room above → hang under the anchor
  const mid = rect.left + rect.width / 2;
  const vw = window.innerWidth;
  const left = vw > TIP_HALF * 2 ? Math.min(Math.max(TIP_HALF, mid), vw - TIP_HALF) : vw / 2;
  const caret = Math.min(Math.max(mid - left, -TIP_CARET_MAX), TIP_CARET_MAX);
  const style = { left, top: below ? rect.bottom + 10 : rect.top - 10, "--nst-caret": `${caret}px` } as CSSProperties;
  const tone = roleTone(role);
  const link = url ? hostAndPath(url) : null;
  return createPortal(
    <div ref={cardRef} className={`node-sem-tip${below ? " below" : ""}`} style={style} role="tooltip">
      {(title || role || tech) && (
        <div className="nst-head">
          {title && <div className="nst-title">{title}</div>}
          {(role || tech) && (
            <div className="nst-pills">
              {role && (
                <span className={`nst-pill role t-${tone}`}>
                  <RoleGlyph tone={tone} size={11} />
                  {titleCase(role)}
                  {roleNote && <i>{roleNote}</i>}
                </span>
              )}
              {tech && (
                <span className="nst-pill tech">
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4.3 3.4 L1.8 6 L4.3 8.6 M7.7 3.4 L10.2 6 L7.7 8.6" />
                  </svg>
                  {tech}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {text && <div className="nst-text">{text}</div>}
      {extras.length > 0 && (
        <dl className="nst-grid">
          {extras.slice(0, TIP_ROWS).map((e) => (
            <div key={e.key} className="nst-row">
              <dt>{e.key}</dt>
              <dd>{e.value}</dd>
            </div>
          ))}
          {extras.length > TIP_ROWS && <div className="nst-row more">+{extras.length - TIP_ROWS} more in the inspector</div>}
        </dl>
      )}
      {(link || hint) && (
        <div className="nst-foot">
          {link && (
            <span className="nst-url" title={url}>
              <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4.2 2.6 H9.4 V7.8 M9.2 2.8 L2.6 9.4" />
              </svg>
              <b>{link.host}</b>
              {link.path && <span>{link.path}</span>}
            </span>
          )}
          {hint && <span className="nst-hint">{hint}</span>}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Hover card for a node's semantics. `anchor` is the node's rendered shape
 * group — its screen rect positions the card (re-read on camera changes). */
export function SemanticTooltip({ node, anchor }: { node: DiagramNode; anchor: SVGGElement | null }) {
  // Subscribing to the camera re-positions the card while zooming/panning.
  useEditorStore((s) => s.cam);
  if (!anchor || typeof document === "undefined") return null;
  const { role, tech, text, url, extras } = summarizeMeta(node.meta);
  if (!role && !tech && !text && !url && extras.length === 0) return null;
  const label = (node.text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return (
    <SemanticTipCard
      rect={anchor.getBoundingClientRect()}
      content={{
        title: label.length > 64 ? `${label.slice(0, 63)}…` : label || undefined,
        role,
        tech,
        text,
        extras,
        url,
        hint: url ? "Click the badge to open" : undefined,
      }}
    />
  );
}
