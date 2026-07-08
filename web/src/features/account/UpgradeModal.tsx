/**
 * features/account/UpgradeModal — the "you hit a plan limit" upsell card.
 *
 * Rendered globally (App.tsx) and opened via appStore.showUpgrade(reason) when
 * a create/AI action returns 402 (board quota or credits exhausted). Buttons
 * open the Lemon Squeezy hosted checkout; unconfigured billing degrades to a
 * "manage in Settings" note instead of dead buttons.
 */
import { useState } from "react";
import { api, ApiError, type PlanVariant } from "../../shared/api/client";
import { useAppStore } from "../../state/appStore";
import { BrandLogo } from "../../shared/ui";

const PLANS: { variant: PlanVariant; name: string; price: string; blurb: string; highlight?: boolean }[] = [
  { variant: "pro_monthly", name: "Pro", price: "$10/mo", blurb: "Unlimited boards · 500 ✦ credits/month", highlight: true },
  { variant: "pro_yearly", name: "Pro yearly", price: "$96/yr", blurb: "Two months free · unlimited boards" },
  { variant: "team_yearly", name: "Team", price: "$12/user/mo", blurb: "Shared boards · 1000 ✦/user · admin audit" },
];

export function UpgradeModal() {
  const reason = useAppStore((s) => s.upgradeReason);
  const hide = useAppStore((s) => s.hideUpgrade);
  const openSettings = useAppStore((s) => s.openSettings);
  const [busy, setBusy] = useState<PlanVariant | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (reason == null) return null;

  const upgrade = async (variant: PlanVariant) => {
    setBusy(variant);
    setError(null);
    try {
      const { url } = await api.createCheckout(variant);
      window.location.href = url;
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setUnavailable(true);
      else setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className="gen-overlay" onClick={hide}>
      <div className="gen-modal upgrade-modal" role="dialog" aria-modal="true" aria-label="Upgrade your plan" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn upgrade-close" aria-label="Close" onClick={hide}>✕</button>
        <div className="upgrade-head">
          <span className="brand-mark" style={{ width: 30, height: 30 }}><BrandLogo /></span>
          <div>
            <div className="upgrade-title">Upgrade to keep building</div>
            <div className="upgrade-reason">{reason}</div>
          </div>
        </div>

        <div className="upgrade-plans">
          {PLANS.map((p) => (
            <button
              key={p.variant}
              className={`upgrade-plan${p.highlight ? " hot" : ""}`}
              disabled={busy !== null || unavailable}
              onClick={() => void upgrade(p.variant)}
            >
              {p.highlight && <span className="upgrade-badge">Most popular</span>}
              <span className="nm">{p.name}</span>
              <span className="price">{p.price}</span>
              <span className="blurb">{p.blurb}</span>
              <span className="cta">{busy === p.variant ? "Opening checkout…" : "Choose"}</span>
            </button>
          ))}
        </div>

        {unavailable && (
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0", textAlign: "center" }}>
            Billing isn't configured on this server yet. Manage plans in{" "}
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: "0 4px", display: "inline" }} onClick={() => { hide(); openSettings("credits"); }}>
              Settings → Credits &amp; plan
            </button>.
          </p>
        )}
        {error && <p style={{ color: "var(--danger-text, var(--danger))", fontSize: 12, margin: "10px 0 0", textAlign: "center" }}>{error}</p>}
        <p className="muted" style={{ fontSize: 11, margin: "12px 0 0", textAlign: "center" }}>
          Or keep going on Free — delete a board to free up space.
        </p>
      </div>
    </div>
  );
}
