/**
 * editor-core/diagram/animation — the single source of truth for diagram
 * animation timing + intensity parameters.
 *
 * PURE TypeScript: no React, no DOM globals. Shared by the live renderers
 * (EdgeView/NodeView CSS + SMIL), the GIF exporter (deterministic per-frame
 * baking) and the static-export baking in editorStore, so all three stay in
 * lock-step.
 *
 * Timing contract: every cycle is base/speed with bases that divide 1.2s
 * (dash 0.6s, everything else 1.2s). With speeds 0.5|1|2 all cycles land in
 * {0.3, 0.6, 1.2, 2.4}s — a 2.4s GIF loops every style seamlessly and a
 * 1.2s GIF loops everything except the 0.5x (2.4s) cycles.
 */
import type { FlowIntensity, FlowSpeed, NodeAnim } from "./types";

/** Dash marching-ants: one period is 14px (`dashflow` keyframe → -14). */
export const DASH_CYCLE_MS = 600;
export const DASH_DISTANCE = 14;
/** Beam comet sweep: one period is 120px (`beamflow` keyframe → -120). */
export const BEAM_CYCLE_MS = 1200;
export const BEAM_DISTANCE = 120;
/** Pulse breathe / dots travel / node anims share the 1.2s base cycle. */
export const PULSE_CYCLE_MS = 1200;
export const DOTS_CYCLE_MS = 1200;
export const NODE_ANIM_CYCLE_MS = 1200;
export const DOTS_PER_EDGE = 3;
/** Even ~1 dot per this many content units. Tight spacing so packets read as a
 * continuous stream (seamless), not a few lonely dots. Clamped for short edges
 * + huge boards; used by both the live renderer and the GIF baker. */
export const DOTS_SPACING = 26;
export function dotsForLength(length: number): number {
  return Math.max(4, Math.min(40, Math.round(length / DOTS_SPACING)));
}

/** Animation speed is a continuous multiplier now (a 1–100 UI slider maps to
 * value/50, so 50 = 1×). Clamp to a sane, non-frozen range. */
export const SPEED_SLIDER_MAX = 100;
export function speedToSlider(mult: number | undefined): number {
  return Math.round(Math.min(SPEED_SLIDER_MAX, Math.max(1, (mult ?? 1) * 50)));
}
export function sliderToSpeed(slider: number): number {
  return Math.min(4, Math.max(0.1, slider / 50));
}

/** Per-intensity knobs for every flow style. Dash/beam dasharrays keep the
 * period sum constant (14 / 120) so the keyframe travel distance — and the
 * GIF phase math — never changes with intensity. */
export const FLOW_INTENSITY: Record<
  FlowIntensity,
  {
    /** dash: on/off pattern, sums to DASH_DISTANCE. */
    dashArray: string;
    /** beam: comet/gap pattern, sums to BEAM_DISTANCE. */
    beamArray: string;
    /** beam: opacity of the dimmed base line under the comet. */
    beamBaseOpacity: number;
    /** pulse: stroke-opacity at the bottom of the breath. */
    pulseMin: number;
    /** dots: packet radius = max(dotMinR, strokeWidth * dotScale). */
    dotScale: number;
    dotMinR: number;
  }
> = {
  subtle: { dashArray: "4 10", beamArray: "10 110", beamBaseOpacity: 0.55, pulseMin: 0.6, dotScale: 1.1, dotMinR: 2.5 },
  normal: { dashArray: "8 6", beamArray: "16 104", beamBaseOpacity: 0.35, pulseMin: 0.3, dotScale: 1.6, dotMinR: 3 },
  strong: { dashArray: "12 2", beamArray: "26 94", beamBaseOpacity: 0.18, pulseMin: 0.1, dotScale: 2.2, dotMinR: 4 },
};

/** Per-anim amplitude for node animations (peak of the 1.2s cycle). */
export const NODE_ANIM_PARAMS: Record<
  NodeAnim,
  { scaleAmp: number; rotateDeg: number; opacityMin: number; glowMaxBlur: number; glowMaxOpacity: number }
> = {
  pulse: { scaleAmp: 0.05, rotateDeg: 0, opacityMin: 1, glowMaxBlur: 0, glowMaxOpacity: 0 },
  glow: { scaleAmp: 0, rotateDeg: 0, opacityMin: 1, glowMaxBlur: 6, glowMaxOpacity: 0.9 },
  breathe: { scaleAmp: 0, rotateDeg: 0, opacityMin: 0.55, glowMaxBlur: 0, glowMaxOpacity: 0 },
  wobble: { scaleAmp: 0, rotateDeg: 1.5, opacityMin: 1, glowMaxBlur: 0, glowMaxOpacity: 0 },
};

/** Cycle duration in ms for a base cycle at a given speed multiplier (any
 * positive number — edges use a continuous 0.1–4× range; nodes use 0.5|1|2). */
export function cycleMs(baseMs: number, speed: number | undefined): number {
  return baseMs / (speed && speed > 0 ? speed : 1);
}

/** CSS `animation-duration` value for a base cycle at a given speed. */
export function cycleCss(baseMs: number, speed: number | undefined): string {
  return `${cycleMs(baseMs, speed) / 1000}s`;
}

/** Clamp an arbitrary number to a valid FlowSpeed (defensive parse). */
export function asFlowSpeed(v: unknown): FlowSpeed {
  return v === 0.5 || v === 2 ? v : 1;
}

/**
 * Ease-in-out "breath" 0→1→0 over phase p∈[0,1) — the cosine equivalent of
 * the CSS ease-in-out keyframes, used by the deterministic GIF bake.
 */
export function breath(p: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
}
