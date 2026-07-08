/**
 * features/editor/gif/gifEncode — minimal, dependency-free animated GIF89a
 * encoder (the npm registry's tarball endpoint is blocked here, so we vendor
 * ~300 lines instead of pulling `gifenc`; same architecture: median-cut
 * quantize → palette indices → LZW).
 *
 * Format notes (best practice for flat design):
 *   • per-frame LOCAL color tables — boards with pasted photos can shift
 *     palettes between frames without global-palette banding;
 *   • no dithering — flat fills stay crisp;
 *   • Netscape loop extension (loop forever);
 *   • delays are in centiseconds (GIF quantum) — callers pass ms.
 */

// ---------------------------------------------------------------------------
// quantization (exact palette when ≤256 colors, else median cut)
// ---------------------------------------------------------------------------

export interface IndexedFrame {
  indices: Uint8Array;
  /** RGB palette, length ≤ 256. */
  palette: [number, number, number][];
  delayMs: number;
}

/** Quantize an RGBA buffer to ≤256 colors + index map. */
export function quantize(rgba: Uint8ClampedArray): {
  indices: Uint8Array;
  palette: [number, number, number][];
} {
  const px = rgba.length / 4;

  // ---- fast path: exact palette for flat artwork -------------------------
  const seen = new Map<number, number>(); // rgb24 → palette index
  const palette: [number, number, number][] = [];
  const indices = new Uint8Array(px);
  let exact = true;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    // composite on white (GIF has no real alpha)
    const a = rgba[o + 3] / 255;
    const r = Math.round(rgba[o] * a + 255 * (1 - a));
    const g = Math.round(rgba[o + 1] * a + 255 * (1 - a));
    const b = Math.round(rgba[o + 2] * a + 255 * (1 - a));
    const key = (r << 16) | (g << 8) | b;
    let idx = seen.get(key);
    if (idx === undefined) {
      if (palette.length >= 256) {
        exact = false;
        break;
      }
      idx = palette.length;
      palette.push([r, g, b]);
      seen.set(key, idx);
    }
    indices[i] = idx;
  }
  if (exact) return { indices, palette };

  // ---- median cut for photographic content -------------------------------
  return medianCut(rgba);
}

function medianCut(rgba: Uint8ClampedArray): {
  indices: Uint8Array;
  palette: [number, number, number][];
} {
  const px = rgba.length / 4;
  // sample at most ~64k pixels for box building
  const stride = Math.max(1, Math.floor(px / 65536));
  const samples: number[] = [];
  for (let i = 0; i < px; i += stride) {
    const o = i * 4;
    const a = rgba[o + 3] / 255;
    samples.push(
      ((Math.round(rgba[o] * a + 255 * (1 - a)) & 0xff) << 16) |
        ((Math.round(rgba[o + 1] * a + 255 * (1 - a)) & 0xff) << 8) |
        (Math.round(rgba[o + 2] * a + 255 * (1 - a)) & 0xff),
    );
  }

  type Box = number[]; // list of rgb24
  let boxes: Box[] = [samples];
  while (boxes.length < 256) {
    // split the box with the largest channel range
    let bi = -1;
    let bRange = -1;
    let bCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      for (let ch = 0; ch < 3; ch++) {
        const sh = 16 - ch * 8;
        let mn = 255, mx = 0;
        for (const c of box) {
          const v = (c >> sh) & 0xff;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mx - mn > bRange) {
          bRange = mx - mn;
          bi = i;
          bCh = ch;
        }
      }
    }
    if (bi < 0 || bRange <= 0) break;
    const sh = 16 - bCh * 8;
    const box = boxes[bi];
    box.sort((a, b) => ((a >> sh) & 0xff) - ((b >> sh) & 0xff));
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }

  const palette: [number, number, number][] = boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    for (const c of box) {
      r += (c >> 16) & 0xff;
      g += (c >> 8) & 0xff;
      b += c & 0xff;
    }
    const n = box.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });

  // nearest-palette mapping with a memo (boards repeat colors heavily)
  const memo = new Map<number, number>();
  const indices = new Uint8Array(px);
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const a = rgba[o + 3] / 255;
    const r = Math.round(rgba[o] * a + 255 * (1 - a));
    const g = Math.round(rgba[o + 1] * a + 255 * (1 - a));
    const b = Math.round(rgba[o + 2] * a + 255 * (1 - a));
    const key = (r << 16) | (g << 8) | b;
    let idx = memo.get(key);
    if (idx === undefined) {
      let bd = Infinity;
      idx = 0;
      for (let p = 0; p < palette.length; p++) {
        const [pr, pg, pb] = palette[p];
        const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        if (d < bd) {
          bd = d;
          idx = p;
        }
      }
      memo.set(key, idx);
    }
    indices[i] = idx;
  }
  return { indices, palette };
}

