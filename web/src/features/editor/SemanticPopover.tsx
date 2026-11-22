/**
 * features/editor/SemanticPopover — the quiet "board semantics" touchpoint in
 * the top-left title island.
 *
 * Trigger: a subtle category pill + info mark when `metadata.category` is set,
 * else a lone doodle tag icon. Click → a popover anchored under the island
 * with two tabs:
 *   • Overview (default) — the LIVE semantic read of the active page
 *     (SemanticOverview: summary + computed overview, zones, flows), so a
 *     board nobody annotated still explains itself; "Copy for AI" exports it
 *     as Markdown.
 *   • Edit metadata — the board summary / category / domain / tags and the
 *     active page's summary / notes (BoardSemanticsForm).
 * Closes on outside pointerdown or Esc. Viewers see the same fields read-only.
 */
import { useEffect, useRef, useState } from "react";
import { titleCase } from "../../editor-core/diagram/semantics";
import { usePagesStore } from "../../state/pagesStore";
import { BoardSemanticsForm } from "./SemanticFields";
import { CopyForAIButton, SemanticOverview, useLiveSemanticSummary } from "./SemanticOverview";

type SemTab = "overview" | "edit";

/** Overview | Edit metadata segmented switch. */
export function SemanticTabs({ tab, onTab, readOnly }: { tab: SemTab; onTab: (t: SemTab) => void; readOnly: boolean }) {
  return (
    <div className="sov-tabs" role="tablist" aria-label="Board semantics view">
      <button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "on" : ""} onClick={() => onTab("overview")}>
        Overview
      </button>
      <button type="button" role="tab" aria-selected={tab === "edit"} className={tab === "edit" ? "on" : ""} onClick={() => onTab("edit")}>
        {readOnly ? "Metadata" : "Edit metadata"}
      </button>
    </div>
  );
}

/** The popover body — mounted only while open, so the live analysis never
 * runs for a closed popover. */
function SemanticPopoverBody({ readOnly, onClose }: { readOnly: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<SemTab>("overview");
  const summary = useLiveSemanticSummary();
  return (
    <div className="sem-pop" role="dialog" aria-label="Board semantics">
      <div className="sem-pop-head">
        <span className="sem-pop-title">Board semantics</span>
        {readOnly && <span className="sem-ro">view only</span>}
        <CopyForAIButton summary={summary} />
        <button type="button" className="sem-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <SemanticTabs tab={tab} onTab={setTab} readOnly={readOnly} />
      <div className="sem-pop-body">
        {tab === "overview" ? (
          <SemanticOverview summary={summary} />
        ) : (
          <>
            <p className="sem-pop-sub">Helps teammates and AI agents understand what this board is about. Never drawn on the canvas.</p>
            <BoardSemanticsForm readOnly={readOnly} />
          </>
        )}
      </div>
    </div>
  );
}

/** Doodle tag (no category yet) — rough single stroke, currentColor. */
function TagDoodle() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.6 11.2 L11.4 3.5 L19.8 3.9 L20.3 12.4 L12.6 20.2 Q11.9 20.9 11.1 20.2 L3.7 12.8 Q3 12 3.6 11.2 Z" />
      <circle cx="15.6" cy="8.1" r="1.4" />
    </svg>
  );
}

/** Small hand-drawn "i" in a circle. */
export function InfoDoodle({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M8 1.9 C4.4 1.8 1.9 4.5 2 8.1 C2.1 11.6 4.6 14.1 8.1 14 C11.5 13.9 14.1 11.4 14 7.9 C13.9 4.6 11.5 2 8 1.9 Z" />
      <path d="M8 7.3 V11.2 M8 4.9 v.1" />
    </svg>
  );
}

export function SemanticTrigger({ readOnly }: { readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const category = usePagesStore((s) => s.metadata?.category);
  const hasSummary = usePagesStore((s) => !!s.metadata?.summary);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Capture: the canvas stops propagation of its own pointerdowns.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label = category ? titleCase(category) : "";
  return (
    <div className="sem-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`simple-island sem-trigger${category ? " has-cat" : " simple-sq"}${open ? " active" : ""}`}
        title="Board semantics & summary"
        aria-label={category ? `Board semantics & summary — ${label}` : "Board semantics & summary"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        {category ? (
          <>
            <span className="sem-cat-pill">{label}</span>
            <InfoDoodle />
          </>
        ) : (
          <>
            <TagDoodle />
            {hasSummary && <span className="sem-dot" aria-hidden="true" />}
          </>
        )}
      </button>
      {open && <SemanticPopoverBody readOnly={readOnly} onClose={() => setOpen(false)} />}
    </div>
  );
}
