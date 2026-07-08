/**
 * features/diagram/ports — the 5 connection anchors shown on node hover.
 * Relative positions (0..1 of the node box): N, E, S, W, center.
 */
import type { Vec } from "../../editor-core/diagram";

export interface PortDef {
  id: string;
  rel: Vec;
}

export const PORTS: PortDef[] = [
  { id: "n", rel: { x: 0.5, y: 0 } },
  { id: "e", rel: { x: 1, y: 0.5 } },
  { id: "s", rel: { x: 0.5, y: 1 } },
  { id: "w", rel: { x: 0, y: 0.5 } },
  { id: "c", rel: { x: 0.5, y: 0.5 } },
];
