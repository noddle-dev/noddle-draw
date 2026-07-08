/**
 * features/comments/CommentsLayer — comment pins + thread cards on the canvas.
 *
 * Anchors live in CONTENT coords (or follow a node/edge); rendering maps them
 * to screen through the shared camera each render — same approach as the
 * remote cursors in CanvasCollab. Threads are Figma-style: a root pin, replies
 * one level deep, resolve/unresolve, @mentions picked from the board's people.
 *
 * Comment MODE (armed from the topbar 💬 button) captures the next pointerdown
 * on the canvas host in the CAPTURE phase (the native canvas handlers can't be
 * stopped by React's synthetic layer — same constraint as #diagram-layer) and
 * turns it into a draft pin: on a node → follows the node; on an edge →
 * follows the edge; empty canvas → a fixed point.
 */
import { useEffect, useRef, useState } from "react";
import { contentToStage, screenToContent } from "../../editor-core";
import type { Attachment } from "../../editor-core/diagram";
import { useEditorStore } from "../../state/editorStore";
import { useDiagramStore } from "../../state/diagramStore";
import { usePagesStore } from "../../state/pagesStore";
import { useAuthStore } from "../../state/authStore";
import { useCommentsStore, type Person } from "../../state/commentsStore";
import type { CommentAnchor, CommentOut } from "../../shared/api/client";

