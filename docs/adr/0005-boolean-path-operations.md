# ADR 0005 — Boolean path operations (union / subtract / intersect / exclude)

Status: **EXPERIMENT (spike the multi-contour model; gated on acceptance criteria before ACCEPT)**
· 2026-08-26 · Realises RFC-5 of `docs/research/0001-next-editor-features.md`.

This ADR is the Architecture RFC that RFC-5 said it required. Booleans are the one item in that
research set that "changes a core data shape (§34/§71-class decision)" rather than adding an
optional field, so it does not ride the additive RFCs' path and is written up on its own here for
the Governor to ratify. No code ships from this document: it records evidence and a decision, and
the vector primitive is `PROVEN_WORKING`, so anything built from it lands regression-test-first
(GOVERNOR.md §11/§78) and must hold the MIGRATION INVARIANT of pixel-identical re-open.

## Problem

VIRO Press can create and edit individual vector shapes (rect, ellipse, line, pen path) but has no
way to **combine** two or more of them: union, subtract, intersect, exclude. Boolean path operations
are core vector tooling — punching a hole in a shape, welding overlapping shapes into one, keeping
only the overlap — and their absence is a real gap for logo/mark and layout work. The Skia primitive
to compute them is already in the bundle; the blocker is the document model, not the maths.

## Evidence (grounded 2026-08-26)

### The single-contour `VectorLayer` limitation — the core constraint

A vector layer is exactly **one open-or-closed contour**:

- `src/document/types.ts:215-221` — `VectorLayer` is `{ kind, closed: boolean, nodes: PathNode[],
  fill, stroke }`. There is a single `nodes` array and a single `closed` flag. There is no way to
  express two disjoint rings, or an outer ring plus an inner hole.
- `src/document/types.ts:183-190` — `PathNode` is `{ x, y, inX, inY, outX, outY }`: an anchor with
  an in-handle and an out-handle. The whole editing model (pen tool, Anchor `press.add_path`) is
  built on this per-node handle representation.
- `src/engine/compositor.ts:1831-1884` (`drawVector`) — builds **one** `ck.PathBuilder`,
  `moveTo(n0)` then one `cubicTo(...)` per segment across `layer.nodes`, closing with a final
  `cubicTo` + `close()` when `layer.closed`. It renders a single contour by construction.
- `src/engine/compositor.ts:1856` — fill only paints when `layer.closed` is true
  (`if (layer.fill && layer.closed)`); the stroke path applies dash/cap/join and frees the effect
  (`:1861-1882`).
- `src/engine/compositor.ts:2316-2332` (`hashLayer`, `case "vector"`) — the thumbnail/repaint hash
  folds `closed`, `fill`, the stroke, and every node's six coordinates. It assumes one `nodes` list.
- `src/document/factory.ts:1064-1069` — validation: a fill on a non-closed path is an error, a
  vector needs ≥2 nodes, and `validateStroke` (`:966-996`) hardens the stroke shape.
- `src/anchor/tools.ts:1262-1335` — the Anchor path ops (`press.add_path`, `append_path_node`,
  `close_path`) all speak the single-`nodes`/`closed` model.

Boolean results are routinely **multi-contour**: subtract punches a hole (an outer ring plus an
inner ring wound the opposite way), union of two separated shapes yields two disjoint pieces,
intersect can yield several islands. **The current model cannot represent any of these.** Worse,
extracting bezier `PathNode`s back out of a combined Skia path is lossy: Skia returns a flat verb
stream (mixed line/quad/cubic/close verbs across multiple contours), which does not map cleanly onto
the in-handle/out-handle-per-anchor node model the editor is built on.

### What Skia / CanvasKit actually offers (verified in the bundled types)

`node_modules/canvaskit-wasm/types/index.d.ts`:

- `Path.makeCombined(other: Path, op: PathOp): Path | null` (`:2497`) and the static
  `Path.MakeFromOp(one: Path, two: Path, op: PathOp): Path | null` (`:3919`) — the boolean engine.
- `PathOp` enum (`:4806-4812`): `Union`, `Intersect`, `Difference`, `ReverseDifference`, `XOR`.
  This maps 1:1 to the requested capability — union → `Union`, intersect → `Intersect`,
  subtract → `Difference`/`ReverseDifference`, exclude → `XOR`.
