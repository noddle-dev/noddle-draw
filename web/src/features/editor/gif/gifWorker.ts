/** Quantize and compress each frame off the main thread. Acknowledgement means
 * both steps are complete; the caller sends only one RGBA buffer at a time. */
import { GifEncoder, quantize } from "./gifEncode";

let encoder: GifEncoder | undefined;

self.onmessage = (e: MessageEvent) => {
  const m = e.data as
    | { type: "frame"; rgba: ArrayBuffer; delayMs: number; w: number; h: number; loop: boolean }
    | { type: "finish" };
  try {
    if (m.type === "frame") {
      encoder ??= new GifEncoder(m.w, m.h, m.loop);
      encoder.addFrame({ ...quantize(new Uint8ClampedArray(m.rgba)), delayMs: m.delayMs });
      (self as unknown as Worker).postMessage({ type: "frameDone" });
    } else if (m.type === "finish") {
      if (!encoder) throw new Error("No GIF frames were rendered.");
      const bytes = encoder.finish();
      encoder = undefined;
      (self as unknown as Worker).postMessage({ type: "done", bytes }, [bytes.buffer as ArrayBuffer]);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
