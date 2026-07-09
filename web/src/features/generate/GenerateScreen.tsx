/**
 * features/generate/GenerateScreen — the "New with AI" flow.
 *
 * REAL AI wiring (no mock):
 *   • text / mermaid → POST /api/ai/text-to-diagram → diagramStore.loadDiagram
 *     (store-based, so it's applied before the editor even mounts).
 *   • sketch (image) → POST /api/ai/image-to-svg → queued as pending SVG and
 *     loaded once the editor canvas mounts (openSvgInEditor).
 *
 * The stepped "Claude is drawing…" overlay is cosmetic progress over the real
 * awaited request. Errors (e.g. 503 when Databricks isn't configured) surface
 * inline with the server's message.
 */
import { useEffect, useRef, useState } from "react";
import { BrandLogo } from "../../shared/ui";
import { api } from "../../shared/api/client";
import { aiErrorMessage } from "../../shared/aiError";
import { useAppStore } from "../../state/appStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useJobsStore } from "../../state/jobsStore";
import { BackendSelect } from "../ai/BackendSelect";

const EXAMPLES = [
  "A user logs in, the system verifies credentials against auth, then loads their dashboard.",
  "Payment authorization flow: validate card, run fraud check, authorize, write to ledger.",
  "KYC onboarding: submit ID, OCR extract, manual review if low confidence, approve.",
  "Incident response: alert fires, on-call triages, mitigate, post-mortem.",
];

const SKETCH_STYLES = ["Corporate", "Hand-drawn", "Minimal", "Colorful"];

const STEP_LABELS = [
  "Reading your prompt…",
  "Planning the layout…",
  "Drawing shapes…",
  "Connecting the flow…",
];

function errText(err: unknown): string {
  return aiErrorMessage(err);
}