// ---------------------------------------------------------------------------
// GIF89a writer
// ---------------------------------------------------------------------------

class ByteBuf {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }
  bytes(arr: ArrayLike<number>) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  u16(v: number) {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  out(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** GIF LZW compress indices at `minCodeSize`, emitting 255-byte sub-blocks. */
function lzw(minCodeSize: number, indices: Uint8Array, out: ByteBuf) {
  out.byte(minCodeSize);
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let dict = new Map<string, number>();
  let next = eoiCode + 1;
  const reset = () => {
    dict = new Map();
    next = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  // bit writer with sub-block flushing
  const block = new Uint8Array(255);
  let blockLen = 0;
  let cur = 0;
  let curBits = 0;
  const flushBlock = () => {
    if (!blockLen) return;
    out.byte(blockLen);
    out.bytes(block.subarray(0, blockLen));
    blockLen = 0;
  };
  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      block[blockLen++] = cur & 0xff;
      if (blockLen === 255) flushBlock();
      cur >>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);
  reset();

  let prev = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const joint = prev + "," + k;
    if (dict.has(joint)) {
      prev = joint;
      continue;
    }
    // output code for prev
    const prevCode = prev.includes(",") ? dict.get(prev)! : Number(prev);
    emit(prevCode);
    dict.set(joint, next++);
    if (next === (1 << codeSize) + 1) {
      if (codeSize < 12) codeSize++;
      else {
        emit(clearCode);
        reset();
      }
    }
    prev = String(k);
  }
  const lastCode = prev.includes(",") ? dict.get(prev)! : Number(prev);
  emit(lastCode);
  emit(eoiCode);
  if (curBits > 0) {
    block[blockLen++] = cur & 0xff;
    if (blockLen === 255) flushBlock();
  }
  flushBlock();
  out.byte(0); // block terminator
}

/** Encode frames (per-frame local palettes) into an animated GIF89a. */
export function encodeGif(
  width: number,
  height: number,
  frames: IndexedFrame[],
  loopForever = true,
): Uint8Array {
  const out = new ByteBuf();
  out.str("GIF89a");
  // logical screen descriptor — no global color table
  out.u16(width);
  out.u16(height);
  out.byte(0x70); // no GCT, 8-bit color resolution
  out.byte(0); // bg color
  out.byte(0); // aspect

  if (loopForever && frames.length > 1) {
    // Netscape application extension: loop forever
    out.bytes([0x21, 0xff, 0x0b]);
    out.str("NETSCAPE2.0");
    out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  }

  for (const f of frames) {
    // pad palette to a power of two ≥ 2
    let bits = 1;
    while (1 << bits < f.palette.length) bits++;
    bits = Math.max(bits, 1);
    const padded = 1 << bits;

    // graphics control extension (delay in centiseconds)
    const delay = Math.max(2, Math.round(f.delayMs / 10)); // <20ms is ignored by browsers
    out.bytes([0x21, 0xf9, 0x04, 0x04]); // disposal: do not dispose
    out.u16(delay);
    out.bytes([0x00, 0x00]);

    // image descriptor + local color table
    out.byte(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.byte(0x80 | (bits - 1)); // local color table flag + size
    for (let i = 0; i < padded; i++) {
      const [r, g, b] = f.palette[i] ?? [0, 0, 0];
      out.bytes([r, g, b]);
    }

    lzw(Math.max(2, bits), f.indices, out);
  }

  out.byte(0x3b); // trailer
  return out.out();
}
