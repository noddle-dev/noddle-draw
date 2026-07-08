/**
 * shared/config — frontend feature flags.
 *
 * EMAIL_AUTH_ENABLED: shows the email/password login/register UI (AccountModal).
 * Enabled alongside SSO: the topbar prefers "Sign in with SSO" when an OIDC
 * provider is configured (oidcStatus.enabled), and falls back to this email
 * login otherwise. Flip to `false` to run in open/guest mode.
 */
export const EMAIL_AUTH_ENABLED = true;
