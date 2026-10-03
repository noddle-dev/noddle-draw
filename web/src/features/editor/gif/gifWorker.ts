/**
 * features/editor/gif/gifWorker — quantize + LZW OFF the main thread.
 *
 * The exporter used to freeze the tab: per-frame quantization is O(pixels)
 * and the final encodeGif pass is O(frames × pixels) — seconds of synchronous
 * work at board sizes. The main thread now only rasterizes (SVG → canvas
 * needs the DOM); every RGBA buffer is TRANSFERRED here (zero-copy), frames
 * quantize while the next one rasterizes, and the LZW pass never blocks UI.
 *
 * Message protocol:
 *   in  {type:"frame", rgba: ArrayBuffer, delayMs, index} — quantize + hold
 *   in  {type:"encode", w, h}                             — LZW → bytes back
 *   out {type:"frameDone", index}
 *   out {type:"done", bytes: Uint8Array}   (buffer transferred back)
 *   out {type:"error", message}
 */
import { encodeGif, quantize, type IndexedFrame } from "./gifEncode";

const frames: IndexedFrame[] = [];

self.onmessage = (e: MessageEvent) => {
  const m = e.data as
    | { type: "frame"; rgba: ArrayBuffer; delayMs: number; index: number }
    | { type: "encode"; w: number; h: number };
  try {
    if (m.type === "frame") {
      const { indices, palette } = quantize(new Uint8ClampedArray(m.rgba));
      frames.push({ indices, palette, delayMs: m.delayMs });
      (self as unknown as Worker).postMessage({ type: "frameDone", index: m.index });
    } else if (m.type === "encode") {
      const bytes = encodeGif(m.w, m.h, frames, true);
      (self as unknown as Worker).postMessage({ type: "done", bytes }, [
        bytes.buffer as ArrayBuffer,
      ]);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
