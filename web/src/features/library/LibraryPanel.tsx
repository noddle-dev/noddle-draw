/**
 * features/library/LibraryPanel — Simple mode's floating Library browser.
 *
 * Right-hand island (shares the slot with the Properties/AI panel — see
 * appStore.libraryOpen). Top to bottom: a search box (name + tags, across
 * every pack; Esc clears, a second Esc closes), category chips (All + one per
 * pack, hue dot), "My library" (the user's saved stencils from
 * myShapesStore), then each built-in pack as a 2-column card grid.
 *
 * A card is the shared state/canvasDrop gesture: click → stamp at the visible
 * canvas centre, drag → stamp under the pointer. Both go through
 * diagramStore.insertFragment (fresh ids, one shared group, on top).
 */
import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { findFreeSpot, type DiagramEdge, type DiagramNode, type Vec } from "../../editor-core/diagram";
import { useAppStore } from "../../state/appStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useMyShapesStore } from "../../state/myShapesStore";
import { canvasCenterPoint, startFragmentDrag } from "../../state/canvasDrop";
import { BUILTIN_PACKS, LIBRARY_SHELVES } from "./builtins";
import { LibraryThumb } from "./LibraryThumb";
import { LIB_PALETTE } from "./palette";
import type { LibraryItem, LibraryPack } from "./types";

/** What a card needs — a built-in item or a saved "My shapes" stencil. */
interface CardItem {
  id: string;
  name: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

function matches(item: { name: string; tags?: string[] }, q: string): boolean {
  if (!q) return true;
  if (item.name.toLowerCase().includes(q)) return true;
  return (item.tags ?? []).some((t) => t.toLowerCase().includes(q));
}

/** Ghost for a card drag: a copy of the card's own thumbnail. */
function thumbGhost(source: Element): () => HTMLElement {
  return () => {
    const el = document.createElement("div");
    el.className = "lib-ghost";
    const svg = source.querySelector("svg.lib-thumb");
    if (svg) el.appendChild(svg.cloneNode(true));
    return el;
  };
}

/** Split a pack's items into consecutive same-`section` runs (sub-headers). */
function sectionRuns(items: LibraryItem[]): { name?: string; color?: string; items: LibraryItem[] }[] {
  const runs: { name?: string; color?: string; items: LibraryItem[] }[] = [];
  for (const it of items) {
    const last = runs[runs.length - 1];
    if (last && last.name === it.section) last.items.push(it);
    else runs.push({ name: it.section, color: it.sectionColor, items: [it] });
  }
  return runs;
}

function Card({
  item,
  onPlace,
  onDelete,
}: {
  item: CardItem;
  /** `dropped`: released over the canvas at `at`; false = click/keyboard. */
  onPlace: (at: Vec, dropped: boolean) => void;
  onDelete?: () => void;
}) {
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) =>
    startFragmentDrag(e, { ghost: thumbGhost(e.currentTarget), onDrop: onPlace });
  return (
    <div className="lib-card-wrap">
      <button
        type="button"
        className="lib-card"
        title={`${item.name} — click to add, or drag onto the board`}
        onPointerDown={onPointerDown}
        // Pointer presses are handled by the drag gesture above (a press
        // without movement = click → centre); detail 0 = keyboard activation.
        onClick={(e) => {
          if (e.detail === 0) onPlace(canvasCenterPoint(), false);
        }}
      >
        <span className="lib-card-thumb">
          <LibraryThumb nodes={item.nodes} edges={item.edges} />
        </span>
        <span className="lib-card-name">{item.name}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          className="lib-card-x"
          title="Remove from My library"
          aria-label={`Remove ${item.name} from My library`}
          onClick={onDelete}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** Doodle magnifier for the search field (no emoji per repo rule). */
function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M10.6 4.4 C14.4 4.2, 17 7, 16.8 10.6 C16.6 14.2, 13.8 16.9, 10.3 16.7 C6.8 16.5, 4.3 13.8, 4.5 10.3 C4.7 6.9, 7.2 4.6, 10.6 4.4 Z" />
      <path d="M15.2 15.3 C16.8 16.8, 18.3 18.4, 19.8 19.9" />
    </svg>
  );
}

