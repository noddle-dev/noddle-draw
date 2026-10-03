/**
 * features/editor/chatMarkdown — minimal markdown-lite renderer for AI chat
 * bubbles (ask-mode answers especially: bullets, bold, code). Deliberately
 * tiny and dependency-free (repo ethos — no `marked`/`react-markdown`), and it
 * builds pure React nodes — never innerHTML — so model output cannot inject
 * markup. Supported (exactly what the co-editor/ask prompts produce):
 *   ``` fenced code blocks ```, "- " / "• " / "* " bullet groups,
 *   "1." numbered groups, #/##/### headings, **bold**, `inline code`,
 *   and plain paragraphs with preserved line breaks.
 */
import type { ReactNode } from "react";

/** Inline spans: **bold** and `code` inside one line of text. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter((p) => p !== "")
    .map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
        return <strong key={i}>{p.slice(2, -2)}</strong>;
      }
      if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
        return <code key={i}>{p.slice(1, -1)}</code>;
      }
      return p;
    });
}

const BULLET = /^\s*[-•*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

/** Lines of one non-code segment → paragraphs / lists / headings. */
function blocks(text: string, keyBase: number): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = keyBase;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push(<div key={key++} className="cm-h">{inline(h[2])}</div>);
      i += 1;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const re = ordered ? NUMBERED : BULLET;
      const items: ReactNode[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(<li key={items.length}>{inline(re.exec(lines[i])![1])}</li>);
        i += 1;
      }
      out.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    // paragraph: consecutive plain lines, soft-wrapped with <br/>
    const para: ReactNode[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !HEADING.test(lines[i])
    ) {
      if (para.length) para.push(<br key={`b${para.length}`} />);
      para.push(...inline(lines[i]));
      i += 1;
    }
    out.push(<p key={key++}>{para}</p>);
  }
  return out;
}

export function ChatMarkdown({ text }: { text: string }) {
  // ``` fences first — everything between them renders verbatim in a <pre>.
  const segments = text.split(/```(?:[a-z0-9]*\n)?/i);
  const nodes: ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      nodes.push(<pre key={`f${i}`}>{seg.replace(/\n$/, "")}</pre>);
    } else if (seg.trim() !== "") {
      nodes.push(...blocks(seg, i * 1000));
    }
  });
  return <div className="chat-md">{nodes}</div>;
}
