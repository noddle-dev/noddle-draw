/**
 * features/account/AccountModal — identity hub (ADR-0002).
 *
 * Guest → Login / Register tabs. Signed-in → a left-nav SETTINGS dialog
 * (Linear/Notion pattern — one topic per view instead of one long scroll):
 *   Profile · Credits & plan (✦ wallet, refill meter, action costs, usage,
 *   upgrade) · AI provider (subscription vs BYOK) · API tokens (AGENT
 *   principals — the secret is shown exactly once) · Teams.
 */
import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type AiSettings,
  type ByokProfile,
  type ApiTokenInfo,
  type BillingEventOut,
  type PlanVariant,
  type UsageReport,
  type SubscriptionInfo,
  type TeamInfo,
} from "../../shared/api/client";
import { useAppStore } from "../../state/appStore";
import { useAuthStore } from "../../state/authStore";
import { BrandLogo } from "../../shared/ui";
import { AuthIllustration } from "./AuthIllustration";
import { TeamActivity } from "./TeamActivity";

const COLORS = ["#7c3aed", "#ea580c", "#ec4899", "#d97706", "#16a34a", "#0891b2", "#dc2626"];

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function AccountModal({ onClose }: { onClose: () => void }) {
  const me = useAuthStore((s) => s.me);
  const isUser = me?.kind === "user";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="gen-overlay" onClick={onClose}>
      <div
        className={isUser ? "gen-modal acct-modal" : "gen-modal auth-modal"}
        role="dialog"
        aria-modal="true"
        aria-label={isUser ? "Account settings" : "Sign in"}
        onClick={(e) => e.stopPropagation()}
      >
        {isUser ? <Account onClose={onClose} /> : <AuthForms />}
      </div>
    </div>
  );
}

/* ---------------- guest: login / register ---------------- */

/** Standard multi-color Google "G" (identity-button convention). */
function GoogleG({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

/** Exported so LoginScreen (full-page, Lucid-style) reuses the same form. */
export function AuthForms() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  // Contextual reason the login screen appeared ("Sign in to view this board.")
  const notice = useAppStore((s) => s.authNotice);
  // SSO button appears only when the server has an OIDC provider configured.
  const [sso, setSso] = useState<{ enabled: boolean; issuer: string | null } | null>(null);
  useEffect(() => {
    void api.oidcStatus().then(setSso).catch(() => {});
  }, []);
  const ssoIsGoogle = !!sso?.issuer?.includes("google");

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === "login") await login(email, password);
      else await register(email, name, password);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <AuthIllustration />
        <div className="auth-tagline">
          Sketch it messy. Keep it <em>Noddle</em>.
        </div>
      </div>
      <div className="auth-form">
        <div className="auth-brand">
          <span className="auth-brand-mark"><BrandLogo size={36} /></span>
          <div>
            <div className="auth-brand-name">Noddle Board</div>
            <div className="auth-brand-sub">Diagram workspace</div>
          </div>
        </div>
        <div className="t" style={{ marginBottom: 4 }}>
          {tab === "login" ? "Welcome back" : "Create your account"}
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
          Private boards, sharing &amp; teams, and a ✦ credit wallet for the AI co-editor.
        </p>
        {notice && (
          <p className="auth-notice" role="status">
            {notice}
          </p>
        )}
        <div className="seg" style={{ marginBottom: 16 }}>
          <button className={tab === "login" ? "active" : ""} onClick={() => setTab("login")}>Log in</button>
          <button className={tab === "register" ? "active" : ""} onClick={() => setTab("register")}>Register</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input className="text-input" placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {tab === "register" && (
            <input className="text-input" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <input
            className="text-input"
            placeholder="Password (≥ 8 characters)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
        </div>
        {error && <p style={{ color: "var(--danger)", fontSize: 12.5, margin: "10px 0 0" }}>{error}</p>}
        <button className="btn btn-grad btn-block" style={{ marginTop: 14 }} disabled={busy} onClick={() => void submit()}>
          {busy ? "Processing…" : tab === "login" ? "Log in" : "Create account"}
        </button>
        {sso?.enabled && (
          <>
            <div className="auth-divider" aria-hidden="true">
              <span>or</span>
            </div>
            <a className="btn btn-block sso-btn" href="/api/auth/oidc/login">
              {ssoIsGoogle ? (
                <>
                  <GoogleG /> Log in with Google
                </>
              ) : (
                "Log in with SSO"
              )}
            </a>
          </>
        )}
        <p className="auth-foot">
          Free plan: 3 boards + 25 ✦/month. No card needed.
        </p>
      </div>
    </div>
  );
}

/* ---------------- signed-in: left-nav settings ---------------- */

export type AcctTab = "profile" | "credits" | "usage" | "ai" | "tokens" | "teams";

export const ACCT_TABS: { id: AcctTab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "credits", label: "✦ Credits & plan" },
  { id: "usage", label: "Usage" },
  { id: "ai", label: "AI provider" },
  { id: "tokens", label: "API tokens" },
  { id: "teams", label: "Teams" },
];

