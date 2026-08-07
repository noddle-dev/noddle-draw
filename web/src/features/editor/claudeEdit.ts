/**
 * features/editor/claudeEdit — Claude as a LIVE co-editor, with a MESSAGE
 * QUEUE and multi-turn context (like chatting with Claude proper).
 *
 * The input never locks: every send is enqueued instantly (the user bubble
 * appears right away) and a single drain loop processes items sequentially —
 * each request reads the diagram FRESH from the store (so item N sees item
 * N-1's edits) and carries the recent conversation transcript, so follow-ups
 * like "change it to blue" keep their referents. Edits apply through
 * diagramStore.loadDiagram → broadcast live to every collab peer.
 */
import { api } from "../../shared/api/client";
import type { DiagramEdge, DiagramNode } from "../../editor-core/diagram";
import { useAppStore } from "../../state/appStore";
import { commitHistoryNow } from "../../state/diagramHistory";
import { useDiagramStore } from "../../state/diagramStore";
import { useEditorStore } from "../../state/editorStore";
import { usePagesStore } from "../../state/pagesStore";
import { recordAiCheckpoint } from "./aiCheckpoints";

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // fetch network failures surface as the useless "Failed to fetch" — long
  // AI calls are the ones most likely to hit a dropped connection or a
  // server restart mid-flight.
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return (
      "the connection dropped while the AI was working (network blip or a " +
      "server restart). Your board is unchanged — please send the message again."
    );
  }
  return msg;
}

// ---- concurrent-edit safe apply ----------------------------------------------

/** JSON with recursively sorted keys — stable equality for diff detection. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

interface BaseSnapshot {
  nodes: Map<string, string>; // id → stable JSON at send time
  edges: Map<string, string>;
}

function snapshotBase(diagram: { nodes: unknown[]; edges: unknown[] }): BaseSnapshot {
  const nodes = new Map<string, string>();
  const edges = new Map<string, string>();
  for (const n of diagram.nodes as { id: string }[]) nodes.set(n.id, stableStringify(n));
  for (const e of diagram.edges as { id: string }[]) edges.set(e.id, stableStringify(e));
  return { nodes, edges };
}

function endpointOk(a: DiagramEdge["source"], nodes: Map<string, DiagramNode>): boolean {
  return a.kind === "free" || nodes.has((a as { nodeId?: string }).nodeId ?? "");
}

// Fields the AI pipeline may drop (model forgets them / older servers strip
// them) but that carry user data or look — when the AI "modifies" an object
// and its output OMITS one of these while the live object has it, keep the
// live value. Losing edge label blocks and z paint order this way was the
// "text on arrows vanishes / layers reshuffle after an AI edit" bug.
const NODE_PRESERVE = [
  "fontSize", "bold", "italic", "underline", "textColor", "textAlign", "wrap",
  "opacity", "cornerRadius", "strokeDash", "iconKey", "imageHref", "groupId", "z",
] as const;
const EDGE_PRESERVE = ["labels", "dash", "endHead", "startHead", "z"] as const;

function withPreserved<T extends DiagramNode | DiagramEdge>(
  ai: T,
  current: T | undefined,
  keys: readonly string[],
): T {
  if (!current) return ai;
  const out = { ...ai } as unknown as Record<string, unknown>;
  const cur = current as unknown as Record<string, unknown>;
  for (const k of keys) {
    if (!(k in out) && k in cur) out[k] = cur[k];
  }
  return out as T;
}

/**
 * Three-way merge of the model's result onto the CURRENT board.
 *
 * The AI call can take minutes; the user (or a collaborator) may have edited
 * shapes meanwhile. Blindly applying the model's FULL diagram replayed the
 * pre-call snapshot and silently clobbered those edits ("the AI used a stale
 * board"). Instead: start from the CURRENT store and apply only what the
 * model actually changed relative to the snapshot it was given —
 *   • object added by the AI            → add it
 *   • object modified vs the snapshot   → the AI wins (it was asked to)
 *   • object the AI left untouched      → keep the CURRENT version
 *   • object deleted by the AI          → delete it
 * Edges pointing at nodes that no longer exist are dropped.
 */
