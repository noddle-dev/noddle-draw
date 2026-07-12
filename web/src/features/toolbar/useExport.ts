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

/** Default when nothing is stored. 2× gives crisp exports for docs/slides out
 * of the box (and roughly matches the old devicePixelRatio behavior on HiDPI). */
const DEFAULT_PNG_SCALE: PngScale = 2;

const EXPORT_SCALE_KEY = "noddle.exportScale";

/** Coerce an arbitrary value to a valid PNG scale, defaulting to 2×. Also
 * guards callers that bind `onClick={exportPng}` (which would pass an event). */
function normalizePngScale(scale?: number): PngScale {
  return (PNG_SCALES as readonly number[]).includes(scale as number)
    ? (scale as PngScale)
    : DEFAULT_PNG_SCALE;
}

/** Remembered export scale (persists across reloads; storage may be blocked). */
export function loadPngScale(): PngScale {
  try {
    return normalizePngScale(Number(localStorage.getItem(EXPORT_SCALE_KEY)));
  } catch {
    return DEFAULT_PNG_SCALE;
  }
}

export function savePngScale(scale: number): void {
  try {
    localStorage.setItem(EXPORT_SCALE_KEY, String(normalizePngScale(scale)));
  } catch {
    /* storage blocked */
  }
}

// Browser canvas limits. Desktop Chrome/Edge/Firefox allow ~16384 px per side
// and ~268M px total area; Safari (especially iOS) is stricter. We clamp the
// export scale to these so a large board at 4× doesn't silently produce nothing,
// and svgToPngBlob()'s null-guard reports anything a stricter browser still rejects.
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 268_000_000;

/** Largest scale ≤ requested whose canvas stays within the browser limits,
 * never below 1× (a normal export should still be attempted — if even that
 * overflows, svgToPngBlob resolves null and the caller surfaces an error). */
function fitPngScale(w: number, h: number, requested: number): number {
  const maxBySide = MAX_CANVAS_SIDE / Math.max(w, h);
  const maxByArea = Math.sqrt(MAX_CANVAS_AREA / (w * h));
  return Math.min(requested, Math.max(1, Math.min(maxBySide, maxByArea)));
}

/** Rasterize a board SVG string to a PNG blob at `scale`. Resolves null on any
 * failure — a blocked/failed SVG load, no 2D context, a tainted canvas
 * (external image refs), or a canvas that exceeds the browser's size limit
 * (`toBlob` yields null in that case). */
function svgToPngBlob(
  svg: string,
  w: number,
  h: number,
  scale: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, w, h);
        c.toBlob(resolve, "image/png");
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
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

  const exportPng = useCallback(async (scale?: number) => {
    const st = useEditorStore.getState();
    const svg = st.currentBoardSvg();
    if (!svg) return;
    const { w, h } = st.artboard;
    const requested = normalizePngScale(scale);
    const s = fitPngScale(w, h, requested);
    const blob = await svgToPngBlob(svg, w, h, s);
    if (!blob) {
      useEditorStore
        .getState()
        .setStatus(
          "PNG export failed — board too large for this browser, or it references external images.",
          "error",
        );
      return;
    }
    download(blob, (st.docId || "drawing") + ".png");
    if (s < requested) {
      useEditorStore
        .getState()
        .setStatus(
          `Exported PNG at ${s.toFixed(1)}× — ${requested}× exceeds this browser's canvas limit.`,
          "ok",
        );
    }
  }, []);

  /** Deck export (#17): every page as a numbered PNG. Pages render through
   * the live canvas, so we switch → wait two frames → rasterize → restore. */
  const exportDeckPng = useCallback(
    async (scale?: number) => {
      const requested = normalizePngScale(scale);
      // Hidden pages are excluded from the deck export.
      const pages = usePagesStore.getState().pages.filter((p) => !p.hidden);
      if (pages.length <= 1) {
        await exportPng(requested);
        return;
      }
      const original = usePagesStore.getState().activeId;
      const twoFrames = () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );

      let n = 0;
      let failed = 0;
      let clamped = false;
      for (const p of pages) {
        usePagesStore.getState().switchPage(p.id);
        await twoFrames();
        const st = useEditorStore.getState();
        const svg = st.currentBoardSvg();
        if (!svg) continue;
        const { w, h } = st.artboard;
        const s = fitPngScale(w, h, requested);
        if (s < requested) clamped = true;
        const blob = await svgToPngBlob(svg, w, h, s);
        if (blob) {
          n += 1;
          download(
            blob,
            `${st.docId || "board"}-${String(n).padStart(2, "0")}.png`,
          );
        } else {
          failed += 1;
        }
      }
      if (original) usePagesStore.getState().switchPage(original);
      let msg = `Exported ${n} page(s) as PNG`;
      if (failed) msg += `; ${failed} skipped (too large or external refs)`;
      else if (clamped) msg += " (some capped to fit the canvas limit)";
      useEditorStore.getState().setStatus(msg + ".", failed ? "error" : "ok");
    },
    [exportPng],
  );

  return { exportSvg, exportPng, exportDeckPng };
}
