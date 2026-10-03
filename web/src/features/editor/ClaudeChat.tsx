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
import { useEditorStore } from "../../state/editorStore";
import { getAiKeyConfig } from "../../shared/api/client";
import { poolInfo, poolInfoSync } from "../../shared/poolConfig";
import { getIdentity } from "../../state/collabStore";
import { AiKeySettings } from "../ai/AiKeySettings";
import { useAiCheckpoints } from "./aiCheckpoints";
import { ChatMarkdown } from "./chatMarkdown";
import { ALLOWED_TYPES, prepareImage } from "./imageAttach";
import { askClaudeEdit, rollbackAiEdit } from "./claudeEdit";
import { ASK_SUGGESTIONS, CHAT_SUGGESTIONS } from "./data";

/** Short provider names for the composer's key chip. */
const PROVIDER_SHORT: Record<string, string> = {
  claude: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  custom: "Custom",
};

export function ClaudeChat() {
  const docId = useEditorStore((s) => s.docId);
  const board = useAppStore((s) => s.chats[chatKey(docId)]);
  const aiThinking = useAppStore((s) => s.aiThinking);
  const queuedChats = useAppStore((s) => s.queuedChats);
  const newChatSession = useAppStore((s) => s.newChatSession);
  const switchChatSession = useAppStore((s) => s.switchChatSession);
  const chatMode = useAppStore((s) => s.chatMode);
  const setChatMode = useAppStore((s) => s.setChatMode);
  const rollbackable = useAiCheckpoints((s) => s.available);
  // Your avatar initials come from the browser identity (renameable in Share).
  const myInitials =
    (getIdentity().name.replace(/^Guest-/, "") || "You")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "Y";
  const [image, setImage] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Client-side BYOK (+ the instance's optional shared pool) — the model
  // comes from the browser-stored key config (X-AI-* headers), so the
  // composer's picker is a key chip that opens the key modal.
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

  // What the composer's key chip shows: your key's provider · model, the
  // shared pool, or a call to action.
  const triggerLabel = keyCfg
    ? `${PROVIDER_SHORT[keyCfg.provider] ?? keyCfg.provider} · ${keyCfg.model || "default model"}`
    : poolAi
      ? "Free AI · limited/day"
      : "Add AI key";

  /** Roll the board back to the state before the AI edit behind `cpId` (and
   * every AI edit after it). Only AI-touched objects revert; the rollback is
   * itself one ⌘Z-able undo step. */
  const rollback = (cpId: string) => rollbackAiEdit(docId, cpId);

  /** Send a message. No arg → read the textarea (uncontrolled — see below). */
  const send = (text?: string) => {
    const el = inputRef.current;
    const t = (text ?? el?.value ?? "").trim();
    if (!t) return;
    // BYOK gate: without a key (and no shared pool) chatting can only fail —
    // open the key modal instead and KEEP the draft so it sends afterwards.
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
        if (!getAiKeyConfig() && !(poolInfoSync()?.pool_ai)) setKeyModalOpen(true);
      })
      .catch((err) => setImgErr(err instanceof Error ? err.message : "Couldn't read that image."));
  };

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
      if (!getAiKeyConfig() && !(poolInfoSync()?.pool_ai)) setKeyModalOpen(true); // see onPaste
    } catch (err) {
      setImgErr(err instanceof Error ? err.message : "Couldn't read that image.");
    }
  };

  return (
    <div className="chat">
      {/* session bar + cost */}
      <div className="chat-sessions" hidden={sessions.length === 0 && !(usage && usage.calls > 0)}>
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
        {usage && usage.calls > 0 && (
          <div className="chat-cost" title="Tokens used in this session">
            ⛃ {usage.calls} calls · {(usage.prompt + usage.completion).toLocaleString()} tokens
            <span className="muted"> ({usage.prompt.toLocaleString()}↑ / {usage.completion.toLocaleString()}↓)</span>
          </div>
        )}
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !aiThinking && (
          <div className="chat-empty">
            <span className="chat-empty-mark" aria-hidden="true">✦</span>
            <div className="chat-empty-title">
              {chatMode === "ask" ? "Ask about this board" : "Draw with AI-Noddle"}
            </div>
            <div className="chat-empty-sub">
              {chatMode === "ask"
                ? "Get advice and explanations — the board is used as context and never changed."
                : "Describe a change and I'll edit the board directly — shapes, arrows, colours, layout. Attach or paste an image to recreate it."}
            </div>
            <div className="chat-empty-list">
              {(chatMode === "ask" ? ASK_SUGGESTIONS : CHAT_SUGGESTIONS).map((t) => (
                <button key={t} type="button" className="chat-empty-card" onClick={() => send(t)}>
                  <span>{t}</span>
                  <span className="go" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg${m.who === "you" ? " you" : ""}`}>
            <span className={`chat-ava ${m.who === "you" ? "you" : "ai"}`}>{m.who === "you" ? myInitials : "✦"}</span>
            <div className={`chat-bubble ${m.who === "you" ? "you" : "ai"}`}>
              {m.image && <img className="chat-msg-thumb" src={m.image} alt="attached reference" />}
              {m.who === "ai" ? <ChatMarkdown text={m.text} /> : m.text}
              {m.checkpointId && rollbackable[m.checkpointId] && (
                <button
                  className="chat-rollback"
                  title="Revert this AI edit (and any AI edits after it)"
                  onClick={() => rollback(m.checkpointId!)}
                >
                  ↩ Rollback
                </button>
              )}
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
        {messages.length > 0 && (
          <div className="chat-suggest">
            {(chatMode === "ask" ? ASK_SUGGESTIONS : CHAT_SUGGESTIONS).map((t) => (
              <button key={t} onClick={() => send(t)}>{t}</button>
            ))}
          </div>
        )}
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
        <div className="chat-composer">
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={1}
            // Keep the placeholder SHORT — a wrapping placeholder overflows
            // the 1-row box (text clipped mid-line under the border).
            // UNCONTROLLED on purpose: a controlled value + IME composition
            // (e.g. Vietnamese Telex) + store-driven re-renders duplicated the
            // last typed character when editing mid-text. The value is read
            // imperatively in send().
            defaultValue=""
            placeholder={
              aiThinking
                ? "Keep typing — messages queue up…"
                : chatMode === "ask"
                  ? "Ask anything — the board is context, not edited…"
                  : "Ask AI-Noddle to edit the diagram…"
            }
            title="Enter to send · Shift+Enter for a new line · paste an image with ⌘V/Ctrl+V"
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
          <div className="chat-composer-bar">
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
          {/* ONE fixed-height config row: mode switch + key chip. Draw
              edits the board; Ask is a tech consultant (board = context only,
              never mutated). The suggestion chips SWAP per mode instead of
              unmounting, so toggling Draw/Ask never reflows the composer.
              Doodle SVG icons per the no-AI-look-icons rule. */}
          <div className="chat-config-row">
            <div className="chat-mode" role="radiogroup" aria-label="Chat mode">
              <button
                className={`chat-mode-btn${chatMode === "edit" ? " active" : ""}`}
                role="radio"
                aria-checked={chatMode === "edit"}
                title="Messages edit the board"
                onClick={() => setChatMode("edit")}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3.8 20.3l1.1-4.5L16.2 4.4a2.1 2.1 0 0 1 3.1 3L8 18.9z" />
                  <path d="M13.8 6.6l3.2 3.2" />
                </svg>
                Draw
              </button>
              <button
                className={`chat-mode-btn${chatMode === "ask" ? " active" : ""}`}
                role="radio"
                aria-checked={chatMode === "ask"}
                title="Ask questions / get advice — the board is never changed"
                onClick={() => setChatMode("ask")}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4.6 5.6a1.8 1.8 0 0 1 1.8-1.7h11.3a1.8 1.8 0 0 1 1.8 1.8v7.6a1.8 1.8 0 0 1-1.9 1.7H10l-4.2 3.8.1-3.8h-.5a1.8 1.8 0 0 1-1.8-1.8z" />
                </svg>
                Ask
              </button>
            </div>
            {/* Key chip — which key runs this chat (BYOK, stays in this
                browser) or the instance's shared pool; click to set/edit. */}
            <div className="chat-model">
              <button
                type="button"
                className={`chat-model-trigger${keyCfg || poolAi ? "" : " unset"}`}
                title={
                  keyCfg
                    ? "Your key runs this chat (BYOK, stays in this browser) — click to edit"
                    : poolAi
                      ? "Shared free AI (limited per day) — click to use your own key"
                      : "Add your AI key to start chatting (BYOK — stays in this browser)"
                }
                onClick={() => setKeyModalOpen(true)}
              >
                <span className="cur">{triggerLabel}</span>
                {/* hand-drawn chevron (no AI-look icons) */}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 9.5l7 6.5 7-6.5" />
                </svg>
              </button>
            </div>
          </div>
            <span className="chat-composer-gap" />
            <button className="chat-send" aria-label="Send" title="Send (Enter)" onClick={() => send()}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19 V5 M6 11 L12 5 L18 11" /></svg>
            </button>
          </div>
        </div>
      </div>
      {keyModalOpen && (
        <AiKeySettings onClose={() => setKeyModalOpen(false)} onSaved={setKeyCfg} />
      )}
    </div>
  );
}
