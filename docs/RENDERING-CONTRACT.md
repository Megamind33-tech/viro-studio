# Rendering contract

Status: **partial — transforms and image frames.** This document specifies the
rules established by foundation slices 1 and 2. Paint, selection masks,
blend/opacity grouping, colour and text shaping are NOT yet specified here; each
becomes binding as its slice lands. Do not read silence here as permission.

VIRO Press has more than one renderer:

| Renderer | Entry point | Output |
|---|---|---|
| Canvas | `Compositor.drawTree` (`src/engine/compositor.ts`) | live Skia surface |
| Layer thumbnail | `Compositor.layerThumb` | PNG data URL |
| Page thumbnail | `Compositor.pageThumb` / `drawThumbTree` | PNG data URL |
| PNG export | `Compositor` page render | PNG file |
| PDF export | `emit` (`src/export/pdf.ts`) | PDF content stream |
| Hit testing | `hitTest` (`src/document/factory.ts`) | picked layer |
| Marquee | `selectIntersecting` (`src/document/ops.ts`) | selection |

They are separate code paths. When they disagree, the user sees artwork that
looks right on screen and exports wrong. The contract exists to stop that.

---

## Rule 1 — position comes from `document/transform.ts`, never from the record

`src/document/transform.ts` is the single source of truth for where a layer is.

Every renderer and every hit test MUST obtain position through:

- `localMatrix(t)` — a layer's own contribution
- `worldMatrix(page, layer)` — full composition through all ancestors
- `parentWorldMatrix(page, layer)` — what a child inherits
- `worldBounds(page, layer)` / `worldCorners(page, layer)` — page-space extents
- `pageToLocal(page, layer, x, y)` — inverse, for picking

**No renderer may read `transform.x` / `transform.y` directly for a layer that
can be nested.** That is what defect #1 was: `drawTree` read the record and never
composed it, so moving a group changed the number and not the pixels.

### The local matrix

```
M = T(x, y) · T(w/2, h/2) · R(rotation) · S(scaleX, scaleY) · T(-w/2, -h/2)
W(layer) = W(parent) · M(layer)          // page is identity
```

Rotation and scale both pivot about the layer's own centre, which is what a
transform handle implies. `scaleX` / `scaleY` are optional; **absent means 1**,
which is how a v1 document reads.

### `w`/`h` versus scale — two operations, two meanings

`w`/`h` are the layer's intrinsic box in its own local space. Leaf geometry is
authored in `[0, 0, w, h]`.

- Resizing a **leaf** edits `w`/`h`.
- Resizing a **group** edits `scaleX`/`scaleY`.

A group has no geometry of its own — it only re-frames its children. Keeping
these distinct is what stops "scale" from having two conflicting meanings, which
is the same class of bug as `Cover`/`Fill` duplication in image fit.

### Degenerate transforms

`invert` returns `null` rather than throwing. A zero-scale layer is invisible,
not an error; callers skip it. `worldMatrix` is cycle-guarded, so a corrupt
`parentId` graph cannot hang a renderer.

---

## Rule 2 — shear is reported, never silently approximated

`{x, y, w, h, rotation, scaleX, scaleY}` cannot represent shear. Shear arises
from `scale ∘ rotate` — a **non-uniformly scaled group containing a rotated
child**. (The reverse, `rotate ∘ scale`, is representable and must not be
flagged.)

`decompose(m, w, h)` returns `{ transform, sheared }`. When `sheared` is true the
caller must surface or preserve, never fabricate a rectangle.
`ungroupSelected` keeps the child anchored at its world origin and leaves its
existing rotation/scale rather than writing a wrong box.

**Known limitation:** ungrouping a non-uniformly scaled, rotated group is
lossy. It is reported, not hidden. Closing it requires a full affine node
transform, which is a later slice.

---

---

## Rule 3 — the frame clips the content

Image geometry comes from `src/document/image-fit.ts`. Same principle as Rule 1:
more than one renderer needs the answer, so exactly one module computes it.

**The frame and the content are two different rectangles.**

- `frame` = `[0, 0, transform.w, transform.h]` in local space. What the user
  drags, what snaps, what clips.
- `content` = where the picture is drawn, from `destWindow`. May be **larger**
  than the frame (`cover`) or **smaller** (`contain`).

**Every renderer MUST clip content to the frame.** Omitting it was defect #2: a
`cover` image drew at its full oversized rect and painted across neighbouring
layers, bounded only by the page edge. The PDF exporter had the same bug in a
different costume — it clipped, but to `dest`, which for `cover` is larger than
the frame, so the clip never bit. A renderer must clip to **frame ∩ dest**:
frame alone loses the crop window, dest alone loses the frame.

### Three modes, no duplicates

| Mode | Aspect | Result vs frame | Needs clipping |
|---|---|---|---|
| `cover` | preserved | ≥ frame on both axes | **yes** |
| `contain` | preserved | ≤ frame on both axes (letterbox) | no |
| `stretch` | **not** preserved | exactly the frame | no |

There is no fourth mode. `fill` existed and was byte-identical to `stretch` in
every renderer *and* was offered as a separate item in the options bar; it was
removed in document v3 and is migrated. `tests/image-fit.test.mjs` asserts the
three modes produce three distinct rectangles, so a redundant mode cannot
reappear unnoticed.

### Focal

`focal` moves the **content** within the frame and never changes the frame. It
is clamped to 0..1. It has no effect on `stretch`, which has no slack to move
within. Crop is a window on the **source**; re-framing changes `transform.w/h`.
These are three different operations on three different rectangles and must not
be conflated.

## Conformance

`tests/transform.test.mjs` (18 tests) covers the algebra, composition through
nested groups, inverse round-trip, shear detection and the migration invariant.

`tests/group-transform.spec.mjs` proves the canvas obeys Rule 1 by moving a
group and asserting the children's own transforms are **unchanged** while the
rendered pixels move.

`tests/group-parity.spec.mjs` proves the PDF exporter agrees with the canvas by
inspecting the content stream for the group's `cm` matrix.

`tests/image-fit.test.mjs` (12 tests) covers the fit geometry, focal clamping,
crop clamping and the no-duplicate-modes guarantee.

`tests/image-frame.spec.mjs` (16 checks) proves Rule 3 against rendered pixels
using a 1:2 asset in a 2:1 frame — `cover` scales it to 1200×2400 inside a
1200×600 frame, so 900px would hang off each edge — and confirms the PDF clips
to `0 0 1200 600` rather than the content rect.

A new renderer is not conformant until it has an equivalent parity test.