export function GenerateScreen() {
  const genMode = useAppStore((s) => s.genMode);
  const seedPrompt = useAppStore((s) => s.seedPrompt);
  const setGenMode = useAppStore((s) => s.setGenMode);
  const loadDiagram = useDiagramStore((s) => s.loadDiagram);

  const [prompt, setPrompt] = useState(seedPrompt);
  const [sketchStyle, setSketchStyle] = useState(SKETCH_STYLES[0]);
  const [sketchPrompt, setSketchPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setPrompt(seedPrompt), [seedPrompt]);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const beginProgress = (total: number) => {
    useAppStore.getState().startGenerating(total);
    let i = 0;
    timerRef.current = setInterval(() => {
      i = Math.min(i + 1, total - 1);
      useAppStore.getState().setGenStep(i);
    }, 700);
  };
  const endProgress = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    useAppStore.getState().stopGenerating();
  };

  const generateDiagram = async () => {
    if (!prompt.trim()) return;
    setError(null);
    beginProgress(4);
    try {
      const res = await api.textToDiagram(prompt, genMode === "mermaid" ? "mermaid" : "text");
      // Persist as a REAL document so the board gets a shareable /d/{id} URL
      // (and a live-collab room) from the very first moment.
      const name = prompt.trim().slice(0, 60) || "AI diagram";
      const meta = await api.create({
        name,
        diagram: { nodes: res.nodes, edges: res.edges },
      });
      loadDiagram(res.nodes, res.edges);
      endProgress();
      useAppStore.getState().openInEditor(meta.id);
    } catch (err) {
      endProgress();
      setError(errText(err));
    }
  };

  // Image conversions run in the BACKGROUND job queue (JobsTray) — picking a
  // file never locks the app; the enrichment prompt rides along with it.
  const onSketchFile = (file: File) => {
    setError(null);
    useJobsStore.getState().enqueueImageJob(file, sketchPrompt);
  };

  return (
    <div className="gen">
      <div className="gen-topbar">
        <button className="gen-logo" onClick={() => useAppStore.getState().bootHome()}>
          <span className="brand-mark"><BrandLogo /></span> NODDLE
        </button>
        <span className="crumb-sep">/</span>
        <span className="crumb-txt">New diagram</span>
        <div className="spacer" />
        <button className="btn" onClick={() => useAppStore.getState().bootHome()}>Cancel</button>
      </div>

      <div className="gen-scroll">
        <div className="gen-inner">
          <div className="gen-hero">
            <div className="mark">✦</div>
            <h1>What do you want to diagram?</h1>
            <p>AI-Noddle drafts it in seconds — you refine it together on the canvas.</p>
          </div>

          <div className="gen-tabs">
            <button className={`gen-tab${genMode === "text" ? " active" : ""}`} onClick={() => setGenMode("text")}>✎ Describe in text</button>
            <button className={`gen-tab${genMode === "sketch" ? " active" : ""}`} onClick={() => setGenMode("sketch")}>◲ Upload a sketch</button>
            <button className={`gen-tab${genMode === "mermaid" ? " active" : ""}`} onClick={() => setGenMode("mermaid")}>{"{ }"} From code</button>
          </div>

          {genMode === "text" && (
            <div>
              <div className="gen-card">
                <textarea
                  className="gen-textarea"
                  placeholder={"Describe your diagram in plain language…\ne.g. A user logs in, the system verifies credentials against auth, then loads their dashboard."}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="gen-card-foot">
                  <div className="hints"><span>◫ Auto-layout</span><span>⇄ Smart connectors</span></div>
                  <button className="btn btn-grad" disabled={!prompt.trim()} onClick={() => void generateDiagram()}>✦ Generate diagram</button>
                </div>
              </div>
              <div className="gen-examples">
                <div className="lbl">Try an example</div>
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="example" onClick={() => setPrompt(ex)}>
                    <span className="spark">✦</span>
                    <span style={{ flex: 1 }}>{ex}</span>
                    <span className="arr">→</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {genMode === "mermaid" && (
            <div className="gen-card">
              <textarea
                className="gen-textarea mono"
                placeholder={"graph TD;\n  A[User] --> B{Auth?};\n  B -->|yes| C[Dashboard];\n  B -->|no| D[Login];"}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="gen-card-foot" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-grad" disabled={!prompt.trim()} onClick={() => void generateDiagram()}>✦ Render diagram</button>
              </div>
            </div>
          )}

          {genMode === "sketch" && (
            <div>
              <div className="gen-card" style={{ marginBottom: 14 }}>
                <div className="props-label">Enrichment prompt (optional)</div>
                <textarea
                  className="gen-textarea"
                  style={{ minHeight: 64 }}
                  placeholder={"Add details for the AI to redraw it more beautifully…\ne.g.: use a blue color palette, rounded corners, add labels, left→right layout, group by infrastructure tier"}
                  value={sketchPrompt}
                  onChange={(e) => setSketchPrompt(e.target.value)}
                />
                <div className="gen-card-foot">
                  <BackendSelect />
                </div>
              </div>
              <div className="dropzone">
                <div className="ic">◲</div>
                <div className="t">Drop your sketch here</div>
                <div className="d">
                  Whiteboard, drafts, old wireframes — PNG/JPG. Runs <b>in a background queue</b>:
                  once picked, keep working (even reload) — progress &amp; history live in the
                  “✦ Image → board” tray at the bottom right.
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    for (const f of Array.from(e.target.files ?? [])) onSketchFile(f);
                    e.target.value = "";
                  }}
                />
                <button className="btn btn-grad" onClick={() => fileRef.current?.click()}>
                  ✦ Choose images (multiple images queue up)
                </button>
                <div style={{ marginTop: 22, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  {SKETCH_STYLES.map((sty) => (
                    <button
                      key={sty}
                      className={`chip${sketchStyle === sty ? " active" : ""}`}
                      onClick={() => {
                        setSketchStyle(sty);
                        setSketchPrompt((p) => (p.includes("Style:") ? p : `Style: ${sty}. ${p}`));
                      }}
                    >
                      {sty}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {error && (
            <p style={{ marginTop: 18, color: "var(--danger)", fontSize: 13, lineHeight: 1.5, textAlign: "center" }}>
              {error}
            </p>
          )}
        </div>
      </div>

      <GenerateOverlay />
    </div>
  );
}

function GenerateOverlay() {
  const generating = useAppStore((s) => s.generating);
  const genStep = useAppStore((s) => s.genStep);
  const genTotal = useAppStore((s) => s.genTotal);
  if (!generating) return null;
  const pct = Math.round(((genStep + 1) / genTotal) * 100);
  return (
    <div className="gen-overlay">
      <div className="gen-modal">
        <div className="sp" />
        <div className="t">✦ AI-Noddle is drawing…</div>
        <div className="d">{STEP_LABELS[genStep] ?? "Finishing up…"}</div>
        <div className="gen-progress"><span style={{ width: `${pct}%` }} /></div>
      </div>
    </div>
  );
}
