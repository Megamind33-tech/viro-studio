# File format and migration

Status: **v5 in place; packaging not started.** Documents are currently plain
JSON (`.vdj` / `.json`). The atomic `.viro` package, autosave journal and crash
recovery described in foundation deliverable D are **not implemented** — see
"Not yet true" below.

## Versions

| Version | Meaning of `Layer.transform` | Hierarchy |
|---|---|---|
| 1 | **Absolute page coordinates** | `parentId` only, decorative |
| 2 | **Local to parent** (page when `parentId` is null) | `parentId` + composed transforms |
| 3 | unchanged from 2 | unchanged from 2 |
| 4 | unchanged from 2 | rich-text ranges, style registries and explicit text-frame semantics |
| 5 | unchanged from 2 | vector stroke styling (dash / cap / join) — a widening stamp |

`PressDocument.version` is `1 | 2 | 3 | 4 | 5` (`src/document/types.ts`).
`createDocument` stamps `DOC_VERSION` (5). `validateDocument` accepts all five
versions, requires the v4 text fields on current documents, and validates any
v5 stroke styling (even dash intervals, bounded length, valid cap/join enums).

v5 widens `VectorLayer.stroke` from `{ color, width }` to add optional
`dash?: number[]`, `dashPhase?`, `cap?: "butt"|"round"|"square"` and
`join?: "miter"|"round"|"bevel"`. It is a **widening version stamp**: a v4
stroke omits all four, which renders solid / butt / miter — pixel-identical to
v4 — so `migrateDocument` rewrites nothing and only reports
`MigrationReport.strokeStylesStamped`. `tests/transform.test.mjs` asserts the
stamp leaves existing strokes byte-identical and that a v5 dashed stroke
round-trips through save/open unchanged.

v3 changes `ImageFit`, not transforms: the mode `"fill"` was removed. It was
byte-identical to `"stretch"` in the compositor and the exporter alike, and the
options bar offered both as separate items. Migration rewrites it to
`"stretch"`, which is what it always rendered as, and the count is reported as
`MigrationReport.imageFitsNormalised`. Migration is staged: a v1 file gets the
transform rebase AND the fit normalisation in one pass.

v4 is an additive typography contract. It initializes sparse character and
paragraph ranges on every story, document-level character/paragraph style
registries, an explicit font-substitution map, and point/area/path container
metadata on type frames. Existing frames migrate as area text because that is
the behavior the pre-v4 compositor actually rendered. The migration does not
change visible text, geometry, shaping, or image-fit behavior.

## Why v2 exists

In v1 a group's transform was inert. `drawTree` composed a group's opacity and
blend but never its transform, so a group was a bounding-box record plus a
`parentId` link, and children drew at their own absolute coordinates regardless.
Moving a group changed the record and nothing on screen.

v2 makes the group's transform compose into its children. That is the fix, and
it is also why migration is mandatory rather than optional: the same bytes mean
different positions under the two renderers.

## v1 → v2 migration

Implemented in `src/document/migrate.ts`, applied in `PressApp.openBytes`.

For every layer with a parent, the parent's **original** origin is subtracted:

```
local = absolute(layer) − absolute(parent)
```

Every layer's original absolute origin is captured before anything is written,
so the result does not depend on visiting parents before children, and nested
groups need no ordering pass.

### The migration invariant

> A migrated document renders pixel-identically to the v1 document it came from.

Asserted twice: in `tests/transform.test.mjs` against the algebra, and in
`tests/group-parity.spec.mjs` against the running application, which loads a v1
fixture and checks that every child's composed world position equals the v1
absolute position it started with.

### What migration deliberately discards

A v1 group's `rotation`. It was never composed, therefore never visible.
Carrying it into v2 would rotate children the user never saw rotated. Discarding
it preserves the pixels, which is the invariant that matters.

It is **counted and reported**, not silent: `MigrationReport.groupRotationsDiscarded`
surfaces in the status line as
`Opened <name> — migrated v1→v2, N layer(s) rebased, M inert group rotation(s) dropped`.

### Corrupt links

A layer whose `parentId` names a missing layer is left at its absolute position
and reported in `MigrationReport.notes`. It stays visible and reviewable rather
than silently teleporting to the page origin.

### Idempotence

`migrateDocument` on a v2 document is a no-op and says so. This matters because
rebasing twice would move everything by the group origin a second time.
`tests/transform.test.mjs` asserts a second call leaves the document
byte-identical, and `tests/group-parity.spec.mjs` asserts a save/reopen
round-trip preserves every transform exactly.

## Not yet true

Stated explicitly so nothing here reads as a promise:

- No `.viro` package. No atomic write, no journal, no crash recovery, no recent documents.
- No schema validation beyond `validate()`'s field checks; no formal schema document.
- Assets are stored inline as data URLs keyed by id — **not** by content hash.
- Corrupt-file handling is `JSON.parse` throwing; there is no structured error report.
- Electron `openFile`/`saveFile` are exposed in `electron/preload.ts` and are
  called by the File-menu handlers in `src/chrome/desk.ts`. Structured recovery
  and atomic package writes are still not implemented.
