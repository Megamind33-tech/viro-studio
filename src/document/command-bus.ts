/**
 * Command bus — execute, undo, redo, transactions, coalescing, dirty regions.
 *
 * ONE UNDO STACK, TWO KINDS OF ENTRY. This is what makes the migration safe.
 *
 *   "command"   a typed command plus its inverse. Undo applies the inverse.
 *               Costs two small serializable objects.
 *   "snapshot"  a whole-document clone, which is how `PressApp.commit` has
 *               always worked (defect #10).
 *
 * If migrated and unmigrated mutations kept separate stacks, undo would jump
 * around in the wrong order the moment a user mixed them — which they would,
 * immediately. Keeping both kinds in one ordered stack means the remaining 30
 * `commit()` call sites can move across one at a time without ever leaving undo
 * broken in between. The currently remaining 35 call sites can move one at a
 * time; each migration turns a clone into a pair of small objects.
 *
 * The bus does not own the document. It is handed the current document and
 * returns the next one, which keeps it directly unit-testable with no browser,
 * no Skia and no app instance.
 *
 * See docs/adr/0002-command-bus.md.
 */
import type { PressDocument } from "./types";
import { cloneDoc, activePage, findLayer } from "./factory";
import { worldBounds } from "./transform";
import { CommandError, deriveInverse, getCommandDef, type Command } from "./commands";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HistoryEntry =
  | {
      kind: "command";
      label: string;
      /**
       * The semantic record of what the user did, in application order. Kept for
       * audit and replay; NOT what redo runs — see `redo`.
       */
      forward: Command[];
      /**
       * What redo actually applies.
       *
       * Re-running a creation command is NOT a correct redo: it calls `uid()`
       * again, so undo-then-redo would hand the layer a different id and quietly
       * break selection, references and any id an AI batch already reported as
       * created. For derived-inverse commands this therefore holds a patch that
       * restores the post-command state exactly, ids included.
       */
      redo: Command[];
      /** In application order; undo runs these in REVERSE. */
      inverse: Command[];
      coalesceKey: string | null;
    }
  | { kind: "snapshot"; label: string; doc: PressDocument };

/** One line of the audit trail: what a single command did, and why. */
export interface CommandNote {
  type: string;
  summary: string;
  /** Carried through from an Anchor envelope; empty for direct UI commands. */
  reason: string;
  affected: string[];
  /** Layer ids this command brought into existence. */
  created: string[];
  /** Selection after this command, so a follow-up batch can chain onto it. */
  selection: string[];
}

export interface ExecuteResult {
  doc: PressDocument;
  label: string;
  /** Per-command audit trail, in application order. */
  notes: CommandNote[];
  /** Layer ids the batch touched. */
  affected: string[];
  /** Page-space region that must be repainted, or null when nothing moved. */
  dirty: Rect | null;
  /** True when this merged into the previous history entry instead of adding one. */
  coalesced: boolean;
}

const HISTORY_LIMIT = 200;

function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Every layer id in the document, across all pages. */
function layerIdSet(doc: PressDocument): Set<string> {
  const ids = new Set<string>();
  for (const page of doc.pages) for (const l of page.layers) ids.add(l.id);
  return ids;
}

/** World bounds of a layer, or null if it is not on the active page. */
function boundsOf(doc: PressDocument, layerId: string): Rect | null {
  const page = activePage(doc);
  const layer = findLayer(page, layerId);
  return layer ? worldBounds(page, layer) : null;
}

/**
 * Dirty region for a set of layers across a mutation.
 *
 * Both the BEFORE and AFTER bounds are needed: moving a layer dirties the place
 * it left as well as the place it arrived. Descendants are included because a
 * group's transform moves everything under it.
 */
function dirtyFor(before: PressDocument, after: PressDocument, ids: string[]): Rect | null {
  let rect: Rect | null = null;
  const withKids = new Set<string>();
  for (const doc of [before, after]) {
    const page = activePage(doc);
    for (const id of ids) {
      withKids.add(id);
      // Cheap descendant sweep: any layer whose ancestor chain hits `id`.
      for (const l of page.layers) {
        let cur = l.parentId;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          if (cur === id) {
            withKids.add(l.id);
            break;
          }
          seen.add(cur);
          cur = page.layers.find((x) => x.id === cur)?.parentId ?? null;
        }
      }
    }
  }
  for (const id of withKids) {
    rect = unionRect(rect, boundsOf(before, id));
    rect = unionRect(rect, boundsOf(after, id));
  }
  return rect;
}

export class CommandBus {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private named: { id: string; label: string; doc: PressDocument }[] = [];

  /**
   * Dirty region of the LAST operation, not an accumulation across a coalesced
   * gesture. One pointer-move only needs that step's delta repainted;
   * accumulating a forty-step drag would repaint far more than necessary. Undo
   * of that same gesture reports the full span, because it really is one jump
   * from the end of the drag back to its start.
   */
  lastDirty: Rect | null = null;

