/**
 * TeamActivity — collapsible "Activity" panel for team admins (WS3).
 *
 * Lists the team's recent audit entries (actor · action · target · when)
 * from GET /api/teams/{teamId}/audit. Self-contained on purpose: it is
 * mounted inside the Teams tab by the integrator and brings no new CSS —
 * only existing classes (props-label, muted, btn, pill).
 */
import { useCallback, useEffect, useState } from "react";

// NOTE: shared/api/client.ts is owned by a parallel workstream in this
// change-set, so this panel keeps its own minimal fetch helper instead of
// touching that file. Same semantics: same-origin /api + session cookie.
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body — keep the status text */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

type AuditEntry = {
  ts: number | null;
  action: string | null;
  actor_kind: string | null;
  actor_id: string | null;
  actor_name: string | null;
  doc_id: string | null;
  detail: string | null;
  team_id: string | null;
};

type TeamAuditResponse = { team_id: string; entries: AuditEntry[] };

function timeAgo(ts: number | null): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function TeamActivity({ teamId }: { teamId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await getJson<TeamAuditResponse>(
        `/api/teams/${encodeURIComponent(teamId)}/audit?limit=50`,
      );
      setEntries(data.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load activity.");
    } finally {
      setBusy(false);
    }
  }, [teamId]);

  useEffect(() => {
    if (open && entries === null && !busy) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <button
          className="btn btn-ghost"
          style={{ padding: "2px 6px" }}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="props-label" style={{ margin: 0 }}>
            {open ? "▾" : "▸"} Activity
          </span>
        </button>
        {open && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11.5 }}
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? "Loading…" : "Refresh"}
          </button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 6 }}>
          {error && (
            <p style={{ color: "var(--danger-text)", fontSize: 12, margin: "4px 0" }}>
              {error}
            </p>
          )}
          {!error && entries !== null && entries.length === 0 && (
            <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
              No activity yet.
            </p>
          )}
          {!error && entries === null && (
            <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
              Loading…
            </p>
          )}
          {!error && entries !== null && entries.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {entries.map((e, i) => (
                <li
                  key={`${e.ts ?? 0}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                    padding: "4px 0",
                    fontSize: 12,
                  }}
                >
                  <strong style={{ whiteSpace: "nowrap" }}>
                    {e.actor_name || "Someone"}
                  </strong>
                  <span className="pill" style={{ fontSize: 10.5 }}>
                    {e.action || "event"}
                  </span>
                  <span
                    className="muted"
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={e.detail || e.doc_id || undefined}
                  >
                    {e.detail || e.doc_id || ""}
                  </span>
                  <span className="muted" style={{ whiteSpace: "nowrap", fontSize: 11 }}>
                    {timeAgo(e.ts)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
