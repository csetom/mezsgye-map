/**
 * Mezsgye Atlas — undo/redo history.
 *
 * Snapshot based: the app hands over the serialized document after every
 * change. That keeps undo correct for every kind of edit (nodes, links,
 * schema/category changes, atlas info) without each mutator having to know
 * how to reverse itself. Pure ESM, no DOM; shared by the browser and tests.
 *
 * Rapid edits with the same `key` (typing into one inspector field) are
 * coalesced into a single undo step.
 */

export class History {
  /**
   * @param {{limit?: number, coalesceMs?: number, now?: () => number}} [opts]
   */
  constructor({ limit = 100, coalesceMs = 1500, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.now = now;
    this.reset(null);
  }

  /**
   * Start a fresh history at `snapshot` (new/opened/imported document).
   *
   * @param {string|null} snapshot
   * @param {{saved?: boolean}} [opts] saved=false when the document has never been stored
   */
  reset(snapshot, { saved = true } = {}) {
    this.undoStack = [];
    this.redoStack = [];
    this.current = snapshot;
    this.saved = saved ? snapshot : null;
    this.lastKey = null;
    this.lastTime = 0;
  }

  /**
   * Record the document state after a change.
   *
   * @param {string} snapshot serialized document
   * @param {string|null} [key] edits sharing a key within `coalesceMs` merge into one step
   * @returns {boolean} false if nothing actually changed
   */
  record(snapshot, key = null) {
    if (snapshot === this.current) return false;
    const t = this.now();
    const coalesce = key !== null
      && key === this.lastKey
      && t - this.lastTime < this.coalesceMs
      && this.undoStack.length > 0;
    if (!coalesce) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.current = snapshot;
    this.redoStack = [];
    this.lastKey = key;
    this.lastTime = t;
    return true;
  }

  /** @returns {string|null} the snapshot to restore, or null if there is nothing to undo */
  undo() {
    if (!this.undoStack.length) return null;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop();
    this.lastKey = null;
    return this.current;
  }

  /** @returns {string|null} the snapshot to restore, or null if there is nothing to redo */
  redo() {
    if (!this.redoStack.length) return null;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop();
    this.lastKey = null;
    return this.current;
  }

  /**
   * The document was just stored. `snapshot` may differ from the current one
   * (the server stamps `modified`); it replaces it without adding a step.
   */
  markSaved(snapshot) {
    this.current = snapshot;
    this.saved = snapshot;
    this.lastKey = null;
  }

  get canUndo() { return this.undoStack.length > 0; }

  get canRedo() { return this.redoStack.length > 0; }

  /** True when the current state differs from the last saved one. */
  get dirty() { return this.current !== this.saved; }
}
