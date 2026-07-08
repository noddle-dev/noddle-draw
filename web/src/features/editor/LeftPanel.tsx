/**
 * features/editor/LeftPanel — Shapes / Layers tabs (design chrome, real wiring).
 *
 * Shapes: adds a diagram node at the canvas centre (diagramStore.addNode; turns
 * diagram mode on). Layers: the REAL layer list — diagram nodes/connectors from
 * diagramStore and any uploaded-SVG objects from useLayers, each selectable.
 */
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { esc, screenToContent } from "../../editor-core";
import type { DiagramNode } from "../../editor-core/diagram";
import {
  MiniGlyph,
  SHAPE_SECTIONS,
  STENCIL_LIBRARIES,
  inUseEntries,
  type PaletteEntry,
} from "../diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";
import { useMyShapesStore, type MyShape } from "../../state/myShapesStore";
import { useLayers } from "../layers/useLayers";
import { addImageToBoard } from "./pasteImage";

// ---- stencil library picker (#19) — which icon libraries show in the panel.
const LIBS_KEY = "noddle-stencil-libs";
function loadEnabledLibs(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(LIBS_KEY) ?? "null");
    if (Array.isArray(raw)) return new Set(raw as string[]);
  } catch {
    /* fall through */
  }
  return new Set(["AWS", "Databricks / Data"]); // default = pre-#19 behavior
}
function saveEnabledLibs(libs: Set<string>): void {
  try {
    localStorage.setItem(LIBS_KEY, JSON.stringify([...libs]));
  } catch {
    /* ignore */
  }
}

/** init overrides for a palette entry (icon nodes carry an iconKey + label;
 * sticky notes carry a fill/stroke color). */
function entryInit(entry: PaletteEntry): Partial<DiagramNode> {
  const init: Partial<DiagramNode> = {};
  if (entry.iconKey) { init.iconKey = entry.iconKey; init.text = entry.label; }
  if (entry.fill) init.fill = entry.fill;
  if (entry.stroke) init.stroke = entry.stroke;
  if (entry.text) init.text = entry.text;
  return init;
}

function addNodeAtCenter(entry: PaletteEntry) {
  const ds = useDiagramStore.getState();
  ds.setDiagramMode(true);
  const refs = useEditorStore.getState().refs;
  let at = { x: 200, y: 150 };
  if (refs) {
    const r = refs.host.getBoundingClientRect();
    at = screenToContent(refs.content, r.left + r.width / 2, r.top + r.height / 2);
  }
  ds.addNode(entry.kind, at, entryInit(entry));
  useAppStore.getState().setRightTab("props");
}

/**
 * Pointer-based drag from a palette cell onto the canvas (Lucid-style).
 * A fixed-position ghost follows the cursor; releasing over the canvas host
 * drops the shape exactly there (screen→content via the shared camera).
 * A press without movement still behaves as click-to-add-at-center.
 */
function startShapeDrag(entry: PaletteEntry) {
  return (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLDivElement | null = null;
    let moved = false;

    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "shape-ghost";
        ghost.textContent = entry.glyph;
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
        // highlight the canvas while the drop would land on it
        const refs = useEditorStore.getState().refs;
        const over =
          refs &&
          (() => {
            const r = refs.host.getBoundingClientRect();
            return (
              ev.clientX >= r.left && ev.clientX <= r.right &&
              ev.clientY >= r.top && ev.clientY <= r.bottom
            );
          })();
        ghost.classList.toggle("droppable", Boolean(over));
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      ghost?.remove();
      if (!moved) {
        addNodeAtCenter(entry);
        return;
      }
      const refs = useEditorStore.getState().refs;
      if (!refs) return;
      const r = refs.host.getBoundingClientRect();
      const inside =
        ev.clientX >= r.left && ev.clientX <= r.right &&
        ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) return;
      const at = screenToContent(refs.content, ev.clientX, ev.clientY);
      const ds = useDiagramStore.getState();
      ds.setDiagramMode(true);
      ds.addNodeAt(entry.kind, at, entryInit(entry));
      useAppStore.getState().setRightTab("props");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

/** One palette cell — drag onto the board or click to add at center. */
function ShapeCell({ entry }: { entry: PaletteEntry }) {
  return (
    <button
      className="shape-cell"
      title={`Drag onto the board or click to add ${entry.label}`}
      onPointerDown={startShapeDrag(entry)}
    >
      <MiniGlyph entry={entry} />
    </button>
  );
}

/** Drag/click for a "My shapes" stencil — same ghost pattern as startShapeDrag,
 * but dropping stamps the whole saved fragment (fresh ids) at the point. */
function startMyShapeDrag(shape: MyShape) {
  return (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLDivElement | null = null;
    let moved = false;
    const place = (clientX: number, clientY: number, fallbackCenter: boolean) => {
      const refs = useEditorStore.getState().refs;
      if (!refs) return;
      const r = refs.host.getBoundingClientRect();
      const inside =
        clientX >= r.left && clientX <= r.right &&
        clientY >= r.top && clientY <= r.bottom;
      if (!inside && !fallbackCenter) return;
      const px = inside ? clientX : r.left + r.width / 2;
      const py = inside ? clientY : r.top + r.height / 2;
      const at = screenToContent(refs.content, px, py);
      useMyShapesStore.getState().instantiate(shape.id, at);
      useAppStore.getState().setRightTab("props");
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) {
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "shape-ghost";
        ghost.textContent = "▣";
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      ghost?.remove();
      place(ev.clientX, ev.clientY, !moved);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

/** Upload a raster image as an `image`-kind diagram node — behaves like any
 * shape (ports, arrows, resize). Same path as paste/drop (pasteImage.ts). */
function UploadImageSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (file) await addImageToBoard(file);
  };
  return (
    <div className="pgroup">
      <button
        className="btn my-shape-save"
        title="Upload a PNG/JPEG/WebP/GIF as a connectable shape (or paste / drop it onto the board)"
        onClick={() => inputRef.current?.click()}
      >
        ＋ Upload image
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: "none" }}
        onChange={onPick}
      />
    </div>
  );
}