function Account({ onClose }: { onClose: () => void }) {
  const logout = useAuthStore((s) => s.logout);
  const [tab, setTab] = useState<AcctTab>("profile");

  return (
    <div>
      <div className="acct-head">
        <span className="t">Account settings</span>
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>✕</button>
      </div>
      <div className="acct">
        <nav className="acct-nav" aria-label="Account sections">
          {ACCT_TABS.map((t) => (
            <button
              key={t.id}
              className={`acct-item${tab === t.id ? " active" : ""}`}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <span className="sp" />
          <button className="acct-item danger" onClick={() => { void logout(); onClose(); }}>
            ⏻ Log out
          </button>
        </nav>
        <div className="acct-body">
          {tab === "profile" && <ProfileSection />}
          {tab === "credits" && <CreditsSection />}
          {tab === "ai" && <AIProviderSection onManageCredits={() => setTab("credits")} />}
          {tab === "tokens" && <TokensSection />}
          {tab === "teams" && <TeamsSection />}
        </div>
      </div>
    </div>
  );
}

/** Longest side of the stored avatar (px) — downscaled client-side so the
 * data URL stays far under the server's 140k-char cap. */
const AVATAR_TARGET_PX = 128;

/** File → small PNG data URL via a canvas (same normalize pattern the board
 * image paste uses). Always re-encodes, so odd source formats never reach
 * the server — it only ever sees `data:image/png;base64,…`. */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error("Pick a raster image (PNG, JPEG or WebP).");
  }
  const raw: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the image file."));
    r.readAsDataURL(file);
  });
  const img: HTMLImageElement = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Invalid image."));
    el.src = raw;
  });
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const scale = Math.min(1, AVATAR_TARGET_PX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.drawImage(img, 0, 0, cw, ch);
  return canvas.toDataURL("image/png"); // PNG keeps transparency
}

