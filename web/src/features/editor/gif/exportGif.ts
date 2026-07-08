/**
 * features/editor/gif/exportGif — render the board to an animated GIF.
 *
 * Frames are rendered DETERMINISTICALLY (best practice — never screen-capture
 * a live CSS animation): for each frame time `t` the phase of every edge flow
 * style (dash/beam offsets, pulse opacity, dots via a hidden measure path +
 * getPointAtLength) AND every node idle animation (pulse/wobble → a centered
 * `transform`, breathe → `opacity`, glow → an feDropShadow filter) is baked
 * inline into a fresh copy of the board SVG, rasterized on a white canvas,
 * quantized and LZW-encoded. Per-edge/node speed scales each cycle
 * (base/speed, bases divide 1.2s), so durations that are multiples of 1.2s
 * loop seamlessly (2.4s covers the 0.5× slow cycles too). Timing/intensity
 * constants live in editor-core/diagram/animation.ts, shared with the live
 * CSS/SMIL renderers.
 */
import {
  asFlowSpeed,
  breath,
  cycleMs,
  DASH_CYCLE_MS,
  DASH_DISTANCE,
  BEAM_CYCLE_MS,
  BEAM_DISTANCE,
  PULSE_CYCLE_MS,
  DOTS_CYCLE_MS,
  dotsForLength,
  NODE_ANIM_CYCLE_MS,
  FLOW_INTENSITY,
  NODE_ANIM_PARAMS,
  type FlowIntensity,
  type NodeAnim,
} from "../../../editor-core/diagram";
import { useEditorStore } from "../../../state/editorStore";
import { watermarkOn } from "../../toolbar/watermark";
import { encodeGif, quantize, type IndexedFrame } from "./gifEncode";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Speed/intensity of an edge group, from the data-* attrs EdgeView emits.
 * Absent attrs (old boards, hand-made SVG) fall back to 1× / normal. */
function flowParams(group: Element): { speed: number; intensity: FlowIntensity } {
  const rawI = group.getAttribute("data-flow-intensity");
  // Edge speed is now a continuous multiplier (0.1–4×); clamp defensively.
  const raw = parseFloat(group.getAttribute("data-flow-speed") ?? "1");
  const speed = Number.isFinite(raw) ? Math.min(4, Math.max(0.1, raw)) : 1;
  return {
    speed,
    intensity: rawI === "subtle" || rawI === "strong" ? rawI : "normal",
  };
}

export interface GifOptions {
  durationMs: number;
  fps: number;
  scale: number;
}

export const GIF_DEFAULTS: GifOptions = { durationMs: 1200, fps: 20, scale: 1 };

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to render frame SVG."));
    };
    img.src = url;
  });
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Render + encode. Returns the GIF blob; reports 0..1 progress. Throws with a
 * descriptive message when the board is empty or rendering fails.
 */