- `FillType` enum (`:4716-4719`): `Winding` (nonzero) and `EvenOdd`; `Path.setFillType(fill)`
  (`:2538`) and `PathBuilder.setFillType` (`:2875`). Booleans presuppose a fill rule, and holes
  read correctly under nonzero winding when the inner contour is wound opposite to the outer.
- `Path.toCmds(): Float32Array` (`:2545`) and `Path.MakeFromCmds(cmds)` (`:3910`) — a lossless verb
  stream in and out, the honest serialization for a combined result.
- `Path.makeSimplified()` (`:2514`) and `Path.makeAsWinding()` (`:2489`) — normalise a combined path
  before storing it.
- `ck.PathBuilder` (`:3963+`) with `moveTo`/`cubicTo`/`close`/`detach` — already used by
  `drawVector`, so a multi-contour builder is `moveTo` per subpath into the same builder.

These are real, in-bundle APIs. Nothing in this ADR invents a Skia call.

## Proposed capability

A `booleanCombine(doc, ids, op)` primitive that takes **2+ selected vector layers** on the active
page and produces one result path:

- **union** → `PathOp.Union`; **intersect** → `PathOp.Intersect`;
  **subtract** → `PathOp.Difference` (topmost minus those beneath, or a defined operand order);
  **exclude** → `PathOp.XOR`.
- Operands are read from each layer's contour and mapped into a common page/parent space (via the
  existing `worldMatrix`/`localMatrix`, `src/document/transform.ts:90-134`) before combining, so the
  boolean is computed where the shapes actually overlap on the page, not in each layer's local box.
- The combined `Path` is folded left across the operands with `makeCombined`, normalised
  (`makeAsWinding`/`makeSimplified`), and stored as the result layer's geometry.
- The operation is **destructive to the operands** in Phase A (like Illustrator's Pathfinder
  "shape modes" without the compound-shape live toggle): the operands are consumed into one result
  layer, and undo restores them as one history step.

## Required data-model change (the crux)

Booleans are gated on a **multi-contour vector representation** — this is the §34/§71-class change.
Two candidate shapes, both of which must coexist with today's single `nodes` array:

1. **Compound path via subpaths (preferred, editor-native).** Extend `VectorLayer` with an optional
   `contours?: { nodes: PathNode[]; closed: boolean }[]`. A layer carries **either** its legacy
   single `nodes`/`closed` (unchanged) **or** a `contours` list. `drawVector` builds each contour
   into the same `PathBuilder` (a `moveTo` per contour), so holes and disjoint pieces render as one
   path under a chosen `FillType`. This keeps the bezier-node model the pen tool and Anchor already
   speak, so a combined shape stays hand-editable node-by-node. The cost is that not every Skia verb
   stream round-trips exactly into per-anchor nodes (arcs/quads must be represented as cubics), which
   is acceptable because `drawVector` already only emits cubics.

2. **Opaque verb-list geometry (lossless, non-editable).** Store the combined result as a serialized
   `toCmds()` verb stream and rebuild it with `MakeFromCmds` at draw time. This is byte-lossless for
   rendering but the result is **not** node-editable, which breaks the "everything stays an editable
   layer" law the Anchor contract states (`src/anchor/tools.ts:5-13`).

**Recommendation: shape (1), the subpath model**, with the legacy single `nodes`/`closed` retained
as the one-contour case (equivalently, a one-element `contours`). The migration wraps every existing
vector's single contour as a one-element list (or leaves `nodes` in place and treats absent
`contours` as `[{ nodes, closed }]`), so no existing pixels move.

## Serialization / migration impact

Yes — a **`DOC_VERSION` bump beyond v5 is required**. Note that the research doc predates RFC-4:
`DOC_VERSION` is already **5** today (`src/document/migrate.ts:46`; stroke styling shipped as
v4→v5, see `types.ts:394-402`). Booleans therefore need **v5 → v6**, following the four-point
serialization contract that RFC-2/RFC-4 established:

1. `src/document/types.ts` — add the multi-contour field to `VectorLayer` (`:215-221`) and widen the
   `PressDocument.version` union to include `6` (`:402`).
