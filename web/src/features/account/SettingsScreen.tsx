/**
 * features/account/SettingsScreen — the full-page account settings
 * (industry pattern: Notion/Linear/Stripe use a dedicated /settings route, not
 * a modal — room for billing, security, teams without a cramped dialog). The
 * per-topic section components are shared with the (now legacy) modal.
 */
import { useEffect } from "react";
import { useAppStore } from "../../state/appStore";
import { useAuthStore } from "../../state/authStore";
import { BrandLogo, Icon } from "../../shared/ui";
import {
  ACCT_TABS,
  ProfileSection,
  CreditsSection,
  UsageSection,
  AIProviderSection,
  TokensSection,
  TeamsSection,
} from "./AccountModal";

export function SettingsScreen() {
  const tab = useAppStore((s) => s.settingsTab);
  const setTab = useAppStore((s) => s.openSettings);
  const go = useAppStore((s) => s.go);
  const logout = useAuthStore((s) => s.logout);
  const me = useAuthStore((s) => s.me);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") go("dashboard"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const initials = (me?.name ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="settings-page">
      <header className="settings-header">
        <button className="settings-back" onClick={() => go("dashboard")}>
          <Icon name="back" size={16} /> Back to boards
        </button>
        <span className="settings-brand">
          <span className="brand-mark" style={{ width: 24, height: 24 }}><BrandLogo /></span>
          Settings
        </span>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-id">
            <span className="avatar" style={{ width: 34, height: 34, background: me?.color, fontSize: 13, overflow: "hidden" }}>
              {me?.avatar ? <img src={me.avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} /> : initials}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="nm">{me?.name}</div>
              <div className="em">{me?.email}</div>
            </div>
          </div>
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
          <button className="acct-item danger" onClick={() => { void logout(); go("dashboard"); }}>
            ⏻ Log out
          </button>
        </nav>

        <main className="settings-main">
          <div className="settings-content">
            {tab === "profile" && <ProfileSection />}
            {tab === "credits" && <CreditsSection />}
            {tab === "usage" && <UsageSection />}
            {tab === "ai" && <AIProviderSection onManageCredits={() => setTab("credits")} />}
            {tab === "tokens" && <TokensSection />}
            {tab === "teams" && <TeamsSection />}
          </div>
        </main>
      </div>
    </div>
  );
}
