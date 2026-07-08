/**
 * shared/ui/Icon — a tiny inline-SVG icon set (Lucide-style: 24×24 viewBox,
 * 2px round stroke, `currentColor`). We render crisp line icons instead of the
 * old ambiguous unicode glyphs (⌂ ▦ ⇄ ◔ ▸ …) which fell back to ugly
 * emoji/box characters on some platforms. Size + color inherit from CSS
 * (font-size drives width/height via the `size` prop; `currentColor` follows
 * text color) so icons drop into existing spans without markup churn.
 */
import type { CSSProperties } from "react";

export type IconName =
  | "home"
  | "templates"
  | "shared"
  | "folder"
  | "folderOpen"
  | "chevronRight"
  | "chevronDown"
  | "plus"
  | "search"
  | "user"
  | "settings"
  | "logout"
  | "more"
  | "back"
  | "close"
  | "edit"
  | "trash"
  | "bell"
  | "download"
  | "save"
  | "share"
  | "game"
  | "sparkles";

// Each entry is the inner markup of a 24×24 icon (paths use stroke, not fill,
// unless noted). Kept minimal + consistent with a 2px round stroke.
const PATHS: Record<IconName, JSX.Element> = {
  home: (
    <path d="M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
  ),
  templates: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  shared: (
    <>
      <circle cx="18" cy="5" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="19" r="2.6" />
      <path d="M8.3 10.8 15.7 6.3M8.3 13.2l7.4 4.5" />
    </>
  ),
  folder: (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  folderOpen: (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H3zM3 9h18l-1.6 8.2a2 2 0 0 1-2 1.8H6.6a2 2 0 0 1-2-1.8z" />
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
    </>
  ),
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 12h9M16 8l3 4-3 4" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  edit: <path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17v3zM14 6l4 4" />,
  trash: <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />,
  bell: <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M9.5 20a2.5 2.5 0 0 0 5 0" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  save: <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v5h7V3M8 21v-7h8v7" />,
  share: (
    <>
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="6" r="2.6" />
      <circle cx="18" cy="18" r="2.6" />
      <path d="M8.3 10.9 15.7 7.1M8.3 13.1l7.4 3.8" />
    </>
  ),
  game: (
    <>
      <rect x="2" y="7" width="20" height="10" rx="5" />
      <path d="M7 11v2M6 12h2" />
      <circle cx="16" cy="11.5" r="0.6" fill="currentColor" />
      <circle cx="18" cy="13.5" r="0.6" fill="currentColor" />
    </>
  ),
  sparkles: (
    <path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  ),
};

/**
 * The NODDLE brand mark — canonical per BRAND.md §2 and synced with
 * the noddle brand mark: a SOLID warm-charcoal tile
 * (--color-logo-tile #211e19 — never a gradient), a white diamond (nib)
 * outline rotated 45°, and the Ember Orange dot (--color-ember #ea580c)
 * top-right. Drawn as real vector geometry so it never renders "broken" at
 * small sizes. Fills its `.brand-mark` box. Change the mark
 * first, then mirror here + web/public/{logo,favicon}.svg.
 */
export function BrandLogo({ size = "100%" }: { size?: number | string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} style={{ display: "block" }} aria-hidden="true">
      <rect x="0" y="0" width="32" height="32" rx="9" fill="#211e19" />
      {/* centered diamond (rotated rounded square outline) */}
      <rect
        x="10.4" y="10.4" width="11.2" height="11.2" rx="2.4"
        transform="rotate(45 16 16)"
        fill="none" stroke="#fff" strokeWidth="2.4"
      />
      {/* ember accent dot, top-right (the "spark on the nib") */}
      <circle cx="24" cy="8" r="3.6" fill="#ea580c" stroke="#211e19" strokeWidth="1.6" />
    </svg>
  );
}

export function Icon({
  name,
  size = "1em",
  strokeWidth = 2,
  className,
  style,
}: {
  name: IconName;
  size?: number | string;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  // sparkles reads best filled; the rest are line icons.
  const filled = name === "sparkles";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      style={{ display: "inline-block", verticalAlign: "-0.14em", flexShrink: 0, ...style }}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
