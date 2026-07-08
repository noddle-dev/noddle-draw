/**
 * features/comments/MentionsBell — 🔔 the cross-board inbox (M1 #4).
 *
 * Two feeds share this bell: @mentions (/api/me/mentions) and notifications
 * (/api/me/notifications — today just share invites). Both are polled for
 * signed-in users; the badge counts items the user hasn't opened yet. "Seen"
 * is a client-side badge aid (localStorage set of item ids), not durable inbox
 * state — the server endpoints stay pure reads. Clicking a row jumps to the
 * board (/d/{id}); opening the dropdown marks everything seen.
 */
import { useEffect, useState } from "react";
import {
  api,
  type MentionOut,
  type NotificationOut,
} from "../../shared/api/client";
import { useAuthStore } from "../../state/authStore";
import { useAppStore } from "../../state/appStore";

const SEEN_KEY = "noddle-mentions-seen";
const POLL_MS = 60_000;

/** A mention or a notification, unified for the merged list. */
type Item =
  | { kind: "mention"; id: string; ts: number; data: MentionOut }
  | { kind: "notif"; id: string; ts: number; data: NotificationOut };

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(ids: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* storage full/blocked — badge just stays */
  }
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function MentionsBell() {
  const me = useAuthStore((s) => s.me);
  const openInEditor = useAppStore((s) => s.openInEditor);
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  const signedIn = me?.kind === "user";

  useEffect(() => {
    if (!signedIn) {
      setItems([]);
      return;
    }
    let alive = true;
    const pull = () =>
      void Promise.all([
        api.myMentions().catch(() => [] as MentionOut[]),
        api.myNotifications().catch(() => [] as NotificationOut[]),
      ]).then(([mentions, notifs]) => {
        if (!alive) return;
        const merged: Item[] = [
          ...mentions.map(
            (m): Item => ({ kind: "mention", id: m.comment_id, ts: m.created_at, data: m }),
          ),
          ...notifs.map(
            (n): Item => ({ kind: "notif", id: n.id, ts: n.ts, data: n }),
          ),
        ];
        merged.sort((a, b) => b.ts - a.ts);
        setItems(merged);
      });
    pull();
    const t = setInterval(pull, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [signedIn]);

  if (!signedIn) return null;

  const unseen = items.filter((it) => !seen.has(it.id)).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unseen > 0) {
      const all = new Set(seen);
      for (const it of items) all.add(it.id);
      setSeen(all);
      saveSeen(all);
    }
  };

  const roleLabel = (role?: string) => (role === "viewer" ? "viewer" : "editor");

  return (
    <div className="mentions-bell">
      <button className="icon-btn" title="Notifications & mentions" onClick={toggle}>
        🔔{unseen > 0 && <span className="count">{unseen > 9 ? "9+" : unseen}</span>}
      </button>
      {open && (
        <div>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-pop mentions-pop" style={{ top: 40 }}>
            <div className="menu-body">
              <div className="mentions-title">Notifications</div>
              {items.length === 0 && (
                <div className="mentions-empty">
                  Nothing yet. Share invites and @mentions of you will show up here.
                </div>
              )}
              {items.map((it) =>
                it.kind === "notif" ? (
                  <button
                    key={it.id}
                    className="mentions-row notif-row"
                    onClick={() => {
                      setOpen(false);
                      if (it.data.doc_id) openInEditor(it.data.doc_id);
                    }}
                  >
                    <span className="avatar" style={{ background: it.data.actor_color || "#9aa1ad" }}>
                      {(it.data.actor_name ?? "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="txt">
                      <span className="who">
                        <b>{it.data.actor_name ?? "Someone"}</b> shared a board
                      </span>
                      <span className="body">
                        “{it.data.doc_name ?? "a board"}” with you as {roleLabel(it.data.role)}
                      </span>
                    </span>
                    <span className="when">{timeAgo(it.ts)}</span>
                  </button>
                ) : (
                  <button
                    key={it.id}
                    className="mentions-row"
                    onClick={() => { setOpen(false); openInEditor(it.data.doc_id); }}
                  >
                    <span className="avatar" style={{ background: it.data.author_color }}>
                      {it.data.author_name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="txt">
                      <span className="who">
                        <b>{it.data.author_name}</b> · {it.data.doc_name}
                        {it.data.resolved ? " · ✓" : ""}
                      </span>
                      <span className="body">{it.data.body}</span>
                    </span>
                    <span className="when">{timeAgo(it.ts)}</span>
                  </button>
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
