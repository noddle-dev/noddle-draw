/**
 * features/diagram/SemanticBadge — the quiet on-canvas hint that a node
 * carries semantic `meta` (role / description / tech / owner / url …).
 *
 *   • SemanticBadge — a 12px dot at the node's top-right corner, in the node's
 *     stroke colour at low opacity (full on hover). With a valid http(s)
 *     `meta.url` it becomes a link mark: click opens the URL in a new tab and
 *     the pointerdown never reaches NodeView (no select / drag).
 *   • SemanticTooltip — an HTML card portaled to <body> above (or below) the
 *     hovered node: role + tech pills, description/notes, extra key chips.
 *
 * BOTH are editor chrome: the badge carries data-editor-only="1" so the
 * SVG/PNG/GIF bake (editorStore.currentBoardSvg) and the offline MCP capture
 * (capture.tsx) strip it; the tooltip lives outside the SVG entirely. Pure
 * rules (what counts as meaningful, which nodes qualify) live in
 * editor-core/diagram/semantics.ts.
 */
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DiagramNode } from "../../editor-core/diagram";
import { summarizeMeta, titleCase } from "../../editor-core/diagram/semantics";
import { useEditorStore } from "../../state/editorStore";

const SIZE = 12;
const MUTED = "#4f5d75";

function badgeColor(node: DiagramNode): string {
  const s = node.stroke;
  return s && s !== "none" && s !== "transparent" && !s.startsWith("url") ? s : MUTED;
}

export function SemanticBadge({ node, hovered }: { node: DiagramNode; hovered: boolean }) {
  const { url, role, text } = summarizeMeta(node.meta);
  const x = node.x + node.w - SIZE - 4;
  const y = node.y + 4;
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
      className={`node-sem-badge${url ? " link" : ""}`}
      opacity={hovered ? 1 : 0.65}
      onPointerDown={url ? stop : undefined}
      onDoubleClick={url ? (e) => e.stopPropagation() : undefined}
      onClick={url ? open : undefined}
      style={{ cursor: url ? "pointer" : undefined, pointerEvents: url ? "all" : "none" }}
    >
      <title>{tip}</title>
      <rect x={x} y={y} width={SIZE} height={SIZE} rx={SIZE / 2} fill="#ffffff" stroke={color} strokeWidth={1} />
      {url ? (
        // tiny chain link
        <path
          d={`M${x + 4.6} ${y + 7.4} l2.8 -2.8 M${x + 5.6} ${y + 4.2} l.9 -.9 a1.4 1.4 0 0 1 2 2 l-.9 .9 M${x + 6.4} ${y + 7.8} l-.9 .9 a1.4 1.4 0 0 1 -2 -2 l.9 -.9`}
          fill="none"
          stroke={color}
          strokeWidth={1.1}
          strokeLinecap="round"
        />
      ) : (
        <>
          <circle cx={x + SIZE / 2} cy={y + 3.6} r={0.85} fill={color} />
          <path d={`M${x + SIZE / 2} ${y + 5.6} V${y + 9.2}`} stroke={color} strokeWidth={1.3} strokeLinecap="round" />
        </>
      )}
    </g>
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
  const r = anchor.getBoundingClientRect();
  const below = r.top < 150; // no room above → hang under the node
  const left = Math.min(Math.max(8, r.left + r.width / 2), window.innerWidth - 8);
  const style = below
    ? { left, top: r.bottom + 8 }
    : { left, top: r.top - 8 };
  return createPortal(
    <div className={`node-sem-tip${below ? " below" : ""}`} style={style} role="tooltip">
      {(role || tech) && (
        <div className="nst-pills">
          {role && <span className="nst-pill role">{role}</span>}
          {tech && <span className="nst-pill tech">{tech}</span>}
        </div>
      )}
      {text && <div className="nst-text">{text}</div>}
      {extras.length > 0 && (
        <div className="nst-extras">
          {extras.slice(0, 8).map((e) => (
            <span key={e.key} className="nst-kv">
              <b>{e.key}</b> {e.value}
            </span>
          ))}
          {extras.length > 8 && <span className="nst-kv more">+{extras.length - 8}</span>}
        </div>
      )}
      {url && (
        <div className="nst-url" title={url}>
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3.5 H12.5 V10 M12.3 3.7 L3.5 12.5" />
          </svg>
          {url.replace(/^https?:\/\//i, "")} · click the badge
        </div>
      )}
    </div>,
    document.body,
  );
}
