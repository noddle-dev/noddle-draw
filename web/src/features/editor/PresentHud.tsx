/** Presentation controls: navigation, content/page framing and transient pointer. */
import { useEffect, useRef, useState } from "react";
import { ZOOM_KEY_STEP } from "../../editor-core";
import { useAppStore } from "../../state/appStore";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { usePagesStore } from "../../state/pagesStore";

type Framing = "page" | "content";

/** Keep the slide above the control bar, including after fullscreen/resize. */
function frameSlide(mode: Framing) {
  const ed = useEditorStore.getState();
  if (!ed.refs) return;
  const { host, content } = ed.refs;
  const view = host.getBoundingClientRect();
  const hud = document.querySelector(".present-hud:not([hidden]), .present-restore")?.getBoundingClientRect();
  const bottom = hud ? Math.max(0, view.bottom - hud.top) + 20 : 24;
  let box = { x: ed.artboard.ox ?? 0, y: ed.artboard.oy ?? 0, width: ed.artboard.w, height: ed.artboard.h };
  if (mode === "content") {
    const layers = [content, host.querySelector<SVGGElement>("#diagram-layer")];
    const boxes = layers.flatMap((layer) => {
      if (!layer) return [];
      const b = layer.getBBox();
      return b.width > 0 && b.height > 0 ? [b] : [];
    });
    if (boxes.length) {
      const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
      box = { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
        height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
    }
  }
  const height = Math.max(80, view.height - bottom);
  const z = Math.max(0.02, Math.min(mode === "page" ? 1 : 4,
    Math.max(40, view.width - 64) / Math.max(1, box.width),
    Math.max(40, height - 48) / Math.max(1, box.height)));
  ed.setCam({ z, x: (view.width - box.width * z) / 2 - box.x * z,
    y: (height - box.height * z) / 2 - box.y * z });
}

function ToolIcon({ kind }: { kind: "hand" | "laser" | "fit" | "focus" }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "hand" ? <path d="M8 12 V5 a1.5 1.5 0 0 1 3 0 v6 -7 a1.5 1.5 0 0 1 3 0 v7 -5 a1.5 1.5 0 0 1 3 0 v7 -3 a1.5 1.5 0 0 1 3 0 v5 c0 5-3 7-6 7 h-2 c-2 0-3-1-4-3 l-4-5 a1.5 1.5 0 0 1 2-2 l2 2" />
      : kind === "laser" ? <><path d="m4 20 9-9 3 3-9 9 Z M15 5 V2 M20 9 h3 M19 5 l2-2" /><circle cx="16" cy="8" r="2" /></>
      : kind === "fit" ? <><path d="M8 3 H3 v5 M16 3 h5 v5 M21 16 v5 h-5 M8 21 H3 v-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></>
      : <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5 M8 11 h6 M11 8 v6" /></>}
  </svg>;
}

export function PresentHud() {
  const pages = usePagesStore((s) => s.pages);
  const activeId = usePagesStore((s) => s.activeId);
  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.cam.z);
  const [controlsHidden, setControlsHidden] = useState(false);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  const toggleControls = () => {
    setControlsHidden((hidden) => !hidden);
    requestAnimationFrame(() => (restoreRef.current ?? hideRef.current)?.focus());
  };
  const [framing, setFraming] = useState<Framing | null>("page");
  const framingRef = useRef<Framing | null>("page");
  const fit = (mode: Framing) => {
    framingRef.current = mode;
    setFraming(mode);
    frameSlide(mode);
  };
  const slides = pages.filter((p) => !p.hidden);
  const index = slides.findIndex((p) => p.id === activeId);
  const exit = () => useAppStore.getState().setPresenting(false);
  const goto = (i: number) => {
    if (i >= 0 && i < slides.length) usePagesStore.getState().switchPage(slides[i].id);
  };
  const setZoom = (percent: number) => {
    framingRef.current = null;
    setFraming(null);
    const ed = useEditorStore.getState();
    ed.zoomBy(Math.min(400, Math.max(2, percent)) / 100 / ed.cam.z);
  };

  useEffect(() => {
    const ed = useEditorStore.getState();
    if (!usePagesStore.getState().pages.some((p) => !p.hidden)) {
      ed.setStatus("No visible slides to present.");
      exit();
      return;
    }
    const previousTool = ed.tool;
    const initialPage = usePagesStore.getState().activeId;
    const previousSelection = useDiagramStore.getState().diagramSelection;
    ed.setTool("pan");
    ed.setSelection([]);
    useDiagramStore.getState().setDiagramSelection([]);
    let alive = true, ownsFullscreen = false;
    const fullscreenChange = () => {
      if (ownsFullscreen && !document.fullscreenElement) exit();
    };
    document.addEventListener("fullscreenchange", fullscreenChange);
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().then(() => {
        ownsFullscreen = true;
        if (!alive && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      }).catch(() => {});
    }
    const ps = usePagesStore.getState();
    if (ps.pages.find((p) => p.id === ps.activeId)?.hidden) {
      const first = ps.pages.find((p) => !p.hidden);
      if (first) ps.switchPage(first.id);
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopImmediatePropagation(); exit(); return;
      }
      if (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.metaKey && !e.altKey && !target.matches("select")) {
        e.preventDefault(); e.stopImmediatePropagation(); toggleControls(); return;
      }
      // Range/select controls keep their own arrows, Home/End and Space.
      if (target.closest(".present-hud, .present-restore") &&
          (target.matches("input, select") || (target.closest("button") && (e.key === "Enter" || e.code === "Space")))) return;
      if ((e.metaKey || e.ctrlKey) && !["0", "+", "=", "-", "_"].includes(e.key)) return;
      const ps = usePagesStore.getState(), visible = ps.pages.filter((p) => !p.hidden);
      const i = visible.findIndex((p) => p.id === ps.activeId);
      const move = (at: number) => { if (visible[at]) ps.switchPage(visible[at].id); };
      let handled = true;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.code === "Space") move(i + 1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") move(i - 1);
      else if (e.key === "Home") move(0);
      else if (e.key === "End") move(visible.length - 1);
      else if (e.key.toLowerCase() === "k") useEditorStore.getState().setTool("laser");
      else if (e.key.toLowerCase() === "h" || e.key.toLowerCase() === "v") useEditorStore.getState().setTool("pan");
      else if (e.key.toLowerCase() === "f") fit("content");
      else if ((e.shiftKey && e.code === "Digit1") || ((e.ctrlKey || e.metaKey) && e.key === "0")) fit("page");
      else if (e.key === "+" || e.key === "=") setZoom(useEditorStore.getState().cam.z * 100 * ZOOM_KEY_STEP);
      else if (e.key === "-" || e.key === "_") setZoom(useEditorStore.getState().cam.z * 100 / ZOOM_KEY_STEP);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    const resize = () => { if (framingRef.current) frameSlide(framingRef.current); };
    window.addEventListener("resize", resize);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", resize);
      document.removeEventListener("fullscreenchange", fullscreenChange);
      if (ownsFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      useEditorStore.getState().setTool(previousTool);
      if (usePagesStore.getState().activeId === initialPage) useDiagramStore.getState().setDiagramSelection(previousSelection);
    };
  }, []);

  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => fit("page"));
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [activeId]);

  return <>
    <div id="present-controls" className="present-hud" role="region" aria-label="Presentation controls" hidden={controlsHidden}>
    <div className="present-slides">
      <button aria-label="Previous slide" title="Previous slide (←)" disabled={index <= 0} onClick={() => goto(index - 1)}>‹</button>
      <select aria-label="Choose slide" value={index < 0 ? "" : activeId ?? ""} disabled={!slides.length}
        onChange={(e) => usePagesStore.getState().switchPage(e.target.value)}>
        {!slides.length && <option value="">No visible slides</option>}
        {slides.map((p, i) => <option value={p.id} key={p.id}>{i + 1}. {p.name}</option>)}
      </select>
      <span className="present-count" aria-live="polite">{index < 0 ? 0 : index + 1} / {slides.length}</span>
      <button aria-label="Next slide" title="Next slide (→)" disabled={index < 0 || index >= slides.length - 1} onClick={() => goto(index + 1)}>›</button>
      <input className="present-progress" type="range" min="1" max={Math.max(1, slides.length)} value={Math.max(1, index + 1)}
        aria-label="Slide progress" aria-valuetext={index < 0 ? "No visible slides" : `${index + 1} of ${slides.length}: ${slides[index].name}`}
        disabled={slides.length < 2} onChange={(e) => goto(Number(e.target.value) - 1)} />
    </div>
    <div className="present-tools" role="group" aria-label="Presentation tools">
      <button aria-label="Pan" title="Pan (H)" aria-pressed={tool === "pan"} onClick={() => useEditorStore.getState().setTool("pan")}><ToolIcon kind="hand" /></button>
      <button aria-label="Laser pointer" title="Laser pointer — hold and drag (K)" aria-pressed={tool === "laser"} onClick={() => useEditorStore.getState().setTool("laser")}><ToolIcon kind="laser" /></button>
      <span className="present-sep" />
      <button aria-label="Focus content" title="Focus content (F)" aria-pressed={framing === "content"} onClick={() => fit("content")}><ToolIcon kind="focus" /><span>Focus</span></button>
      <button aria-label="Fit slide" title="Fit slide (⇧1)" aria-pressed={framing === "page"} onClick={() => fit("page")}><ToolIcon kind="fit" /><span>Fit</span></button>
    </div>
    <div className="present-zoom" role="group" aria-label="Presentation zoom">
      <button aria-label="Zoom out" onClick={() => setZoom(zoom * 100 / ZOOM_KEY_STEP)}>−</button>
      <input type="range" min="2" max="400" step="1" value={Math.min(400, Math.max(2, Math.round(zoom * 100)))}
        aria-label="Presentation zoom" aria-valuetext={`${Math.round(zoom * 100)} percent`} onChange={(e) => setZoom(Number(e.target.value))} />
      <button aria-label="Zoom in" onClick={() => setZoom(zoom * 100 * ZOOM_KEY_STEP)}>+</button>
      <output>{Math.round(zoom * 100)}%</output>
    </div>
    <button ref={hideRef} className="present-hide" aria-label="Hide presentation controls" aria-controls="present-controls"
      aria-expanded={true} title="Hide controls (C)" onClick={toggleControls}>
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 7 5 5 5-5" /></svg>
    </button>
    <button className="present-exit" aria-label="Exit presentation" title="Exit presentation (Esc)" onClick={exit}>Exit <span aria-hidden="true">×</span></button>
    </div>
    {controlsHidden && <button ref={restoreRef} className="present-restore" aria-label="Show presentation controls"
      aria-controls="present-controls" aria-expanded={false} title="Show controls (C)" onClick={toggleControls}>
      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg>
      Controls
    </button>}
  </>;
}
