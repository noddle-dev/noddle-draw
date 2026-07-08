/**
 * features/diagram/DirectionalArrows — draw.io-style growth arrows.
 *
 * A SINGLE selected shape shows 4 chevrons (N/E/S/W just outside it):
 *   • click a chevron  → create a connected shape of the SAME kind in that
 *     direction (fast path), select it and open its text editor;
 *   • hover a chevron  → a mini shape picker (rect / rounded / ellipse /
 *     diamond) pops out beyond it; clicking one creates THAT kind instead.
 * Everything is screen-constant (scaled by 1/zoom) and editor-only chrome.
 */
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DiagramNode, NodeKind, Vec } from "../../editor-core/diagram";
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";
import { panState } from "../../state/panState";
import { beginNodeTextEdit } from "./nodeTextEdit";

const ACCENT = "#2563eb";
const GAP = 70; // content-space gap between the source and the spawned shape
const PICKER_KINDS: NodeKind[] = ["rect", "rounded", "ellipse", "diamond"];

type Dir = "n" | "e" | "s" | "w";
const DIRS: { dir: Dir; dx: number; dy: number; rel: Vec }[] = [
  { dir: "n", dx: 0, dy: -1, rel: { x: 0.5, y: 0 } },
  { dir: "e", dx: 1, dy: 0, rel: { x: 1, y: 0.5 } },
  { dir: "s", dx: 0, dy: 1, rel: { x: 0.5, y: 1 } },
  { dir: "w", dx: -1, dy: 0, rel: { x: 0, y: 0.5 } },
];

function mintEdgeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export function DirectionalArrows({ node }: { node: DiagramNode }) {
  const z = useEditorStore((s) => s.cam.z) || 1;
  const [picker, setPicker] = useState<Dir | null>(null);
  const u = 1 / z; // screen px → content units
  // Grace period: the picker must survive the pointer traveling from the
  // chevron across to it (and brief overshoots) — hide only after a delay.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPicker = (d: Dir) => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setPicker(d);
  };
  const schedulePickerHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPicker(null), 350);
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const spawn = (d: (typeof DIRS)[number], kind?: NodeKind) => {
    const ds = useDiagramStore.getState();
    const src = ds.nodes[node.id];
    if (!src) return;
    const k = kind ?? src.kind;
    const same = k === src.kind;
    // Same kind clones the size; a different kind uses its catalog default.
    const w = same ? src.w : undefined;
    const h = same ? src.h : undefined;
    const halfW = (w ?? 140) / 2;
    const halfH = (h ?? 90) / 2;
    const cx = src.x + src.w / 2;
    const cy = src.y + src.h / 2;
    const center = {
      x: cx + d.dx * (src.w / 2 + GAP + halfW),
      y: cy + d.dy * (src.h / 2 + GAP + halfH),
    };
    const newId = ds.addNodeAt(k, center, {
      ...(w != null && h != null ? { w, h } : {}),
      fill: src.fill,
      stroke: src.stroke,
      strokeWidth: src.strokeWidth,
      sketch: src.sketch,
      wrap: src.wrap,
    });
    useDiagramStore.getState().addEdge({
      id: mintEdgeId(),
      source: { kind: "port", nodeId: node.id, rel: d.rel },
      target: { kind: "floating", nodeId: newId },
      routing: "elbow",
      stroke: "#475569",
      strokeWidth: 2,
      endArrow: true,
      startArrow: false,
      animated: false,
    });
    const st = useDiagramStore.getState();
    st.setDiagramSelection([newId]);
    const created = st.nodes[newId];
    if (created) beginNodeTextEdit(created);
    useEditorStore.getState().setStatus("Shape added and connected.", "ok");
  };

  const onArrowDown = (d: (typeof DIRS)[number]) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || panState.spaceHeld) return;
    e.stopPropagation();
    spawn(d);
  };

  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const OFF = 26 * u; // chevron distance beyond the border
  const S = 9 * u; // chevron half-size

  return (
    <g data-editor-only="1" onPointerEnter={() => { if (picker) showPicker(picker); }} onPointerLeave={schedulePickerHide}>
      {DIRS.map((d) => {
        const ax = cx + d.dx * (node.w / 2 + OFF);
        const ay = cy + d.dy * (node.h / 2 + OFF);
        // chevron pointing outward
        const rot = d.dir === "e" ? 0 : d.dir === "s" ? 90 : d.dir === "w" ? 180 : -90;
        const open = picker === d.dir;
        return (
          <g key={d.dir}>
            {/* invisible BRIDGE from the border past the chevron to the panel,
                so the pointer never "falls off" while traveling to it */}
            {open && (
              <rect
                x={d.dx !== 0 ? cx + (d.dx > 0 ? node.w / 2 : -node.w / 2 - 96 * u) : cx - 30 * u}
                y={d.dy !== 0 ? cy + (d.dy > 0 ? node.h / 2 : -node.h / 2 - 96 * u) : cy - 30 * u}
                width={d.dx !== 0 ? 96 * u : 60 * u}
                height={d.dy !== 0 ? 96 * u : 60 * u}
                fill="transparent"
                onPointerEnter={() => showPicker(d.dir)}
              />
            )}
            <g
              transform={`translate(${ax} ${ay}) rotate(${rot})`}
              style={{ cursor: "copy" }}
              onPointerDown={onArrowDown(d)}
              onPointerEnter={() => showPicker(d.dir)}
            >
              <circle r={16 * u} fill="transparent" />
              <path
                d={`M ${-S * 0.5} ${-S} L ${S * 0.7} 0 L ${-S * 0.5} ${S} Z`}
                fill={ACCENT}
                opacity={open ? 0.9 : 0.55}
              />
              <title>Click: add a connected shape · hover: pick a shape</title>
            </g>
            {open && (
              <g onPointerEnter={() => showPicker(d.dir)}>
                <ShapePicker node={node} d={d} u={u} onPick={(k) => spawn(d, k)} />
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Mini vertical shape palette floating beyond one chevron (see screenshot UX). */
function ShapePicker({
  node,
  d,
  u,
  onPick,
}: {
  node: DiagramNode;
  d: (typeof DIRS)[number];
  u: number;
  onPick: (k: NodeKind) => void;
}) {
  const [hover, setHover] = useState<NodeKind | null>(null);
  const BTN = 36 * u; // generous targets — the old 30px felt fiddly
  const PAD = 6 * u;
  const W = BTN + PAD * 2;
  const H = BTN * PICKER_KINDS.length + PAD * 2;
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  // panel sits just beyond the chevron, centered on the axis
  const px =
    d.dx !== 0
      ? cx + d.dx * (node.w / 2 + 44 * u) + (d.dx > 0 ? 0 : -W)
      : cx - W / 2;
  const py =
    d.dy !== 0
      ? cy + d.dy * (node.h / 2 + 44 * u) + (d.dy > 0 ? 0 : -H)
      : cy - H / 2;

  const glyph = (k: NodeKind, x: number, y: number, s: number) => {
    const common = { fill: "none", stroke: "#6b7280", strokeWidth: 1.6 * u } as const;
    switch (k) {
      case "rect":
        return <rect x={x - s} y={y - s * 0.62} width={s * 2} height={s * 1.24} {...common} />;
      case "rounded":
        return <rect x={x - s} y={y - s * 0.62} width={s * 2} height={s * 1.24} rx={s * 0.4} {...common} />;
      case "ellipse":
        return <circle cx={x} cy={y} r={s * 0.8} {...common} />;
      default:
        return (
          <path
            d={`M ${x} ${y - s * 0.8} L ${x + s * 0.9} ${y} L ${x} ${y + s * 0.8} L ${x - s * 0.9} ${y} Z`}
            {...common}
          />
        );
    }
  };

  return (
    <g data-testid={`shape-picker-${d.dir}`}>
      <rect
        x={px}
        y={py}
        width={W}
        height={H}
        rx={8 * u}
        fill="#fff"
        stroke="#e2e6ee"
        strokeWidth={1 * u}
        style={{ filter: "drop-shadow(0 2px 6px rgba(16,24,40,.14))" }}
      />
      {PICKER_KINDS.map((k, i) => {
        const bx = px + PAD;
        const by = py + PAD + i * BTN;
        return (
          <g
            key={k}
            style={{ cursor: "pointer" }}
            onPointerEnter={() => setHover(k)}
            onPointerLeave={() => setHover((h) => (h === k ? null : h))}
            onPointerDown={(e) => {
              if (e.button !== 0 || panState.spaceHeld) return;
              e.stopPropagation();
              onPick(k);
            }}
          >
            <rect
              x={bx}
              y={by}
              width={BTN}
              height={BTN}
              rx={6 * u}
              fill={hover === k ? "#eef4ff" : "transparent"}
            />
            {glyph(k, bx + BTN / 2, by + BTN / 2, 10 * u)}
            <title>{k}</title>
          </g>
        );
      })}
    </g>
  );
}