function mergeAiResult(
  base: BaseSnapshot,
  aiNodes: DiagramNode[],
  aiEdges: DiagramEdge[],
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const ds = useDiagramStore.getState();
  const nodes = new Map<string, DiagramNode>(Object.entries(ds.nodes));
  const edges = new Map<string, DiagramEdge>(Object.entries(ds.edges));

  const aiNodeIds = new Set<string>();
  for (const n of aiNodes) {
    aiNodeIds.add(n.id);
    const before = base.nodes.get(n.id);
    if (before === undefined || before !== stableStringify(n)) {
      nodes.set(n.id, withPreserved(n, nodes.get(n.id), NODE_PRESERVE));
    }
  }
  for (const id of base.nodes.keys()) {
    if (!aiNodeIds.has(id)) nodes.delete(id); // AI deleted it
  }

  const aiEdgeIds = new Set<string>();
  for (const e of aiEdges) {
    aiEdgeIds.add(e.id);
    const before = base.edges.get(e.id);
    if (before === undefined || before !== stableStringify(e)) {
      edges.set(e.id, withPreserved(e, edges.get(e.id), EDGE_PRESERVE));
    }
  }
  for (const id of base.edges.keys()) {
    if (!aiEdgeIds.has(id)) edges.delete(id);
  }

  // Never emit dangling refs (an endpoint's node was deleted on either side).
  for (const [id, e] of edges) {
    if (!endpointOk(e.source, nodes) || !endpointOk(e.target, nodes)) edges.delete(id);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

interface QueueItem {
  text: string;
  /** Board the message was written on — skipped if the user switched docs. */
  docId: string | null;
  /** PAGE the message was written on — the diagram store only holds the
   * ACTIVE page, so running this item on another page would read the wrong
   * context and, worse, apply the result over the wrong page's shapes. */
  pageId: string | null;
  /** Optional reference image (data URL) sent to the vision model with the text. */
  image?: string;
  /** Chat intent captured at ENQUEUE time (the user may flip the switch while
   * a message waits): "edit" mutates the board, "ask" only answers. */
  mode: "edit" | "ask";
}

const MAX_TURNS = 12;

type Turn = { role: "user" | "assistant"; content: string };

const queue: QueueItem[] = [];
let processing = false;
/** Per-BOARD processed transcripts — sessions are graph-scoped, never shared. */
const transcripts = new Map<string, Turn[]>();

/** Active session id for a board (used to scope the model transcript). */
function activeSessionId(docId: string | null): string {
  const board = useAppStore.getState().chats[docId ?? "__scratch__"];
  return board?.activeId ?? "s0";
}

/** Transcript is per (board, session) so a new session starts a clean context. */
function transcriptOf(docId: string | null, sessionId: string): Turn[] {
  const key = `${docId ?? "__scratch__"}::${sessionId}`;
  let t = transcripts.get(key);
  if (!t) {
    t = [];
    transcripts.set(key, t);
  }
  return t;
}

function syncQueueCount() {
  useAppStore.setState({ queuedChats: queue.length });
}

/** Enqueue a chat message. Returns immediately; the drain loop does the work.
 * ``image`` optionally attaches a reference image (validated data URL) that is
 * sent to the vision model alongside the text. ``mode`` overrides the current
 * chat-mode switch (programmatic edit actions always force "edit"). */
export function askClaudeEdit(text: string, image?: string, mode?: "edit" | "ask"): void {
  const t = text.trim();
  if (!t) return;
  const docId = useEditorStore.getState().docId;
  const pageId = usePagesStore.getState().activeId;
  useAppStore.getState().pushChat(docId, { who: "you", text: t, ...(image ? { image } : {}) });
  queue.push({ text: t, docId, pageId, image, mode: mode ?? useAppStore.getState().chatMode });
  syncQueueCount();
  void drain();
}

/** Enrich ONLY the given objects (right-click → "Enrich with AI"). */
export function askClaudeEditSelection(text: string, ids: string[]): void {
  const t = text.trim();
  if (!t || !ids.length) return;
  askClaudeEdit(
    `[Apply ONLY to the objects with id: ${ids.join(", ")} — keep everything else exactly unchanged] ${t}`,
    undefined,
    "edit",
  );
}

/** One-click semantic grouping of the whole board. */
export function askClaudeGroupBy(): void {
  askClaudeEdit(
    "Semantically analyze the objects and GROUP them: create a container (rect fill transparent + label node) for each group by tier/function, move the related nodes inside their corresponding frame (no overlap, keep a gap ≥40), and keep the edges and each node's style unchanged.",
    undefined,
    "edit",
  );
}

async function drain(): Promise<void> {
  if (processing) return;
  processing = true;
  useAppStore.getState().setAiThinking(true);
  try {
    while (queue.length) {
      const item = queue.shift()!;
      syncQueueCount();

      // The board changed underneath this message — don't edit the wrong doc.
      if (item.docId !== useEditorStore.getState().docId) {
        useAppStore.getState().pushChat(item.docId, {
          who: "ai",
          text: `Skipped "${item.text.slice(0, 40)}…" — the board has changed.`,
        });
        continue;
      }
      // Same for the PAGE: the store only holds the active page, so a
      // message written on page A must never run against (or write into)
      // page B after a switch.
      if (item.pageId !== usePagesStore.getState().activeId) {
        useAppStore.getState().pushChat(item.docId, {
          who: "ai",
          text: `Skipped "${item.text.slice(0, 40)}…" — you switched to another page. Switch back and ask again.`,
        });
        continue;
      }

      const transcript = transcriptOf(item.docId, activeSessionId(item.docId));
      try {
        const ds = useDiagramStore.getState();
        const diagram = {
          nodes: Object.values(ds.nodes),
          edges: Object.values(ds.edges),
        };
        // Snapshot what the model SEES — the merge below diffs its output
        // against this, so edits made while it works survive.
        const base = snapshotBase(diagram);
        const res = await api.editDiagram(
          item.text,
          diagram,
          transcript.slice(-MAX_TURNS),
          undefined,
          item.image,
          item.mode,
        );
        if (res.nodes == null || res.edges == null) {
          // Answer-only: "ask" mode, or the model judged the message a
          // question in edit mode — nothing touches the board.
          useAppStore.getState().pushChat(item.docId, { who: "ai", text: res.message });
        } else {
          // The user may have switched pages WHILE the model worked — applying
          // now would overwrite the newly active page with page-A content.
          if (item.pageId !== usePagesStore.getState().activeId) {
            useAppStore.getState().pushChat(item.docId, {
              who: "ai",
              text: "Done, but you switched pages while I was working — I dropped the result to avoid editing the wrong page. Switch back and ask again.",
            });
            continue;
          }
          // Apply the model's CHANGES onto the current board (not a blind
          // replace) → renders locally AND syncs to all collab peers.
          const merged = mergeAiResult(base, res.nodes, res.edges);
          // Any in-flight user gesture becomes its own undo step first, then
          // the AI edit is recorded as a rollback checkpoint (max 20/board)
          // and committed as ONE immediately-⌘Z-able step of its own.
          commitHistoryNow();
          const checkpointId = recordAiCheckpoint(item.docId, item.text, merged.nodes, merged.edges);
          if (checkpointId) {
            useDiagramStore.getState().loadDiagram(merged.nodes, merged.edges);
            commitHistoryNow();
          }
          useAppStore.getState().pushChat(item.docId, {
            who: "ai",
            text: res.message,
            ...(checkpointId ? { checkpointId } : {}),
          });
        }
        if (res.usage) useAppStore.getState().addChatUsage(item.docId, res.usage);
        transcript.push({ role: "user", content: item.text });
        transcript.push({ role: "assistant", content: res.message });
        if (transcript.length > MAX_TURNS * 2) {
          transcript.splice(0, transcript.length - MAX_TURNS * 2);
        }
      } catch (err) {
        useAppStore.getState().pushChat(item.docId, {
          who: "ai",
          text: `Couldn't edit the diagram: ${errText(err)}`,
        });
        // errors are not added to the transcript — the next turn starts clean
      }
    }
  } finally {
    processing = false;
    useAppStore.getState().setAiThinking(false);
  }
}
