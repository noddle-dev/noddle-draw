/**
 * features/library/types — the Library browser's data contract.
 *
 * A LIBRARY ITEM is a normalized diagram FRAGMENT — the same shape as a
 * "My shapes" stencil (state/myShapesStore.MyShape): nodes + the edges between
 * them, coordinates re-based so the bbox min is (0,0), plus the bbox size.
 * Inserting one stamps fresh ids (diagramStore.insertFragment), so the ids
 * authored here only need to be unique WITHIN the item.
 *
 * Built-in packs are static TypeScript (builtins/*.ts) — type-checked against
 * DiagramNode, tree-shaken, no backend: nothing durable is stored server-side.
 */
import type { DiagramEdge, DiagramNode } from "../../editor-core/diagram";

export interface LibraryItem {
  id: string;
  name: string;
  /** Search keywords beyond the name (lowercase). */
  tags: string[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Fragment bbox (nodes re-based to 0,0). */
  w: number;
  h: number;
  /** Sub-section within its pack (e.g. a cloud service cluster) — consecutive
   * items sharing one render under a small coloured header. */
  section?: string;
  sectionColor?: string;
}

/** A pack's colour identity — a key of LIB_PALETTE. */
export type LibHue = keyof typeof import("./palette").LIB_PALETTE;

export interface LibraryPack {
  id: string;
  name: string;
  /** One-line description shown under the pack title. */
  blurb: string;
  hue: LibHue;
  items: LibraryItem[];
}
