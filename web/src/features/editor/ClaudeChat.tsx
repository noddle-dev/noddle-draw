/**
 * features/editor/ClaudeChat — the right-panel "Claude" tab: a REAL live
 * co-editor with PER-BOARD, MULTI-SESSION conversations + token cost tracking.
 *
 * Each board owns several sessions (auto-init on first message; "＋" starts a
 * fresh one with a clean context). The header shows a session picker and the
 * active session's accumulated token usage. Every message applies to the board
 * via /api/ai/edit-diagram (see claudeEdit.ts) and syncs to collaborators.
 */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { chatKey, useAppStore } from "../../state/appStore";
import type { ChatMessage } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { getAiKeyConfig } from "../../shared/api/client";
import { poolInfo, poolInfoSync } from "../../shared/poolConfig";
import { getIdentity } from "../../state/collabStore";
import { AiKeySettings } from "../ai/AiKeySettings";
import { askClaudeEdit } from "./claudeEdit";
import { CHAT_SUGGESTIONS } from "./data";

const WELCOME: ChatMessage = {
  who: "ai" as const,
  text: "I'm the co-editor for this board — message me and I'll edit it directly: add/remove nodes, connect arrows, change colors, animation, grouping… Attach an image (📎) to say things like \"recreate this screenshot\" or \"match these colors\". Each session has its own context.",
};

// --- reference-image attach helpers ------------------------------------------
// Downscale to ≤ MAX_DIM on the longest side and keep the data URL under the
// backend's ~1.5MB wire cap (falling back to JPEG when a PNG is still too big).
const MAX_DIM = 1400;
const MAX_LEN = 2_100_000; // mirrors CHAT_IMAGE_MAX_LEN on the backend
const ALLOWED_TYPES = /^image\/(png|jpeg|webp)$/;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that image."));
    r.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Invalid image."));
    img.src = url;
  });
}

/** Read → downscale → (re-encode if needed) into a wire-safe data URL. */
async function prepareImage(file: File): Promise<string> {
  const raw = await fileToDataUrl(file);
  const img = await loadImage(raw);
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const draw = (mime: string, quality?: number): string => {
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL(mime, quality);
  };

  let url = scale < 1 ? draw("image/png") : raw;
  if (url.length > MAX_LEN) url = draw("image/jpeg", 0.85); // shrink to fit the cap
  if (url.length > MAX_LEN) {
    throw new Error("Image is too large even after resizing — try a smaller one.");
  }
  return url;
}

