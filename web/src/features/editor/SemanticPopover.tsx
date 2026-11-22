/**
 * features/editor/SemanticPopover — the "board semantics" touchpoint in the
 * top-left title island.
 *
 * Trigger: a compact gradient spark-graph jewel (32px icon button), plus the
 * board's category pill when `metadata.category` is set. It is also reachable
 * from ☰ → Board overview & semantics and the inspector's overview card.
 * Click → a floating panel anchored under the island:
 *   • hero header — board name, live status line, "Copy for AI" and a sliding
 *     Overview | Metadata switch;
 *   • Overview (default) — the LIVE semantic read of the active page
 *     (SemanticOverview: narrative, metrics, topology, zones, flows), so a
 *     board nobody annotated still explains itself;
 *   • Metadata — the board summary / category / domain / tags and the active
 *     page's summary / notes (BoardSemanticsForm).
 * Closes on outside pointerdown or Esc. Viewers see the same fields read-only.
 */
import { useEffect, useRef, useState } from "react";
import { titleCase } from "../../editor-core/diagram/semantics";
import { useEditorStore } from "../../state/editorStore";
import { usePagesStore } from "../../state/pagesStore";
import { SparkMark } from "../diagram/SemanticBadge";
import { BoardSemanticsForm } from "./SemanticFields";
import { CopyForAIButton, SemanticOverview, useLiveSemanticSummary } from "./SemanticOverview";

type SemTab = "overview" | "edit";

/** Overview | Metadata segmented switch (the thumb slides via `data-tab`). */
export function SemanticTabs({ tab, onTab, readOnly }: { tab: SemTab; onTab: (t: SemTab) => void; readOnly: boolean }) {
  return (
    <div className="sov-tabs" role="tablist" aria-label="Board semantics view" data-tab={tab}>
      <button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "on" : ""} onClick={() => onTab("overview")}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2.4" y="2.4" width="4.6" height="6" rx="1.3" />
          <rect x="9" y="2.4" width="4.6" height="3.4" rx="1.3" />
          <rect x="9" y="7.8" width="4.6" height="5.8" rx="1.3" />
          <rect x="2.4" y="10.4" width="4.6" height="3.2" rx="1.3" />
        </svg>
        Overview
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "edit"}
        className={tab === "edit" ? "on" : ""}
        title={readOnly ? "Board and page metadata (view only)" : "Edit the board and page metadata"}
        onClick={() => onTab("edit")}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.4 4.6 H8.2 M11.8 4.6 H13.6 M2.4 11.4 H4.2 M7.8 11.4 H13.6" />
          <circle cx="10" cy="4.6" r="1.8" />
          <circle cx="6" cy="11.4" r="1.8" />
        </svg>
        Metadata
      </button>
    </div>
  );
}

/** The popover body — mounted only while open, so the live analysis never
 * runs for a closed popover. */
function SemanticPopoverBody({ readOnly, onClose }: { readOnly: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<SemTab>("overview");
  const summary = useLiveSemanticSummary();
  const boardName = useEditorStore((s) => s.docName.replace(/^·\s*/, "").trim()) || "Untitled board";
  const pageName = usePagesStore((s) => (s.pages.length > 1 ? s.pages.find((p) => p.id === s.activeId)?.name : undefined));
  const category = summary.page?.category || summary.board?.category;
  const tagline = category === "architecture" ? "Live architectural intelligence" : "Live board intelligence";
  return (
    <div className="sem-pop" role="dialog" aria-label="Board semantics">
      <header className="sem-pop-hero">
        <div className="sem-pop-head">
          <span className="sem-jewel lg" aria-hidden="true"><SparkMark size={16} /></span>
          <div className="sem-pop-titles">
            <div className="sem-pop-title" title={boardName}>{boardName}</div>
            <div className="sem-pop-sub">
              <i className="sov-live-dot" aria-hidden="true" />
              <span>{tagline}{pageName ? ` · ${pageName}` : ""}</span>
            </div>
          </div>
          {readOnly && <span className="sem-ro">View only</span>}
          <CopyForAIButton summary={summary} />
          <button type="button" className="sem-x" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M4.2 4.2 L11.8 11.8 M11.8 4.2 L4.2 11.8" />
            </svg>
          </button>
        </div>
        <div className="sem-pop-nav">
          <SemanticTabs tab={tab} onTab={setTab} readOnly={readOnly} />
          <span className="sem-pop-kbd" aria-hidden="true"><kbd>esc</kbd> to close</span>
        </div>
      </header>
      <div className="sem-pop-body" key={tab}>
        {tab === "overview" ? (
          <SemanticOverview summary={summary} />
        ) : (
          <>
            <p className="sem-pop-note">
              Helps teammates and AI agents understand what this board is about. Never drawn on the canvas.
            </p>
            <BoardSemanticsForm readOnly={readOnly} />
          </>
        )}
      </div>
    </div>
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

/**
 * The title-island touchpoint. Compact by design (the inspector's
 * BoardOverviewCard already features the overview when nothing is selected):
 * a quiet 32px jewel button when the board has no category, jewel + category
 * pill when it does — never a wide pill that crowds the board title. Open
 * state can be controlled so the ☰ File menu ("Board overview & semantics")
 * opens the same popover.
 */
export function SemanticTrigger({
  readOnly,
  open: openProp,
  onOpenChange,
}: {
  readOnly: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(open) : v;
    if (onOpenChange) onOpenChange(next);
    if (openProp === undefined) setOpenLocal(next);
  };
  const category = usePagesStore((s) => s.metadata?.category);
  const hasSummary = usePagesStore((s) => !!s.metadata?.summary);
  const anchorRef = useRef<HTMLDivElement>(null);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpenRef.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A typed overview filter owns the first Esc (it clears itself).
      const t = e.target;
      if (t instanceof HTMLInputElement && t.hasAttribute("data-sov-filter") && t.value) return;
      e.stopPropagation();
      setOpenRef.current(false);
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
        className={`simple-island sem-trigger${category ? " has-cat" : " icon-only"}${open ? " active" : ""}`}
        title={category ? `Board overview & semantics — ${label}` : "Board overview & semantics"}
        aria-label={category ? `Board overview & semantics — ${label}` : "Board overview & semantics"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sem-jewel" aria-hidden="true">
          <SparkMark size={13} />
          {!category && hasSummary && <span className="sem-dot" />}
        </span>
        {category && <span className="sem-cat-pill">{label}</span>}
      </button>
      {open && <SemanticPopoverBody readOnly={readOnly} onClose={() => setOpen(false)} />}
    </div>
  );
}