  // ── execution ──────────────────────────────────────────────────────────────

  /**
   * Validate and apply one command or a batch.
   *
   * ATOMIC: every command is validated and applied against a working copy. If
   * any of them throws, the caller's document is returned untouched and nothing
   * lands in history — a rejected batch must not leave the document half-edited.
   */
  execute(doc: PressDocument, input: Command | Command[], opts: { label?: string } = {}): ExecuteResult {
    const run = this.applyAll(doc, input, opts.label);
    const coalesceKey = this.coalesceKeyFor(run.forward);
    const coalesced = this.push({
      kind: "command",
      label: run.label,
      forward: run.forward,
      inverse: run.inverse,
      redo: run.redo,
      coalesceKey,
    });
    this.redoStack = [];
    this.lastDirty = run.dirty;
    return { doc: run.doc, label: run.label, notes: run.notes, affected: run.affected, dirty: run.dirty, coalesced };
  }

  /**
   * Apply commands and report exactly what WOULD happen, without touching the
   * document or the history.
   *
   * This is the "every AI batch must be previewable" requirement. Because
   * preview and execute share one code path, a preview cannot drift from what
   * execution actually does — it IS the execution, minus the commit.
   */
  preview(doc: PressDocument, input: Command | Command[], opts: { label?: string } = {}): ExecuteResult {
    const run = this.applyAll(doc, input, opts.label);
    return { doc: run.doc, label: run.label, notes: run.notes, affected: run.affected, dirty: run.dirty, coalesced: false };
  }

  private applyAll(
    doc: PressDocument,
    input: Command | Command[],
    labelIn?: string,
  ): {
    doc: PressDocument;
    label: string;
    notes: CommandNote[];
    affected: string[];
    dirty: Rect | null;
    forward: Command[];
    inverse: Command[];
    redo: Command[];
  } {
    const cmds = Array.isArray(input) ? input : [input];
    if (!cmds.length) throw new CommandError("execute: no commands given");

    let working = doc;
    const forward: Command[] = [];
    const inverse: Command[] = [];
    const redo: Command[] = [];
    const notes: CommandNote[] = [];
    const affected = new Set<string>();
    let label = labelIn ?? "";

    for (const cmd of cmds) {
      if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string") {
        throw new CommandError(`execute: each command must be { type, params }, got ${JSON.stringify(cmd)}`);
      }
      const def = getCommandDef(cmd.type);
      const params = def.validate(cmd.params, working);
      const before = working;
      for (const id of def.affects(params, working)) affected.add(id);
      if (!label) label = def.label(params, working);
      forward.push({ type: cmd.type, params: params as Record<string, unknown> });

      let inv: Command;
      let summary = "";
      if (def.invert) {
        // Known up front: read the inverse BEFORE applying, since it describes
        // the state we are leaving.
        inv = def.invert(params, working);
        const out = def.apply(params, working);
        working = out.doc;
        summary = out.summary ?? def.label(params, before);
        // Deterministic: replaying the command reproduces the same state.
        redo.push({ type: cmd.type, params: params as Record<string, unknown> });
      } else if (def.invertAfter) {
        // Derived: the command may create, delete and reorder in one step, so
        // the inverse is only knowable once the work is done. See patch.ts.
        const out = def.apply(params, working);
        working = out.doc;
        summary = out.summary ?? def.label(params, before);
        inv = def.invertAfter(params, before, working);
        // Not deterministic (fresh ids), so redo restores the exact state
        // instead of re-running the command.
        redo.push(deriveInverse(cmd.type, working, before));
      } else {
        throw new CommandError(`command "${cmd.type}" defines neither invert() nor invertAfter()`);
      }
      inverse.push(inv);
      // A derived inverse knows which layers really changed; that is better
      // information than affects() could give before the work was done.
      const carried = (inv.params as { affected?: unknown } | undefined)?.affected;
      const here: string[] = Array.isArray(carried) ? carried.map(String) : def.affects(params, before);
      for (const id of here) affected.add(id);
      const idsBefore = layerIdSet(before);
      notes.push({
        type: cmd.type,
        summary,
        reason: String((cmd.params as { op?: { reason?: unknown } })?.op?.reason ?? ""),
        affected: here,
        created: [...layerIdSet(working)].filter((id) => !idsBefore.has(id)),
        selection: [...working.activeLayerIds],
      });
    }

