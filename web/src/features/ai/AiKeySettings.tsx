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
  api,
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

/** Where to create a key for each provider (opens in a new tab). */
const KEY_LINKS: Record<AiProvider, string> = {
  claude: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/settings/keys",
  custom: "",
};

/** One-click FREE presets — providers with a genuinely free key (no card). */
const FREE_PRESETS: {
  id: string;
  label: string;
  note: string;
  provider: AiProvider;
  model: string;
  base: string;
  link: string;
}[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    note: "free key in ~2 min, vision + best JSON",
    provider: "gemini",
    model: "gemini-2.5-flash",
    base: "",
    link: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq",
    // Groq deprecated the Llama-4 vision models (2026-06); GPT-OSS 120B is
    // their recommended free replacement — text + strong JSON, blazing fast.
    // (Vision → use the Gemini preset.) Model ids churn: if Test 404s, pick a
    // current one from console.groq.com/docs/models.
    note: "free, very fast (GPT-OSS 120B)",
    provider: "custom",
    model: "openai/gpt-oss-120b",
    base: "https://api.groq.com/openai/v1",
    link: "https://console.groq.com/keys",
  },
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const canSave =
    !!key.trim() && (provider !== "custom" || !!base.trim());

  const formConfig = (): AiKeyConfig => ({
    provider,
    key: key.trim(),
    model: model.trim(),
    base: provider === "custom" ? base.trim() : "",
  });

  // Fire the smallest possible chat at the provider to prove the CURRENT form
  // values work — before saving. The key rides the request headers only.
  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testAiKey(formConfig()));
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    const cfg = formConfig();
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
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px", lineHeight: 1.5 }}>
          Bring your own key: it stays in this browser and is sent only with
          your AI requests — the server never stores it.
        </p>

        {/* One-click free presets — turns BYOK from a barrier into 2 minutes. */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {FREE_PRESETS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="btn"
              style={{
                flex: 1, textAlign: "left", padding: "8px 10px", lineHeight: 1.35,
                borderColor: provider === f.provider && (f.base === "" || base === f.base)
                  ? "var(--purple)" : undefined,
              }}
              onClick={() => {
                setProvider(f.provider);
                setModel(f.model);
                setBase(f.base);
              }}
            >
              <span style={{ fontWeight: 650, display: "block" }}>⚡ {f.label}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{f.note}</span>
            </button>
          ))}
        </div>

        <div className="prop-row" style={{ marginBottom: 10 }}>
          <span className="lbl">Provider</span>
          <select
            className="text-input"
            style={{ flex: 1 }}
            value={provider}
            onChange={(e) => {
              // Switching provider clears a preset-filled model/base — sending
              // e.g. "openai/gpt-oss-120b" to OpenAI would just error.
              setProvider(e.target.value as AiProvider);
              setModel("");
              setBase("");
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="prop-row" style={{ marginBottom: 4 }}>
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
        {(() => {
          const link =
            provider === "custom"
              ? FREE_PRESETS.find((f) => f.base && f.base === base)?.link ?? ""
              : KEY_LINKS[provider];
          return link ? (
            <p style={{ fontSize: 12, margin: "0 0 10px", textAlign: "right" }}>
              <a href={link} target="_blank" rel="noreferrer">Get a free key ↗</a>
            </p>
          ) : (
            <div style={{ height: 10 }} />
          );
        })()}

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

        {testResult && (
          <p
            style={{
              fontSize: 12.5,
              margin: "10px 0 0",
              lineHeight: 1.45,
              color: testResult.ok ? "var(--ok, #16a34a)" : "var(--danger)",
            }}
          >
            {testResult.ok ? "✓ " : "✕ "}
            {testResult.message}
          </p>
        )}

        {/* Explain WHY Test/Save are disabled — otherwise a key-less form just
            looks broken (the buttons grey out with no reason given). */}
        {!canSave && (
          <p className="muted" style={{ fontSize: 12, margin: "12px 0 0", lineHeight: 1.45 }}>
            {provider === "custom" && !base.trim()
              ? "Add the base URL and your API key to test and save."
              : "Paste your API key to enable Test and Save — free keys take ~2 min via “Get a free key ↗”."}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {existing && (
            <button className="btn" style={{ color: "var(--danger)" }} onClick={remove}>
              Remove key
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            className="btn"
            disabled={!canSave || testing}
            title={canSave ? "Send a tiny test request to your provider" : "Enter your API key first"}
            onClick={() => void test()}
          >
            {testing ? "Testing…" : "Test"}
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!canSave}
            title={canSave ? "Save the key in this browser" : "Enter your API key first"}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
