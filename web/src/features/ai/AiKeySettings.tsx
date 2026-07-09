/**
 * features/ai/AiKeySettings — the client-side BYOK modal.
 *
 * The provider/key/model live ONLY in this browser's localStorage
 * ("noddle.aiKey") and ride each AI request as X-AI-* headers — the server
 * proxies the call and never stores the key (Excalidraw-style BYOK for an
 * account-less product).
 */
import { useState } from "react";
import {
  getAiKeyConfig,
  setAiKeyConfig,
  type AiKeyConfig,
  type AiProvider,
} from "../../shared/api/client";

const PROVIDERS: { value: AiProvider; label: string; keyHint: string }[] = [
  { value: "claude", label: "Anthropic (Claude)", keyHint: "sk-ant-…" },
  { value: "openai", label: "OpenAI", keyHint: "sk-…" },
  { value: "gemini", label: "Google Gemini", keyHint: "AIza…" },
  { value: "openrouter", label: "OpenRouter", keyHint: "sk-or-…" },
  { value: "custom", label: "Custom (OpenAI-compatible)", keyHint: "API key" },
];

export function AiKeySettings({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved?: (cfg: AiKeyConfig | null) => void;
}) {
  const existing = getAiKeyConfig();
  const [provider, setProvider] = useState<AiProvider>(existing?.provider ?? "claude");
  const [key, setKey] = useState(existing?.key ?? "");
  const [model, setModel] = useState(existing?.model ?? "");
  const [base, setBase] = useState(existing?.base ?? "");

  const canSave =
    !!key.trim() && (provider !== "custom" || !!base.trim());

  const save = () => {
    const cfg: AiKeyConfig = {
      provider,
      key: key.trim(),
      model: model.trim(),
      base: provider === "custom" ? base.trim() : "",
    };
    setAiKeyConfig(cfg);
    onSaved?.(cfg);
    onClose();
  };

  const remove = () => {
    setAiKeyConfig(null);
    onSaved?.(null);
    onClose();
  };

  const hint = PROVIDERS.find((p) => p.value === provider)?.keyHint ?? "API key";

  return (
    <div className="gen-overlay" onClick={onClose}>
      <div
        className="gen-modal"
        style={{ textAlign: "left", width: 440 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <div className="t" style={{ flex: 1, margin: 0 }}>Your AI key</div>
          <button className="props-close" onClick={onClose}>✕</button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 14px", lineHeight: 1.5 }}>
          Bring your own key: it stays in this browser and is sent only with
          your AI requests — the server never stores it.
        </p>

        <div className="prop-row" style={{ marginBottom: 10 }}>
          <span className="lbl">Provider</span>
          <select
            className="text-input"
            style={{ flex: 1 }}
            value={provider}
            onChange={(e) => setProvider(e.target.value as AiProvider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="prop-row" style={{ marginBottom: 10 }}>
          <span className="lbl">API key</span>
          <input
            className="text-input"
            style={{ flex: 1 }}
            type="password"
            placeholder={hint}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>

        <div className="prop-row" style={{ marginBottom: 10 }}>
          <span className="lbl">Model</span>
          <input
            className="text-input"
            style={{ flex: 1 }}
            placeholder="(provider default)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        {provider === "custom" && (
          <div className="prop-row" style={{ marginBottom: 10 }}>
            <span className="lbl">Base URL</span>
            <input
              className="text-input"
              style={{ flex: 1 }}
              placeholder="https://…/v1 (OpenAI-compatible)"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {existing && (
            <button className="btn" style={{ color: "var(--danger)" }} onClick={remove}>
              Remove key
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSave} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
