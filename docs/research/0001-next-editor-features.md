# Research 0001 — Next editor-engine features (RFC set)

Date: 2026-08-26 · Author: Principal Researcher · Status: **Proposed (RFC-gated, GOVERNOR.md §34/§36)**

> Scope guard: this document proposes only **real, local, single-user editor-engine**
> capabilities that the current Skia/CanvasKit compositor and the versioned document model can
> actually deliver. Nothing here touches cloud, auth, billing, collaboration, stock/template
> marketplaces, or AI-beyond-cutout — those are ADR 0004 territory or aspirational
> (GOVERNOR.md Feature Truth Ledger) and are out of scope by construction. No code has been
> changed to write this; it is a proposal set for the Governor to accept or reject per §36.

## How this was grounded (evidence base)

Read before writing, to avoid inventing APIs (GOVERNOR.md §1 reality-over-appearance):

- Document model: `src/document/types.ts` — `VectorLayer.fill: Rgba | null`,
  `VectorLayer.stroke: { color, width } | null`, `LayerBase.effects?: LayerEffect[]`,
  `LayerEffect = DropShadowEffect` (a single-member union today), `Transform` (parent-local
  `x,y,w,h,rotation,scaleX?,scaleY?`), `PressDocument.version: 1|2|3|4`.
- Rendering: `src/engine/compositor.ts` — `drawVector` builds a `PathBuilder` and calls
  `setStyle(Fill)` / `setColor` then `setStyle(Stroke)` / `setStrokeWidth`; `drawLayer` /
  `drawLayerWithEffects` (drop shadow via `ImageFilter.MakeDropShadowOnly` + `saveLayer`);
  `selectionFrame` already computes the axis-aligned union of a multi-selection; the marquee
  already uses `ck.PathEffect.MakeDash(...)`; the checker already uses `makeShaderOptions` +
  `paint.setShader`.
- Mutation & undo: `src/document/ops.ts` (pure `doc -> doc` primitives incl. `setLayerDropShadow`
  which stores effects as a filtered list), `src/document/command-bus.ts` (one undo stack;
  `commit()` snapshots, migrated paths use typed inverses; `deriveInverse` diffs), `src/app.ts`
  (`commit`, `setDropShadow`, `openBytes`).
- Anchor op surface: `src/anchor/tools.ts` (`OPS` registry; `pStroke`, `pRgba`, `applyFill`).
- Serialization / migration: `src/document/migrate.ts` (`DOC_VERSION = 4`, `migrateDocument`
  per-version `if (from < N)` steps), `src/app.ts` `openBytes` guard
  `json.version >= 1 && json.version <= 4`, `src/document/factory.ts` `validateDocument`
  (`version must be 1, 2, 3 or 4`) and the `DOC_VERSION` constant.

### CanvasKit primitives confirmed available (`node_modules/canvaskit-wasm/types/index.d.ts`)

- `Shader.MakeLinearGradient`, `MakeRadialGradient`, `MakeSweepGradient`,
  `MakeTwoPointConicalGradient` → gradient paints. `Paint.setShader` exists and is already used.
- `PathEffect.MakeDash(intervals, phase)` and `Path.makeDashed(on, off, phase)` → dashed strokes
  (already exercised for the marquee).
- `Path.makeCombined(other, op)` / `Path.MakeFromOp(a, b, op)` with
  `PathOp = { Difference, Intersect, Union, XOR }` → boolean path operations.
- `ImageFilter.MakeDropShadowOnly` (used now), plus blur mask filters → inner shadow / outer glow.

### Serialization contract that every schema-affecting RFC must honour

`DOC_VERSION = 4`. Any change that widens a **persisted** shape (a new fill kind, a new stroke
field, a new effect variant that must survive round-trip) requires a coordinated bump:

1. `src/document/types.ts` — widen the type; bump `PressDocument.version` union to include `5`.
2. `src/document/migrate.ts` — `DOC_VERSION = 5`; add an `if (from < 5)` step (a **widening**
   migration: existing `Rgba` fills / `{color,width}` strokes stay valid, so it is effectively a
   version stamp — preserves the MIGRATION INVARIANT of pixel-identical re-open).
