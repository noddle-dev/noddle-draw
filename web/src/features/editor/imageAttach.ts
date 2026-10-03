/**
 * features/editor/imageAttach — shared reference-image attach pipeline.
 * Read → downscale to ≤ MAX_DIM on the longest side → re-encode if a PNG is
 * still over the backend's ~1.5MB wire cap. Used by the chat composer AND the
 * generate screen's Describe-in-text reference attach.
 */
const MAX_DIM = 1400;
const MAX_LEN = 2_100_000; // mirrors CHAT_IMAGE_MAX_LEN on the backend
export const ALLOWED_TYPES = /^image\/(png|jpeg|webp)$/;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that image."));
    r.readAsDataURL(file);
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

/** Read → downscale → (re-encode if needed) into a wire-safe data URL. */
export async function prepareImage(file: File): Promise<string> {
  const raw = await fileToDataUrl(file);
  const img = await loadImage(raw);
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const draw = (mime: string, quality?: number): string => {
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL(mime, quality);
  };

  let url = scale < 1 ? draw("image/png") : raw;
  if (url.length > MAX_LEN) url = draw("image/jpeg", 0.85); // shrink to fit the cap
  if (url.length > MAX_LEN) {
    throw new Error("Image is too large even after resizing — try a smaller one.");
  }
  return url;
}
