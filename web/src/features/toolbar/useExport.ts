/**
 * features/toolbar/useExport — export the current document as SVG or PNG, and
 * trigger a file download. Ported from the export/download section of
 * `frontend/editor.js`.
 */
import { useCallback, useEffect } from "react";
import { useEditorStore } from "../../state/editorStore";
import { usePagesStore } from "../../state/pagesStore";
import { refreshWatermarkTier, watermarkOn } from "./watermark";

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function useExport() {
  useEffect(refreshWatermarkTier, []);

  const exportSvg = useCallback(() => {
    const st = useEditorStore.getState();
    const svg = st.currentBoardSvg({ watermark: watermarkOn() });
    if (!svg) return;
    download(
      new Blob([svg], { type: "image/svg+xml" }),
      (st.docId || "drawing") + ".svg",
    );
  }, []);

  const exportPng = useCallback(() => {
    const st = useEditorStore.getState();
    const svg = st.currentBoardSvg({ watermark: watermarkOn() });
    if (!svg) return;
    const { w, h } = st.artboard;
    const dpr = window.devicePixelRatio || 1;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
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
  const exportDeckPng = useCallback(async () => {
    // Hidden pages are excluded from the deck export.
    const pages = usePagesStore.getState().pages.filter((p) => !p.hidden);
    if (pages.length <= 1) {
      exportPng();
      return;
    }
    const original = usePagesStore.getState().activeId;
    const twoFrames = () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
    const rasterize = (svg: string, w: number, h: number) =>
      new Promise<Blob | null>((resolve) => {
        const dpr = window.devicePixelRatio || 1;
        const img = new Image();
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = w * dpr;
          c.height = h * dpr;
          const ctx = c.getContext("2d");
          URL.revokeObjectURL(url);
          if (!ctx) return resolve(null);
          ctx.scale(dpr, dpr);
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
      const svg = st.currentBoardSvg({ watermark: watermarkOn() });
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