const SHELF_KEY = "noddle-lib-shelf";
/** Pack order everywhere = shelf order (the chip row reads the same way). */
const SHELF_ORDER = LIBRARY_SHELVES.flatMap((s) => s.packs.map((p) => p.id));

export function LibraryPanel() {
  const setLibraryOpen = useAppStore((s) => s.setLibraryOpen);
  const myShapes = useMyShapesStore((s) => s.shapes);
  const canSave = useDiagramStore((s) => s.diagramSelection.some((id) => s.nodes[id]));
  const [query, setQuery] = useState("");
  // Two-level navigation (one row each, never a chip wall): a SHELF tab
  // (All · Diagrams · Wireframes · Cloud · Mine — remembered per browser) and,
  // inside a shelf, a horizontally scrolling row of its packs.
  const [shelf, setShelfState] = useState<string>(() => {
    try {
      return localStorage.getItem(SHELF_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  const setShelf = (id: string) => {
    setShelfState(id);
    setPackId(null);
    try {
      localStorage.setItem(SHELF_KEY, id);
    } catch {
      /* private mode */
    }
  };
  const [packId, setPackId] = useState<string | null>(null); // null = whole shelf
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const shelfDef = LIBRARY_SHELVES.find((s) => s.id === shelf);

  // A search always spans the WHOLE library (tabs only scope browsing).
  const packs: LibraryPack[] = useMemo(() => {
    const inScope = (p: LibraryPack) =>
      q ? true : shelf === "mine" ? false : packId ? p.id === packId : !shelfDef || shelfDef.packs.some((x) => x.id === p.id);
    return BUILTIN_PACKS.filter(inScope)
      .sort((a, b) => SHELF_ORDER.indexOf(a.id) - SHELF_ORDER.indexOf(b.id)) // = chip order
      .map((p) => ({ ...p, items: p.items.filter((it) => matches(it, q)) }))
      .filter((p) => p.items.length > 0);
  }, [packId, q, shelf, shelfDef]);
  const mine = myShapes.filter((s) => matches(s, q));
  // My library: its own tab always (the empty-state hint lives there); on
  // All / in search results only when it actually has something to show.
  const showMine = shelf === "mine" && !q ? true : (q || shelf === "all") && mine.length > 0;
  const empty = packs.length === 0 && !(showMine && mine.length > 0);
  const resultCount = packs.reduce((n, p) => n + p.items.length, 0) + mine.length;

  // A drop lands exactly where released; a click/keyboard insert starts at
  // the canvas centre but slides to the nearest free spot, so adding several
  // items in a row lays them out side by side instead of stacking them.
  const placeItem = (item: LibraryItem) => (at: Vec, dropped: boolean) => {
    const ds = useDiagramStore.getState();
    const spot = dropped ? at : findFreeSpot(Object.values(ds.nodes), item.w, item.h, at);
    ds.insertFragment(item, spot);
  };

  // Inline naming (no window.prompt): "+ Add selection" swaps in a small
  // input; Enter saves, Esc / blur-empty cancels.
  const [naming, setNaming] = useState<string | null>(null);
  const commitSave = () => {
    const name = (naming ?? "").trim();
    setNaming(null);
    if (name) useMyShapesStore.getState().saveFromSelection(name);
  };

  return (
    <div className="ed-panel right lib-panel" role="dialog" aria-label="Library">
      <div className="lib-head">
        <span className="lib-title">Library</span>
        <button
          className="ed-panel-close"
          title="Close library (Esc)"
          aria-label="Close library"
          onClick={() => setLibraryOpen(false)}
        >
          ×
        </button>
      </div>

      <label className="lib-search">
        <SearchGlyph />
        <input
          ref={searchRef}
          // NOT autofocused: the panel stays open while you draw, and a
          // focused search box would swallow every tool key (2, 3, L, Q…).
          type="search"
          value={query}
          placeholder="Search shapes & templates"
          aria-label="Search the library"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            if (query) setQuery("");
            else setLibraryOpen(false);
          }}
        />
      </label>

      <div className="lib-tabs" role="tablist" aria-label="Library shelves">
        {[{ id: "all", label: "All" }, ...LIBRARY_SHELVES, { id: "mine", label: "Mine" }].map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={!q && shelf === t.id}
            className={`lib-tab${!q && shelf === t.id ? " active" : ""}`}
            onClick={() => {
              setQuery("");
              setShelf(t.id);
            }}
          >
            {t.label}
            {t.id === "mine" && myShapes.length > 0 && <span className="lib-tab-ct">{myShapes.length}</span>}
          </button>
        ))}
      </div>

      {q ? (
        <div className="lib-results" role="status">
          {resultCount} result{resultCount === 1 ? "" : "s"} across the library
        </div>
      ) : (
        shelfDef && (
          // keyed by shelf: a fresh row starts scrolled to its first chip
          <div key={shelf} className="lib-chips lib-chips-row" role="group" aria-label={`${shelfDef.label} packs`}>
            <button
              type="button"
              className={`lib-chip${packId === null ? " active" : ""}`}
              aria-pressed={packId === null}
              onClick={() => setPackId(null)}
            >
              All {shelfDef.label.toLowerCase()}
            </button>
            {shelfDef.packs.map(({ id, short }) => {
              const p = BUILTIN_PACKS.find((x) => x.id === id);
              if (!p) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className={`lib-chip${packId === id ? " active" : ""}`}
                  aria-pressed={packId === id}
                  title={p.name}
                  onClick={() => setPackId(packId === id ? null : id)}
                >
                  <span className="lib-dot" style={{ background: LIB_PALETTE[p.hue].stroke }} />
                  {short}
                </button>
              );
            })}
          </div>
        )
      )}

      <div className="ed-panel-scroll lib-scroll">
        {showMine && (
          <section className="lib-section">
            <div className="lib-section-head">
              <span className="nm">My library</span>
              {naming !== null ? (
                <input
                  className="lib-name-input"
                  autoFocus
                  value={naming}
                  aria-label="Name for this library item"
                  onChange={(e) => setNaming(e.target.value)}
                  onBlur={commitSave}
                  onKeyDown={(e) => {
                    e.stopPropagation(); // Esc here must not close the panel
                    if (e.key === "Enter") commitSave();
                    else if (e.key === "Escape") setNaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="lib-add"
                  disabled={!canSave}
                  title={canSave ? "Save the selected shapes to My library" : "Select shapes on the board first"}
                  onClick={() => setNaming(`Shape ${myShapes.length + 1}`)}
                >
                  + Add selection
                </button>
              )}
            </div>
            {mine.length > 0 ? (
              <div className="lib-grid">
                {mine.map((s) => (
                  <Card
                    key={s.id}
                    item={s}
                    onPlace={(at, dropped) =>
                      useMyShapesStore.getState().instantiate(
                        s.id,
                        dropped ? at : findFreeSpot(Object.values(useDiagramStore.getState().nodes), s.w, s.h, at),
                      )
                    }
                    onDelete={() => useMyShapesStore.getState().remove(s.id)}
                  />
                ))}
              </div>
            ) : (
              !q && <p className="lib-hint">Select shapes on the board and add them here to reuse them.</p>
            )}
          </section>
        )}

        {packs.map((p) => (
          <section key={p.id} className="lib-section">
            <div className="lib-section-head">
              <span className="lib-dot" style={{ background: LIB_PALETTE[p.hue].stroke }} />
              <span className="nm">{p.name}</span>
              <span className="ct">{p.items.length}</span>
            </div>
            <p className="lib-blurb">{p.blurb}</p>
            {sectionRuns(p.items).map((run, ri) => (
              <div key={ri}>
                {run.name && (
                  <div className="lib-sub-head">
                    {run.color && <span className="lib-dot" style={{ background: run.color }} />}
                    {run.name}
                    <span className="ct">{run.items.length}</span>
                  </div>
                )}
                <div className="lib-grid">
                  {run.items.map((it) => (
                    <Card key={it.id} item={it} onPlace={placeItem(it)} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}

        {empty && q && (
          <div className="lib-empty">
            <p>Nothing matches “{query.trim()}”.</p>
            <button
              type="button"
              className="lib-add"
              onClick={() => {
                setQuery("");
                setPackId(null);
                searchRef.current?.focus();
              }}
            >
              Clear search
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
