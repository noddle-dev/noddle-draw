/**
 * features/editor/pasteImage — paste/drop/upload raster images onto the board.
 *
 * The image becomes a DIAGRAM NODE (`kind: "image"`, data URL in `imageHref`),
 * so it behaves like any other shape: drag-move, resize handles, hover
 * connection ports, arrows attach to its rect perimeter, per-object undo/redo,
 * autosave and bake-on-save. The sanitizer explicitly allows `data:image/`
 * hrefs, so the baked SVG round-trips server-side sanitation intact.
 *
 * Oversized sources are downscaled through a canvas before embedding so a
 * 12-MP screenshot doesn't balloon the stored board.
 */
import { screenToContent } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { useAppStore } from "../../state/appStore";

/** Sources larger than this (px) are downscaled before embedding. */
const MAX_SOURCE_DIM = 1600;
/** Placed size on the board (content units, longest side). */
const MAX_PLACED_DIM = 480;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read the image from the clipboard."));
    r.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Invalid image."));
    img.src = url;
  });
}

/** Data URL + natural size, downscaling huge sources via a canvas. */
async function normalize(blob: Blob): Promise<{ url: string; w: number; h: number }> {
  const raw = await blobToDataUrl(blob);
  const img = await loadImage(raw);
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  if (Math.max(w, h) <= MAX_SOURCE_DIM) return { url: raw, w, h };

  const scale = MAX_SOURCE_DIM / Math.max(w, h);
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { url: raw, w, h };
  ctx.drawImage(img, 0, 0, cw, ch);
  // PNG keeps transparency; screenshots compress fine either way.
  return { url: canvas.toDataURL("image/png"), w: cw, h: ch };
}

/**
 * Add an image blob to the board as a DIAGRAM NODE (`kind: "image"`), centered
 * at `at` (content coords) or at the current viewport center; scaled down to a
 * sane on-board size. Hover it for connection ports, drag from a port to draw
 * an arrow — exactly like any other shape. Returns false when the canvas isn't
 * mounted.
 */
export async function addImageToBoard(
  blob: Blob,
  at?: { x: number; y: number },
): Promise<boolean> {
  const st = useEditorStore.getState();
  const refs = st.refs;
  if (!refs) return false;

  let url: string, w: number, h: number;
  try {
    ({ url, w, h } = await normalize(blob));
  } catch (err) {
    st.setStatus(err instanceof Error ? err.message : String(err), "error");
    return false;
  }

  const scale = Math.min(1, MAX_PLACED_DIM / Math.max(w, h));
  const pw = Math.round(w * scale);
  const ph = Math.round(h * scale);

  let center = at;
  if (!center) {
    const r = refs.host.getBoundingClientRect();
    center = screenToContent(refs.content, r.left + r.width / 2, r.top + r.height / 2);
  }

  const ds = useDiagramStore.getState();
  ds.setDiagramMode(true);
  ds.addNodeAt("image", center, {
    imageHref: url,
    w: pw,
    h: ph,
    text: "",
    // No frame by default — the image edges ARE the shape. Users can add a
    // border from the Properties panel (stroke + width render a frame rect).
    fill: "none",
    strokeWidth: 0,
  });
  useAppStore.getState().setRightTab("props");
  st.setStatus(`Added image (${pw}×${ph}) to the board.`, "ok");
  return true;
}

/** First image blob in a clipboard/drag payload, if any. */
export function imageFromDataTransfer(dt: DataTransfer | null): Blob | null {
  if (!dt) return null;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/") && item.type !== "image/svg+xml") {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith("image/") && f.type !== "image/svg+xml") return f;
  }
  return null;
}