// ---- helpers ----------------------------------------------------------------

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Content-coords position of an anchor, or null when its object is gone. */
function anchorContentPos(anchor: CommentAnchor): { x: number; y: number } | null {
  const ds = useDiagramStore.getState();
  if (anchor.kind === "point") return { x: anchor.x, y: anchor.y };
  if (anchor.kind === "node") {
    const n = ds.nodes[anchor.ref];
    return n ? { x: n.x + n.w, y: n.y } : null; // top-right corner
  }
  const e = ds.edges[anchor.ref];
  if (!e) return null;
  const p1 = attachmentPos(e.source);
  const p2 = attachmentPos(e.target);
  if (!p1 || !p2) return null;
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

function attachmentPos(a: Attachment): { x: number; y: number } | null {
  if (a.kind === "free") return a.point;
  const n = useDiagramStore.getState().nodes[a.nodeId];
  return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
}

// ---- mention textarea ---------------------------------------------------------

interface MentionInputProps {
  value: string;
  onChange: (v: string) => void;
  mentions: string[];
  onMentionsChange: (ids: string[]) => void;
  people: Person[];
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: () => void;
  onCancel?: () => void;
}

/** Textarea with a lightweight "@" picker: typing `@que` pops the people list;
 * picking inserts `@Name ` and records the user id in `mentions`. */
function MentionInput(props: MentionInputProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ query: string; start: number } | null>(null);

  const detectMention = (text: string, caret: number) => {
    const upto = text.slice(0, caret);
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(upto);
    if (!m) return setMenu(null);
    setMenu({ query: m[2].toLowerCase(), start: caret - m[2].length - 1 });
  };

  const candidates = menu
    ? props.people.filter((p) => p.name.toLowerCase().includes(menu.query)).slice(0, 6)
    : [];

  const pick = (p: Person) => {
    if (!menu || !ref.current) return;
    const caret = ref.current.selectionStart ?? props.value.length;
    const next =
      props.value.slice(0, menu.start) + `@${p.name} ` + props.value.slice(caret);
    props.onChange(next);
    if (!props.mentions.includes(p.id)) {
      props.onMentionsChange([...props.mentions, p.id]);
    }
    setMenu(null);
    requestAnimationFrame(() => ref.current?.focus());
  };

  return (
    <div className="comment-input">
      <textarea
        ref={ref}
        rows={2}
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        onChange={(e) => {
          props.onChange(e.target.value);
          detectMention(e.target.value, e.target.selectionStart ?? 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (menu) setMenu(null);
            else props.onCancel?.();
            e.stopPropagation();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (menu && candidates.length) pick(candidates[0]);
            else props.onSubmit();
          }
        }}
      />
      {menu && candidates.length > 0 && (
        <div className="mention-menu">
          {candidates.map((p) => (
            <button key={p.id} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
              <span className="dot" style={{ background: p.color }} />
              {p.name}
              <span className="email">{p.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- thread card --------------------------------------------------------------

function ThreadCard({ root, at }: { root: CommentOut; at: { x: number; y: number } }) {
  const comments = useCommentsStore((s) => s.comments);
  const people = useCommentsStore((s) => s.people);
  const me = useAuthStore((s) => s.me);
  const myRole = useEditorStore((s) => s.myRole);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);

  const replies = comments.filter((c) => c.parent_id === root.id);
  const store = useCommentsStore.getState();
  const isAuthor = (c: CommentOut) =>
    me?.kind === "user" && !!c.author_id && me.id === c.author_id;
  const canResolve = myRole !== "viewer" || isAuthor(root);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    setMentions([]);
    await store.reply(root.id, body, mentions);
  };

  return (
    <>
      <div className="menu-backdrop" onClick={() => store.openThread(null)} />
      <div
        className="comment-thread"
        style={{ left: at.x + 20, top: at.y - 8 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="head">
          <span className="title">💬 Thread</span>
          {canResolve && (
            <button
              className={`resolve${root.resolved ? " on" : ""}`}
              title={root.resolved ? "Reopen" : "Mark as resolved"}
              onClick={() => void store.setResolved(root.id, !root.resolved)}
            >
              ✓ {root.resolved ? "Resolved" : "Resolve"}
            </button>
          )}
          <button className="x" onClick={() => store.openThread(null)}>✕</button>
        </div>
        <div className="items">
          {[root, ...replies].map((c) => (
            <div key={c.id} className="item">
              <span className="avatar" style={{ background: c.author_color }}>
                {c.author_name.slice(0, 1).toUpperCase()}
              </span>
              <div className="bubble">
                <div className="meta">
                  <b>{c.author_name}</b>
                  <span>{timeAgo(c.created_at)}</span>
                  {(isAuthor(c) || myRole === "owner") && (
                    <button
                      className="del"
                      title="Delete"
                      onClick={() => void store.remove(c.id)}
                    >
                      🗑
                    </button>
                  )}
                </div>
                <div className="body">{c.body}</div>
              </div>
            </div>
          ))}
        </div>
        <MentionInput
          value={text}
          onChange={setText}
          mentions={mentions}
          onMentionsChange={setMentions}
          people={people}
          placeholder="Reply… (@ to mention someone)"
          onSubmit={() => void send()}
          onCancel={() => store.openThread(null)}
        />
      </div>
    </>
  );
}

// ---- draft composer -------------------------------------------------------------

function DraftCard({ at }: { at: { x: number; y: number } }) {
  const people = useCommentsStore((s) => s.people);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const store = useCommentsStore.getState();

  return (
    <div
      className="comment-thread draft"
      style={{ left: at.x + 20, top: at.y - 8 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <MentionInput
        value={text}
        onChange={setText}
        mentions={mentions}
        onMentionsChange={setMentions}
        people={people}
        placeholder="Add a comment… (@ to mention someone)"
        autoFocus
        onSubmit={() => void store.submitDraft(text, mentions)}
        onCancel={() => store.cancelDraft()}
      />
      <div className="actions">
        <button className="btn" onClick={() => store.cancelDraft()}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={!text.trim()}
          onClick={() => void store.submitDraft(text, mentions)}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ---- the layer ------------------------------------------------------------------

export function CommentsLayer() {
  const refs = useEditorStore((s) => s.refs);
  const docId = useEditorStore((s) => s.docId);
  const cam = useEditorStore((s) => s.cam); // re-render on pan/zoom
  const nodes = useDiagramStore((s) => s.nodes); // re-render on node move
  const activePage = usePagesStore((s) => s.activeId);
  const comments = useCommentsStore((s) => s.comments);
  const commentMode = useCommentsStore((s) => s.commentMode);
  const commentsVisible = useCommentsStore((s) => s.commentsVisible);
  const activeThreadId = useCommentsStore((s) => s.activeThreadId);
  const draft = useCommentsStore((s) => s.draft);
  const showResolved = useCommentsStore((s) => s.showResolved);
  void cam;
  void nodes;

  // Load comments when the bound document changes.
  useEffect(() => {
    if (docId) void useCommentsStore.getState().load(docId);
    else useCommentsStore.getState().clear();
  }, [docId]);

  // Comment mode: capture the next canvas pointerdown → place a draft pin.
  useEffect(() => {
    if (!refs || !commentMode) return;
    const host = refs.host;
    host.classList.add("commenting");
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as Element;
      const nodeId = target
        .closest("[data-diagram-node]")
        ?.getAttribute("data-diagram-node");
      const edgeId = target
        .closest("[data-diagram-edge]")
        ?.getAttribute("data-diagram-edge");
      let anchor: CommentAnchor;
      if (nodeId) anchor = { kind: "node", ref: nodeId };
      else if (edgeId) anchor = { kind: "edge", ref: edgeId };
      else {
        const p = screenToContent(refs.content, e.clientX, e.clientY);
        anchor = { kind: "point", x: p.x, y: p.y };
      }
      useCommentsStore.getState().startDraft(anchor, activePage);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useCommentsStore.getState().setCommentMode(false);
    };
    host.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      host.classList.remove("commenting");
      host.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [refs, commentMode, activePage]);

  // Hidden layer → draw nothing (the topbar 💬 toggle controls this). The
  // add-mode capture effect above still runs, and arming forces visible on.
  if (!refs || !docId || !commentsVisible) return null;

  const toScreen = (anchor: CommentAnchor) => {
    const p = anchorContentPos(anchor);
    return p ? contentToStage(refs.content, refs.host, p.x, p.y) : null;
  };

  const roots = comments.filter(
    (c) =>
      !c.parent_id &&
      (c.page_id == null || activePage == null || c.page_id === activePage) &&
      (showResolved || !c.resolved),
  );
  const replyCount = (rootId: string) =>
    comments.filter((c) => c.parent_id === rootId).length;
  const resolvedCount = comments.filter((c) => !c.parent_id && c.resolved).length;

  const active = roots.find((c) => c.id === activeThreadId) ?? null;
  const activeAt = active?.anchor ? toScreen(active.anchor) : null;
  const draftAt = draft ? toScreen(draft.anchor) : null;

  return (
    <>
      {roots.map((c) => {
        if (!c.anchor) return null;
        const p = toScreen(c.anchor);
        if (!p) return null; // anchored object was deleted
        return (
          <button
            key={c.id}
            className={`comment-pin${c.resolved ? " resolved" : ""}${
              c.id === activeThreadId ? " active" : ""
            }`}
            style={{
              transform: `translate(${p.x}px, ${p.y}px)`,
              borderColor: c.author_color,
            }}
            title={`${c.author_name}: ${c.body.slice(0, 80)}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() =>
              useCommentsStore
                .getState()
                .openThread(c.id === activeThreadId ? null : c.id)
            }
          >
            {c.resolved ? "✓" : c.author_name.slice(0, 1).toUpperCase()}
            {replyCount(c.id) > 0 && <i>{replyCount(c.id) + 1}</i>}
          </button>
        );
      })}
      {active && activeAt && <ThreadCard root={active} at={activeAt} />}
      {draft && draftAt && <DraftCard at={draftAt} />}
      {resolvedCount > 0 && (
        <button
          className={`comment-resolved-chip${showResolved ? " on" : ""}`}
          onClick={() => useCommentsStore.getState().toggleResolvedVisible()}
        >
          ✓ {resolvedCount} resolved
        </button>
      )}
    </>
  );
}