export async function exportAnimatedGif(
  opts: GifOptions,
  onProgress: (v: number) => void,
): Promise<Blob> {
  const st = useEditorStore.getState();
  const baseSvg = st.currentBoardSvg({ watermark: watermarkOn() });
  if (!baseSvg) throw new Error("Board is empty — nothing to export.");
  const { w, h } = st.artboard;

  const outW = Math.max(1, Math.round(w * opts.scale));
  const outH = Math.max(1, Math.round(h * opts.scale));
  const frameCount = Math.max(1, Math.round((opts.durationMs / 1000) * opts.fps));
  const delayMs = 1000 / opts.fps;

  const doc = new DOMParser().parseFromString(baseSvg, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("The board's SVG is invalid.");
  const serializer = new XMLSerializer();

  // ---- collect edge animations with their per-edge speed/intensity -------
  // (data-* attrs on the edge group; cycle = base/speed so 1.2s-multiple GIF
  // durations keep looping seamlessly at every speed)
  const dashed: { el: Element; cycle: number; array: string }[] = [];
  const beams: { el: Element; cycle: number; array: string }[] = [];
  const pulses: { el: Element; cycle: number; min: number }[] = [];
  for (const g of Array.from(doc.querySelectorAll("[data-flow]"))) {
    const { speed, intensity } = flowParams(g);
    const P = FLOW_INTENSITY[intensity];
    g.querySelectorAll(".edge-animated").forEach((el) =>
      dashed.push({ el, cycle: cycleMs(DASH_CYCLE_MS, speed), array: P.dashArray }),
    );
    g.querySelectorAll(".edge-beam").forEach((el) =>
      beams.push({ el, cycle: cycleMs(BEAM_CYCLE_MS, speed), array: P.beamArray }),
    );
    g.querySelectorAll(".edge-pulse").forEach((el) =>
      pulses.push({ el, cycle: cycleMs(PULSE_CYCLE_MS, speed), min: P.pulseMin }),
    );
  }

  // ---- collect node animations (data-* attrs from NodeView) --------------
  // Scale/rotate bake a `transform` attribute around the recorded center;
  // breathe bakes `opacity`; glow is approximated with an feDropShadow
  // filter whose stdDeviation/flood-opacity are re-baked per frame.
  interface AnimNode {
    g: Element;
    anim: NodeAnim;
    cycle: number;
    cx: number;
    cy: number;
    shadow?: Element;
  }
  const animNodes: AnimNode[] = [];
  {
    const groups = Array.from(doc.querySelectorAll("[data-node-anim]"));
    let defs: Element | null = null;
    let glowSeq = 0;
    for (const g of groups) {
      const anim = g.getAttribute("data-node-anim") as NodeAnim | null;
      if (!anim || !(anim in NODE_ANIM_PARAMS)) continue;
      const speed = asFlowSpeed(parseFloat(g.getAttribute("data-anim-speed") ?? "1"));
      const entry: AnimNode = {
        g,
        anim,
        cycle: cycleMs(NODE_ANIM_CYCLE_MS, speed),
        cx: parseFloat(g.getAttribute("data-anim-cx") ?? "0"),
        cy: parseFloat(g.getAttribute("data-anim-cy") ?? "0"),
      };
      if (anim === "glow") {
        if (!defs) {
          defs = doc.createElementNS(SVG_NS, "defs");
          doc.documentElement.insertBefore(defs, doc.documentElement.firstChild);
        }
        const fid = `gif-glow-${glowSeq++}`;
        const filter = doc.createElementNS(SVG_NS, "filter");
        filter.setAttribute("id", fid);
        // generous region so the halo never clips at max blur
        filter.setAttribute("x", "-50%");
        filter.setAttribute("y", "-50%");
        filter.setAttribute("width", "200%");
        filter.setAttribute("height", "200%");
        const shadow = doc.createElementNS(SVG_NS, "feDropShadow");
        shadow.setAttribute("dx", "0");
        shadow.setAttribute("dy", "0");
        shadow.setAttribute("stdDeviation", "0");
        shadow.setAttribute("flood-color", g.getAttribute("data-anim-color") ?? "#2563eb");
        shadow.setAttribute("flood-opacity", "0");
        filter.appendChild(shadow);
        defs.appendChild(filter);
        g.setAttribute("filter", `url(#${fid})`);
        entry.shadow = shadow;
      }
      animNodes.push(entry);
    }
  }

  // ---- dots: replace SMIL circles with per-frame baked positions ----------
  // SMIL can't be "seeked" from markup, so we measure each dots-path in a
  // hidden live <svg> and place the packet circles ourselves each frame.
  const measureHost = document.createElementNS(SVG_NS, "svg");
  measureHost.setAttribute("width", "0");
  measureHost.setAttribute("height", "0");
  measureHost.style.position = "absolute";
  measureHost.style.visibility = "hidden";
  document.body.appendChild(measureHost);

  interface DotsEdge {
    group: Element;
    measure: SVGPathElement;
    cycle: number;
    r: number;
    fill: string;
  }
  const dotsEdges: DotsEdge[] = [];
  for (const g of Array.from(doc.querySelectorAll('[data-flow="dots"]'))) {
    const vis = g.querySelector('path[id^="edge-vis-"]') as SVGPathElement | null;
    const sample = g.querySelector("circle");
    if (!vis) continue;
    const mp = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    mp.setAttribute("d", vis.getAttribute("d") ?? "");
    measureHost.appendChild(mp);
    dotsEdges.push({
      group: g,
      measure: mp,
      cycle: cycleMs(DOTS_CYCLE_MS, flowParams(g).speed),
      // the live circles already carry the intensity-scaled radius
      r: sample ? parseFloat(sample.getAttribute("r") ?? "3.5") : 3.5,
      fill: sample?.getAttribute("fill") ?? "#475569",
    });
    // strip the SMIL circles — baked ones replace them each frame
    g.querySelectorAll("circle").forEach((c) => c.remove());
  }
  const bakedDots: Element[] = [];

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Couldn't create the canvas.");

  const frames: IndexedFrame[] = [];
  try {
  for (let i = 0; i < frameCount; i++) {
    const t = i * delayMs;
    // ---- bake every flow style's phase inline (CSS/SMIL never bakes itself)
    for (const d of dashed) {
      d.el.setAttribute("stroke-dasharray", d.array);
      d.el.setAttribute("stroke-dashoffset", (-DASH_DISTANCE * ((t / d.cycle) % 1)).toFixed(2));
    }
    for (const b of beams) {
      b.el.setAttribute("stroke-dasharray", b.array);
      b.el.setAttribute("stroke-dashoffset", (-BEAM_DISTANCE * ((t / b.cycle) % 1)).toFixed(2));
    }
    for (const p of pulses) {
      // 1 → min → 1 over one cycle (cosine ≈ the CSS ease-in-out breathe)
      const opacity = 1 - (1 - p.min) * breath((t / p.cycle) % 1);
      p.el.setAttribute("stroke-opacity", opacity.toFixed(3));
    }
    // node idle animations: transform / opacity / drop-shadow per frame
    for (const an of animNodes) {
      const P = NODE_ANIM_PARAMS[an.anim];
      const b = breath((t / an.cycle) % 1);
      switch (an.anim) {
        case "pulse": {
          const s = 1 + P.scaleAmp * b;
          an.g.setAttribute(
            "transform",
            `translate(${an.cx} ${an.cy}) scale(${s.toFixed(4)}) translate(${-an.cx} ${-an.cy})`,
          );
          break;
        }
        case "wobble": {
          // -deg at cycle start, +deg at half-cycle (mirrors the keyframes)
          const a = -P.rotateDeg + 2 * P.rotateDeg * b;
          an.g.setAttribute("transform", `rotate(${a.toFixed(3)} ${an.cx} ${an.cy})`);
          break;
        }
        case "breathe":
          an.g.setAttribute("opacity", (1 - (1 - P.opacityMin) * b).toFixed(3));
          break;
        case "glow":
          // feDropShadow stdDeviation ≈ CSS drop-shadow blur / 2
          an.shadow?.setAttribute("stdDeviation", ((P.glowMaxBlur / 2) * b).toFixed(2));
          an.shadow?.setAttribute("flood-opacity", (P.glowMaxOpacity * b).toFixed(3));
          break;
      }
    }
    // dots: place packets along each measured path
    bakedDots.forEach((c) => c.remove());
    bakedDots.length = 0;
    for (const de of dotsEdges) {
      const len = de.measure.getTotalLength();
      if (!len) continue;
      const dotsP = (t / de.cycle) % 1;
      const n = dotsForLength(len); // match the live renderer's dot count
      for (let d = 0; d < n; d++) {
        const at = ((dotsP + d / n) % 1) * len;
        const p = de.measure.getPointAtLength(at);
        const c = doc.createElementNS(SVG_NS, "circle");
        c.setAttribute("cx", p.x.toFixed(1));
        c.setAttribute("cy", p.y.toFixed(1));
        c.setAttribute("r", String(de.r));
        c.setAttribute("fill", de.fill);
        de.group.appendChild(c);
        bakedDots.push(c);
      }
    }
    const img = await svgToImage(serializer.serializeToString(doc.documentElement));

    ctx.fillStyle = "#ffffff"; // GIF has no real alpha — flat white background
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    const data = ctx.getImageData(0, 0, outW, outH).data;

    const { indices, palette } = quantize(data);
    frames.push({ indices, palette, delayMs });

    onProgress((i + 1) / (frameCount + 1)); // reserve the last tick for encode
    await nextTick(); // keep the UI responsive
  }
  } finally {
    measureHost.remove();
  }

  const bytes = encodeGif(outW, outH, frames, true);
  onProgress(1);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "image/gif" });
}
