/**
 * features/layers/useLayers — derive the layer list from the live #content DOM.
 *
 * The editable SVG lives in real DOM, not React state, so we re-derive whenever
 * `contentRev` (bumped on every content mutation) or `selection` changes.
 * Top of the panel = top of z-order, so children are iterated in reverse.
 */
import { useMemo } from "react";
import { localName, NON_VISUAL, type SceneObject } from "../../editor-core";
import { useEditorStore } from "../../state/editorStore";

export interface LayerRow {
  el: SceneObject;
  id: string;
  tag: string;
  hidden: boolean;
  selected: boolean;
}

export function useLayers(): LayerRow[] {
  const refs = useEditorStore((s) => s.refs);
  const selection = useEditorStore((s) => s.selection);
  const contentRev = useEditorStore((s) => s.contentRev);

  return useMemo(() => {
    if (!refs) return [];
    const rows: LayerRow[] = [];
    const children = Array.from(refs.content.children).reverse();
    for (const el of children) {
      if (NON_VISUAL.has(localName(el))) continue;
      const g = el as SceneObject;
      rows.push({
        el: g,
        id: g.id,
        tag: localName(g),
        hidden: g.getAttribute("display") === "none",
        selected: selection.includes(g),
      });
    }
    return rows;
    // contentRev intentionally in deps: it signals the DOM changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, selection, contentRev]);
}
