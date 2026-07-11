/**
 * features/toolbar/useExport — export the current document as SVG or PNG, and
 * trigger a file download. Ported from the export/download section of
 * `frontend/editor.js`.
 */
import { useCallback } from "react";
import { useEditorStore } from "../../state/editorStore";
import { usePagesStore } from "../../state/pagesStore";

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Allowed PNG export scale factors — device-independent multipliers of the
 * artboard size (1× = artboard pixels). Higher = larger, sharper PNGs for
 * docs/slides. The source is vector SVG, so a bigger canvas re-rasterizes it
 * crisply rather than upscaling. */
export const PNG_SCALES = [1, 2, 4] as const;
export type PngScale = (typeof PNG_SCALES)[number];

const EXPORT_SCALE_KEY = "noddle.exportScale";

/** Coerce an arbitrary value to a valid PNG scale, defaulting to 1×. Also
 * guards callers that bind `onClick={exportPng}` (which would pass an event). */
function normalizePngScale(scale?: number): PngScale {
  return (PNG_SCALES as readonly number[]).includes(scale as number)
    ? (scale as PngScale)
    : 1;
}

/** Remembered export scale (persists across reloads; storage may be blocked). */
export function loadPngScale(): PngScale {
  try {
    return normalizePngScale(Number(localStorage.getItem(EXPORT_SCALE_KEY)));
  } catch {
    return 1;
  }
}

export function savePngScale(scale: number): void {
  try {
    localStorage.setItem(EXPORT_SCALE_KEY, String(normalizePngScale(scale)));
  } catch {
    /* storage blocked */
  }
}

export function useExport() {
  const exportSvg = useCallback(() => {
    const st = useEditorStore.getState();
    const svg = st.currentBoardSvg();
    if (!svg) return;
    download(
      new Blob([svg], { type: "image/svg+xml" }),
      (st.docId || "drawing") + ".svg",
    );
  }, []);

  const exportPng = useCallback((scale?: number) => {
    const s = normalizePngScale(scale);
    const st = useEditorStore.getState();
    const svg = st.currentBoardSvg();
    if (!svg) return;
    const { w, h } = st.artboard;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(w * s);
      c.height = Math.round(h * s);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.scale(s, s);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob(
        (b) => b && download(b, (st.docId || "drawing") + ".png"),
        "image/png",
      );
    };
    img.onerror = () =>
      useEditorStore.getState().setStatus("PNG export error (external refs?).", "error");
    img.src = url;
  }, []);

  /** Deck export (#17): every page as a numbered PNG. Pages render through
   * the live canvas, so we switch → wait two frames → rasterize → restore. */
  const exportDeckPng = useCallback(async (scale?: number) => {
    const s = normalizePngScale(scale);
    // Hidden pages are excluded from the deck export.
    const pages = usePagesStore.getState().pages.filter((p) => !p.hidden);
    if (pages.length <= 1) {
      exportPng(s);
      return;
    }
    const original = usePagesStore.getState().activeId;
    const twoFrames = () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
    const rasterize = (svg: string, w: number, h: number) =>
      new Promise<Blob | null>((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = Math.round(w * s);
          c.height = Math.round(h * s);
          const ctx = c.getContext("2d");
          URL.revokeObjectURL(url);
          if (!ctx) return resolve(null);
          ctx.scale(s, s);
          ctx.drawImage(img, 0, 0, w, h);
          c.toBlob(resolve, "image/png");
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(null);
        };
        img.src = url;
      });

    let n = 0;
    for (const p of pages) {
      usePagesStore.getState().switchPage(p.id);
      await twoFrames();
      const st = useEditorStore.getState();
      const svg = st.currentBoardSvg();
      if (!svg) continue;
      const blob = await rasterize(svg, st.artboard.w, st.artboard.h);
      n += 1;
      if (blob) {
        download(blob, `${st.docId || "board"}-${String(n).padStart(2, "0")}.png`);
      }
    }
    if (original) usePagesStore.getState().switchPage(original);
    useEditorStore.getState().setStatus(`Exported ${n} page(s) as PNG.`, "ok");
  }, [exportPng]);

  return { exportSvg, exportPng, exportDeckPng };
}
