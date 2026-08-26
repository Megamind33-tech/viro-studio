/**
 * Anchor ops as commands.
 *
 * Before this, the AI path and the UI path were two mechanisms for one job:
 * Anchor had its own validation, its own atomic batch and its own audit trail,
 * while the UI had `commit()` and a whole-document clone. Only one of them was
 * auditable, and neither was previewable.
 *
 * This makes every Anchor op a first-class command on the same bus the UI uses,
 * which is what the product rule "all UI actions, keyboard shortcuts, imports,
 * AI proposals and automation must use the same typed command system" actually
 * requires. Concretely a batch now gets, for free and by construction:
 *
 *   previewable   `bus.preview()` reports exactly what would happen, via the
 *                 same code path as execution, without touching the document.
 *   auditable     each op contributes a `CommandNote` carrying its own summary
 *                 and its mandatory `reason`.
 *   reversible    the inverse is DERIVED by diffing (see document/patch.ts),
 *                 so all 33 ops are undoable without 33 hand-written inverses
 *                 — and the entry costs a diff, not a document clone.
 *
 * The op registry is not duplicated here. `apply` delegates to
 * `applyAnchorBatch`, so validation, error messages and behaviour remain
 * defined in exactly one place: `tools.ts`.
 */
import {
  CommandError,
  deriveInverse,
  PatchScopeError,
  registerCommand,
  type Command,
  type CommandDef,
} from "../document/commands";
import { applyAnchorBatch, type AnchorOp } from "./tools";

// Re-exported so existing callers keep importing it from here; it lives in the
// document layer now because UI commands raise it too.
export { PatchScopeError };

export interface AnchorOpParams {
  op: AnchorOp;
}

const anchorOpCmd: CommandDef<AnchorOpParams> = {
  type: "anchor.op",
  label: (p) => `Anchor — ${p.op?.reason || p.op?.op || "op"}`,

  validate(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CommandError(`anchor.op: params must be an object like { op: { op, params, reason } }`);
    }
    const op = (raw as { op?: unknown }).op;
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      throw new CommandError(`anchor.op: "op" is required — an Anchor envelope { op, params, reason }`);
    }
    // Deliberately shallow. The op layer owns the real schema, the enum lists
    // and the error wording; duplicating any of it here would let the two
    // drift. An invalid op throws out of `apply`, and because the bus builds a
    // working copy and only records history after the whole batch succeeds,
    // the caller's document is still untouched.
    return { op: op as AnchorOp };
  },

  // The real answer comes from the diff in `invertAfter`, which knows what
  // actually changed rather than what the op declared it might touch.
  affects: () => [],

  apply(p, doc) {
    const batch = applyAnchorBatch(doc, [p.op]);
    return { doc: batch.doc, summary: batch.results[0]?.summary ?? p.op.op };
  },

  invertAfter: (p, before, after) => deriveInverse(`anchor.op "${p.op.op}"`, before, after),
};

let installed = false;

/**
 * Register Anchor's commands. Explicit rather than an import side effect, so
 * test files and the app opt in the same visible way and import order cannot
 * change behaviour.
 */
export function installAnchorCommands(): void {
  if (installed) return;
  registerCommand(anchorOpCmd);
  installed = true;
}

/** Wrap Anchor ops as commands for the bus. */
export function anchorCommands(ops: AnchorOp[]): Command[] {
  return ops.map((op) => ({ type: "anchor.op", params: { op } }) as unknown as Command);
}