2. `src/document/migrate.ts` — set `DOC_VERSION = 6` (`:46`); add an `if (from < 6)` step that wraps
   each existing single-contour vector as its one-element multi-contour form. This is a **widening
   migration**: a v≤5 vector is already a valid v6 single-contour path, so nothing is rewritten and
   only a count is reported — the same pattern as `stampStrokeStyles` (`:103-109`). MIGRATION
   INVARIANT (pixel-identical re-open) asserted in `tests/transform.test.mjs`.
3. `src/app.ts` — raise the `openBytes` guard from `json.version <= 5` to `<= 6` (`:1525`). This is
   the exact class of bug the Sprint-0 P0 reopen fix addressed: a guard capped below `DOC_VERSION`
   silently drops content.
4. `src/document/factory.ts` — `validateDocument` accepts `6` (`:1001`) and validates the new
   contour arrays (each contour ≥2 nodes, finite coordinates, bounded contour/node counts), mirroring
   the defensive posture of `validateStroke` (`:966-996`).

## Rendering impact

- **Fill rule.** A combined path needs an explicit `FillType`. Nonzero (`Winding`) with the inner
  hole wound opposite the outer contour is the natural output of `makeCombined`; `EvenOdd` is the
  alternative and is what most cleanly renders a hole regardless of winding. `drawVector` must call
  `setFillType`/`PathBuilder.setFillType` (`index.d.ts:2538/2875`) before filling — today it never
  sets one and relies on the single-contour default.
- **Stroke.** A stroke of a combined path strokes **every** contour, including the inner edge of a
  hole, which is the correct and expected result. `drawVector`'s existing dash/cap/join application
  (`compositor.ts:1861-1882`) works unchanged on a multi-contour path.
- **Hash.** `hashLayer`'s vector branch (`:2316-2332`) must fold every contour's nodes and the fill
  rule, or thumbnails and repaints go stale after a combine.
- Canvas, PNG and PDF share `drawVector`, so a multi-contour build there is automatically correct on
  export (the "applied by the compositor **and** the exporter" contract, `types.ts:72-75`).

## Hit-testing / selection impact

- Selection geometry uses axis-aligned bounds (`compositor.selectionFrame`, `:763-785`;
  `transform.worldBounds`, `:157-164`), which are derived from the layer box, not the contour, so a
  multi-contour layer selects and shows handles exactly as a single-contour one does — no change
  needed for the marquee/handle path.
- Point-in-shape hit-testing (e.g. clicking inside a hole should miss) would want
  `Path.contains(x, y)` under the chosen fill rule; this is an enhancement, not a blocker, and can
  follow the existing bounding-box hit path initially.

## Dependencies

None new. Reuses CanvasKit (already the compositor), the command bus (undo, one history step),
`transform.ts` matrices, and the existing `PathBuilder`/`drawVector` seam. No new npm dependency, so
no §71 dependency ADR beyond this one.

## Complexity

Medium–High, and — as RFC-5 said — dominated by the **geometry-model change and node round-tripping**,
not by the Skia call (`makeCombined` is one line). The schema bump, migration, validation, the
`drawVector` multi-contour build + fill rule, `hashLayer`, a `booleanCombine` op, an Anchor
`press.boolean` op, and desk UI + tests are all in scope. Files that would change:
`src/document/types.ts`, `src/document/migrate.ts`, `src/document/factory.ts`, `src/app.ts`,
`src/engine/compositor.ts`, `src/document/ops.ts` (+ possibly `commands.ts`), `src/anchor/tools.ts`,
`src/chrome/desk.ts` + `index.html`, and `tests/`.

## Security / Perf / Accessibility implications

- **Security.** New parser surface: the contour arrays widen `validateDocument`'s job. Validate
  contour count, per-contour node count, finiteness and bounds, exactly as `validateStroke` and the
  Anchor `readNodes`/`pNodes` guards already do (`tools.ts:269-291,505-529`). No `eval`, no network.
- **Perf.** `makeCombined` runs **once at edit time**, not per frame, so the composite path is
  unaffected. The per-frame cost is only that `drawVector` builds N contours instead of one, which is
  bounded by the stored node count and folded into the existing hash. Delete every intermediate
  `Path` returned by `makeCombined` to avoid WASM-heap churn — the compositor already treats
  undeleted Skia objects as an `Aborted()` risk (`compositor.ts:448-460,1876-1882`).
- **Accessibility.** Standard buttons with labels + keyboard shortcuts, per the UX rules; the four
  operations are discrete commands with distinct semantics.

