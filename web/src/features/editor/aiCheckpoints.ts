/**
 * features/editor/aiCheckpoints — rollback points for AI chat edits.
 *
 * Every applied AI edit records ONE checkpoint: a per-object before/after
 * diff (same philosophy as state/diagramHistory — never whole-board
 * snapshots, so rolling back on a live shared board only reverts the
 * objects the AI touched, not collaborators' work). Checkpoints are kept
 * per board, newest last, capped at 20; rolling back to checkpoint N
 * reverts N..newest in reverse order and drops them from the stack.
 *
 * The rollback itself is applied WITHOUT pausing history, then committed as
 * one undo step — so a rollback is itself undoable with ⌘Z and broadcasts
 * to collab peers like any local change.
 */
import { create } from "zustand";
import type { DiagramEdge, DiagramNode } from "../../editor-core/diagram";
import { commitHistoryNow } from "../../state/diagramHistory";
import { useDiagramStore } from "../../state/diagramStore";
import { usePagesStore } from "../../state/pagesStore";

const MAX_CHECKPOINTS = 20;

type NodeMap = Record<string, DiagramNode>;
type EdgeMap = Record<string, DiagramEdge>;

interface Diff {
  nodes: { id: string; before?: DiagramNode; after?: DiagramNode }[];
  edges: { id: string; before?: DiagramEdge; after?: DiagramEdge }[];
}

interface AiCheckpoint {
  id: string;
  pageId: string | null;
  /** The user instruction that produced this edit (UI/debug context). */
  prompt: string;
  diff: Diff;
}

/** Per-board stacks, newest last. In-memory only: a reload drops them (the
 * regular undo history and server-side document versions still exist). */
const stacks = new Map<string, AiCheckpoint[]>();
let seq = 0;

interface AiCheckpointState {
  /** Ids still present in some stack — drives the chat Rollback buttons. */
  available: Record<string, true>;
}

export const useAiCheckpoints = create<AiCheckpointState>(() => ({ available: {} }));

function syncAvailable() {
  const available: Record<string, true> = {};
  for (const stack of stacks.values()) {
    for (const cp of stack) available[cp.id] = true;
  }
  useAiCheckpoints.setState({ available });
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Diff two object maps into a reversible per-object step (changed ids only). */
function diffMaps(
  beforeNodes: NodeMap,
  beforeEdges: EdgeMap,
  afterNodes: NodeMap,
  afterEdges: EdgeMap,
): Diff | null {
  const diff: Diff = { nodes: [], edges: [] };
  for (const id of new Set([...Object.keys(beforeNodes), ...Object.keys(afterNodes)])) {
    const b = beforeNodes[id], a = afterNodes[id];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff.nodes.push({ id, before: b && clone(b), after: a && clone(a) });
    }
  }
  for (const id of new Set([...Object.keys(beforeEdges), ...Object.keys(afterEdges)])) {
    const b = beforeEdges[id], a = afterEdges[id];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff.edges.push({ id, before: b && clone(b), after: a && clone(a) });
    }
  }
  return diff.nodes.length || diff.edges.length ? diff : null;
}

/**
 * Record a checkpoint for an AI edit about to replace the CURRENT store
 * content with `afterNodes`/`afterEdges`. Returns the checkpoint id, or null
 * when the edit changes nothing (no checkpoint recorded → no rollback button).
 */
export function recordAiCheckpoint(
  docId: string | null,
  prompt: string,
  afterNodes: DiagramNode[],
  afterEdges: DiagramEdge[],
): string | null {
  const ds = useDiagramStore.getState();
  const afterN: NodeMap = {};
  for (const n of afterNodes) afterN[n.id] = n;
  const afterE: EdgeMap = {};
  for (const e of afterEdges) afterE[e.id] = e;
  const diff = diffMaps(ds.nodes, ds.edges, afterN, afterE);
  if (!diff) return null;

  const key = docId ?? "__scratch__";
  const stack = stacks.get(key) ?? [];
  const cp: AiCheckpoint = {
    id: `cp${++seq}`,
    pageId: usePagesStore.getState().activeId,
    prompt: prompt.slice(0, 200),
    diff,
  };
  stack.push(cp);
  if (stack.length > MAX_CHECKPOINTS) stack.shift();
  stacks.set(key, stack);
  syncAvailable();
  return cp.id;
}

/** How many objects a checkpoint's diff touches (for the chat status line). */
export function checkpointSize(diff: Diff): number {
  return diff.nodes.length + diff.edges.length;
}

export type RollbackResult =
  | { ok: true; reverted: number }
  | { ok: false; reason: "gone" | "wrong-page" };

/**
 * Roll the board back to the state BEFORE checkpoint `id`: reverts that
 * checkpoint and every AI edit applied after it (newest first), then drops
 * them from the stack. Only objects those edits touched are reverted —
 * unrelated user/collaborator work is left alone.
 */
export function rollbackAiCheckpoint(docId: string | null, id: string): RollbackResult {
  const key = docId ?? "__scratch__";
  const stack = stacks.get(key) ?? [];
  const idx = stack.findIndex((cp) => cp.id === id);
  if (idx === -1) return { ok: false, reason: "gone" };

  const activePage = usePagesStore.getState().activeId;
  const toRevert = stack.slice(idx);
  if (toRevert.some((cp) => cp.pageId !== activePage)) {
    return { ok: false, reason: "wrong-page" };
  }

  commitHistoryNow(); // the user's in-flight gesture becomes its own undo step
  let reverted = 0;
  for (let i = toRevert.length - 1; i >= 0; i--) {
    const { diff } = toRevert[i];
    const upsertNodes: DiagramNode[] = [];
    const removeNodeIds: string[] = [];
    const upsertEdges: DiagramEdge[] = [];
    const removeEdgeIds: string[] = [];
    for (const n of diff.nodes) {
      if (n.before) upsertNodes.push(clone(n.before));
      else removeNodeIds.push(n.id); // added by the AI → remove
    }
    for (const e of diff.edges) {
      if (e.before) upsertEdges.push(clone(e.before));
      else removeEdgeIds.push(e.id);
    }
    useDiagramStore.getState().applyPatch({ upsertNodes, removeNodeIds, upsertEdges, removeEdgeIds });
    reverted += 1;
  }
  stack.splice(idx);
  syncAvailable();
  commitHistoryNow(); // the whole rollback = one undoable step
  return { ok: true, reverted };
}