export function ProfileSection() {
  const me = useAuthStore((s) => s.me);
  const patchProfile = useAuthStore((s) => s.patchProfile);
  const [name, setName] = useState(me?.name ?? "");
  const [title, setTitle] = useState(me?.title ?? "");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onPickAvatar = async (file: File | undefined) => {
    if (!file || avatarBusy) return;
    setAvatarBusy(true);
    setError(null);
    try {
      const url = await fileToAvatarDataUrl(file);
      await patchProfile({ avatar: url });
    } catch (e) {
      setError(errText(e));
    } finally {
      setAvatarBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const dirty =
    (name.trim() && name.trim() !== (me?.name ?? "")) ||
    title.trim().slice(0, 80) !== (me?.title ?? "");

  return (
    <div>
      <div className="props-label">Profile</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
        <span
          className="avatar"
          style={{ width: 56, height: 56, background: me?.color, fontSize: 20, overflow: "hidden" }}
        >
          {me?.avatar ? (
            <img
              src={me.avatar}
              alt={`${me?.name ?? "Your"} profile picture`}
              style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
            />
          ) : (
            (me?.name ?? "?").slice(0, 2).toUpperCase()
          )}
        </span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input
            ref={fileRef}
            id="avatar-file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Choose a profile picture"
            style={{ display: "none" }}
            onChange={(e) => void onPickAvatar(e.target.files?.[0])}
          />
          <button
            className="btn"
            aria-label="Upload profile picture"
            disabled={avatarBusy}
            onClick={() => fileRef.current?.click()}
          >
            {avatarBusy ? "Uploading…" : me?.avatar ? "Change photo" : "Upload photo"}
          </button>
          {me?.avatar && (
            <button
              className="btn btn-danger"
              aria-label="Remove profile picture"
              disabled={avatarBusy}
              onClick={() => {
                setError(null);
                void patchProfile({ avatar: null }).catch((e) => setError(errText(e)));
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
        <input
          className="text-input"
          aria-label="Display name"
          placeholder="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="text-input"
          aria-label="Job title"
          placeholder="Title (e.g. Product Designer)"
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          className="btn"
          style={{ alignSelf: "flex-start" }}
          disabled={!dirty}
          onClick={() => {
            setError(null);
            void patchProfile({
              ...(name.trim() ? { name: name.trim() } : {}),
              title: title.trim().slice(0, 80),
            }).catch((e) => setError(errText(e)));
          }}
        >
          Save
        </button>
      </div>
      <div className="prop-row">
        <span className="lbl">{me?.email}</span>
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch${me?.color === c ? " sel" : ""}`}
              style={{ background: c }}
              aria-label={`Cursor color ${c}`}
              onClick={() => void patchProfile({ color: c })}
            />
          ))}
        </div>
      </div>
      {error && (
        <p style={{ color: "var(--danger-text)", fontSize: 12, margin: "8px 0 0" }}>{error}</p>
      )}
      <p className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.45 }}>
        Your name, photo and color identify you on shared boards — collaborators see them on
        your cursor and comments.
      </p>
      <ChangePasswordSection />
    </div>
  );
}

/** "Change password" disclosure — current + new + confirm, inline errors.
 * A successful change revokes every OTHER session server-side. */
function ChangePasswordSection() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setDone(false);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("New password and confirmation don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div className="props-label">Security</div>
      <button
        className="btn"
        aria-expanded={open}
        aria-label={open ? "Hide change password form" : "Show change password form"}
        onClick={() => { setOpen((v) => !v); setError(null); setDone(false); }}
      >
        {open ? "▾ Change password" : "▸ Change password"}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          <input
            className="text-input"
            type="password"
            autoComplete="current-password"
            aria-label="Current password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <input
            className="text-input"
            type="password"
            autoComplete="new-password"
            aria-label="New password"
            placeholder="New password (≥ 8 characters)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <input
            className="text-input"
            type="password"
            autoComplete="new-password"
            aria-label="Confirm new password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
          {error && (
            <p role="alert" style={{ color: "var(--danger-text)", fontSize: 12, margin: 0 }}>
              {error}
            </p>
          )}
          {done && (
            <p role="status" style={{ color: "var(--text-2)", fontSize: 12, margin: 0 }}>
              Password changed — other devices were signed out.
            </p>
          )}
          <button
            className="btn btn-primary"
            style={{ alignSelf: "flex-start" }}
            disabled={busy || !current || !next || !confirm}
            onClick={() => void submit()}
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- credits & plan ---------------- */

/** ✦ wallet management: balance, monthly refill meter, action costs, this
 * month's usage, then the plan card (upgrades top the wallet up). */
export function CreditsSection() {
  const [s, setS] = useState<AiSettings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api.getAiSettings().then(setS).catch(() => setFailed(true));
  }, []);

  if (failed) return <p className="muted" style={{ fontSize: 12.5 }}>Couldn't load credit info.</p>;
  if (!s) return <p className="muted" style={{ fontSize: 12.5 }}>Loading…</p>;

  const maxCost = Math.max(1, ...Object.values(s.costs));
  const low = s.credits < maxCost;
  const spentPct = Math.min(100, Math.round((s.month_spent / Math.max(1, s.monthly_allowance)) * 100));

  return (
    <div>
      <div className="props-label">Credits</div>
      <div className="credit-tiles">
        <div className={`credit-tile${low ? " warn" : ""}`}>
          <div className="num">✦ {s.credits}</div>
          <div className="cap">{low ? "Almost out — top up below" : "Available now"}</div>
        </div>
        <div className="credit-tile">
          <div className="num">{s.month_spent}</div>
          <div className="cap">Spent this month</div>
        </div>
      </div>

      <div className="credit-meter-row">
        <span>Monthly refill</span>
        <span>{s.month_spent} / {s.monthly_allowance} ✦</span>
      </div>
      <div className="meter" role="img" aria-label={`${s.month_spent} of ${s.monthly_allowance} monthly credits used`}>
        <span style={{ width: `${spentPct}%` }} />
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 16px", lineHeight: 1.45 }}>
        Each month your wallet refills up to {s.monthly_allowance} ✦ (your plan's floor) —
        higher balances from payments are never clamped. BYOK calls never spend credits.
      </p>

      <div className="props-label">What one action costs</div>
      <div className="cost-list">
        {Object.entries(s.costs).map(([k, v]) => (
          <div className="cost-row" key={k}>
            <span className="nm">{ACTION_LABELS[k] ?? k}</span>
            <span className="pill pill-accent">✦ {v}</span>
          </div>
        ))}
      </div>

      {s.usage.calls > 0 && (
        <>
          <div className="props-label">Usage this month</div>
          <div className="cost-list">
            <div className="cost-row">
              <span className="nm">AI calls</span><span>{s.usage.calls}</span>
            </div>
            <div className="cost-row">
              <span className="nm">Tokens (in + out)</span>
              <span>
                {fmtTokens(s.usage.prompt + s.usage.completion)}
                {s.usage.cache_read > 0 ? ` · ${fmtTokens(s.usage.cache_read)} cached` : ""}
              </span>
            </div>
            <div className="cost-row">
              <span className="nm">Credits charged</span><span>✦ {s.usage.credits_charged}</span>
            </div>
          </div>
        </>
      )}

      <PlanSection />
    </div>
  );
}

/* ---------------- usage dashboard (provider-style) ---------------- */

/** AI usage over time — per-day bar chart + breakdowns + recent calls, read
 * from the append-only ledger (like OpenAI/Anthropic dashboards). */
/** Human labels for the billing mode a call ran under. */
const MODE_LABELS: Record<string, string> = {
  subscription: "Subscription",
  byok: "BYOK",
  pool: "Free pool",
};

export function UsageSection() {
  const [u, setU] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  // Chart metric: credits hides BYOK (0 ✦); tokens surfaces every call.
  const [metric, setMetric] = useState<"credits" | "tokens">("credits");

  useEffect(() => {
    void api.myUsage(30).then(setU).catch(() => setFailed(true));
  }, []);

  if (failed) return <p className="muted" style={{ fontSize: 12.5 }}>Couldn't load usage.</p>;
  if (!u) return <p className="muted" style={{ fontSize: 12.5 }}>Loading…</p>;

  if (u.total.calls === 0) {
    return (
      <div>
        <div className="props-label">Usage · last {u.window_days} days</div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          No AI calls yet. Usage from image→board, text→diagram and the Claude
          co-editor will show here — per day, by action and model.
        </p>
      </div>
    );
  }

  const maxVal = Math.max(1, ...u.days.map((d) => (metric === "credits" ? d.credits : d.tokens)));
  const models = Object.entries(u.by_model).sort((a, b) => b[1].tokens - a[1].tokens);
  const modes = Object.entries(u.by_mode ?? {}).sort((a, b) => b[1].calls - a[1].calls);

  return (
    <div>
      <div className="props-label">Usage · last {u.window_days} days</div>
      <div className="credit-tiles" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="credit-tile"><div className="num">{u.total.calls}</div><div className="cap">AI calls</div></div>
        <div className="credit-tile"><div className="num">✦ {u.total.credits}</div><div className="cap">Credits spent</div></div>
        <div className="credit-tile"><div className="num">{fmtTokens(u.total.tokens)}</div><div className="cap">Tokens</div></div>
      </div>

      {/* per-day bars — a tiny inline chart, no chart lib. Toggle credits↔tokens
          so BYOK calls (0 ✦) are visible under the token metric. */}
      <div className="usage-chart-head">
        <div className="props-label" style={{ margin: 0 }}>
          {metric === "credits" ? "Credits per day" : "Tokens per day"}
        </div>
        <div className="usage-metric-toggle" role="tablist" aria-label="Chart metric">
          <button
            className={metric === "credits" ? "on" : ""}
            role="tab"
            aria-selected={metric === "credits"}
            onClick={() => setMetric("credits")}
          >
            ✦ Credits
          </button>
          <button
            className={metric === "tokens" ? "on" : ""}
            role="tab"
            aria-selected={metric === "tokens"}
            onClick={() => setMetric("tokens")}
          >
            Tokens
          </button>
        </div>
      </div>
      <div className="usage-chart" role="img" aria-label={`${metric} per day over ${u.window_days} days`}>
        {u.days.map((d) => {
          const v = metric === "credits" ? d.credits : d.tokens;
          return (
            <div
              key={d.date}
              className="usage-bar"
              title={`${d.date}: ✦${d.credits} · ${d.calls} calls · ${fmtTokens(d.tokens)} tokens`}
            >
              <span style={{ height: `${Math.round((v / maxVal) * 100)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="usage-chart-axis">
        <span>{u.days[0]?.date.slice(5)}</span>
        <span>{u.days[u.days.length - 1]?.date.slice(5)}</span>
      </div>

      {modes.length > 0 && (
        <>
          <div className="props-label" style={{ marginTop: 14 }}>By mode</div>
          <div className="cost-list">
            {modes.map(([k, v]) => (
              <div className="cost-row" key={k}>
                <span className="nm">{MODE_LABELS[k] ?? k}</span>
                <span className="muted">{v.calls} calls · {fmtTokens(v.tokens)} tok</span>
                <span className="pill pill-accent" style={{ marginLeft: 8 }}>
                  {k === "byok" ? "own key" : `✦ ${v.credits}`}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="props-label" style={{ marginTop: 14 }}>By action</div>
      <div className="cost-list">
        {Object.entries(u.by_action).map(([k, v]) => (
          <div className="cost-row" key={k}>
            <span className="nm">{ACTION_LABELS[k] ?? k}</span>
            <span className="muted">{v.calls} calls · {fmtTokens(v.tokens)} tok</span>
            <span className="pill pill-accent" style={{ marginLeft: 8 }}>✦ {v.credits}</span>
          </div>
        ))}
      </div>

      {models.length > 0 && (
        <>
          <div className="props-label">By model</div>
          <div className="cost-list">
            {models.map(([m, v]) => (
              <div className="cost-row" key={m}>
                <span className="nm" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>{m || "—"}</span>
                <span className="muted">{v.calls} calls · {fmtTokens(v.tokens)} tok</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="props-label">Recent calls</div>
      <div className="cost-list">
        {u.recent.map((r, i) => (
          <div className="cost-row" key={i}>
            <span className="nm">{ACTION_LABELS[r.action] ?? r.action}</span>
            {r.mode && r.mode !== "subscription" && (
              <span className={`usage-mode-tag${r.mode === "byok" ? " byok" : ""}`}>
                {MODE_LABELS[r.mode] ?? r.mode}
              </span>
            )}
            <span className="muted" style={{ fontSize: 11 }}>
              {new Date(r.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="muted" style={{ marginLeft: 8 }}>{fmtTokens(r.prompt + r.completion)} tok</span>
            {r.credits_charged > 0 && <span className="pill pill-accent" style={{ marginLeft: 8 }}>✦ {r.credits_charged}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const TIER_LABELS: Record<SubscriptionInfo["tier"], string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
};

const PLAN_BUTTONS: { variant: PlanVariant; label: string }[] = [
  { variant: "pro_monthly", label: "Pro Monthly · $10/mo" },
  { variant: "pro_yearly", label: "Pro Yearly · $96/yr" },
  { variant: "team_yearly", label: "Team · $12/user/mo" },
];

/** Current plan badge + upgrade buttons (Lemon Squeezy hosted checkout). */
function PlanSection() {
  const [sub, setSub] = useState<SubscriptionInfo | null>(null);
  const [busy, setBusy] = useState<PlanVariant | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.mySubscription().then(setSub).catch(() => {});
  }, []);

  if (!sub) return null;

  const upgrade = async (variant: PlanVariant) => {
    setBusy(variant);
    setError(null);
    try {
      const { url } = await api.createCheckout(variant);
      window.location.href = url;
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setUnavailable(true);
      else setError(errText(e));
      setBusy(null);
    }
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="props-label">Plan</div>
      <div className="prop-row" style={{ marginBottom: 8 }}>
        <span className="lbl">Current plan</span>
        <span
          className="pill"
          style={
            sub.tier === "free"
              ? { background: "var(--panel-2)", color: "var(--text-2)" }
              : { background: "var(--accent, #2563eb)", color: "#fff" }
          }
        >
          {TIER_LABELS[sub.tier]}
          {sub.status === "cancelled" && " · cancelled"}
          {sub.status === "past_due" && " · past due"}
        </span>
      </div>
      {sub.tier === "free" ? (
        <>
          <p className="muted" style={{ fontSize: 11.5, margin: "0 0 8px", lineHeight: 1.45 }}>
            Free plan: up to {sub.features.boards_max} boards and{" "}
            {sub.features.ai_credits_month} AI credits/month. Upgrade for unlimited boards.
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PLAN_BUTTONS.map((p) => (
              <button
                key={p.variant}
                className="btn btn-primary"
                style={{ fontSize: 12 }}
                disabled={busy !== null || unavailable}
                onClick={() => void upgrade(p.variant)}
              >
                {busy === p.variant ? "Opening checkout…" : p.label}
              </button>
            ))}
          </div>
          {unavailable && (
            <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
              Billing is not configured on this server — upgrades are unavailable.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 11.5, margin: 0, lineHeight: 1.45 }}>
            Unlimited boards · {sub.features.ai_credits_month} AI credits
            {sub.tier === "team" ? "/user" : ""}/month
            {sub.current_period_end
              ? ` · ${sub.status === "cancelled" ? "access until" : "renews"} ${new Date(sub.current_period_end * 1000).toLocaleDateString()}`
              : ""}
            {sub.customer_portal_url
              ? "."
              : ". Manage billing from the Lemon Squeezy receipt email."}
          </p>
          {sub.customer_portal_url && (
            <a
              className="btn"
              style={{ marginTop: 8, fontSize: 12, display: "inline-flex" }}
              href={sub.customer_portal_url}
              target="_blank"
              rel="noopener"
            >
              Manage billing ↗
            </a>
          )}
        </>
      )}
      {error && <p style={{ color: "var(--danger)", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
      <BillingHistory />
    </div>
  );
}

/** Human labels for Lemon Squeezy webhook event names in the history list. */
const BILLING_EVENT_LABELS: Record<string, string> = {
  subscription_payment_success: "Payment",
  subscription_payment_failed: "Payment failed",
  subscription_created: "Subscription started",
  subscription_updated: "Plan updated",
  subscription_resumed: "Subscription resumed",
  subscription_cancelled: "Subscription cancelled",
  subscription_expired: "Subscription expired",
};

/** Billing history (webhook-recorded) — loads when the Credits tab opens. */
function BillingHistory() {
  const [events, setEvents] = useState<BillingEventOut[] | null>(null);

  useEffect(() => {
    void api.myBillingEvents().then(setEvents).catch(() => setEvents([]));
  }, []);

  return (
    <div style={{ marginTop: 14 }}>
      <div className="props-label">Billing history</div>
      {events === null ? (
        <p className="muted" style={{ fontSize: 12 }}>Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>No payments yet.</p>
      ) : (
        <div className="cost-list">
          {events.map((e, i) => (
            <div className="cost-row" key={`${e.created_at}-${i}`}>
              <span className="nm">
                {new Date(e.created_at * 1000).toLocaleDateString()} ·{" "}
                {BILLING_EVENT_LABELS[e.event] ?? e.event.replace(/_/g, " ")}
              </span>
              <span>
                {e.amount_usd != null ? `$${e.amount_usd.toFixed(2)}` : ""}
                {e.amount_usd != null && e.credits_granted > 0 ? " · " : ""}
                {e.credits_granted > 0 ? `+✦ ${e.credits_granted}` : ""}
                {e.amount_usd == null && e.credits_granted === 0 ? "—" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PROVIDER_LABELS: Record<AiSettings["provider"], string> = {
  claude: "Claude (Anthropic)",
  openai: "OpenAI",
  gemini: "Gemini (Google)",
  openrouter: "OpenRouter",
  custom: "Custom (OpenAI-compatible)",
};

// Popular OpenRouter model slugs (researched mid-2026) — suggestions in the
// model input's datalist; the field stays free-text so ANY of OpenRouter's
// 400+ models can be typed. Slugs follow provider/model; verify on
// openrouter.ai/models as the catalog shifts every few months.
// Verified against openrouter.ai/api/v1/models (2026-07). Free-text field, so
// any of OpenRouter's 340+ models can still be typed.
// `vision: false` models can't run image→board (OpenRouter answers 404
// "No endpoints found that support image input") — the datalist labels warn.
const OPENROUTER_MODELS: { slug: string; vision: boolean }[] = [
  // frontier
  { slug: "anthropic/claude-opus-4.8", vision: true },
  { slug: "anthropic/claude-sonnet-4.6", vision: true },
  { slug: "anthropic/claude-fable-5", vision: true },
  { slug: "openai/gpt-5.4", vision: true },
  { slug: "google/gemini-3.1-flash-lite", vision: true },
  // strong + cheap / open-weight (great value) — TEXT ONLY
  { slug: "deepseek/deepseek-v4-flash", vision: false },
  { slug: "deepseek/deepseek-v4-pro", vision: false },
  { slug: "minimax/minimax-m3", vision: false },
  { slug: "z-ai/glm-5.2", vision: false },
];

/** AI provider — use credits (subscription) or your own API key (BYOK). */
const ACTION_LABELS: Record<string, string> = {
  image_to_svg: "image → board",
  text_to_diagram: "text → diagram",
  edit_diagram: "chat edit",
};

/** 12345 → "12.3k" — compact token counts for the usage meter. */
function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** One BYOK key config form — used for both "add new" and "edit existing".
 * Provider chips + name + key + model (OpenRouter combobox) + base URL (custom).
 * ``initial`` prefills for edit; the key field is always blank (never echo the
 * secret) and an empty key on save keeps the stored one. */
function ProfileForm({
  initial,
  defaultModels,
  busy,
  onSave,
  onCancel,
}: {
  initial?: ByokProfile;
  defaultModels: AiSettings["default_models"];
  busy: boolean;
  onSave: (patch: {
    name: string;
    provider: AiSettings["provider"];
    api_key?: string;
    model: string;
    api_base?: string;
  }) => void;
  onCancel?: () => void;
}) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState<AiSettings["provider"]>(initial?.provider ?? "claude");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiBase, setApiBase] = useState(initial?.api_base ?? "");

  const hasKey = editing ? initial!.has_key : false;
  const canSave =
    !busy &&
    name.trim().length > 0 &&
    (key.trim() || hasKey) &&
    (provider !== "custom" || apiBase.trim());

  return (
    <div className="byok-form">
      <label className="byok-field">
        <span className="byok-label">Profile name</span>
        <input
          className="text-input"
          maxLength={40}
          placeholder="e.g. Work OpenAI, Personal OpenRouter…"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="byok-providers">
        {(Object.keys(PROVIDER_LABELS) as AiSettings["provider"][]).map((p) => (
          <button
            key={p}
            type="button"
            className={`byok-provider${provider === p ? " sel" : ""}`}
            disabled={busy}
            onClick={() => setProvider(p)}
          >
            {PROVIDER_LABELS[p]}
          </button>
        ))}
      </div>

      <label className="byok-field">
        <span className="byok-label">API key</span>
        <input
          className="text-input mono"
          placeholder={hasKey ? (initial!.masked_key ?? "•••• saved — leave blank to keep") : "Paste your API key…"}
          type="password"
          autoComplete="off"
          value={key}
          disabled={busy}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>

      {provider === "custom" && (
        <label className="byok-field">
          <span className="byok-label">Base URL</span>
          <input
            className="text-input mono"
            placeholder="https://openrouter.ai/api/v1"
            value={apiBase}
            disabled={busy}
            onChange={(e) => setApiBase(e.target.value)}
          />
        </label>
      )}

      <label className="byok-field">
        <span className="byok-label">
          Model
          {provider !== "custom" && provider !== "openrouter" && (
            <span className="muted"> · default {defaultModels[provider]}</span>
          )}
          {provider === "openrouter" && <span className="muted"> · pick or type any slug</span>}
        </span>
        <input
          className="text-input mono"
          list={provider === "openrouter" ? "openrouter-models" : undefined}
          placeholder={
            provider === "custom"
              ? "anthropic/claude-opus-4-8 · llama-3.3-70b · …"
              : provider === "openrouter"
                ? "openai/gpt-4o · anthropic/claude-3.7-sonnet · …"
                : defaultModels[provider]
          }
          value={model}
          disabled={busy}
          onChange={(e) => setModel(e.target.value)}
        />
        {provider === "openrouter" && (
          <datalist id="openrouter-models">
            {OPENROUTER_MODELS.map((m) => (
              <option
                key={m.slug}
                value={m.slug}
                label={m.vision ? `${m.slug} — vision ✓` : `${m.slug} — text only (no image→board)`}
              />
            ))}
          </datalist>
        )}
      </label>
      {provider === "openrouter" && model && OPENROUTER_MODELS.some((m) => m.slug === model && !m.vision) && (
        <p className="muted" style={{ fontSize: 11.5, margin: "-4px 0 8px", color: "var(--warn, #b45309)" }}>
          ⚠ This model is text-only — image→board uploads will fail. Pick a vision model
          (GPT, Claude, Gemini) for image conversion.
        </p>
      )}

      <div className="byok-actions">
        <button
          className="btn btn-primary"
          disabled={!canSave}
          onClick={(e) => {
            e.preventDefault();
            onSave({
              name: name.trim(),
              provider,
              api_key: key.trim() || undefined,
              model: model.trim(),
              api_base: provider === "custom" ? apiBase.trim() : undefined,
            });
          }}
        >
          {busy ? "Saving…" : editing ? "Save changes" : "Add profile"}
        </button>
        {onCancel && (
          <button className="btn btn-ghost" disabled={busy} onClick={(e) => { e.preventDefault(); onCancel(); }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function AIProviderSection({ onManageCredits }: { onManageCredits?: () => void }) {
  const [s, setS] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which profile row is expanded for editing (id), or "new" for the add form.
  const [editing, setEditing] = useState<string | null>(null);
  // Key check: which profile is being pinged, and the last result per profile.
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const runTest = async (pid: string) => {
    setTesting(pid);
    setTestResults((r) => {
      const { [pid]: _, ...rest } = r;
      return rest;
    });
    try {
      const res = await api.testByokProfile(pid);
      setTestResults((r) => ({ ...r, [pid]: res }));
    } catch (e) {
      setTestResults((r) => ({ ...r, [pid]: { ok: false, message: errText(e) } }));
    } finally {
      setTesting(null);
    }
  };

  const load = () => void api.getAiSettings().then(setS).catch(() => {});
  useEffect(load, []);

  if (!s) return null;

  const apply = async (fn: () => Promise<AiSettings>) => {
    setBusy(true);
    setError(null);
    try {
      setS(await fn());
      setEditing(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const maxCost = Math.max(1, ...Object.values(s.costs));
  const lowCredits = s.mode === "subscription" && s.credits < maxCost;
  const profiles = s.byok_profiles ?? [];

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="props-label">AI provider</div>
      <p className="muted" style={{ fontSize: 11.5, margin: "0 0 8px", lineHeight: 1.45 }}>
        Choose the AI source for image→SVG, text→diagram, and co-editing. Save
        several BYOK profiles and pick one per chat from the model dropdown.
      </p>

      {s.model_catalog && s.model_catalog.length > 0 && (
        <details className="model-catalog">
          <summary>Available models</summary>
          {s.model_catalog.map((m) => (
            <div className="model-row" key={m.model}>
              <span className="mc-name">{m.label}</span>
              <span className="mc-desc">{m.description}</span>
            </div>
          ))}
        </details>
      )}

      {/* Subscription */}
      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 10,
          marginBottom: 8,
          cursor: "pointer",
        }}
      >
        <input
          type="radio"
          name="ai-mode"
          checked={s.mode === "subscription"}
          disabled={busy}
          onChange={() => void apply(() => api.putAiSettings({ mode: "subscription" }))}
        />
        <span style={{ flex: 1 }}>
          <b style={{ fontSize: 13 }}>Subscription</b>
          <span className="muted" style={{ fontSize: 11.5, display: "block" }}>
            Uses the shared pool, paying per action:{" "}
            {Object.entries(s.costs)
              .map(([k, v]) => `✦${v} ${ACTION_LABELS[k] ?? k}`)
              .join(" · ")}
            .
          </span>
          {onManageCredits && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11.5, padding: "2px 6px", marginTop: 4 }}
              onClick={(e) => { e.preventDefault(); onManageCredits(); }}
            >
              Manage credits & plan →
            </button>
          )}
        </span>
        <span
          className="pill"
          style={
            lowCredits
              ? { background: "var(--danger, #dc2626)", color: "#fff" }
              : { background: "var(--panel-2)", color: "var(--text-2)" }
          }
        >
          {s.credits} ✦ left
        </span>
      </label>
      {lowCredits && (
        <p className="muted" style={{ fontSize: 11.5, margin: "0 0 8px" }}>
          Out of credits — top up under{" "}
          {onManageCredits ? (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11.5, padding: "0 3px", display: "inline" }}
              onClick={onManageCredits}
            >
              ✦ Credits &amp; plan
            </button>
          ) : (
            "✦ Credits & plan"
          )}
          , or switch to one of your API keys below.
        </p>
      )}

      {/* BYOK — a LIST of named key configs (LLM-gateway style) */}
      <div className={`byok-card${s.mode === "byok" ? " active" : ""}`}>
        <label className="byok-radio">
          <input
            type="radio"
            name="ai-mode"
            checked={s.mode === "byok"}
            disabled={busy || profiles.length === 0}
            onChange={() => void apply(() => api.putAiSettings({ mode: "byok" }))}
          />
          <span>
            <b>Your own API keys (BYOK)</b>
            <span className="muted byok-sub">
              No ✦ credit spent, on any plan. “Custom” connects any
              OpenAI-compatible endpoint (OpenRouter, Together, Groq, vLLM,
              Ollama, a LiteLLM/LLM-gateway proxy).
            </span>
          </span>
          {s.mode === "byok" && s.byok_active_id && (
            <span className="pill pill-accent byok-active-pill">Active</span>
          )}
        </label>

        {/* saved profiles */}
        {profiles.length > 0 && (
          <div className="byok-profiles">
            {profiles.map((p) => {
              const isActive = s.mode === "byok" && s.byok_active_id === p.id;
              return (
                <div key={p.id} className={`byok-profile${isActive ? " active" : ""}`}>
                  <div className="byok-profile-head">
                    <div className="byok-profile-main">
                      <span className="byok-profile-name">{p.name}</span>
                      <span className="muted byok-profile-meta">
                        {PROVIDER_LABELS[p.provider]}
                        {p.model ? ` · ${p.model}` : ""}
                        {p.masked_key ? ` · ${p.masked_key}` : " · no key"}
                      </span>
                    </div>
                    <div className="byok-profile-actions">
                      {isActive ? (
                        <span className="pill pill-accent">In use</span>
                      ) : (
                        <button
                          className="btn btn-ghost"
                          disabled={busy || !p.has_key}
                          title={p.has_key ? "Use this profile" : "Add a key first"}
                          onClick={() => void apply(() => api.activateByokProfile(p.id))}
                        >
                          Use this one
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        disabled={busy || testing !== null || !p.has_key}
                        title={p.has_key ? "Send a tiny request to check the key" : "Add a key first"}
                        onClick={() => void runTest(p.id)}
                      >
                        {testing === p.id ? "Testing…" : "Test"}
                      </button>
                      <button
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => setEditing(editing === p.id ? null : p.id)}
                      >
                        {editing === p.id ? "Close" : "Edit"}
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={busy}
                        onClick={() => void apply(() => api.deleteByokProfile(p.id))}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {testResults[p.id] && (
                    <p className={`byok-test-result${testResults[p.id].ok ? " ok" : " err"}`}>
                      {testResults[p.id].ok ? "✓ " : "✕ "}
                      {testResults[p.id].message}
                    </p>
                  )}
                  {editing === p.id && (
                    <ProfileForm
                      initial={p}
                      defaultModels={s.default_models}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={(patch) =>
                        void apply(() => api.updateByokProfile(p.id, patch))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* add a new profile */}
        {editing === "new" ? (
          <ProfileForm
            defaultModels={s.default_models}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(patch) =>
              void apply(() =>
                api.addByokProfile({
                  name: patch.name,
                  provider: patch.provider,
                  api_key: patch.api_key,
                  model: patch.model,
                  api_base: patch.api_base,
                }),
              )
            }
          />
        ) : (
          <button
            className="btn"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={() => setEditing("new")}
          >
            ＋ Add API key profile
          </button>
        )}
      </div>
      {error && <p style={{ color: "var(--danger-text, var(--danger))", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
    </div>
  );
}

/** API tokens — each token is an AGENT principal (native AI collaboration). */
export function TokensSection() {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(true);
  const [fresh, setFresh] = useState<ApiTokenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => void api.listApiTokens().then(setTokens).catch(() => {});
  useEffect(reload, []);

  const create = async () => {
    setError(null);
    try {
      const t = await api.createApiToken(
        name.trim() || "Agent",
        write ? ["boards:read", "boards:write"] : ["boards:read"],
      );
      setFresh(t);
      setName("");
      reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="props-label">API tokens — for AI agents</div>
      <p className="muted" style={{ fontSize: 11.5, margin: "0 0 8px", lineHeight: 1.45 }}>
        The agent uses <code>Authorization: Bearer noddle_…</code> and appears on the board as its
        own collaborator (with its own name and permissions — never impersonating you).
      </p>
      {tokens.map((t) => (
        <div key={t.id} className="prop-row" style={{ marginBottom: 6 }}>
          <span className="lbl" style={{ flex: 1 }}>
            ✦ {t.name}
            <span className="muted" style={{ fontSize: 11 }}> · {t.scopes.join(", ")}</span>
          </span>
          <button
            className="btn btn-danger"
            style={{ padding: "3px 9px", fontSize: 11.5 }}
            onClick={() => void api.deleteApiToken(t.id).then(reload)}
          >
            Revoke
          </button>
        </div>
      ))}
      {fresh?.token && (
        <div className="ai-tip" style={{ margin: "8px 0", flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <span><b>Copy now</b> — the token is shown only once:</span>
          <input
            className="text-input"
            readOnly
            value={fresh.token}
            style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input className="text-input" style={{ flex: 1 }} placeholder="Agent name (e.g., Claude release bot)" value={name} onChange={(e) => setName(e.target.value)} />
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--muted)" }}>
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> write
        </label>
        <button className="btn btn-primary" onClick={() => void create()}>＋ Create</button>
      </div>
      {error && <p style={{ color: "var(--danger)", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
    </div>
  );
}

export function TeamsSection() {
  const me = useAuthStore((s) => s.me);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [name, setName] = useState("");
  const [invite, setInvite] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = () => void api.listTeams().then(setTeams).catch(() => {});
  useEffect(reload, []);

  return (
    <div>
      <div className="props-label">Teams</div>
      {teams.map((t) => (
        <div key={t.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
          <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 6 }}>{t.name}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {t.members.map((m) => (
              <span
                key={m.id}
                className="pill"
                style={{ background: "var(--panel-2)", color: "var(--text-2)" }}
                title={m.title ? `${m.name} — ${m.title}` : m.name}
              >
                <span className="avatar" style={{ width: 16, height: 16, fontSize: 8, background: m.color, overflow: "hidden" }}>
                  {m.avatar ? (
                    <img src={m.avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
                  ) : (
                    m.name.slice(0, 2).toUpperCase()
                  )}
                </span>
                {m.name} · {m.role}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="text-input"
              style={{ flex: 1, fontSize: 12 }}
              placeholder="Member email"
              value={invite[t.id] ?? ""}
              onChange={(e) => setInvite((v) => ({ ...v, [t.id]: e.target.value }))}
            />
            <button
              className="btn"
              onClick={() => {
                setError(null);
                void api
                  .addTeamMember(t.id, (invite[t.id] ?? "").trim(), "member")
                  .then(() => { setInvite((v) => ({ ...v, [t.id]: "" })); reload(); })
                  .catch((e) => setError(errText(e)));
              }}
            >
              Add
            </button>
          </div>
          {/* Team audit trail (WS3) — admin-only, so non-admins never see a 403. */}
          {t.members.some((m) => m.id === me?.id && m.role === "admin") && (
            <TeamActivity teamId={t.id} />
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <input className="text-input" style={{ flex: 1 }} placeholder="New team name" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn btn-primary"
          disabled={!name.trim()}
          onClick={() => void api.createTeam(name.trim()).then(() => { setName(""); reload(); })}
        >
          ＋ Create team
        </button>
      </div>
      {error && <p style={{ color: "var(--danger)", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
    </div>
  );
}
