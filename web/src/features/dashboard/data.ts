/**
 * features/dashboard/data — dashboard nav config + small display helpers.
 *
 * The "Recent" grid is REAL (editorStore.docs from GET /api/documents, see
 * HomeView). Former mock content (fake "Shared with me" rows, fake avatar
 * stacks, fake storage meter) has been REMOVED — the dashboard now shows only
 * real data or honest empty states.
 */
import type { DashPage } from "../../state/appStore";
import type { IconName } from "../../shared/ui";

export interface NavItem {
  key: DashPage;
  icon: IconName;
  label: string;
}

export const NAV: NavItem[] = [
  { key: "home", icon: "home", label: "Home" },
  { key: "templates", icon: "templates", label: "Templates" },
  { key: "shared", icon: "shared", label: "Shared with me" },
  { key: "games", icon: "game", label: "Team play" },
];

/** Accent per recent doc, rotated by index (purely visual). */
export const DOC_ACCENTS = ["#2563eb", "#7c3aed", "#16a34a", "#0891b2", "#d97706", "#dc2626"];

export function permStyle(perm: string): { border: string; color: string; bg: string } {
  switch (perm) {
    case "Can edit":
      return { border: "#cfe0ff", color: "#2563eb", bg: "#eef4ff" };
    case "Owner":
      return { border: "#e6d9ff", color: "#7c3aed", bg: "#f4f0ff" };
    default:
      return { border: "#e6e8ec", color: "#6b7280", bg: "#f7f8fa" };
  }
}

/** Relative "when" label from a unix (seconds) timestamp. */
export function relTime(sec: number): string {
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}
