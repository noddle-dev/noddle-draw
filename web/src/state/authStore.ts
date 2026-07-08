/**
 * state/authStore — the signed-in identity (ADR-0002).
 *
 * `me` is null while unknown, `{kind:"guest"}` when anonymous, or the user
 * profile. Loaded once on boot; login/register/logout/profile actions keep it
 * in sync. Collab presence prefers this identity over the per-tab guest one
 * (see collabStore.getIdentity).
 */
import { create } from "zustand";
import { api, type Me, type MePatch } from "../shared/api/client";

interface AuthState {
  me: Me | null; // null = not yet loaded
  /** Server runs in anonymous mode (NODDLE_ANON) — guests draw without login. */
  anon: boolean;
  loadMe: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Patch name/color/title/avatar (`avatar: null` removes the picture). */
  patchProfile: (patch: MePatch) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  me: null,
  anon: false,

  async loadMe() {
    // feature flags first — the login gate must not flash for anon servers
    try {
      const cfg = await api.getConfig();
      set({ anon: !!cfg.anon });
    } catch { /* older servers have no /api/config — assume accounts mode */ }
    try {
      set({ me: await api.me() });
    } catch {
      set({ me: { kind: "guest" } });
    }
  },

  async login(email, password) {
    set({ me: await api.login(email, password) });
  },

  async register(email, name, password) {
    set({ me: await api.register(email, name, password) });
  },

  async logout() {
    await api.logout();
    set({ me: { kind: "guest" } });
  },

  async patchProfile(patch) {
    set({ me: await api.patchMe(patch) });
  },
}));
