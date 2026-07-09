/**
 * features/ai/BackendSelect — shows which key runs your AI calls (BYOK-only).
 *
 * The OSS build has exactly one AI backend: YOUR key, stored in this browser
 * (localStorage) and sent per-request as X-AI-* headers. This chip shows the
 * configured provider/model and opens the key modal.
 */
import { useEffect, useState } from "react";
import { getAiKeyConfig, type AiKeyConfig } from "../../shared/api/client";
import { poolInfo, poolInfoSync } from "../../shared/poolConfig";
import { AiKeySettings } from "./AiKeySettings";

export function BackendSelect({
  onChange,
}: {
  /** Notified when the key config changes (saved/removed). */
  onChange?: (cfg: AiKeyConfig | null) => void;
}) {
  const [keyCfg, setKeyCfg] = useState(getAiKeyConfig());
  const [modalOpen, setModalOpen] = useState(false);
  const [poolAi, setPoolAi] = useState(poolInfoSync()?.pool_ai ?? false);
  useEffect(() => {
    void poolInfo().then((i) => setPoolAi(i.pool_ai));
  }, []);

  return (
    <label className="ai-backend" title="Your browser-stored API key runs the AI (BYOK)">
      <span className="lbl">Run with</span>
      <span className="muted" style={{ fontSize: 12.5 }}>
        {keyCfg
          ? `Your ${keyCfg.provider} key${keyCfg.model ? ` · ${keyCfg.model}` : ""}`
          : poolAi
            ? "Free AI (shared, limited/day)"
            : "No API key yet"}
      </span>
      <button
        type="button"
        className="btn"
        style={{ marginLeft: 6 }}
        onClick={() => setModalOpen(true)}
      >
        {keyCfg ? "Edit key…" : "Add key…"}
      </button>
      {modalOpen && (
        <AiKeySettings
          onClose={() => setModalOpen(false)}
          onSaved={(cfg) => {
            setKeyCfg(cfg);
            onChange?.(cfg);
          }}
        />
      )}
    </label>
  );
}
