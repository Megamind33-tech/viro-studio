# ADR 0002 — Typed command bus

Date: 2026-08-25
Status: **Accepted**. Transform/image commands landed in slice 3; Anchor in
slice 4; the UI migration completed in slice 5. See ADR 0003 for how inverses
are derived for commands that cannot know theirs in advance.

## Context

`PressApp` mutated the document through roughly thirty ad-hoc methods, each
ending in `commit(label, nextDoc)`, and `History` stored a **full `cloneDoc` of
the document per entry** (defect #10). Consequences visible in the code:

- A drag could not afford a history entry per pointer event, so the drag paths
  worked around history entirely: `history.snapshot()` on pointerdown, then
  direct `this.doc = …` mutation on every pointermove
  (`src/app.ts`, resize/move/crop). Undo granularity was a side effect of that
  workaround rather than a designed property.
- Every pointermove allocated `cloneDoc(this.doc)` — for an A4 document at
  300 ppi, per frame, for the whole gesture.
- The primitives in `ops.ts` return the document **unchanged** when the layer is
  missing, the wrong kind, or locked. A silent no-op. Callers could not tell a
  refusal from a success.
- Anchor (AI) had its own validation and audit layer; the UI had none. Two
  mechanisms for one job, and only one of them was auditable.

Slices 1 and 2 both had to widen this surface (`scaleX`/`scaleY`, `ImageFit`),
which made the duplication concrete rather than theoretical.

## Decision

1. **A command is a plain `{ type, params }` value.** Serializable by
   construction: loggable, replayable, transmissible, and emittable by a model.
   No closures, no class instances, no document references.
2. **`CommandDef` requires `validate`, `affects`, `apply`, `label`, and exactly
   one of `invert` / `invertAfter`** — so a command cannot exist without stating
   what it touches and how to undo it. `registerCommand` enforces the
   one-of-two rule, so neither can be forgotten. `validate` **throws** rather
   than silently correcting, closing the `ops.ts` no-op hole at the boundary.
3. **The inverse is read against the pre-apply document.** Undo costs two small
   objects instead of a document clone.
4. **ONE undo stack with two entry kinds** — `command` and `snapshot`.
5. **Coalescing by `session` key.** Consecutive entries sharing a key merge,
   keeping the **earliest** inverse and the **latest** forward.
6. **Dirty regions are per operation, not accumulated.**
7. **The bus does not own the document.** It takes a document and returns the
   next one, so it is unit-testable with no browser, no Skia, no app instance.

## The migration decision, which is the important one

The obvious approach — convert all thirty call sites, then switch — would leave
undo broken for the whole conversion and land as one unreviewable change.

Instead the stack accepts **both** entry kinds. `commit()` pushes a snapshot into
the same ordered stack that typed commands push inverses into. A user mixing a
migrated action with an unmigrated one gets correct undo ordering **today**, and
each subsequent migration converts one clone into a pair of small objects.
`stats()` reports `snapshotEntries` vs `commandEntries`, so migration progress is
a number rather than a feeling.

This is why the design is safe to land before it is finished.

## Alternatives rejected

**Keep snapshot undo; just make clones cheaper (structural sharing / immer).**
Rejected: it treats the symptom. Snapshots cannot say what changed, so dirty
regions, previewable AI batches and audit trails all remain impossible. The cost
was never only memory.

**Event sourcing — rebuild the document by replaying from the origin.**
Rejected: undo becomes O(history), and every command would have to stay
replay-compatible forever, which is a very expensive constraint this early.

**Let commands mutate the document in place.**
Rejected: the `ops.ts` primitives are already copy-on-write via `cloneDoc`, and
in-place mutation would make the "rejected batch leaves the document untouched"
guarantee impossible to state simply.

**A separate stack for typed commands.**
Rejected outright — see the migration decision. Two stacks means wrong undo
order the first time a user mixes an old and a new action, which would be
immediately.

## Consequences

Good:

- A 40-step pointer drag is **one** history entry whose undo returns to the
  gesture's start, verified against real pointer events in the running app.
- The per-pointermove `cloneDoc` is gone from the migrated drag paths.
- Refusals are loud and quotable: `layer.transform: no layer "ly_nope" on the
  active page "Page 1" — the page is empty`.
- Dirty regions exist, which unblocks partial repaint later.
- Commands survive `JSON.parse(JSON.stringify(...))`, which is the prerequisite
  for AI preview, replay and audit.
- Anchor preview and execution now share `anchor.op` on this bus. All 33 current
  Anchor operations are covered by exact execute/undo round-trip tests, and a
  multi-op proposal is one atomic history entry with a per-operation audit note.

Costs and limits, stated plainly:

- The registry holds four commands that know their inverse up front
  (`layer.transform`, `image.fit`, `image.focal`, `image.crop`), the internal
  `doc.restore` inverse primitive, **30 UI editing commands**
  (`src/document/ui-commands.ts`), and `anchor.op`, which adapts all 33 Anchor
  operations without duplicating their schemas. Counted 2026-08-26.
- **Six `commit()` call sites remain, and five of them are correct as they
  stand**: New (×2), Open, Open PSD, Open VDJ. Those replace the whole document,
  so a diff would be the size of the document with none of the benefit — a
  snapshot is the honest representation, not migration debt. Read
  `stats().snapshotEntries` as "document replacements".
- The sixth is the `PatchScopeError` fallback in `applyAnchorDetailed`, kept for
  an operation that changes a document field the patch model cannot express. The
  current 33-operation corpus reports zero such cases, so it is dead code that
  earns its place by failing loudly if that ever changes.
- Selection changes are still not commands and do not participate in undo,
  matching the previous behaviour.
- `HISTORY_LIMIT` is a flat 200 entries. Entries are now proportional to the
  edit, so the practical ceiling is far higher than before, but it has not been
  profiled against the 500-node/20-page budget in acceptance test 8.
