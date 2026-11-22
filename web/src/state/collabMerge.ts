/** Apply only the remote author's changes, preserving unrelated local edits. */
export type LiveObject = { id: string; [key: string]: unknown };
export type LivePage = { nodes: unknown[]; edges: unknown[] };

function objects(current: unknown[], desired: unknown[], base?: unknown[], removed: string[] = []) {
  const before = new Map((base ?? []).map((v) => [(v as LiveObject).id, v as LiveObject]));
  const incoming = new Map(desired.map((v) => [(v as LiveObject).id, v as LiveObject]));
  const result = new Map(current.map((v) => [(v as LiveObject).id, v as LiveObject]));
  for (const id of removed) result.delete(id);
  if (base) for (const id of before.keys()) if (!incoming.has(id)) result.delete(id);
  for (const [id, next] of incoming) {
    const prev = before.get(id);
    if (prev && !result.has(id)) continue; // don't resurrect a local deletion
    if (!prev || !base) { result.set(id, next); continue; }
    const merged = { ...result.get(id)! };
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (JSON.stringify(prev[key]) === JSON.stringify(next[key])) continue;
      if (key in next) merged[key] = next[key]; else delete merged[key];
    }
    result.set(id, merged);
  }
  return [...result.values()];
}

export function mergeRemotePage(current: LivePage, desired: LivePage, base?: LivePage,
                                removedNodes: string[] = [], removedEdges: string[] = []): LivePage {
  return {
    nodes: objects(current.nodes, desired.nodes, base?.nodes, removedNodes),
    edges: objects(current.edges, desired.edges, base?.edges, removedEdges),
  };
}