export function ClaudeChat() {
  const docId = useEditorStore((s) => s.docId);
  const board = useAppStore((s) => s.chats[chatKey(docId)]);
  const aiThinking = useAppStore((s) => s.aiThinking);
  const queuedChats = useAppStore((s) => s.queuedChats);
  const newChatSession = useAppStore((s) => s.newChatSession);
  const switchChatSession = useAppStore((s) => s.switchChatSession);
  const [image, setImage] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Client-side BYOK — the ONLY backend in the OSS build: the model comes
  // from the browser-stored key config (X-AI-* headers).
  const [keyCfg, setKeyCfg] = useState(getAiKeyConfig());
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [poolAi, setPoolAi] = useState(poolInfoSync()?.pool_ai ?? false);
  useEffect(() => {
    void poolInfo().then((i) => setPoolAi(i.pool_ai));
  }, []);

  const sessions = board?.sessions ?? [];
  const active = sessions.find((s) => s.id === board?.activeId);
  const messages = active?.messages ?? [];
  const usage = active?.usage;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, aiThinking]);


  /** Send a message. No arg → read the textarea (uncontrolled — see below).
   * BYOK gate: without a key, chatting can only fail — open the key modal
   * instead and KEEP the draft so it sends after configuring. */
  const send = (text?: string) => {
    const el = inputRef.current;
    const t = (text ?? el?.value ?? "").trim();
    if (!t) return;
    if (!getAiKeyConfig() && !(poolInfoSync()?.pool_ai)) {
      setKeyModalOpen(true);
      return;
    }
    if (text === undefined && el) {
      el.value = "";
      // collapse the auto-grown textarea on EVERY send path (the ↑ button
      // used to leave it stuck tall, stretching send/attach into giant blocks)
      el.style.height = "auto";
    }
    askClaudeEdit(t, image ?? undefined); // enqueued — never locks
    setImage(null);
    setImgErr(null);
  };

  /** Paste an image straight into the chat (⌘V on macOS, Ctrl+V on Windows/
   * Linux) — same downscale/cap pipeline as the 📎 picker. Text pastes are
   * untouched. */
  const onPaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => ALLOWED_TYPES.test(i.type));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    setImgErr(null);
    void prepareImage(file)
      .then((url) => {
        setImage(url);
        // Attaching an image IS an AI intent — without a key it can only
        // fail at send, so prompt for the key now (the image stays attached).
        if (!getAiKeyConfig()) setKeyModalOpen(true);
      })
      .catch((err) => setImgErr(err instanceof Error ? err.message : "Couldn't read that image."));
  };
  const modKey = /mac/i.test(navigator.platform) ? "\u2318" : "Ctrl";
  // Your avatar initials come from the browser identity (renameable in Share).
  const myInitials = getIdentity().name.replace(/^Guest-/, "").slice(0, 2).toUpperCase() || "ME";

  const onPickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (!ALLOWED_TYPES.test(file.type)) {
      setImgErr("Only PNG, JPEG or WebP images.");
      return;
    }
    setImgErr(null);
    try {
      setImage(await prepareImage(file));
      if (!getAiKeyConfig()) setKeyModalOpen(true); // see onPaste
    } catch (err) {
      setImgErr(err instanceof Error ? err.message : "Couldn't read that image.");
    }
  };

  return (
    <div className="chat">
      {/* session bar + cost */}
      <div className="chat-sessions">
        {/* Session tabs only once a session exists — a lone dangling "＋"
            above the model row read as broken UI. */}
        <div className="chat-session-tabs" style={sessions.length === 0 ? { display: "none" } : undefined}>
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`chat-session-tab${s.id === board?.activeId ? " active" : ""}`}
              onClick={() => switchChatSession(docId, s.id)}
              title={`${s.usage.calls} calls · ${s.usage.prompt + s.usage.completion} tokens`}
            >
              {s.title}
            </button>
          ))}
          <button className="chat-session-new" title="New session (clean context)" onClick={() => newChatSession(docId)}>＋</button>
        </div>
        <div className="chat-key-row">
          <button
            type="button"
            className={`chat-key-chip${keyCfg || poolAi ? "" : " unset"}`}
            onClick={() => setKeyModalOpen(true)}
            title={
              keyCfg
                ? "Your key runs this chat (BYOK, stays in this browser) — click to edit"
                : "Add your AI key to start chatting (BYOK — stays in this browser)"
            }
          >
            <span className="dot" />
            {keyCfg ? (
              <>
                <span className="prov">{keyCfg.provider}</span>
                <span className="mod">{keyCfg.model || "default model"}</span>
                <span className="edit">Edit</span>
              </>
            ) : poolAi ? (
              <>
                <span className="prov">Free AI</span>
                <span className="mod">shared, limited/day</span>
                <span className="edit">Use my key</span>
              </>
            ) : (
              <>
                <span className="prov">Add your AI key</span>
                <span className="edit">Set up</span>
              </>
            )}
          </button>
          {keyModalOpen && (
            <AiKeySettings
              onClose={() => setKeyModalOpen(false)}
              onSaved={setKeyCfg}
            />
          )}
        </div>
        {usage && usage.calls > 0 && (
          <div className="chat-cost" title="Tokens used in this session">
            ⛃ {usage.calls} calls · {(usage.prompt + usage.completion).toLocaleString()} tokens
            <span className="muted"> ({usage.prompt.toLocaleString()}↑ / {usage.completion.toLocaleString()}↓)</span>
          </div>
        )}
      </div>

      <div className="chat-log" ref={logRef}>
        {[WELCOME, ...messages].map((m, i) => (
          <div key={i} className={`chat-msg${m.who === "you" ? " you" : ""}`}>
            <span className={`chat-ava ${m.who === "you" ? "you" : "ai"}`}>{m.who === "you" ? myInitials : "✦"}</span>
            <div className={`chat-bubble ${m.who === "you" ? "you" : "ai"}`}>
              {m.image && <img className="chat-msg-thumb" src={m.image} alt="attached reference" />}
              {m.text}
            </div>
          </div>
        ))}
        {aiThinking && (
          <div className="chat-msg">
            <span className="chat-ava ai">✦</span>
            <div className="chat-typing"><span /><span /><span /></div>
            {queuedChats > 0 && (
              <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>{queuedChats} messages queued</span>
            )}
          </div>
        )}
      </div>
      <div className="chat-foot">
        <div className="chat-suggest">
          {CHAT_SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => send(s)}>{s}</button>
          ))}
        </div>
        {(image || imgErr) && (
          <div className="chat-attach-preview">
            {image && (
              <span className="chat-attach-chip">
                <img src={image} alt="attachment preview" />
                <button className="chat-attach-remove" title="Remove image" onClick={() => setImage(null)}>✕</button>
              </span>
            )}
            {imgErr && <span className="chat-attach-err">{imgErr}</span>}
          </div>
        )}
        <div className="chat-input-row">
          <button
            className="chat-attach"
            title="Attach a reference image (PNG/JPEG/WebP)"
            onClick={() => fileRef.current?.click()}
          >
            {/* hand-drawn paperclip (no AI-look icons) */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20.4 11.5l-8 8a5 5 0 0 1-7-7l8.2-8.1a3.2 3.2 0 0 1 4.6 4.6l-8.2 8.1a1.4 1.4 0 0 1-2-2l7.5-7.4" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={onPickImage}
          />
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={1}
            // UNCONTROLLED on purpose: a controlled value + IME composition
            // (Vietnamese Telex…) + store-driven re-renders duplicated the
            // last typed character when editing mid-text. The value is read
            // imperatively in send().
            defaultValue=""
            // Keep the placeholder SHORT — a wrapping placeholder overflows
            // the 1-row box (text clipped mid-line under the border).
            placeholder={aiThinking ? "Keep typing — messages queue up…" : "Ask AI-Noddle to edit the diagram…"}
            // auto-grow up to the CSS max-height, then scroll
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 160) + "px";
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="chat-send" title="Send (Enter)" onClick={() => send()}>↑</button>
        </div>
        <div className="chat-hint">
          <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> new line ·{" "}
          <kbd>{modKey}+V</kbd> paste an image
        </div>
      </div>
    </div>
  );
}
