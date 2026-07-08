/**
 * state/commentsStore — comment threads pinned to the board (M1).
 *
 * Server-backed (REST CRUD under /api/documents/{id}/comments) + realtime:
 * every mutation response carries the FULL comment list (LWW), and the backend
 * pushes the same shape to the live room as a {"t":"comments"} frame — both
 * paths land in `applyList`, so local and remote updates are one code path.
 *
 * UI state that lives here too: comment MODE (the 💬 tool — next canvas click
 * places a pin), the open thread, and an in-progress draft anchor.
 */
import { create } from "zustand";
import {
  api,
  type CommentAnchor,
  type CommentOut,
  type CommentsOut,
} from "../shared/api/client";
import { getIdentity, onCollabComments } from "./collabStore";

// Comment-layer visibility is a personal view preference — remember it across
// reloads (not per board; it's how you like to work).
const VIS_KEY = "noddle:comments-visible";
function loadVisible(): boolean {
  try { return localStorage.getItem(VIS_KEY) !== "0"; } catch { return true; }
}
function saveVisible(v: boolean): void {
  try { localStorage.setItem(VIS_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}

export interface Person {
  id: string;
  name: string;
  email: string;
  color: string;
}

interface CommentsState {
  docId: string | null;
  comments: CommentOut[];
  people: Person[];
  /** 💬 tool armed — the next canvas click drops a comment pin. */
  commentMode: boolean;
  /** Whether comment pins/threads are drawn on the board (toggle to declutter). */
  commentsVisible: boolean;
  /** Open thread (root comment id), or null. */
  activeThreadId: string | null;
  /** Draft pin placed but not yet submitted. */
  draft: { anchor: CommentAnchor; pageId: string | null } | null;
  showResolved: boolean;

  load: (docId: string) => Promise<void>;
  clear: () => void;
  applyList: (comments: CommentOut[]) => void;
  setCommentMode: (on: boolean) => void;
  /** Show/hide the comment layer. Hiding also disarms add-mode + closes threads. */
  toggleCommentsVisible: () => void;
  toggleResolvedVisible: () => void;
  openThread: (rootId: string | null) => void;
  startDraft: (anchor: CommentAnchor, pageId: string | null) => void;
  cancelDraft: () => void;
  /** Submit the draft as a new root thread. */
  submitDraft: (body: string, mentions: string[]) => Promise<void>;
  reply: (rootId: string, body: string, mentions: string[]) => Promise<void>;
  setResolved: (rootId: string, resolved: boolean) => Promise<void>;
  editBody: (commentId: string, body: string) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
}

export const useCommentsStore = create<CommentsState>((set, get) => ({
  docId: null,
  comments: [],
  people: [],
  commentMode: false,
  commentsVisible: loadVisible(),
  activeThreadId: null,
  draft: null,
  showResolved: false,

  async load(docId) {
    set({ docId, comments: [], people: [], activeThreadId: null, draft: null });
    try {
      const out = await api.listComments(docId);
      // Doc switched again while fetching — drop the stale response.
      if (get().docId !== docId) return;
      set({ comments: out.comments, people: out.people ?? [] });
    } catch {
      /* viewer without access / offline — leave empty */
    }
  },

  clear() {
    set({
      docId: null,
      comments: [],
      people: [],
      commentMode: false,
      activeThreadId: null,
      draft: null,
    });
  },

  applyList(comments) {
    set((s) => ({
      comments,
      // The open thread may have been deleted remotely.
      activeThreadId:
        s.activeThreadId && comments.some((c) => c.id === s.activeThreadId)
          ? s.activeThreadId
          : null,
    }));
  },

  setCommentMode(on) {
    // Arming add-mode implies the layer is visible (you can't pin what you
    // can't see); disarming clears any half-placed draft.
    set({ commentMode: on, ...(on ? { commentsVisible: true } : { draft: null }) });
  },

  toggleCommentsVisible() {
    set((s) => {
      const commentsVisible = !s.commentsVisible;
      saveVisible(commentsVisible); // remember the preference across reloads
      // Hiding the layer also disarms add-mode and closes any open thread/draft.
      return commentsVisible
        ? { commentsVisible }
        : { commentsVisible, commentMode: false, activeThreadId: null, draft: null };
    });
  },

  toggleResolvedVisible() {
    set((s) => ({ showResolved: !s.showResolved }));
  },

  openThread(rootId) {
    set({ activeThreadId: rootId, draft: null });
  },

  startDraft(anchor, pageId) {
    // One-shot tool, like Lucid: placing the pin disarms comment mode.
    set({ draft: { anchor, pageId }, commentMode: false, activeThreadId: null });
  },

  cancelDraft() {
    set({ draft: null });
  },

  async submitDraft(body, mentions) {
    const { docId, draft } = get();
    if (!docId || !draft || !body.trim()) return;
    const out = await api.addComment(docId, {
      body,
      anchor: draft.anchor,
      page_id: draft.pageId,
      mentions,
      guest_name: getIdentity().name,
    });
    set({ draft: null });
    applyOut(out, set, get);
    // Open the thread just created (the newest root).
    const roots = out.comments.filter((c) => !c.parent_id);
    const newest = roots[roots.length - 1];
    if (newest) set({ activeThreadId: newest.id });
  },

  async reply(rootId, body, mentions) {
    const { docId } = get();
    if (!docId || !body.trim()) return;
    const out = await api.addComment(docId, {
      body,
      parent_id: rootId,
      mentions,
      guest_name: getIdentity().name,
    });
    applyOut(out, set, get);
  },

  async setResolved(rootId, resolved) {
    const { docId } = get();
    if (!docId) return;
    applyOut(await api.patchComment(docId, rootId, { resolved }), set, get);
  },

  async editBody(commentId, body) {
    const { docId } = get();
    if (!docId || !body.trim()) return;
    applyOut(await api.patchComment(docId, commentId, { body }), set, get);
  },

  async remove(commentId) {
    const { docId } = get();
    if (!docId) return;
    applyOut(await api.deleteComment(docId, commentId), set, get);
  },
}));

function applyOut(
  out: CommentsOut,
  _set: unknown,
  get: () => CommentsState,
): void {
  get().applyList(out.comments);
}

// Realtime: a peer's comment mutation arrives as a full-list frame.
onCollabComments((comments) => {
  useCommentsStore.getState().applyList(comments as CommentOut[]);
});
