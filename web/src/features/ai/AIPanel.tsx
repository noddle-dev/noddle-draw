/**
 * features/ai/AIPanel — left-panel AI generation section (features #1 & #2).
 *
 * Two independent flows, each with its own loading/error state:
 *   1. Image → SVG:  upload an image → POST /api/ai/image-to-svg → the returned
 *      SVG string is loaded into the editable canvas via editorStore.loadSvgString.
 *   2. Text → diagram: free text or a Mermaid definition (optionally filled from
 *      a .md/.mmd file) → POST /api/ai/text-to-diagram → the returned nodes/edges
 *      are loaded via diagramStore.loadDiagram (which flips diagramMode on so the
 *      result renders as editable diagram objects).
 *
 * Untrusted strings (SVG markup, error messages) are only ever rendered as React
 * text / handed to the parser — never injected via innerHTML here.
 */
import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { api, type DiagramTextFormat } from "../../shared/api/client";
import { aiErrorMessage } from "../../shared/aiError";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";

function errText(err: unknown): string {
  return aiErrorMessage(err);
}

export function AIPanel() {
  const [open, setOpen] = useState(true);

  return (
    <div className="ai-panel">
      <h3>
        <button
          type="button"
          className="ai-collapse"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ai-caret">{open ? "▾" : "▸"}</span> AI
        </button>
      </h3>
      {open && (
        <div className="ai-body">
          <ImageToSvg />
          <TextToDiagram />
        </div>
      )}
    </div>
  );
}

/** Feature #1 — upload an image, convert to SVG, load into the editable canvas. */
function ImageToSvg() {
  const loadSvgString = useEditorStore((s) => s.loadSvgString);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
    setError(null);
  };

  const convert = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.imageToSvg(file);
      loadSvgString(res.svg);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-section">
      <div className="ai-title">Image → SVG</div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="ai-file"
        onChange={onPick}
        disabled={busy}
      />
      <button
        type="button"
        className="btn primary ai-btn"
        onClick={() => void convert()}
        disabled={!file || busy}
      >
        {busy ? "Converting…" : "Convert to SVG"}
      </button>
      {error && <p className="ai-error">{error}</p>}
    </div>
  );
}

/** Feature #2 — free text / Mermaid → diagram nodes+edges (flips diagram mode). */
function TextToDiagram() {
  const loadDiagram = useDiagramStore((s) => s.loadDiagram);
  const [text, setText] = useState("");
  const [format, setFormat] = useState<DiagramTextFormat>("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const content = await f.text();
      setText(content);
      // .mmd files are Mermaid; nudge the toggle accordingly.
      if (/\.mmd$/i.test(f.name)) setFormat("mermaid");
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
    // allow re-selecting the same file
    e.target.value = "";
  };

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.textToDiagram(text, format);
      loadDiagram(res.nodes, res.edges);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-section">
      <div className="ai-title">Text / flow → Diagram</div>
      <div className="ai-format" role="radiogroup" aria-label="Source format">
        <button
          type="button"
          className={`ai-toggle${format === "text" ? " active" : ""}`}
          aria-pressed={format === "text"}
          onClick={() => setFormat("text")}
          disabled={busy}
        >
          Text
        </button>
        <button
          type="button"
          className={`ai-toggle${format === "mermaid" ? " active" : ""}`}
          aria-pressed={format === "mermaid"}
          onClick={() => setFormat("mermaid")}
          disabled={busy}
        >
          Mermaid
        </button>
      </div>
      <textarea
        className="ai-textarea"
        rows={5}
        placeholder={
          format === "mermaid"
            ? "graph TD; A[Start] --> B{Decision} --> C[End]"
            : "Describe the flow, e.g.: User logs in → system authenticates → home page is shown"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <label className="ai-file-label">
        <span className="muted">Or load from a file (.md / .mmd):</span>
        <input
          type="file"
          accept=".md,.mmd,.markdown,text/markdown,text/plain"
          className="ai-file"
          onChange={(e) => void onFile(e)}
          disabled={busy}
        />
      </label>
      <button
        type="button"
        className="btn primary ai-btn"
        onClick={() => void generate()}
        disabled={!text.trim() || busy}
      >
        {busy ? "Generating diagram…" : "Generate diagram"}
      </button>
      {error && <p className="ai-error">{error}</p>}
    </div>
  );
}
