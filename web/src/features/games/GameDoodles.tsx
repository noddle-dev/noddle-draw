/**
 * GameDoodles — hand-drawn style inline SVG icons for the games UI.
 *
 * Per the repo rule (CLAUDE.md): no glossy 3D/emoji "AI-look" pictograms in
 * product UI — icons are sketchy strokes matching the board template previews
 * (round caps, wobbly paths, 2px stroke, template palette accents).
 */
import type { CSSProperties } from "react";

export type GameKind = "draw" | "trivia" | "wordbomb";
/** Extra hand-drawn glyphs used by the games hub chrome (headers, etc.). */
export type DoodleKind = GameKind | "trophy" | "live" | "controller";

interface Props {
  kind: DoodleKind;
  size?: number;
  /** Stroke color; defaults to the game's catalog accent. */
  accent?: string;
  style?: CSSProperties;
}

const DEFAULT_ACCENT: Record<DoodleKind, string> = {
  draw: "#2563eb",
  trivia: "#7c3aed",
  wordbomb: "#dc2626",
  trophy: "#d97706",
  live: "#16a34a",
  controller: "#2563eb",
};

export function GameDoodle({ kind, size = 24, accent, style }: Props) {
  const stroke = accent ?? DEFAULT_ACCENT[kind];
  const common = {
    fill: "none",
    stroke,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-0.18em", ...style }}
    >
      {kind === "draw" && (
        // pencil, slightly tilted, with a squiggle it just drew
        <g {...common}>
          <path d="M5.2 16.9 6 13.4 15.8 3.9c.9-.9 2.3-.8 3.1.1.8.9.9 2.1.1 3L9.3 16.3l-4.1 1z" />
          <path d="M14.6 5.2l3.1 3" />
          <path d="M4.4 21.2c2.1-1.3 4.2-1.1 6 .1 1.8 1.1 4-.2 5.8-.4" />
        </g>
      )}
      {kind === "trivia" && (
        // brain: two wobbly lobes + folds
        <g {...common}>
          <path d="M11.8 4.1c-1.9-1.4-4.8-.6-5.5 1.6-1.5.4-2.4 2-1.9 3.6-1 1.2-.8 3.1.4 4 .1 2 1.7 3.4 3.7 3.3.6 1.6 2.3 2.4 3.5 1.7" />
          <path d="M12.2 4.1c1.9-1.4 4.8-.6 5.5 1.6 1.5.4 2.4 2 1.9 3.6 1 1.2.8 3.1-.4 4-.1 2-1.7 3.4-3.7 3.3-.6 1.6-2.3 2.4-3.5 1.7" />
          <path d="M12 4v14.3" />
          <path d="M8.2 8.4c1.1.2 1.9 1 2.1 2.1M15.8 8.4c-1.1.2-1.9 1-2.1 2.1M8.6 13.5c.9-.3 1.9 0 2.5.7" />
        </g>
      )}
      {kind === "wordbomb" && (
        // round bomb with a curly fuse and a little spark
        <g {...common}>
          <path d="M10.9 8.2c-3.4.2-5.9 3-5.7 6.3.2 3.3 3 5.9 6.3 5.7 3.3-.2 5.9-3 5.7-6.3-.2-3.2-2.9-5.7-6.3-5.7z" />
          <path d="M13.2 8.6l1.6-2c.8-1 2-1.6 3.3-1.7" />
          <path d="M20.2 2.6l.9-.9M21.4 5.2l1.2-.3M19.7 1.2l-.2-1" transform="translate(-1 2)" />
        </g>
      )}
      {kind === "trophy" && (
        // wobbly cup + handles + little base
        <g {...common}>
          <path d="M7.2 4.3h9.6v3.4c0 2.7-2.1 4.9-4.8 4.9S7.2 10.4 7.2 7.7z" />
          <path d="M7.2 5.2c-1.9.2-2.7 1-2.6 2.3.1 1.2 1.1 2 2.9 1.9M16.8 5.2c1.9.2 2.7 1 2.6 2.3-.1 1.2-1.1 2-2.9 1.9" />
          <path d="M12 12.6v3.1M8.9 19.4c.4-2 1.6-3.2 3.1-3.6 1.5.4 2.7 1.6 3.1 3.6zM7.4 20.3h9.2" />
        </g>
      )}
      {kind === "live" && (
        // broadcast: dot with two sketchy signal arcs
        <g {...common}>
          <circle cx={12} cy={12} r={2.2} fill={stroke} stroke="none" />
          <path d="M8.4 8.4c-1.9 2-1.9 5.2 0 7.2M15.6 8.4c1.9 2 1.9 5.2 0 7.2" />
          <path d="M5.7 5.7c-3.3 3.4-3.3 9.2 0 12.6M18.3 5.7c3.3 3.4 3.3 9.2 0 12.6" />
        </g>
      )}
      {kind === "controller" && (
        // rounded gamepad with a d-pad + two buttons
        <g {...common}>
          <path d="M7.5 8.2h9c2 0 3.6 1.9 3.9 4.2l.4 3.1c.3 2-1.6 3.4-3.1 2.3l-2.1-1.6c-.5-.4-1.1-.6-1.7-.6H9.2c-.6 0-1.2.2-1.7.6l-2.1 1.6c-1.5 1.1-3.4-.3-3.1-2.3l.4-3.1c.3-2.3 1.9-4.2 3.9-4.2z" />
          <path d="M7.4 11.7v2.4M6.2 12.9h2.4" />
          <path d="M15.8 12.4h.01M17.6 14h.01" />
        </g>
      )}
    </svg>
  );
}