3. `src/app.ts` `openBytes` — raise the guard to `json.version <= 5` (the exact class of bug the
   Sprint-0 P0 reopen fix addressed: a guard capped below `DOC_VERSION` silently drops content).
4. `src/document/factory.ts` `validateDocument` — accept `5` and validate the new shape.

Effects added to `LayerEffect` are the one exception: `effects?` is optional and was documented
as "additive and forward/backward safe", and drop-shadow shipped **without** a version bump. A
new effect *variant* can therefore ship versionless (old builds ignore an unknown effect), but if
it lands in the same slice as a persisted-shape change (gradient fill / dashed stroke) it should
ride the same v5 bump for a single clean file-format step.

---

## Ranking (value ÷ effort; highest first)

| # | Feature | Value | Effort | Schema bump | Verdict |
| - | --- | --- | --- | --- | --- |
| 1 | Alignment & distribution of multi-selection | High | Low | **No** | Do first |
| 2 | Gradient fills + Gradient Overlay effect | High | Med–High | **Yes (v4→v5)** | Flagship |
| 3 | Extra layer effects (stroke, inner shadow, outer glow) | High | Med | No (effects additive)* | Strong |
| 4 | Stroke styling (dashes, caps, joins) | Med | Low–Med | **Yes (v4→v5)** | Bundle with #2 |
| 5 | Boolean path operations | Med | Med–High | **Yes (multi-contour)** | Gated on geometry model |
| 6 | Multi-select transform & smart guides | Med–High | High | No | Last / phased |

\* If shipped alongside #2/#4, fold into the same v5 bump for one file-format step.

---

## RFC-1 — Alignment & distribution of multiple selected layers

- **Problem.** A professional layout tool must align/distribute selected objects (left/center/
  right, top/middle/bottom, distribute-horizontal/vertical, distribute-spacing). Today the only
  multi-layer geometry op is grouping; users must nudge by eye.
- **Evidence.** `compositor.selectionFrame(doc)` already returns the union frame of the
  multi-selection; `src/document/transform.ts` `worldBounds(page, layer)` gives per-layer
  page-space bounds; `ops.setLayerTransform(doc, id, patch)` already mutates parent-space `x/y`
  and respects `locked`. Everything needed exists; nothing new must be rendered.
- **Proposed capability.** Pure `doc -> doc` primitives `alignSelected(doc, edge)` and
  `distributeSelected(doc, axis, mode)` computing each layer's target parent-space `x/y` from the
  selection union (or the page, for "align to page") and applying via `setLayerTransform`. For
  grouped children, convert world targets back through the parent matrix (`decompose`/`mul`
  helpers already exist in `transform.ts`).
- **Dependencies.** None new. Reuses `selectionFrame`, `worldBounds`, `setLayerTransform`.
- **Complexity.** Low. ~1 new file's worth of geometry in `ops.ts`; wiring in
  `src/chrome/desk.ts` + a button cluster in `index.html`; one Anchor op `press.align` in
  `src/anchor/tools.ts`; a unit test `tests/align.test.mjs`.
- **Files that change.** `src/document/ops.ts` (new prims), `src/chrome/desk.ts` + `index.html`
  (controls), `src/anchor/tools.ts` (op), optionally `src/document/commands.ts` (register a typed
  command; otherwise `commit()` snapshot suffices), `tests/`.
- **Schema bump.** **None.** Only `Transform.x/y` change — already versioned and undoable.
- **Security / Perf / Accessibility.** No parser surface. Perf trivial (N layers, one repaint;
  dirty region already computed by the bus). Accessibility: give each button a shortcut + label
  per UX rules; keyboard-operable.
- **Impact on architecture.** None — sits squarely in `document model → command bus → compositor`.
- **Acceptance criteria.** Aligning 3 layers left makes their world-left equal; distribute-
  horizontal equalizes centre spacing; locked layers are skipped, not moved; single-selection is a
  no-op; one undo step restores all positions; grouped children align in world space.
