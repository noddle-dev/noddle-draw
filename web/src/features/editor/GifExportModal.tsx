/**
 * features/editor/GifExportModal — config + progress UI for animated GIF export.
 *
 * Duration options snap to multiples of the 0.6s marching-ants cycle so the
 * loop is seamless; the frame count and estimated output size preview update
 * live. Encoding runs chunked (UI stays responsive) with a progress bar.
 */
import { useState } from "react";
import { useEditorStore } from "../../state/editorStore";
import { exportAnimatedGif, GIF_DEFAULTS } from "./gif/exportGif";

const DURATIONS = [
  { ms: 600, label: "0.6s (1 cycle)" },
  { ms: 1200, label: "1.2s" },
  { ms: 2400, label: "2.4s" },
  { ms: 3600, label: "3.6s" },
];
const FPS_OPTS = [10, 15, 20, 25];
const SCALES = [
  { v: 0.5, label: "0.5×" },
  { v: 1, label: "1×" },
  { v: 2, label: "2×" },
];

export function GifExportModal({ onClose }: { onClose: () => void }) {
  const artboard = useEditorStore((s) => s.artboard);
  const docId = useEditorStore((s) => s.docId);
  const [durationMs, setDurationMs] = useState(GIF_DEFAULTS.durationMs);
  const [fps, setFps] = useState(GIF_DEFAULTS.fps);
  const [scale, setScale] = useState(GIF_DEFAULTS.scale);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const frames = Math.round((durationMs / 1000) * fps);
  const outW = Math.round(artboard.w * scale);
  const outH = Math.round(artboard.h * scale);
  const busy = progress !== null && progress < 1;

  const run = async () => {
    setError(null);
    setProgress(0);
    try {
      const blob = await exportAnimatedGif({ durationMs, fps, scale }, setProgress);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (docId || "board") + ".gif";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      useEditorStore
        .getState()
        .setStatus(`Exported GIF ${outW}×${outH} · ${frames} frames · ${(blob.size / 1024).toFixed(0)} KB.`, "ok");
      onClose();
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="gen-overlay" onClick={busy ? undefined : onClose}>
      <div className="gen-modal" style={{ textAlign: "left", width: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="t" style={{ marginBottom: 14 }}>⬒ Export Animated GIF</div>

        <div className="props-label">Duration (seamless loop on a 0.6s cycle)</div>
        <div className="seg" style={{ marginBottom: 14 }}>
          {DURATIONS.map((d) => (
            <button key={d.ms} className={durationMs === d.ms ? "active" : ""} disabled={busy} onClick={() => setDurationMs(d.ms)}>
              {d.label}
            </button>
          ))}
        </div>

        <div className="props-label">Frame rate</div>
        <div className="seg" style={{ marginBottom: 14 }}>
          {FPS_OPTS.map((f) => (
            <button key={f} className={fps === f ? "active" : ""} disabled={busy} onClick={() => setFps(f)}>
              {f} fps
            </button>
          ))}
        </div>

        <div className="props-label">Scale</div>
        <div className="seg" style={{ marginBottom: 14 }}>
          {SCALES.map((s) => (
            <button key={s.v} className={scale === s.v ? "active" : ""} disabled={busy} onClick={() => setScale(s.v)}>
              {s.label}
            </button>
          ))}
        </div>

        <p className="muted" style={{ fontSize: 12, margin: "0 0 14px" }}>
          {outW}×{outH} px · {frames} frames · connectors with <b>Animated</b> turned on will run marching-ants in the GIF.
        </p>

        {progress !== null && (
          <div className="gen-progress" style={{ marginBottom: 14 }}>
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {error && <p style={{ color: "var(--danger)", fontSize: 12.5, margin: "0 0 12px" }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-grad" disabled={busy} onClick={() => void run()}>
            {busy ? `Rendering… ${Math.round((progress ?? 0) * 100)}%` : "Export GIF"}
          </button>
        </div>
      </div>
    </div>
  );
}
