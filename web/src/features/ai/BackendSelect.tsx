/**
 * features/ai/BackendSelect — which AI backend runs your calls.
 *
 * BYOK is client-side: "Your API key" (localStorage, sent per-request as
 * X-AI-* headers) or "Server AI" (the shared pool — only offered when the
 * server reports one via GET /api/config → pool_ai). A "Configure…" button
 * opens the key modal.
 */
import { useEffect, useState } from "react";
import {
  api,
  getAiBackend,
  getAiKeyConfig,
  setAiBackend,
  type AiBackendChoice,
} from "../../shared/api/client";
import { AiKeySettings } from "./AiKeySettings";

export function BackendSelect({
  onChange,
}: {
  /** Notified when the effective backend changes (key saved/removed, pick). */
  onChange?: (v: AiBackendChoice) => void;
}) {
  const [choice, setChoice] = useState<AiBackendChoice>(getAiBackend());
  const [poolAi, setPoolAi] = useState(false);
  const [keyCfg, setKeyCfg] = useState(getAiKeyConfig());
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getConfig()
      .then((c) => {
        if (live) setPoolAi(c.pool_ai);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const pick = (v: AiBackendChoice) => {
    setChoice(v);
    setAiBackend(v);
    onChange?.(v);
  };

  return (
    <label className="ai-backend" title="Which AI backend runs your calls">
      <span className="lbl">Run with</span>
      <select
        value={keyCfg ? choice : poolAi ? "pool" : "key"}
        onChange={(e) => pick(e.target.value as AiBackendChoice)}
      >
        <option value="key">
          {keyCfg
            ? `Your ${keyCfg.provider} key${keyCfg.model ? ` · ${keyCfg.model}` : ""}`
            : "Your API key (not set)"}
        </option>
        {poolAi && <option value="pool">Server AI (shared)</option>}
      </select>
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
            pick(cfg ? "key" : poolAi ? "pool" : "key");
          }}
        />
      )}
    </label>
  );
}
