#!/usr/bin/env node
/** Dependency-free GIF regression check. Run from repo root after npm ci in web.
 * Decodes LZW independently, checking dictionary growth/reset, local palettes,
 * delays and multi-frame order rather than comparing encoder implementation. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const {buildSync} = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'noddle-gif-check-'));

function decodeLzw(data, min) {
  const clear = 1 << min, end = clear + 1;
  let size, dict, previous, bit = 0;
  const reset = () => { size = min + 1; dict = Array.from({length: end + 1}, (_, i) => [i]); previous = null; };
  reset();
  const result = [];
  for (;;) {
    assert.ok(bit + size <= data.length * 8, 'Missing end code');
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) { reset(); continue; }
    if (code === end) return Uint8Array.from(result);
    const entry = code < dict.length ? dict[code] : code === dict.length && previous ? [...previous, previous[0]] : null;
    assert.ok(entry, 'Invalid LZW dictionary reference');
    for (const value of entry) result.push(value);
    if (previous) {
      dict.push([...previous, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
    }
    previous = entry;
  }
}

function decodeGif(bytes) {
  let p = 6, loop = false, delay;
  const u16 = () => {const n = bytes[p] | bytes[p + 1] << 8; p += 2; return n;};
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 6)), 'GIF89a');
  const width = u16(), height = u16(), flags = bytes[p++]; p += 2;
  if (flags & 128) p += 3 * (1 << ((flags & 7) + 1));
  const blocks = () => {
    const values = [];
    while (bytes[p]) {const n = bytes[p++]; for (let i = 0; i < n; i++) values.push(bytes[p++]);}
    p++; return Uint8Array.from(values);
  };
  const frames = [];
  while (bytes[p] !== 0x3b) {
    assert.ok(p < bytes.length, 'Missing GIF trailer');
    const tag = bytes[p++];
    if (tag === 0x21) {
      const type = bytes[p++];
      if (type === 0xf9) { assert.equal(bytes[p++], 4); p++; delay = u16() * 10; p += 2; }
      else if (type === 0xff) {const n = bytes[p++]; const name = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; const data = blocks(); loop = name === 'NETSCAPE2.0' && data[1] === 0 && data[2] === 0;}
      else blocks();
    } else {
      assert.equal(tag, 0x2c);
      assert.equal(u16(), 0); assert.equal(u16(), 0);
      assert.equal(u16(), width); assert.equal(u16(), height);
      const flags = bytes[p++]; assert.ok(flags & 128);
      const colors = 1 << ((flags & 7) + 1), palette = bytes.slice(p, p + colors * 3); p += colors * 3;
      const min = bytes[p++];
      frames.push({indices: decodeLzw(blocks(), min), palette, delay});
    }
  }
  assert.equal(p + 1, bytes.length);
  return {width, height, frames, loop};
}

try {
  const out = join(dir, 'encoder.mjs');
  buildSync({entryPoints: [new URL('../web/src/features/editor/gif/gifEncode.ts', import.meta.url).pathname], outfile: out, bundle: true, platform: 'node', format: 'esm'});
  const {encodeGif, GifEncoder, quantize} = await import(pathToFileURL(out));
  let seed = 1;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const w = 512, h = 256;
  const frames = [1, 2, 17, 256].map((colors, f) => ({
    indices: Uint8Array.from({length: w * h}, (_, i) => f === 1 ? (i < w * h / 2 ? 0 : 1) : random() % colors),
    palette: Array.from({length: colors}, (_, i) => [i, (i * 17) % 256, 255 - i]), delayMs: 30 + 20 * f,
  }));
  const streaming = new GifEncoder(w, h);
  for (const frame of frames) streaming.addFrame(frame);
  const data = streaming.finish();
  assert.deepEqual(data, encodeGif(w, h, frames));
  const decoded = decodeGif(data);
  assert.equal(decoded.loop, true); assert.equal(decoded.frames.length, frames.length);
  frames.forEach((f, i) => {
    assert.deepEqual(decoded.frames[i].indices, f.indices);
    assert.equal(decoded.frames[i].delay, f.delayMs);
    assert.deepEqual(decoded.frames[i].palette.slice(0, f.palette.length * 3), Uint8Array.from(f.palette.flat()));
  });
  const single = decodeGif(encodeGif(1, 1, [{indices: new Uint8Array([0]), palette: [[255, 255, 255]], delayMs: 5}]));
  assert.equal(single.loop, false); assert.equal(single.frames[0].delay, 20);
  const alpha = quantize(new Uint8ClampedArray([0, 0, 0, 0, 45, 49, 66, 255]));
  assert.deepEqual(alpha.palette, [[255, 255, 255], [45, 49, 66]]);
  console.log('PASS: decoded pixels, 1/2/17/256 colors, LZW growth/reset, delays, loop, alpha, incremental output');
} finally { rmSync(dir, {recursive: true, force: true}); }
