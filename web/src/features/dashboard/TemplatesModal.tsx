/**
 * features/dashboard/TemplatesModal — Lucid-style template gallery.
 *
 * Layout mirrors Lucid: header (title + search + ✕), a left category RAIL with
 * hand-drawn doodle icons, a "Create a diagram with AI" prompt box (routes to the
 * real text→diagram flow), then either horizontally-scrollable CAROUSEL rows
 * (Recommended / Popular / one per category on the "For you" landing) or a full
 * grid (a specific category, "All templates", or a search). Picking a card
 * creates a REAL document from the template (POST /api/documents/new) and
 * navigates to its /d/{id} URL.
 */
import { useMemo, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { TemplateThumb } from "./Thumbnails";
import {
  createBoard,
  POPULAR_IDS,
  RECOMMENDED_IDS,
  TEMPLATES,
  TPL_CATS,
  TPL_CAT_ORDER,
  type TemplateDef,
} from "./templates";

/** Hand-drawn doodle rail icons — sketchy stroke aesthetic (never glossy/emoji). */
function CatIcon({ name }: { name: string }) {
  const p = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "For you":
      return (
        <svg {...p}>
          <path d="M12 3.4l2.3 4.9 5.2.6-3.9 3.5 1.1 5.2L12 15.4 7.2 17.6l1.1-5.2L4.4 8.9l5.2-.6z" />
        </svg>
      );
    case "All templates":
      return (
        <svg {...p}>
          <rect x="3.6" y="3.6" width="7" height="7" rx="1.4" />
          <rect x="13.4" y="3.6" width="7" height="7" rx="1.4" />
          <rect x="3.6" y="13.4" width="7" height="7" rx="1.4" />
          <rect x="13.4" y="13.4" width="7" height="7" rx="1.4" />
        </svg>
      );
    case "Flowchart":
      return (
        <svg {...p}>
          <rect x="3.4" y="4" width="8" height="5.4" rx="1.4" />
          <path d="M15.8 12.2l3 3-3 3-3-3z" />
          <path d="M7.4 9.4v3.4h5.4" />
        </svg>
      );
    case "Org chart":
      return (
        <svg {...p}>
          <rect x="8.6" y="3.4" width="6.8" height="4.4" rx="1.2" />
          <rect x="2.8" y="15.6" width="6" height="4.2" rx="1.2" />
          <rect x="15.2" y="15.6" width="6" height="4.2" rx="1.2" />
          <path d="M12 7.8v3.6M5.8 15.6v-2.4h12.4v2.4M12 11.4v4.2" />
        </svg>
      );
    case "ERD":
      return (
        <svg {...p}>
          <rect x="3.4" y="4.6" width="7.4" height="9" rx="1.2" />
          <path d="M3.4 8h7.4M3.4 11h7.4" />
          <rect x="14" y="10.4" width="6.6" height="7" rx="1.2" />
          <path d="M10.8 8.2q3 0 3.2 4" />
        </svg>
      );
    case "Cloud":
      return (
        <svg {...p}>
          <path d="M7 17.4a3.4 3.4 0 01-.5-6.8 4.4 4.4 0 018.5-1.2 3.3 3.3 0 01.7 6.5" />
          <path d="M7 17.4h9.2" />
          <path d="M9.4 12.2l1.8 1.8 3-3.2" />
        </svg>
      );
    case "Sequence":
      return (
        <svg {...p}>
          <path d="M6 3.6v16.8M18 3.6v16.8" />
          <path d="M6 8.4h10.4M16.4 8.4l-2-1.6M16.4 8.4l-2 1.6" />
          <path d="M18 14.4H7.6M7.6 14.4l2-1.6M7.6 14.4l2 1.6" />
        </svg>
      );
    case "Retro":
      return (
        <svg {...p}>
          <rect x="3.6" y="5" width="7.2" height="7.2" rx="1.2" transform="rotate(-6 7.2 8.6)" />
          <rect x="12.6" y="10.4" width="7.2" height="7.2" rx="1.2" transform="rotate(5 16.2 14)" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

export function TemplatesModal() {
  const open = useAppStore((s) => s.tplModalOpen);
  const setTplModal = useAppStore((s) => s.setTplModal);
  const startNewWithAI = useAppStore((s) => s.startNewWithAI);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("For you");
  const [aiPrompt, setAiPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForNew, setShowForNew] = useState(true);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const byId = useMemo(() => new Map(TEMPLATES.map((t) => [t.id, t])), []);
  const pickIds = (ids: string[]) => ids.map((id) => byId.get(id)).filter((t): t is TemplateDef => !!t);

  const matches = (t: TemplateDef) =>
    t.name.toLowerCase().includes(q) || t.cat.toLowerCase().includes(q);

  // Search + explicit-category views are flat grids.
  const gridItems = useMemo(() => {
    if (searching) return TEMPLATES.filter(matches);
    if (cat === "All templates") return TEMPLATES;
    if (cat !== "For you") return TEMPLATES.filter((t) => t.cat === cat);
    return [];
  }, [cat, q, searching]);

  if (!open) return null;

  const pick = async (tpl?: TemplateDef) => {
    if (busy) return;
    setBusy(tpl ? tpl.id : "blank");
    setError(null);
    try {
      await createBoard(tpl); // navigates on success; 402 → global upgrade card
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Always stop the spinner: createBoard swallows the 402 quota case (shows
      // the upgrade card) and returns without navigating, so the card would
      // otherwise spin forever waiting for an unmount that never happens.
      setBusy(null);
    }
  };

  const submitAI = () => {
    const t = aiPrompt.trim();
    if (!t) return;
    startNewWithAI({ prompt: t }); // closes the modal (store action)
  };

  const catForRail = ["For you", "All templates"];

  return (
    <div className="tpl-overlay" onClick={() => setTplModal(false)}>
      <div className="tpl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tpl-head">
          <h1>Templates</h1>
          <div className="tpl-search field">
            <span style={{ color: "var(--faint)" }}>⌕</span>
            <input
              placeholder="Search all templates…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <button className="tpl-close" onClick={() => setTplModal(false)}>✕</button>
        </div>

        <div className="tpl-body">
          <div className="tpl-side">
            {catForRail.map((c) => (
              <button
                key={c}
                className={`tpl-side-item${cat === c && !searching ? " active" : ""}`}
                onClick={() => {
                  setQuery("");
                  setCat(c);
                }}
              >
                <span className="ico"><CatIcon name={c} /></span> {c}
              </button>
            ))}
            <div className="tpl-side-sep" />
            {TPL_CATS.filter((c) => c !== "All").map((c) => (
              <button
                key={c}
                className={`tpl-side-item${cat === c && !searching ? " active" : ""}`}
                onClick={() => {
                  setQuery("");
                  setCat(c);
                }}
              >
                <span className="ico"><CatIcon name={c} /></span> {c}
              </button>
            ))}
            <div className="spacer" />
            <label className="tpl-shownew">
              <input
                type="checkbox"
                checked={showForNew}
                onChange={(e) => setShowForNew(e.target.checked)}
              />
              Show for new documents
            </label>
          </div>

          <div className="tpl-main">
            <div className="tpl-section-title">
              Create a diagram with AI{" "}
              <span
                title="AI-Noddle drafts an editable diagram from your description"
                style={{ color: "var(--faint)", cursor: "help" }}
              >
                ⓘ
              </span>
            </div>
            <div className="tpl-ai-box">
              <textarea
                placeholder="Create a diagram with AI…"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitAI();
                  }
                }}
              />
              <div className="tpl-ai-actions">
                <button
                  className="chat-send"
                  title="Generate with AI-Noddle"
                  disabled={!aiPrompt.trim()}
                  onClick={submitAI}
                >
                  ↑
                </button>
              </div>
            </div>

            {searching ? (
              <>
                <div className="tpl-section-title" style={{ marginTop: 26 }}>
                  Results for “{query.trim()}”
                </div>
                <div className="tpl-grid">
                  {gridItems.map((t) => (
                    <TemplateCard key={t.id} tpl={t} busy={busy} onPick={pick} />
                  ))}
                  {gridItems.length === 0 && (
                    <p className="muted" style={{ gridColumn: "1 / -1" }}>
                      No templates match “{query.trim()}”.
                    </p>
                  )}
                </div>
              </>
            ) : cat === "For you" ? (
              <>
                <SectionTitle>Recommended</SectionTitle>
                <Carousel>
                  <BlankCard busy={busy} onPick={() => void pick()} />
                  {pickIds(RECOMMENDED_IDS).map((t) => (
                    <TemplateCard key={t.id} tpl={t} busy={busy} onPick={pick} fixed />
                  ))}
                </Carousel>

                <SectionTitle>Popular</SectionTitle>
                <Carousel>
                  {pickIds(POPULAR_IDS).map((t) => (
                    <TemplateCard key={t.id} tpl={t} busy={busy} onPick={pick} fixed />
                  ))}
                </Carousel>

                {TPL_CAT_ORDER.map((c) => {
                  const items = TEMPLATES.filter((t) => t.cat === c);
                  if (!items.length) return null;
                  return (
                    <div key={c}>
                      <SectionTitle>
                        <span className="tpl-row-ico"><CatIcon name={c} /></span>
                        {c}
                        <button className="tpl-row-more" onClick={() => setCat(c)}>
                          See all
                        </button>
                      </SectionTitle>
                      <Carousel>
                        {items.map((t) => (
                          <TemplateCard key={t.id} tpl={t} busy={busy} onPick={pick} fixed />
                        ))}
                      </Carousel>
                    </div>
                  );
                })}
              </>
            ) : (
              <>
                <div className="tpl-section-title" style={{ marginTop: 26 }}>
                  {cat === "All templates" ? "All templates" : cat}
                </div>
                <div className="tpl-grid">
                  {cat === "All templates" && (
                    <BlankCard busy={busy} onPick={() => void pick()} inGrid />
                  )}
                  {gridItems.map((t) => (
                    <TemplateCard key={t.id} tpl={t} busy={busy} onPick={pick} />
                  ))}
                </div>
              </>
            )}

            {error && (
              <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 14 }}>{error}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="tpl-section-title tpl-row-title" style={{ marginTop: 26 }}>
      {children}
    </div>
  );
}

/** Horizontally-scrollable carousel row with prev/next affordances. */
function Carousel({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * 520, behavior: "smooth" });
  return (
    <div className="tpl-carousel">
      <button
        className="tpl-row-nav left"
        onClick={() => scroll(-1)}
        aria-label="Scroll left"
        type="button"
      >
        ‹
      </button>
      <div className="tpl-row-scroll" ref={ref}>
        {children}
      </div>
      <button
        className="tpl-row-nav right"
        onClick={() => scroll(1)}
        aria-label="Scroll right"
        type="button"
      >
        ›
      </button>
    </div>
  );
}

