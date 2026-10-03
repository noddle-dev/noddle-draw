/**
 * state/grouping — the ONE place the group UX reads and acts from (⌘G
 * shortcut, Simple style panel, context menu), so the buttons, the keys and
 * the status copy can't disagree.
 *
 * Model: a group is just a shared `groupId` on nodes (flat, no nesting —
 * grouping members of different groups merges them into one new group).
 * Clicking a member selects the whole group (NodeView); ⌘/Ctrl-click
 * deep-selects ONE member so it can be edited/moved alone.
 */
import type { DiagramNode } from "../editor-core/diagram";
import { useDiagramStore } from "./diagramStore";
import { useEditorStore } from "./editorStore";

export interface GroupState {
  /** ≥2 nodes selected and they aren't already exactly one group. */
  canGroup: boolean;
  /** Some selected node belongs to a group. */
  canUngroup: boolean;
  /** The selection is exactly one whole group → its id. */
  wholeGroup: string | null;
  /** Groups only PARTLY selected (a deep-selected member) → their ids. */
  partialGroups: string[];
}

export function groupState(nodes: Record<string, DiagramNode>, selection: string[]): GroupState {
  const sel = selection.filter((id) => nodes[id]);
  const gids = new Set(sel.map((id) => nodes[id].groupId).filter(Boolean) as string[]);
  const members = (gid: string) => Object.values(nodes).filter((n) => n.groupId === gid).map((n) => n.id);
  let wholeGroup: string | null = null;
  if (gids.size === 1 && sel.every((id) => nodes[id].groupId)) {
    const [gid] = gids;
    if (members(gid).length === sel.length) wholeGroup = gid;
  }
  const partialGroups = [...gids].filter((gid) => members(gid).some((id) => !sel.includes(id)));
  return {
    canGroup: sel.length >= 2 && !wholeGroup,
    canUngroup: gids.size > 0,
    wholeGroup,
    partialGroups,
  };
}

/** ⌘G — group the selected nodes, with a status line that teaches the undo key. */
export function groupSelected(): void {
  const ds = useDiagramStore.getState();
  const st = groupState(ds.nodes, ds.diagramSelection);
  const ed = useEditorStore.getState();
  if (!st.canGroup) {
    ed.setStatus(st.wholeGroup ? "Already a group — ⌘⇧G ungroups it." : "Select at least two shapes to group.");
    return;
  }
  const n = ds.diagramSelection.filter((id) => ds.nodes[id]).length;
  ds.groupSelection();
  ed.setStatus(`Grouped ${n} shapes — ⌘-click edits one, ⌘⇧G ungroups.`, "ok");
}

/** ⌘⇧G — ungroup every group the selection touches (the WHOLE group, so no
 * stragglers stay grouped with a lone member). */
export function ungroupSelected(): void {
  const ds = useDiagramStore.getState();
  const gids = new Set(
    ds.diagramSelection.map((id) => ds.nodes[id]?.groupId).filter(Boolean) as string[],
  );
  const ed = useEditorStore.getState();
  if (!gids.size) {
    ed.setStatus("Nothing grouped in the selection.");
    return;
  }
  const all = Object.values(ds.nodes).filter((n) => n.groupId && gids.has(n.groupId)).map((n) => n.id);
  ds.setDiagramSelection([...new Set([...ds.diagramSelection, ...all])]);
  ds.ungroupSelection();
  ed.setStatus(`Ungrouped ${all.length} shapes.`, "ok");
}
