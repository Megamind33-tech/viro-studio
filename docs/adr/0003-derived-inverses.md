# ADR 0003 — Derived inverses by document diffing

Date: 2026-08-26
Status: **Accepted**, implemented in foundation slices 4 and 5.

## Context

ADR 0002 established that every command must be invertible, and that the inverse
should cost a small object rather than a document clone. For the first four
commands (`layer.transform`, `image.fit`, `image.focal`, `image.crop`) that was
easy: to undo "set x to 900" you only need the current x, which is readable
before the command runs.

That approach did not scale to the rest of the application:

- **Anchor has 33 operations.** Hand-writing 33 inverses means 33 fresh chances
  to get undo subtly wrong, in code that only executes on the undo path and so
  is the least exercised in the product.
- **Some effects are not knowable up front.** `press.group` creates a group,
  reparents N children and rewrites their local coordinates. `press.ungroup`
  bakes a matrix into each child. `duplicateSelected` mints ids. You cannot
  write the inverse before running the command, because you do not yet know what
  it did.
- **The primitives already exist.** `ops.ts` knows how to *do* every one of
  these things. Only the reversal was missing.

## Decision

**Derive the inverse by diffing the document before and after.**

1. `CommandDef` gains `invertAfter(params, before, after)` alongside `invert`.
   A command declares **exactly one** of the two; `registerCommand` enforces
   that, so neither can be forgotten.
2. `document/patch.ts` diffs two documents into a `DocPatch` and applies one.
   The generic `doc.restore` command carries a patch.
3. **The patch is proportional to the change**, not to the document. Measured on
   a 300-layer fixture: changing one layer's opacity produces a **4.5 KB** patch
   against an **82 KB** document clone.

### The ordering trick that keeps patches small

A page patch stores the **prior id order** plus **only the records that differ**.

- A layer the forward command **created** is simply not in the prior order, so it
  disappears on restore. No delete list is needed.
- A layer the forward command **deleted** is missing from the after-state, so its
  record is carried and the prior order puts it back at its index.
- A layer that was **edited** has a differing record, so it is carried.
- A **reorder** changes only the id list.

One mechanism covers create, delete, reorder and edit.

### Redo is not a replay

Re-running a creation command is **not** a correct redo: it calls `uid()` again,
so undo-then-redo would hand the layer a **different id**, silently breaking
selection, references, and any id an AI batch already reported as `created`.

So a history entry stores three things, not two:

| Field | Purpose |
|---|---|
| `forward` | the semantic record of what the user did — audit and replay |
| `inverse` | what undo applies |
| `redo` | what redo applies |

For derived-inverse commands `redo` is a patch restoring the post-command state
**exactly, ids included**. This was found by the mechanical round-trip tests,
not by inspection.

### Honest failure

`diffDocuments` reports `outOfScope` for any document field it cannot express.
`deriveInverse` raises `PatchScopeError`, and the caller falls back to a
snapshot entry rather than recording an undo that would silently lose data.
`UNSUPPORTED` is empty today — pages, layers, stories, assets are covered
proportionally; spreads, swatches and colour are carried whole because they are
small — but the mechanism stays so a future field fails loudly.

## Alternatives rejected

**Hand-write 33 + 27 inverses.** Rejected: the volume is the problem, and the
inverse path is the least-tested code in any editor. The diff is written once
and exercised by every command.

**Store a snapshot for the hard cases only.** Rejected as the default. It is
still the fallback, but as a *reported* exception rather than a design choice —
otherwise the expensive cases quietly stay expensive forever.

**Immutable/persistent data structures with structural sharing.** Genuinely
attractive and would make cloning cheap, but it is a rewrite of every primitive
in `ops.ts` and `factory.ts`, and it still would not produce an audit trail or a
dirty region. Revisit if patch weight ever becomes the bottleneck.

**Diff at the JSON level with a generic library.** Rejected: a generic diff has
no idea that layer ids are identity or that ordering is semantic, so it produces
large, fragile patches for a reorder. The document model is small enough to diff
knowingly.

## Consequences

Good:

- All 33 Anchor operations and all 27 UI commands are undoable, each verified by
  an execute→undo→compare round trip rather than by assertion.
- Adding a command is now roughly ten lines: validate, apply, done.
- Undo cost scales with the edit, not the document.
- The same mechanism gave `preview()` for free, because a preview is just an
  execution whose result is not committed.

Costs and limits, stated plainly:

- **Diffing is O(document) per command**, even when the patch is tiny. Fine at
  present sizes and inside a per-frame coalesced drag, but it is a real cost and
  has not been profiled against the 500-node/20-page budget in acceptance test 8.
- `JSON.stringify` comparison is used for record equality. Correct for this
  model, since documents are plain JSON, but it is not cheap and it is sensitive
  to key order — which is stable only because every record is constructed by
  `factory.ts`.
- A resample or cutout genuinely carries image bytes in the inverse. That is
  unavoidable: undoing a resample means restoring the original pixels.
- Selection changes still are not commands and do not participate in undo.
