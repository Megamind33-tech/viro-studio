# ADR 0001 — Hierarchical local transforms for the scene graph

Date: 2026-08-25
Status: **Accepted**, implemented in foundation slice 1.

## Context

Groups did not work. Evidence at the time of the decision:

- `src/document/types.ts` — `Transform { x, y, w, h, rotation }` held **absolute
  page coordinates**; hierarchy was expressed by `parentId: string | null` alone.
- `src/engine/compositor.ts` `drawTree` — the group branch called `saveLayer`
  for opacity and blend, recursed into children, and **never applied the
  group's own transform**.
- `src/document/ops.ts` `groupSelected` — set the group's transform to the
  children's absolute bounding box and only reparented them.

So moving a group updated the group record and changed nothing on screen. There
was no world-transform composition anywhere in the codebase.

Four further consumers each re-derived position from the raw record, so they
would drift from the canvas independently: layer thumbnails, page thumbnails,
`layerBounds`, PDF export, `hitTest` and `selectIntersecting`. `hitTest` also
ignored rotation entirely, testing the axis-aligned record instead of the shape.

## Decision

1. **`Layer.transform` becomes local to its parent.** Document version 2.
2. **One shared algebra**, `src/document/transform.ts`, is the only source of
   position. Every renderer and hit test composes through it. See
   `docs/RENDERING-CONTRACT.md`.
3. **Add optional `scaleX`/`scaleY`** to `Transform`, defaulting to 1 when
   absent, so v1 records read correctly without a rewrite. Resizing a leaf edits
   `w`/`h`; resizing a group edits scale.
4. **Explicit, reported migration** with a pixel-identity invariant.
5. **Shear is reported, not approximated** (`decompose` returns `sheared`).

## Alternatives rejected

**Keep absolute coordinates; have group edits fan out to children.**
Rejected: it is the "fake groups with parentId" pattern the product rules
forbid. Every child mutates on every group drag, so undo granularity, dirty
regions and future collaborative editing all degrade, and nested groups compound
the error. It also cannot express group scale without destroying child geometry.

**Full affine matrix (a,b,c,d,e,f) per node instead of a decomposed record.**
Rejected *for this slice* only. It is strictly more expressive — it would remove
the shear limitation entirely — but `t.x`/`t.y`/`t.w`/`t.h` are read by panels,
options bar, ops, anchor tools, PDF, thumbnails and hit-testing. Changing the
representation everywhere at once is the kind of broad rewrite that must not
happen without migration tests, and slice 1 needed to land the correctness fix
first. Revisit when the command bus exists.

**Cache a computed world transform on each node.**
Rejected: two sources of truth for position, and invalidation would have to be
perfect on every ancestor edit. Composition is a handful of multiplies; measure
before caching.

## Consequences

Good:

- Nested groups compose correctly; children are never rewritten when a group moves.
- `hitTest` now tests the layer's own local space, which fixed rotated-leaf
  picking as a side effect.
- Canvas, thumbnails and PDF share one definition, so parity is testable and
  tested.

Costs and limits, stated plainly:

- Ungrouping a non-uniformly scaled, rotated group is lossy. Reported via
  `sheared`, not hidden. Closing it needs the full affine node.
- `press.set_transform` does **not** expose `scaleX`/`scaleY`, so group scale is
  not yet reachable from the Anchor op surface or the Transform panel. The
  renderer supports it; the command surface has not caught up.
- Every v1 document on disk must migrate on open. Skipping migration displaces
  grouped artwork by its group origin.
