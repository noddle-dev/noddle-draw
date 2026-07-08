/**
 * HTML-escape untrusted values before they enter markup.
 *
 * Ported verbatim from `frontend/editor.js`. SECURITY INVARIANT: any value that
 * originates from an uploaded SVG (element ids, attribute values, tag names,
 * colours, opacity, …) MUST pass through `esc()` before being rendered into
 * text/JSX/markup — otherwise a crafted id or fill is a DOM-XSS sink in the
 * layers / properties panels. React auto-escapes children, but we still use
 * this for defense-in-depth and for any place we build strings by hand.
 */
const REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => REPLACEMENTS[c] ?? c);
