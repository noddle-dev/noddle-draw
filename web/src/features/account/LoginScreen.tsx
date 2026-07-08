/**
 * features/account/LoginScreen — the full-page signed-out experience
 * (Lucid-style: dedicated login page, not a modal). Guests land here for any
 * app view that needs an identity (dashboard, generate) and when a board
 * deep-link answers 401/403 (appStore.authNotice explains why; the board
 * reopens automatically after sign-in via authRetryDocId — see App.tsx).
 * Share-link boards that ARE guest-accessible never route here.
 */
import { BrandLogo } from "../../shared/ui";
import { AuthForms } from "./AccountModal";

export function LoginScreen() {
  return (
    <div className="login-page">
      <header className="login-header">
        <span className="brand-mark" style={{ width: 28, height: 28 }}>
          <BrandLogo />
        </span>
        <span className="login-brand-name">Noddle Board</span>
      </header>
      <main className="login-main">
        <div className="login-card">
          <AuthForms />
        </div>
      </main>
    </div>
  );
}