    const dirty = dirtyFor(doc, working, [...affected]);
    return { doc: working, label, notes, affected: [...affected], dirty, forward, inverse, redo };
  }

  /**
   * Run several commands as ONE history entry.
   *
   * `fn` receives a `run` that applies commands against the in-progress
   * document. The whole thing is atomic: a throw leaves the caller's document
   * and the history untouched.
   */
  transaction(
    doc: PressDocument,
    label: string,
    fn: (run: (cmd: Command) => void) => void,
  ): ExecuteResult {
    const collected: Command[] = [];
    fn((cmd) => collected.push(cmd));
    if (!collected.length) throw new CommandError(`transaction "${label}": no commands were run`);
    return this.execute(doc, collected, { label });
  }

  /** A command batch shares a coalesce key only if EVERY command agrees on it. */
  private coalesceKeyFor(forward: Command[]): string | null {
    const keys = forward.map((c) => {
      const def = getCommandDef(c.type);
      return def.coalesceKey ? def.coalesceKey(c.params as never) : null;
    });
    if (!keys.length || keys.some((k) => k === null)) return null;
    return keys.join("|");
  }

  /**
   * Push an entry, merging into the previous one when they share a coalesce key.
   *
   * Merging keeps the EARLIEST inverse — undo must return to where the drag
   * started, not to the previous pointer event — and takes the latest forward.
   * Returns true when it merged.
   */
  private push(entry: HistoryEntry): boolean {
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      entry.kind === "command" &&
      entry.coalesceKey &&
      top &&
      top.kind === "command" &&
      top.coalesceKey === entry.coalesceKey
    ) {
      top.forward = entry.forward;
      top.redo = entry.redo;
      top.label = entry.label;
      return true;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    return false;
  }

  /**
   * Bridge for the not-yet-migrated `commit()` path: record a whole-document
   * clone in the SAME stack so ordering across mixed edits stays correct.
   */
  pushSnapshot(label: string, docBefore: PressDocument): void {
    this.undoStack.push({ kind: "snapshot", label, doc: cloneDoc(docBefore) });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  // ── undo / redo ────────────────────────────────────────────────────────────

  private applyInverse(doc: PressDocument, entry: Extract<HistoryEntry, { kind: "command" }>): { doc: PressDocument; affected: string[] } {
    let working = doc;
    const affected = new Set<string>();
    // Inverses undo in reverse application order.
    for (let i = entry.inverse.length - 1; i >= 0; i--) {
      const cmd = entry.inverse[i]!;
      const def = getCommandDef(cmd.type);
      const params = def.validate(cmd.params, working);
      for (const id of def.affects(params, working)) affected.add(id);
      working = def.apply(params, working).doc;
    }
    return { doc: working, affected: [...affected] };
  }

  private redoEntry(doc: PressDocument, entry: Extract<HistoryEntry, { kind: "command" }>): { doc: PressDocument; affected: string[] } {
    let working = doc;
    const affected = new Set<string>();
    for (const cmd of entry.redo) {
      const def = getCommandDef(cmd.type);
      const params = def.validate(cmd.params, working);
      for (const id of def.affects(params, working)) affected.add(id);
      working = def.apply(params, working).doc;
    }
    return { doc: working, affected: [...affected] };
  }

  undo(doc: PressDocument): ExecuteResult | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    if (entry.kind === "snapshot") {
      this.redoStack.push({ kind: "snapshot", label: entry.label, doc: cloneDoc(doc) });
      this.lastDirty = null; // a whole-document swap dirties everything
      return { doc: entry.doc, label: entry.label, notes: [], affected: [], dirty: null, coalesced: false };
    }
    const { doc: next, affected } = this.applyInverse(doc, entry);
    this.redoStack.push(entry);
    const dirty = dirtyFor(doc, next, affected);
    this.lastDirty = dirty;
    return { doc: next, label: entry.label, notes: [], affected, dirty, coalesced: false };
  }

  redo(doc: PressDocument): ExecuteResult | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    if (entry.kind === "snapshot") {
      this.undoStack.push({ kind: "snapshot", label: entry.label, doc: cloneDoc(doc) });
      this.lastDirty = null;
      return { doc: entry.doc, label: entry.label, notes: [], affected: [], dirty: null, coalesced: false };
    }
    const { doc: next, affected } = this.redoEntry(doc, entry);
    this.undoStack.push(entry);
    const dirty = dirtyFor(doc, next, affected);
    this.lastDirty = dirty;
    return { doc: next, label: entry.label, notes: [], affected, dirty, coalesced: false };
  }

  // ── inspection ─────────────────────────────────────────────────────────────

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Most recent first, for the History panel. */
  labels(): string[] {
    return this.undoStack.map((e) => e.label).reverse();
  }

  /** How much of the stack is still whole-document clones — migration progress. */
  stats(): { entries: number; commandEntries: number; snapshotEntries: number; redo: number } {
    const snapshots = this.undoStack.filter((e) => e.kind === "snapshot").length;
    return {
      entries: this.undoStack.length,
      commandEntries: this.undoStack.length - snapshots,
      snapshotEntries: snapshots,
      redo: this.redoStack.length,
    };
  }

  nameSnapshot(label: string, doc: PressDocument): void {
    this.named.push({ id: `h_${this.named.length}`, label, doc: cloneDoc(doc) });
  }

  namedList(): { id: string; label: string }[] {
    return this.named.map(({ id, label }) => ({ id, label }));
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastDirty = null;
  }
}
