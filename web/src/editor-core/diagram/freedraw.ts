/**
 * editor-core/diagram/freedraw — pen-stroke geometry (pure).
 *
 * A freedraw node stores its ink as points normalised to the node box, so the
 * stroke moves/resizes with the node. These helpers turn absolute pointer
 * samples into that form and back into a smooth SVG path (quadratic curves
 * through segment midpoints — the classic cheap smoothing that reads as ink).
 */
import type { PenBrush, Vec } from "./types";

/** Absolute samples → node box + flat normalised points. */
export function normaliseStroke(abs: Vec[]): { x: number; y: number; w: number; h: number; points: number[] } {
  const xs = abs.map((p) => p.x);
  const ys = abs.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  // A perfectly straight stroke has a zero side — keep the box ≥ 1 unit.
  const w = Math.max(1, Math.max(...xs) - x);
  const h = Math.max(1, Math.max(...ys) - y);
  const points: number[] = [];
  for (const p of abs) points.push(round4((p.x - x) / w), round4((p.y - y) / h));
  return { x, y, w, h, points };
}

/** Flat normalised points + box → smooth SVG path `d`. */
export function freedrawPath(points: number[] | undefined, x: number, y: number, w: number, h: number): string {
  if (!points || points.length < 4) return "";
  const P: Vec[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) P.push({ x: x + points[i] * w, y: y + points[i + 1] * h });
  if (P.length === 2) return `M ${P[0].x} ${P[0].y} L ${P[1].x} ${P[1].y}`;
  let d = `M ${P[0].x} ${P[0].y}`;
  for (let i = 1; i < P.length - 1; i++) {
    const mx = (P[i].x + P[i + 1].x) / 2;
    const my = (P[i].y + P[i + 1].y) / 2;
    d += ` Q ${P[i].x} ${P[i].y} ${mx} ${my}`;
  }
  const last = P[P.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Variable-width ink outline (a small perfect-freehand cousin): per-sample
 * width follows a simulated pressure (slow = full, fast = thin, by
 * `thinning`), optional tapered ends, then the left/right offset rails are
 * joined with round caps into ONE filled path. Returns "" when the brush has
 * no width variation (callers then stroke `freedrawPath`, which is crisper).
 */
export function freedrawOutline(
  points: number[] | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  size: number,
  brush: PenBrush = {},
): string {
  const thinning = clamp01(brush.thinning ?? 0);
  if (!points || points.length < 6 || (thinning === 0 && !brush.taper)) return "";
  let P: Vec[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) P.push({ x: x + points[i] * w, y: y + points[i + 1] * h });
  P = smooth(P, brush.smoothing ?? 0);
  const n = P.length;
  // Simulated pressure from sample spacing (the pointer is sampled per
  // move event, so spacing ≈ hand speed). Normalised by a FIXED distance,
  // not by the brush size — a size-relative scale made almost every motion
  // read as "fast" on bold brushes and the stroke came out far thinner than
  // the chosen width.
  const press: number[] = [];
  let ema = 0.5;
  for (let i = 0; i < n; i++) {
    const d = i ? Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y) : 0;
    const p = 1 - Math.min(1, d / 18);
    ema = ema * 0.7 + p * 0.3;
    press.push(ema);
  }
  // cumulative length for the taper ramp
  const acc = [0];
  for (let i = 1; i < n; i++) acc.push(acc[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y));
  const total = acc[n - 1] || 1;
  const ramp = Math.min(total * 0.18, size * 6);
  const half = (i: number) => {
    // Width swings AROUND the chosen stroke width (slow = thicker, fast =
    // thinner, ±45% at full thinning) so the stroke still reads as `size`.
    let r = (size / 2) * (1 + thinning * 0.9 * (press[i] - 0.5));
    if (brush.taper) {
      const t = Math.min(acc[i], total - acc[i]) / (ramp || 1);
      r *= 0.15 + 0.85 * Math.min(1, t);
    }
    return Math.max(0.35, r);
  };
  const L: Vec[] = [];
  const R: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const r = half(i);
    L.push({ x: P[i].x - ty * r, y: P[i].y + tx * r });
    R.push({ x: P[i].x + ty * r, y: P[i].y - tx * r });
  }
  const rEnd = half(n - 1);
  const rStart = half(0);
  const rail = (pts: Vec[]) => {
    let d = "";
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`;
    }
    const last = pts[pts.length - 1];
    return `${d} L ${f(last.x)} ${f(last.y)}`;
  };
  const back = [...R].reverse();
  return (
    `M ${f(L[0].x)} ${f(L[0].y)}` +
    rail(L) +
    ` A ${f(rEnd)} ${f(rEnd)} 0 0 1 ${f(back[0].x)} ${f(back[0].y)}` +
    rail(back) +
    ` A ${f(rStart)} ${f(rStart)} 0 0 1 ${f(L[0].x)} ${f(L[0].y)} Z`
  );
}

/** Moving-average smoothing: window grows with `amount` (0..1 → 0..6 neighbours). */
function smooth(P: Vec[], amount: number): Vec[] {
  const k = Math.round(clamp01(amount) * 6);
  if (!k || P.length < 3) return P;
  return P.map((_, i) => {
    let sx = 0, sy = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(P.length - 1, i + k); j++) {
      sx += P[j].x; sy += P[j].y; c++;
    }
    // keep the true endpoints so the stroke still starts/ends where drawn
    return i === 0 || i === P.length - 1 ? P[i] : { x: sx / c, y: sy / c };
  });
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function f(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