- **Why now.** Best value/effort in the set; unblocks credible layout work with zero format risk.
- **Why not now.** Only if the team wants to bundle the copper selection UI with #6 — but the
  geometry is independent and should not wait.

## RFC-2 — Gradient fills for vectors + a "Gradient Overlay" layer effect

- **Problem.** Vector fills are a single flat `Rgba`. Gradients (linear/radial) are table stakes
  for posters/branding and are the highest-visibility "pro editor" gap.
- **Evidence.** `Shader.MakeLinearGradient` / `MakeRadialGradient` exist; `Paint.setShader` is
  already used by the checkerboard. `drawVector` already sets a fill paint per layer, so a gradient
  is "set a shader instead of a solid colour on the same paint". Effects already compose through
  `drawLayerWithEffects` (drop-shadow precedent), so a Gradient Overlay is another entry there.
- **Proposed capability.**
  1. A serializable `Gradient` type: `{ type: "linear" | "radial", stops: { offset: 0..1;
     color: Rgba }[], angle?; center?; radius? }` in page-relative units, plus a `Paint` union
     `Rgba | Gradient`. Widen `VectorLayer.fill` to `Rgba | Gradient | null`.
  2. `GradientOverlayEffect` added to the `LayerEffect` union (paints a gradient inside the
     layer's silhouette via `saveLayer` + blend, mirroring `DropShadowEffect`).
  3. Compositor: in `drawVector`, when `fill` is a `Gradient`, build the shader from the layer
     box (`t.w × t.h`) and `paint.setShader(...)` before `drawPath`; delete the shader after.
- **Dependencies.** RFC "serialization contract" above (this is the one that forces the bump).
- **Complexity.** Med–High: type + shader construction + colour handling (channels are 0-1
  floats, matching `color()` helper) + serialization/migration + validation + UI (a gradient
  editor is the largest sub-cost) + Anchor schema.
- **Files that change.** `src/document/types.ts` (Gradient type, `fill` union, `LayerEffect`
  union, `version` union), `src/engine/compositor.ts` (`drawVector`, a
  `drawGradientOverlay` branch in `drawLayerWithEffects`; also fold gradient into `hashLayer`
  so thumbnails invalidate), `src/document/ops.ts` (`setVectorFill` accepting a gradient;
  `setLayerGradientOverlay` like `setLayerDropShadow`), `src/document/migrate.ts` (v4→v5 stamp),
  `src/app.ts` (`openBytes` `<= 5`; a `setGradientOverlay` method), `src/document/factory.ts`
  (`validateDocument`: accept 5, validate stops), `src/chrome/desk.ts` + `index.html` +
  `src/styles/desk.css` (gradient editor UI), `src/anchor/tools.ts` (extend `press.apply_fill`
  or add `press.set_gradient`), `tests/effects.*` + a new gradient test.
- **Schema bump.** **Yes: DOC_VERSION 4 → 5.** Persisted fill shape widens.
- **Security / Perf / Accessibility.** Parser surface grows: `validateDocument` must reject
  malformed stops (offsets 0-1, ≥2 stops, channels 0-1) — the same defensive posture as existing
  colour validation in `anchor/tools.ts`. Perf: one extra shader per gradient layer per composite;
  `pageSurf` reuse already amortises allocation; delete shaders to avoid WASM-heap churn
  (compositor already treats churn as an `Aborted()` risk). Accessibility: numeric stop inputs
  and keyboard-editable angle.
- **Impact on architecture.** Additive to the model; keeps the fill in the document (not baked),
  so it stays editable/undoable — consistent with the "never rasterise" Anchor law.
- **Acceptance criteria.** A saved-then-reopened v5 doc with a gradient fill renders pixel-stable;
  canvas and PNG/PDF export match (effects "applied by the compositor **and** the exporter" per
  types.ts); an old v≤4 file still opens; undo restores the previous fill; Anchor gradient op
  round-trips.
- **Why now.** Highest-visibility real capability; the effects list and shader plumbing already
  exist, so it is incremental, not foundational.
- **Why not now.** Only if the file-format bump must be sequenced behind ADR-0004 P2 cloud-doc
  work (cloud stores the same `PressDocument` + `migrateDocument`); a v5 bump is compatible with
  that but should be coordinated so both land one clean format step.

## RFC-3 — Additional layer effects: stroke/outline, inner shadow, outer glow

- **Problem.** Only drop shadow exists. Stroke, inner shadow and outer glow are the next-most-used
  Photoshop layer styles and reuse the freshly-built effects list.
- **Evidence.** `LayerBase.effects?: LayerEffect[]` is already a list; `setLayerDropShadow`
  filters-and-replaces by `type`, so more variants slot in unchanged; `drawLayerWithEffects`
  is the single composition seam; `ImageFilter.MakeDropShadowOnly` and blur mask filters are
  available. Outer glow ≈ drop shadow with zero offset and a colour; inner shadow is a drop
  shadow drawn into the *inverse* silhouette (blend `SrcIn`/`DstOut` inside a `saveLayer`);
  stroke/outline can be an offset-silhouette pass or a widened path.
- **Proposed capability.** Add `StrokeEffect`, `InnerShadowEffect`, `OuterGlowEffect` to the
  `LayerEffect` union and render them in `drawLayerWithEffects` (pre-pass for glow/outer stroke,
  post-pass clipped to the layer for inner shadow / inner stroke).
- **Dependencies.** Cleanest if it rides RFC-2's v5 bump; otherwise ships versionless like
  drop-shadow.
- **Complexity.** Med. Rendering math for inner shadow (mask inversion) is the trickiest part;
  the op/UI plumbing mirrors drop-shadow exactly.
- **Files that change.** `src/document/types.ts` (union), `src/engine/compositor.ts`
  (`drawLayerWithEffects`, `dropShadowOf`-style selectors, `hashLayer` fold),
  `src/document/ops.ts` (`setLayer<Effect>` prims), `src/app.ts` (setter methods),
  `src/chrome/desk.ts` + `index.html` (the existing `g-effects` panel gains sections),
  `src/anchor/tools.ts` (ops), `tests/effects.*`.
- **Schema bump.** Not strictly required (effects are additive/forward-safe — drop-shadow
  precedent). Recommend folding into v5 if bundled with #2/#4.
- **Security / Perf / Accessibility.** No parser surface if versionless; validation should still
  bound blur/offset. Perf: each enabled effect is an extra `saveLayer` pass — cap counts and keep
  blur sigmas modest (compositor already halves blur to sigma). Accessibility: mirror the
  drop-shadow controls' labels/shortcuts.
- **Impact on architecture.** None new; extends an existing seam.
- **Acceptance criteria.** Each effect toggles on/off with one undo step; canvas == export;
  stacking with drop shadow composites in a defined order; thumbnails update (hash includes the
  effect).
- **Why now.** Compounds the value of the just-added effects list at low marginal cost.
- **Why not now.** If inner-shadow mask math needs its own spike, ship stroke + outer glow first
  (both are near-clones of drop shadow) and defer inner shadow.

## RFC-4 — Stroke styling: dashes, caps, joins

- **Problem.** Vector strokes are solid, butt-cap, miter-join only. Dashed rules, rounded caps
  and joins are basic vector needs (coupons, dividers, technical layouts).
- **Evidence.** `PathEffect.MakeDash([...], phase)` is already used for the marquee in
  `compositor.paintOverlay`; `Paint` exposes stroke cap/join in CanvasKit. `drawVector` already
  owns the stroke paint.
- **Proposed capability.** Widen `VectorLayer.stroke` to
  `{ color; width; dash?: number[]; cap?: "butt"|"round"|"square"; join?: "miter"|"round"|"bevel"
  }`. In `drawVector`, when `dash` is present call `paint.setPathEffect(ck.PathEffect.MakeDash(...))`
  (and delete it); set cap/join from the enums.
- **Dependencies.** Serialization contract (stroke shape widens) — bundle with RFC-2's v5 bump.
- **Complexity.** Low–Med. Rendering is a few lines; the cost is serialization/validation + UI
  fields + Anchor `pStroke` schema extension.
- **Files that change.** `src/document/types.ts` (stroke shape, `version`),
  `src/engine/compositor.ts` (`drawVector`, `hashLayer` fold), `src/document/migrate.ts`
  (v4→v5), `src/app.ts` (`openBytes` guard), `src/document/factory.ts` (`validateDocument`),
  `src/chrome/desk.ts` + `index.html` (stroke controls), `src/anchor/tools.ts` (`pStroke`),
  `tests/`.
- **Schema bump.** **Yes: v4 → v5** (shared with RFC-2 if co-scheduled).
- **Security / Perf / Accessibility.** Validate dash arrays (finite, non-negative, bounded
  length) — new parser surface. Perf negligible (one path effect per stroked layer; delete after
  use). Accessibility: numeric dash inputs, enum selects with labels.
- **Impact on architecture.** Additive; stroke stays a document property, not baked.
- **Acceptance criteria.** A dashed stroke round-trips through save/open on v5; renders identically
  on canvas and export; old files still open solid; undo restores prior stroke.
- **Why now.** Cheap, high-polish, and shares the exact bump RFC-2 already pays for.
- **Why not now.** No reason to ship a v5 bump for dashes alone — schedule with RFC-2.

## RFC-5 — Boolean path operations (union / intersect / subtract / exclude)

- **Problem.** No way to combine vector shapes. Booleans are core vector tooling.
- **Evidence.** `Path.makeCombined(other, PathOp)` / `Path.MakeFromOp` and the `PathOp` enum
  (`Union/Intersect/Difference/XOR`) exist in CanvasKit. **However**, `VectorLayer` is a
  *single* contour: `nodes: PathNode[]` + `closed: boolean`. Boolean results are routinely
  **multi-contour** (subtract punches holes; union can yield disjoint pieces), which today's model
  cannot represent, and extracting bezier `PathNode`s back out of a combined Skia `Path` (mixed
  line/quad/cubic verbs, multiple contours) is lossy against the in/out-handle node model.
- **Proposed capability (phased).**
  - *Phase A (feasible now, honest):* compute the combined `Path` at op time and store the result
    as a **compound path** — i.e. extend `VectorLayer` to hold `subpaths: PathNode[][]` (each with
    its own `closed`) or a serialized verb list, and teach `drawVector` to build every subpath into
    one `PathBuilder`. This is the correct, non-lossy representation and is a schema change.
  - *Phase B:* editable boolean *results* (re-open the operands) would need a non-destructive
    boolean node — larger, defer.
- **Dependencies.** A multi-contour geometry model (schema change beyond a simple stamp).
- **Complexity.** Med–High, dominated by the geometry-model change and node round-tripping, not
  by the Skia call.
- **Files that change.** `src/document/types.ts` (multi-contour `VectorLayer` +/or a verb-list
  path; `version`), `src/engine/compositor.ts` (`drawVector` multi-contour build; `hashLayer`),
  `src/document/ops.ts` (`booleanCombine(doc, ids, op)`), `src/document/migrate.ts` (v→next:
  wrap each existing single contour as a one-element `subpaths`), `src/document/factory.ts`
  (validation), `src/anchor/tools.ts` (`press.boolean`), `src/chrome/desk.ts` + `index.html`,
  `tests/`.
- **Schema bump.** **Yes**, and larger than a stamp: the vector shape genuinely changes. Migrate
  existing vectors to the new multi-contour form (invariant: pixel-identical re-open).
- **Security / Perf / Accessibility.** New parser surface (subpath arrays) — validate node counts
  and finiteness as `tools.ts` already does. Perf fine (combine is one-shot at edit time, not per
  frame). Accessibility: standard buttons + shortcuts.
- **Impact on architecture.** Non-trivial: it evolves the vector primitive. Warrants its own ADR
  because it changes a core data shape (§34/§71-class decision), unlike the additive RFCs above.
- **Acceptance criteria.** Subtract on two rects yields a shape with a hole that renders and
  exports correctly and survives round-trip; existing single-contour vectors migrate unchanged;
  undo restores operands.
- **Why now.** Real user value and the Skia primitive is present.
- **Why not now.** The single-contour model is the true blocker; ship it only after the
  multi-contour representation is agreed (own ADR). Rank below the additive RFCs.

## RFC-6 — Multi-select transform & smart guides

- **Problem.** Two gaps: (a) resizing/rotating a *multi-selection* as one unit (today
  `selectionFrame` draws the union but the drag handlers scale a single layer's `w/h`), and
  (b) no snapping — `press.add_guide`'s own description says guides "do not snap or constrain
  anything yet". A pro editor snaps to object edges/centres and the page.
- **Evidence.** `compositor.selectionFrame` already yields the union frame and `hitHandle`
  already hit-tests handles against it; `paintOverlay` already draws transient overlays (marquee,
  shape preview, cursor rule) with no document change; `worldBounds` gives candidate snap edges.
  Guides are already document state (`Page.guides`); *smart* guides are ephemeral (view-only).
- **Proposed capability.**
  1. Multi-transform: when >1 layer is selected, a handle drag scales every member's parent-space
     `x/y/w/h` proportionally about the union (grouped children via the existing matrix helpers),
     applied through `setLayerTransform` as one coalesced history entry.
  2. Smart guides: during a move/resize, compute snap candidates from other layers' `worldBounds`
     edges/centres + page margins/centre, snap within a pixel tolerance, and draw copper alignment
     lines in `paintOverlay` (transient, like `shapePreview`).
- **Dependencies.** None new; builds on existing selection geometry and overlay passes.
- **Complexity.** High — mostly in `src/chrome/desk.ts` pointer/drag logic (multi-layer scaling
  math, snap resolution) and the overlay renderer, plus careful coalescing so a 200-event drag is
  one undo step (the bus already supports `coalesceKey`).
- **Files that change.** `src/chrome/desk.ts` (drag handlers, snap logic), `src/engine/compositor.ts`
  (`paintOverlay` smart-guide lines; possibly a `snapCandidates` helper), `src/document/transform.ts`
  (shared geometry), `src/document/ops.ts`/`commands.ts` (batch transform), `tests/`.
- **Schema bump.** **None** — transforms and existing guides are already versioned; smart guides
  are view-state only.
- **Security / Perf / Accessibility.** No parser surface. Perf sensitive: snapping runs on the
  pointer-move path, which the compositor explicitly keeps allocation-free (overlay-only repaint,
  `Aborted()` risk if it re-composites) — snap math must stay off the composite path and reuse the
  cached page image. Accessibility: honour a modifier to suspend snapping; keep arrow-key nudge.
- **Impact on architecture.** None to the model; concentrated in chrome + overlay.
- **Acceptance criteria.** Dragging a corner of a 3-layer selection scales all three about the
  union as one undo step; layers snap to a neighbour's edge/centre and to page centre within
  tolerance; snapping never triggers a full-page re-composite mid-drag; disabling snap restores
  free movement.
- **Why now.** High perceived quality; entirely local, no format risk.
- **Why not now.** Highest effort and perf-sensitive; sequence after the additive wins (RFC-1–4)
  land and are regression-covered.

---

## Recommended sequencing

RFC-1 (no bump, best ratio) → RFC-2 + RFC-4 + (optionally RFC-3) shipped as **one v4→v5 file-format
step** with the four-point serialization contract satisfied and a widening migration → RFC-3 inner
shadow if spiked separately → RFC-6 (perf-gated, chrome-heavy) → RFC-5 only after its own ADR for
the multi-contour vector model. Each RFC must land with the GOVERNOR.md quality gates green
(`npm test`, `tsc --noEmit`, build) and — for anything touching `PROVEN_WORKING` compositor/model
code — a regression test first (§78).