## Impact on existing architecture and PROVEN_WORKING vector flows

Non-trivial: this evolves the **core vector primitive**, which is `PROVEN_WORKING` (Feature Truth
Ledger; document model v1..v5). It stays inside the sanctioned layering (`document model → command
bus → compositor → chrome`) and adds no second state store or renderer. Because it touches
`PROVEN_WORKING` model + compositor code, a regression test comes first (§78): the migration invariant
test must prove that every existing single-contour vector renders pixel-identically after the v6
wrap before any boolean code lands.

## Acceptance criteria

- Subtract on two overlapping rectangles yields a shape **with a hole** that renders and exports
  (PNG + PDF) correctly and survives save → reopen on v6.
- Union of two disjoint shapes yields one layer with **two visible pieces**.
- Existing single-contour vectors migrate v5 → v6 unchanged: `tests/transform.test.mjs` migration
  invariant stays green (pixel-identical re-open); an old v≤5 file still opens.
- Undo of a combine restores the original operands as **one** history step.
- Combined-path fill honours the chosen fill rule; stroke traces every contour including holes.
- Thumbnails/repaint update after a combine (hash includes all contours + fill rule).
- `validateDocument` rejects malformed contour arrays; no undeleted Skia `Path` leaks
  (heap stable across repeated combines).
- Governor quality gates green: `npm test`, `npx tsc --noEmit`, `npm run build`.

## Phased implementation plan

- **Phase 0 — spike (this EXPERIMENT).** Prove the multi-contour representation end-to-end on a
  branch: the v5→v6 widening migration + invariant test, a `drawVector` multi-contour build with a
  fill rule, and a throwaway subtract-two-rects to confirm a hole renders and round-trips. This
  de-risks the model before committing the file-format step.
- **Phase A — destructive booleans (the shippable feature).** `booleanCombine(doc, ids, op)` for
  union/subtract/intersect/exclude consuming operands into one multi-contour result layer; command +
  Anchor `press.boolean` op; desk UI (a Pathfinder-style button cluster); full validation + tests.
  Result nodes remain hand-editable (subpath model).
- **Phase B — non-destructive / live boolean (DEFER).** Keeping the operands live and re-deriving the
  result on edit (Illustrator "compound shape") needs a boolean *node* in the layer graph and a
  dependency/recompute story — materially larger. Defer to its own ADR after Phase A ships and is
  regression-covered.

## Why now / Why not now

- **Why now.** Real, frequently-requested vector capability, and the Skia primitive is already in the
  bundle — the only thing standing between the editor and booleans is a model decision the Governor
  can make here. Settling the multi-contour representation also unblocks future vector work (compound
  shapes, even-odd fills, imported multi-contour SVG/PSD paths).
- **Why not now (sequencing).** The single-contour model is the true blocker, and this is the only
  RFC in the set that changes a core, `PROVEN_WORKING` data shape. The additive RFCs (alignment,
  gradients, effects, stroke styling — RFC-1..4) carry lower format risk and higher value/effort, and
  RFC-5 was explicitly ranked **below** them and gated on this ADR. Ship it after those land and are
  regression-covered, and only once the Phase 0 spike's acceptance criteria are green.

## Recommendation (for the Governor to ratify)

**EXPERIMENT → ACCEPT the multi-contour subpath model; DEFER non-destructive booleans (Phase B).**

Concretely:

1. **ACCEPT the direction**: the compound-path *subpath* representation (shape 1) as the committed
   evolution of `VectorLayer`, carried by a v5 → v6 widening migration under the four-point
   serialization contract, with the single-contour case preserved.
2. **EXPERIMENT first**: land the Phase 0 spike (migration + invariant test + multi-contour render +
   a proof subtract) behind the normal branch/PR flow before the file-format bump is merged. Promote
   to full **ACCEPT of Phase A** (the shippable destructive booleans) once the acceptance criteria
   above are green.
3. **DEFER Phase B** (live/non-destructive booleans) to a later ADR.

Rationale: the value is real and the Skia engine is present, but this is the one item that mutates a
`PROVEN_WORKING` core shape, so it earns a proof-of-model spike and a regression-test-first landing
(§11/§78) rather than a blind ACCEPT — while still committing to the multi-contour direction so the
team is not left guessing. This ADR does not alter `GOVERNOR.md`; the Governor records the ratified
decision there.
