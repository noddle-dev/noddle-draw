/**
 * shared/svgScrub — a minimal client-side SVG scrubber.
 *
 * The server's `svg_sanitizer.py` is the real whitelist and every stored/served
 * SVG passes through it. This exists ONLY for the offline upload fallback
 * (backend unreachable → open a local file), where raw file text would
 * otherwise be injected straight into the live DOM. Without it, an
 * attacker-supplied .svg opened offline could run script in noddle's origin and
 * read the BYOK key from localStorage. Deny-list of the active vectors:
 * <script>/<foreignObject>, on* handlers, and javascript: URLs.
 */
const ACTIVE_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed", "audio", "video"]);

export function scrubSvgString(svg: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  } catch {
    return ""; // unparseable → refuse rather than inject
  }
  if (doc.querySelector("parsererror")) return "";

  const walk = (el: Element) => {
    // children first (snapshot — we mutate as we go)
    for (const child of Array.from(el.children)) walk(child);

    if (ACTIVE_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      const isUrlAttr = name === "href" || name === "xlink:href" || name === "src";
      if (
        name.startsWith("on") ||
        (isUrlAttr && val.startsWith("javascript:")) ||
        // allow data:image/* (inert in <image>) but drop other data: URLs
        (isUrlAttr && val.startsWith("data:") && !val.startsWith("data:image/"))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  };
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return "";
  walk(root);
  return new XMLSerializer().serializeToString(root);
}
