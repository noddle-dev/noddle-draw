/**
 * features/jobs/JobsTray — floating background-jobs tray (bottom-right, like
 * Drive's upload tray). Shows every image→board job with a REAL progress bar.
 * Jobs live on the SERVER (see state/jobsStore): the tray merges in the
 * per-user history on mount, so running conversions and past results survive
 * page reloads. A finished row opens the board it created.
 */
import { useEffect } from "react";
import { useAppStore } from "../../state/appStore";
import { useJobsStore } from "../../state/jobsStore";

export function JobsTray() {
  const jobs = useJobsStore((s) => s.jobs);
  const dismiss = useJobsStore((s) => s.dismiss);
  const clearFinished = useJobsStore((s) => s.clearFinished);
  const loadHistory = useJobsStore((s) => s.loadHistory);
  const openInEditor = useAppStore((s) => s.openInEditor);


  // merge the server-side history in once we know who's signed in
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  if (jobs.length === 0) return null;
  const active = jobs.filter((j) => j.status === "queued" || j.status === "processing").length;

  return (
    <div className="jobs-tray">
      <div className="jobs-head">
        <span>
          ✦ Image → board {active > 0 ? `(${active} running)` : "(history)"}
        </span>
        {active === 0 && (
          <button className="jobs-clear" onClick={clearFinished}>Clear</button>
        )}
      </div>
      {jobs.map((j) => {
        const openable = j.status === "done" && !!j.docId;
        // session uploads carry an object-URL preview; history rows fall back
        // to the created board's rendered SVG
        const thumb = j.previewUrl || (openable ? `/api/documents/${j.docId}/export.svg` : "");
        return (
          <div
            key={j.id}
            className={`jobs-row${openable ? " openable" : ""}`}
            onClick={openable ? () => openInEditor(j.docId!) : undefined}
            role={openable ? "button" : undefined}
            title={openable ? "Open the board created from this image" : undefined}
          >
            {thumb ? (
              <img className="jobs-thumb" src={thumb} alt="" aria-hidden="true" />
            ) : (
              <span className="jobs-thumb jobs-thumb-ph" aria-hidden="true">◲</span>
            )}
            <div className="jobs-info">
              <span className="jobs-name" title={j.prompt || j.name}>
                {j.status === "done" ? "✅" : j.status === "error" ? "⚠️" : j.status === "processing" ? "⚙️" : "⏳"}{" "}
                {j.name}
              </span>
              {j.status === "error" ? (
                <span className="jobs-err">{j.error}</span>
              ) : (
                <div className="jobs-bar">
                  <span
                    className={j.status === "processing" ? "run" : undefined}
                    style={{ width: `${Math.round(j.progress * 100)}%` }}
                  />
                </div>
              )}
            </div>
            {openable && (
              <button
                className="btn btn-primary"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={(e) => { e.stopPropagation(); openInEditor(j.docId!); }}
              >
                Open
              </button>
            )}
            {(j.status === "done" || j.status === "error") && (
              <button
                className="jobs-x"
                onClick={(e) => { e.stopPropagation(); dismiss(j.id); }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
