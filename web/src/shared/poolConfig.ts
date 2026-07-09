/**
 * shared/poolConfig — cached server feature flags + optional Turnstile.
 *
 * `GET /api/config` says whether a shared AI pool exists (`pool_ai`) and, when
 * the operator enabled Cloudflare Turnstile for it, the site key. The token is
 * fetched invisibly per AI request and rides the `X-Turnstile-Token` header —
 * everything here is best-effort: any failure returns null and the backend
 * fails closed with an actionable message.
 */

export interface PoolInfo {
  pool_ai: boolean;
  turnstile_site_key: string | null;
}

let cached: PoolInfo | null = null;
let inflight: Promise<PoolInfo> | null = null;

export function poolInfo(): Promise<PoolInfo> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/config")
      .then((r) => r.json())
      .then((v) => (cached = {
        pool_ai: !!v.pool_ai,
        turnstile_site_key: typeof v.turnstile_site_key === "string" ? v.turnstile_site_key : null,
      }))
      .catch(() => (cached = { pool_ai: false, turnstile_site_key: null }));
  }
  return inflight;
}

/** Last fetched value (null until poolInfo() resolved once). */
export function poolInfoSync(): PoolInfo | null {
  return cached;
}

// ---- Turnstile (invisible) ---------------------------------------------------

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      execute: (id: string, opts?: Record<string, unknown>) => void;
      reset: (id: string) => void;
    };
  }
}

let widgetId: string | null = null;
let scriptLoading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptLoading) {
    scriptLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("turnstile script failed"));
      document.head.appendChild(s);
    });
  }
  return scriptLoading;
}

/** A fresh Turnstile token for one pool request, or null (no turnstile / error). */
export async function turnstileToken(): Promise<string | null> {
  const info = await poolInfo();
  const siteKey = info.turnstile_site_key;
  if (!siteKey) return null;
  try {
    await loadScript();
    const ts = window.turnstile;
    if (!ts) return null;
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 12_000);
      const done = (token: string) => {
        clearTimeout(timer);
        resolve(token || null);
      };
      if (widgetId === null) {
        const host = document.createElement("div");
        host.style.position = "fixed";
        host.style.bottom = "-9999px";
        document.body.appendChild(host);
        widgetId = ts.render(host, {
          sitekey: siteKey,
          size: "flexible",
          execution: "execute",
          callback: done,
          "error-callback": () => done(""),
        });
        ts.execute(widgetId);
      } else {
        // tokens are single-use — reset re-arms the widget, execute re-runs it
        ts.reset(widgetId);
        ts.execute(widgetId, { callback: done, "error-callback": () => done("") });
      }
    });
  } catch {
    return null;
  }
}
