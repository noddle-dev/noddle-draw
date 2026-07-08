/**
 * features/editor/HistoryPanel — version history dropdown (M1).
 *
 * Lists the board's snapshots (newest first); selecting one fetches the full
 * payload and shows an SVG thumbnail preview. Restore is CLIENT-driven: PUT
 * the snapshot back as a normal save (server sanitizes/validates and records
 * it as the newest version), reload via openDoc, then force a state broadcast
 * so collaborators see the restored board immediately (openDoc's programmatic
 * page load is suppressed from the normal change-subscriber).
 */
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type AuditEvent,
  type VersionMeta,
  type VersionOut,
} from "../../shared/api/client";
import { useEditorStore } from "../../state/editorStore";
import { broadcastDiagramNow } from "../../state/collabStore";

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today ${hm}` : `${d.toLocaleDateString("vi-VN")} ${hm}`;
}

export function HistoryPanel({ docId, onClose }: { docId: string; onClose: () => void }) {
  const myRole = useEditorStore((s) => s.myRole);
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [selected, setSelected] = useState<VersionOut | null>(null);
  const [busy, setBusy] = useState(false);
  // Owner-visible audit trail (#22) — 403s (non-owners) just hide the section.
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);

  useEffect(() => {
    void api.listVersions(docId).then(setVersions).catch(() => setVersions([]));
    if (myRole === "owner") {
      void api.docAudit(docId).then(setAudit).catch(() => setAudit([]));
    }
  }, [docId, myRole]);

  const previewUrl = useMemo(
    () =>
      selected
        ? URL.createObjectURL(new Blob([selected.svg], { type: "image/svg+xml" }))
        : null,
    [selected],
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const pick = (v: VersionMeta) => {
    setSelected(null);
    void api.getVersion(docId, v.id).then(setSelected).catch(() => setSelected(null));
  };

  const restore = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.save(docId, selected.svg, (selected.diagram ?? null) as never);
      await useEditorStore.getState().openDoc(docId);
      broadcastDiagramNow(); // peers get the restored state
      useEditorStore
        .getState()
        .setStatus(`Restored version ${fmtTime(selected.created_at)}`, "ok");
      onClose();
    } catch {
      useEditorStore.getState().setStatus("Restore failed", "error");
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu-pop history-pop" style={{ top: 42 }}>
        <div className="menu-body">
          <div className="history-title">🕘 Version history</div>
          {versions === null && <div className="history-empty">Loading…</div>}
          {versions !== null && versions.length === 0 && (
            <div className="history-empty">
              No versions yet — every save creates a snapshot.
            </div>
          )}
          <div className="history-list">
            {versions?.map((v) => (
              <button
                key={v.id}
                className={`history-row${selected?.id === v.id ? " active" : ""}`}
                onClick={() => pick(v)}
              >
                <span className="when">{fmtTime(v.created_at)}</span>
                <span className="who">{v.author_name || "Guest"}</span>
              </button>
            ))}
          </div>
          {audit.length > 0 && (
            <div className="audit-block">
              <button className="pgroup-head" onClick={() => setAuditOpen((v) => !v)}>
                <span className="chev">{auditOpen ? "▾" : "▸"}</span>
                <span className="nm">Activity log</span>
                <span className="ct">{audit.length}</span>
              </button>
              {auditOpen && (
                <div className="audit-list">
                  {audit.map((e, i) => (
                    <div key={i} className="audit-row">
                      <span className="when">{fmtTime(e.ts)}</span>
                      <span className="what">
                        <b>{e.actor_name}</b> · {e.action}
                        {e.detail ? ` — ${e.detail}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {selected && previewUrl && (
            <div className="history-preview">
              <img src={previewUrl} alt="Version preview" />
              <button
                className="btn btn-primary"
                disabled={busy || myRole === "viewer"}
                title={myRole === "viewer" ? "You have view-only access" : undefined}
                onClick={() => void restore()}
              >
                {busy ? "Restoring…" : "⟲ Restore this version"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
