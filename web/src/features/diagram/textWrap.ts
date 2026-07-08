/**
 * features/diagram/textWrap — split a node label into rendered lines.
 *
 * Explicit \n breaks are ALWAYS honored (Enter in the inline editor). When
 * `node.wrap` is on, each paragraph is additionally greedy word-wrapped to the
 * shape's inner width using real canvas text measurement, so the result
 * matches what SVG renders (approximation-by-char-count drifted badly on
 * mixed-width scripts). Lives in features/ (not editor-core) because it needs
 * the DOM canvas.
 */
import type { DiagramNode } from "../../editor-core/diagram";

const PAD = 8; // matches NodeView's TEXT_PAD
let ctx: CanvasRenderingContext2D | null = null;

function measure(text: string, font: string): number {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 8; // canvas unavailable — rough fallback
  ctx.font = font;
  return ctx.measureText(text).width;
}

export function nodeFont(node: DiagramNode): string {
  const size = node.fontSize ?? 14;
  const weight = node.bold ? "700 " : "";
  const style = node.italic ? "italic " : "";
  const family = node.sketch
    ? '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive'
    : "ui-sans-serif, system-ui, sans-serif";
  return `${style}${weight}${size}px ${family}`;
}

/** The label as display lines: \n splits always; word-wrap when node.wrap. */
export function labelLines(node: DiagramNode): string[] {
  const paragraphs = (node.text ?? "").split("\n");
  if (!node.wrap) return paragraphs;
  const maxW = Math.max(24, node.w - PAD * 2);
  const font = nodeFont(node);
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      if (measure(`${line} ${word}`, font) <= maxW) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** True when any line of the label paints wider than the shape's inner width
 * (drives the "text overflows — turn on wrap?" affordance). */
export function labelOverflows(node: DiagramNode): boolean {
  const maxW = Math.max(24, node.w - PAD * 2);
  const font = nodeFont(node);
  return (node.text ?? "")
    .split("\n")
    .some((line) => measure(line, font) > maxW);
}
