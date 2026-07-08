/**
 * features/editor/data — presentation-only constants for the editor chrome:
 * presence avatars, colour swatches, diagram themes, chat suggestions. The
 * collaboration bits (presence/cursors/comments/chat) are mockup; the swatches
 * and themes drive REAL edits on the selected diagram node/edge.
 */
export interface Presence {
  i: string;
  name: string;
  bg: string;
  dot: string;
}

export const PRESENCE: Presence[] = [
  { i: "DK", name: "Deo Khoi (you)", bg: "#2563eb", dot: "#16a34a" },
  { i: "LT", name: "Linh Tran", bg: "#ec4899", dot: "#16a34a" },
  { i: "ML", name: "Minh Le", bg: "#d97706", dot: "#f59e0b" },
  { i: "✦", name: "Claude", bg: "#7c3aed", dot: "#16a34a" },
];

/** Fill swatches for a selected node (accent). */
export const FILL_SWATCHES = ["#eef4ff", "#f4f0ff", "#f0fdf4", "#fffbeb", "#fef2f2", "#ffffff"];
/** Stroke/border swatches. */
export const STROKE_SWATCHES = ["#2563eb", "#7c3aed", "#16a34a", "#d97706", "#dc2626", "#6b7280"];
/** Connector colour swatches. */
export const EDGE_SWATCHES = ["#475569", "#2563eb", "#7c3aed", "#16a34a", "#dc2626"];

export interface DiagramTheme {
  id: string;
  name: string;
  swatch: string;
  fill: string;
  stroke: string;
}

export const THEMES: DiagramTheme[] = [
  { id: "colorful", name: "Colorful", swatch: "linear-gradient(90deg,#2563eb,#7c3aed)", fill: "#eef4ff", stroke: "#2563eb" },
  { id: "mono", name: "Monochrome", swatch: "linear-gradient(90deg,#64748b,#334155)", fill: "#f1f5f9", stroke: "#334155" },
  { id: "forest", name: "Forest", swatch: "linear-gradient(90deg,#16a34a,#065f46)", fill: "#f0fdf4", stroke: "#16a34a" },
  { id: "sunset", name: "Sunset", swatch: "linear-gradient(90deg,#f59e0b,#dc2626)", fill: "#fffbeb", stroke: "#d97706" },
];

/** Quick prompts — each performs a REAL edit through /api/ai/edit-diagram. */
export const CHAT_SUGGESTIONS = [
  "Add an error-handling branch",
  "Tidy up the layout",
  "Add an end node",
];