function BlankCard({
  busy,
  onPick,
  inGrid,
}: {
  busy: string | null;
  onPick: () => void;
  inGrid?: boolean;
}) {
  return (
    <button
      className={`tpl-card${inGrid ? "" : " tpl-card-fixed"}`}
      onClick={onPick}
      disabled={busy !== null}
    >
      <div className="tpl-card-thumb blank">
        {busy === "blank" ? <span className="tpl-spin" /> : <span className="plus">＋</span>}
      </div>
      <div className="tpl-card-name">Blank board</div>
      <div className="tpl-card-sub">Start from scratch</div>
    </button>
  );
}

function TemplateCard({
  tpl,
  busy,
  onPick,
  fixed,
}: {
  tpl: TemplateDef;
  busy: string | null;
  onPick: (t: TemplateDef) => void | Promise<void>;
  fixed?: boolean;
}) {
  return (
    <button
      className={`tpl-card${fixed ? " tpl-card-fixed" : ""}`}
      onClick={() => void onPick(tpl)}
      disabled={busy !== null}
    >
      <div className="tpl-card-thumb" style={{ background: tpl.soft }}>
        {busy === tpl.id ? <span className="tpl-spin" /> : <TemplateThumb tpl={tpl} />}
      </div>
      <div className="tpl-card-name">
        <span className="spark" style={{ marginRight: 5 }}>✦</span>
        {tpl.name}
      </div>
      <div className="tpl-card-sub">
        {tpl.cat} · {tpl.count}
      </div>
    </button>
  );
}