/** "My shapes" (#20): saved selections as personal stencils. */
function MyShapesSection() {
  const shapes = useMyShapesStore((s) => s.shapes);
  const selection = useDiagramStore((s) => s.diagramSelection);
  const nodes = useDiagramStore((s) => s.nodes);
  const [open, setOpen] = useState(true);
  const canSave = selection.some((id) => nodes[id]);

  const save = () => {
    const name = window.prompt("Name for this shape:", `Shape ${shapes.length + 1}`);
    if (name === null) return;
    useMyShapesStore.getState().saveFromSelection(name);
  };

  return (
    <div className="pgroup">
      <button className="pgroup-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="nm">My shapes</span>
        <span className="ct">{shapes.length}</span>
      </button>
      {open && (
        <>
          <button
            className="btn my-shape-save"
            disabled={!canSave}
            title={canSave ? "Save the selected shapes as a stencil" : "Select shapes on the board first"}
            onClick={save}
          >
            ＋ Save selected shapes
          </button>
          {shapes.length > 0 && (
            <div className="my-shape-list">
              {shapes.map((s) => (
                <div key={s.id} className="my-shape-row">
                  <button
                    className="body"
                    title="Drag onto the board or click to add"
                    onPointerDown={startMyShapeDrag(s)}
                  >
                    <span className="glyph">▣</span>
                    <span className="nm">{esc(s.name)}</span>
                    <span className="ct">{s.nodes.length}</span>
                  </button>
                  <button
                    className="x"
                    title="Delete stencil"
                    onClick={() => useMyShapesStore.getState().remove(s.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ShapesTab() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [libs, setLibs] = useState<Set<string>>(loadEnabledLibs);
  const nodes = useDiagramStore((s) => s.nodes);
  const q = query.trim().toLowerCase();

  const toggleLib = (section: string) => {
    setLibs((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      saveEnabledLibs(next);
      return next;
    });
  };

  // "In use" = distinct shapes currently on the board (Lucid-style).
  // Searching looks across ALL libraries (even hidden ones) — hiding a library
  // only trims browsing noise, it never hides results you asked for.
  const libSections = new Set(STENCIL_LIBRARIES.map((l) => l.section));
  const inUse = inUseEntries(Object.values(nodes));
  const sections: { name: string; entries: PaletteEntry[] }[] = [
    ...(inUse.length ? [{ name: "In use", entries: inUse }] : []),
    ...SHAPE_SECTIONS.filter(
      (s) => !libSections.has(s.name) || libs.has(s.name) || q.length > 0,
    ),
  ];

  return (
    <>
      <div style={{ padding: "0 0 8px" }}>
        <div className="field">
          <span style={{ color: "var(--faint)", fontSize: 13 }}>⌕</span>
          <input placeholder="Search shapes…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="lib-chips">
          {STENCIL_LIBRARIES.map((l) => (
            <button
              key={l.section}
              className={`lib-chip${libs.has(l.section) ? " on" : ""}`}
              title={`Toggle the ${l.label} library`}
              onClick={() => toggleLib(l.section)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <UploadImageSection />
      <MyShapesSection />

      {sections.map((sec) => {
        const entries = sec.entries.filter(
          (en) => !q || en.label.toLowerCase().includes(q) || en.kind.toLowerCase().includes(q),
        );
        if (!entries.length) return null;
        const isOpen = open[sec.name] ?? true;
        return (
          <div className="pgroup" key={sec.name}>
            <button className="pgroup-head" onClick={() => setOpen((o) => ({ ...o, [sec.name]: !isOpen }))}>
              <span className="chev">{isOpen ? "▾" : "▸"}</span>
              <span className="nm">{sec.name}</span>
              <span className="ct">{entries.length}</span>
            </button>
            {isOpen && (
              <div className="shape-grid2">
                {entries.map((en, i) => (
                  <ShapeCell key={en.kind + (en.iconKey ?? "") + i} entry={en} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ padding: "10px 0 0" }}>
        <div className="ai-tip">
          <span className="ic">✦</span>
          <span>Tip: hover over a shape then drag from the <b>blue dot</b> to connect to another shape.</span>
        </div>
      </div>
    </>
  );
}

function LayersTab() {
  const svgRows = useLayers();
  const beginAction = useEditorStore((s) => s.beginAction);
  const commitAction = useEditorStore((s) => s.commitAction);
  const setSelection = useEditorStore((s) => s.setSelection);

  const nodes = useDiagramStore((s) => s.nodes);
  const edges = useDiagramStore((s) => s.edges);
  const diagramSelection = useDiagramStore((s) => s.diagramSelection);
  const setDiagramSelection = useDiagramStore((s) => s.setDiagramSelection);

  const nodeList = Object.values(nodes);
  const edgeList = Object.values(edges);

  const toggleVis = (el: SVGGraphicsElement, hidden: boolean) => {
    beginAction();
    el.setAttribute("display", hidden ? "inline" : "none");
    commitAction();
  };

  const empty = svgRows.length === 0 && nodeList.length === 0 && edgeList.length === 0;
  if (empty) return <p className="muted" style={{ padding: "8px 4px" }}>No objects yet.</p>;

  return (
    <>
      {nodeList.length > 0 && (
        <div className="pgroup">
          <div className="pgroup-head" style={{ cursor: "default", background: "var(--panel-2)" }}>
            <span className="dot" style={{ width: 9, height: 9, borderRadius: 3, background: "#2563eb" }} />
            <span className="nm">Shapes</span>
            <span className="ct">{nodeList.length}</span>
          </div>
          {nodeList.map((n) => (
            <button
              key={n.id}
              className={`layer-row${diagramSelection.includes(n.id) ? " selected" : ""}`}
              onClick={() => setDiagramSelection([n.id])}
            >
              <span className="dot" style={{ background: n.stroke }} />
              <span className="nm">{n.text || n.kind}</span>
            </button>
          ))}
        </div>
      )}

      {edgeList.length > 0 && (
        <div className="pgroup">
          <div className="pgroup-head" style={{ cursor: "default", background: "var(--panel-2)" }}>
            <span style={{ color: "var(--faint)", fontSize: 12, width: 10 }}>⇢</span>
            <span className="nm">Connectors</span>
            <span className="ct">{edgeList.length}</span>
          </div>
          {edgeList.map((e) => (
            <button
              key={e.id}
              className={`layer-row${diagramSelection.includes(e.id) ? " selected" : ""}`}
              onClick={() => setDiagramSelection([e.id])}
            >
              <span style={{ color: "var(--faint)", fontSize: 12 }}>⇢</span>
              <span className="nm">{e.label || "Connector"}</span>
            </button>
          ))}
        </div>
      )}

      {svgRows.length > 0 && (
        <div className="pgroup">
          <div className="pgroup-head" style={{ cursor: "default", background: "var(--panel-2)" }}>
            <span className="dot" style={{ width: 9, height: 9, borderRadius: 3, background: "#7c3aed" }} />
            <span className="nm">Elements</span>
            <span className="ct">{svgRows.length}</span>
          </div>
          {svgRows.map((row) => (
            <div
              key={row.id}
              className={`layer-row${row.selected ? " selected" : ""}`}
              onClick={() => setSelection([row.el])}
              role="button"
            >
              <span className="dot" style={{ background: "#9aa1ad" }} />
              <span className="nm">{esc(row.id) || esc(row.tag)}</span>
              <span className="tag">{esc(row.tag)}</span>
              <span
                className="vis"
                onClick={(e) => { e.stopPropagation(); toggleVis(row.el, row.hidden); }}
              >
                {row.hidden ? "🙈" : "👁"}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function LeftPanel() {
  const leftTab = useAppStore((s) => s.leftTab);
  const setLeftTab = useAppStore((s) => s.setLeftTab);

  return (
    <div className="ed-panel left">
      <div className="ed-tabs">
        <button className={`ed-tab${leftTab === "shapes" ? " active" : ""}`} onClick={() => setLeftTab("shapes")}>Shapes</button>
        <button className={`ed-tab${leftTab === "layers" ? " active" : ""}`} onClick={() => setLeftTab("layers")}>Layers</button>
      </div>
      <div className="ed-panel-scroll">
        {leftTab === "shapes" ? <ShapesTab /> : <LayersTab />}
      </div>
    </div>
  );
}
