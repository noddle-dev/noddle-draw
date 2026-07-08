/**
 * features/ai/BackendSelect — per-upload AI billing picker.
 *
 * Image→board uploads used to silently follow the ACCOUNT-level AI mode, so
 * subscription users burned ✦ credits without realizing a BYOK key was an
 * option. This select makes the choice explicit PER CALL: the ✦ wallet
 * ("subscription") or one of the named BYOK profiles ("byok:{id}" — the
 * user's own key, 0 ✦ charged). The value is the `backend` form field of
 * POST /api/ai/image-to-svg.
 *
 * On first settings load it initializes an empty value to mirror the
 * account's mode, so what the select shows is exactly what gets charged.
 * Renders nothing for guests/agents (they ride the shared pool, unmetered)
 * and while settings are still loading.
 */
import { useEffect, useState } from "react";
import { api, type AiBackendChoice, type AiSettings } from "../../shared/api/client";
import { useAuthStore } from "../../state/authStore";

export function BackendSelect({
  value,
  onChange,
}: {
  value: AiBackendChoice;
  onChange: (v: AiBackendChoice) => void;
}) {
  const me = useAuthStore((s) => s.me);
  const signedIn = me?.kind === "user";
  const [settings, setSettings] = useState<AiSettings | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api
      .getAiSettings()
      .then((s) => {
        if (live) setSettings(s);
      })
      .catch(() => {}); // no settings ⇒ selector simply stays hidden
    return () => {
      live = false;
    };
  }, [signedIn]);

  // Initialize "" → the account's current mode; also heal a stale value that
  // points at a deleted/keyless profile (e.g. restored from localStorage).
  useEffect(() => {
    if (!settings) return;
    const usable = settings.byok_profiles.filter((p) => p.has_key);
    if (value.startsWith("byok:") && usable.some((p) => `byok:${p.id}` === value)) return;
    if (value === "subscription") return;
    const active =
      usable.find((p) => p.id === settings.byok_active_id) ?? usable[0];
    // Prefer the user's own key whenever one exists — the wallet path also
    // needs the server-side Databricks pool, which some deploys don't have.
    onChange(
      active && (settings.mode === "byok" || value.startsWith("byok:"))
        ? `byok:${active.id}`
        : "subscription",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, value]);

  if (!signedIn || !settings) return null;
  const cost = settings.costs.image_to_svg ?? 1;
  const usable = settings.byok_profiles.filter((p) => p.has_key);
  return (
    <label className="ai-backend" title="Who pays for this AI conversion">
      <span className="lbl">Run with</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as AiBackendChoice)}
      >
        <option value="subscription">
          ✦ Plan credits — {settings.credits} ✦ left · {cost} ✦ per image
        </option>
        {usable.map((p) => (
          <option key={p.id} value={`byok:${p.id}`}>
            {p.name} · your {p.provider} key — 0 ✦
          </option>
        ))}
      </select>
    </label>
  );
}
