/**
 * editor-core/history — snapshot-based undo/redo.
 *
 * Ported from `frontend/editor.js` (undoStack/redoStack + beginAction/
 * commitAction/undo/redo). A snapshot is the serialised innerHTML of #content.
 * Refactored from module-global stacks into a class so it is instantiable and
 * unit-testable in isolation (no DOM required — it just stores strings).
 *
 * Usage pattern (matches the vanilla app):
 *   history.begin(currentHtml)        // on pointer-down / before a mutation
 *   ...mutate the DOM...
 *   const changed = history.commit(currentHtml)  // on pointer-up
 *   history.undo(currentHtml) -> html | null      // apply returned html to DOM
 */
export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pending: string | null = null;
  private readonly limit: number;

  constructor(limit = 60) {
    this.limit = limit;
  }

  /** Capture the pre-mutation snapshot. */
  begin(snapshot: string): void {
    this.pending = snapshot;
  }

  /**
   * Commit the pending action if the current snapshot differs from it.
   * Returns true if a new undo entry was pushed (i.e. something changed).
   */
  commit(current: string): boolean {
    if (this.pending == null) return false;
    let changed = false;
    if (this.pending !== current) {
      this.undoStack.push(this.pending);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
      changed = true;
    }
    this.pending = null;
    return changed;
  }

  /**
   * Pop the last undo snapshot. Caller passes the *current* snapshot so it can
   * be pushed onto the redo stack. Returns the html to restore, or null.
   */
  undo(current: string): string | null {
    if (!this.undoStack.length) return null;
    this.redoStack.push(current);
    return this.undoStack.pop() ?? null;
  }

  /** Redo the last undone action. Symmetric to undo(). */
  redo(current: string): string | null {
    if (!this.redoStack.length) return null;
    this.undoStack.push(current);
    return this.redoStack.pop() ?? null;
  }

  /** Clear all history (e.g. when loading a new document). */
  reset(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending = null;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
