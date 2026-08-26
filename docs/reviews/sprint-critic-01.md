# Principal Critic Review — Sprint (autosave/recovery · Projects · flags · drop shadow)

Branch: `cursor/env-setup-and-desk-mount-fix-1726` vs base `main`.
Method: adversarial read of the diff (`git diff main...HEAD`) plus targeted probes against the
GOVERNOR.md §81 no-nonsense checklist and §82 hard-stop flags (no fake data, no decorative
control, no false success state, no dead/duplicated system, no regression to PROVEN_WORKING
flows, no unbacked capability). Unit tests `flags.test.mjs` + `effects.test.mjs` run green (8/8).

Verdict: **no P0**. The headline claims hold up — autosave/recovery round-trips, Projects
persist real page-rendered thumbnails, drop shadow genuinely renders and undoes, and the
`esc()` usage in `renderProjects` is correct (no XSS). But there are real P1/P2 issues: a
drop shadow silently does nothing on **group** layers (false-success control), the shadow
pre-pass reintroduces the exact full-page-offscreen heap pressure the compositor otherwise
works hard to avoid, and the new multi-project model has a same-project two-tab overwrite
window. Details below.

---

## Security probe — XSS in Projects (requested: CHECK esc() carefully)

**PASS — no injection.** `renderProjects` (`src/chrome/desk.ts:256-274`) escapes every
interpolated value: the project name in both the `title="Open …"` attribute and the
`.proj-name` text (`esc(p.name)`), the id in `data-proj*` attributes (`esc(p.id)`), the
timestamp (`esc(when)`), and the thumbnail `src` (`esc(p.thumbnail)`, only when truthy).
`esc()` (`desk.ts:1915`) encodes `& < > " '`, which covers both the attribute and text
contexts used here. The rename current-value read uses `.textContent` (`desk.ts:300`), which
decodes rather than injects. The rest of the innerHTML sinks (library assets, layers, pages,
fonts, swatches) are likewise escaped. A malicious project/asset **name** loaded from an
imported `.press.json`/`.vdj` is therefore inert at render time. No change required; keep the
`effects`/name round-trip covered so a future refactor cannot drop `esc()`.

---

## P1 — findings

### P1-1  Drop shadow is a decorative control on GROUP layers (false success state · §79/§80)
`drawTree` routes **leaf** layers through `drawLayerWithEffects` (`compositor.ts:1536`) but the
**group** branch (`compositor.ts:1518-1535`) renders children directly and never consults
`dropShadowOf(group)`. Meanwhile the Effects panel binds to `selectedLayers(app.doc)[0]` with
**no kind guard** (`desk.ts:197-229`): a selected group can have Drop Shadow toggled on, the
effect is stored on the group, `render()` shows the checkbox lit and the fields enabled
(`desk.ts:1530-1539`), yet nothing draws on canvas **or** export. That is exactly the
"visible control that does not do what it claims" the constitution forbids.
- Evidence: `compositor.ts:1518-1536` (group branch skips effects); `desk.ts:197-229`,
  `desk.ts:1530-1541` (panel enables the control for any selected layer).
- Fix (pick one): (a) render group effects — wrap the group's `saveLayer` result through the
  drop-shadow filter in the group branch of `drawTree`/`drawThumbTree`; or (b) if group
  effects are out of scope this sprint, gate the panel so the Drop Shadow control is
  `disabled` (with an honest hint) whenever the selected layer is a `group`. Do not leave it
  toggle-able while inert.

---

## P2 — findings

### P2-1  Shadow pre-pass allocates a page-sized offscreen per shadowed layer, per composite (perf/stability)
`drawLayerWithEffects` does `sk.saveLayer(paint)` with `paint.setImageFilter(MakeDropShadowOnly(...))`
and no explicit bounds (`compositor.ts:1547-1559`). Under the page clip set in
`compositePage` (`compositor.ts:1492`), that `saveLayer` is bounded by the whole page rect, so
each shadowed leaf forces a full-page offscreen (~2480×3508 RGBA ≈ 35 MB) plus a blur
convolution — the precise allocation the compositor's surface-reuse machinery exists to avoid
(`compositor.ts:379-392`, the `Aborted()`/heap comments). `compositePage` runs on every
`emit()` and, via `emitSoon`, every frame of a drag; a doc with several shadowed layers, or a
drag while a shadow is enabled, can reintroduce WASM-heap exhaustion on large pages. The
double draw (shadow pass + normal pass) is inherent to the technique and acceptable; the
unbounded offscreen size is the risk.
- Evidence: `compositor.ts:1545-1561`, `compositor.ts:1465-1499`.
- Fix: pass explicit bounds to the shadow layer (`saveLayerRec`/`saveLayer` with a rect =
  the layer's local box expanded by `blur*offset` spread) so the offscreen is layer-sized, not
  page-sized; consider caching the shadow image while only pan/zoom change.

### P2-2  Two tabs editing the SAME project silently overwrite each other (data-loss window)
The new multi-project store is a last-write-wins upsert keyed by id
(`store.ts:174-176`, `app.ts:337-357`). The single recovery slot clobber is documented and
accepted for single-window use, but the **Projects** feature makes it realistic to open the
same project (`openProject` sets `currentProjectId = record.id`, `app.ts:382`) in two tabs;
both then autosave to the same `documents` row and the slower tab's edits vanish with no
warning. This is new surface the "single-window" caveat in GOVERNOR Active Risks does not
cover.
- Evidence: `app.ts:337-357`, `app.ts:371-397`; `store.ts:174-176`.
- Fix: stamp each save with a monotonic `updatedAt`/revision and refuse (or prompt) on a
  detected out-of-band change; or take a Web Lock / `BroadcastChannel` advisory lock per
  project id. At minimum, document the limitation next to the existing recovery-slot caveat.

### P2-3  Every autosave tick deep-serializes the whole document twice (main-thread jank)
`autosaveTick` (`app.ts:267-270`) calls `writeRecovery` **and** `persistCurrentProject`, each of
which does `JSON.parse(JSON.stringify(this.doc))` over the entire document including embedded
image data-URLs in `assets` (`app.ts:283`, `app.ts:347`). For a large embedded-image doc that
is two full base64 deep-clones on the interaction-adjacent debounce callback. It degrades
honestly on IndexedDB quota (both writes are wrapped and fall back to in-memory —
`app.ts:287-296`, `app.ts:352-356`, matching the GOVERNOR risk note), so this is performance,
not correctness.
- Evidence: `app.ts:267-296`, `app.ts:337-357`.
- Fix: serialize once and share the plain snapshot between the recovery and project writes;
  longer term store binary assets out-of-line (already the P2-cloud plan in ADR 0004).

---

## P3 — findings (correctness/UX papercuts, not blocking)

- **P3-1 Panel-thumbnail parity gap.** Layer/Page/Navigator thumbnails call `drawLayer`
  directly (`compositor.ts:1881`, `compositor.ts:1975`), so they omit drop shadows, while the
  canvas, PNG/PDF export (`snapshotPagePng` → `compositePage`) and the Projects/dashboard
  thumbnail (`thumbnailDataUrl` → `compositePage`) include them. Export parity is fine; the
  small panels just under-represent the layer. Route panel thumbs through
  `drawLayerWithEffects` (with bounded offscreen per P2-1) if parity matters.
- **P3-2 Recovery restore loses project identity.** `restoreRecovery` (`app.ts:452-468`)
  commits the doc but never sets `currentProjectId`; the recovery snapshot carries no project
  id. Editing after a restore creates a **new** project rather than updating the one the work
  came from, duplicating it. Consider persisting the source project id in the snapshot.
- **P3-3 Deleting the open project then editing re-creates it under a new id.**
  `deleteProject` nulls `currentProjectId` (`app.ts:428-434`); the working doc stays on screen,
  and the next autosave mints a fresh `uid("proj")`. Not data loss, but surprising.
- **P3-4 No length cap on project names.** `renameProject` rejects empty/whitespace
  (`app.ts:411-413`) and the prompt guards empty (`desk.ts:302`), but a pathologically long
  name is stored and rendered (escaped). Add a sane cap.
- **P3-5 Drop-shadow edits are one undo entry per field.** Each field `change` calls
  `setDropShadow` → `commit` (`desk.ts:213-229`, `app.ts:1222-1224`), a full-doc snapshot per
  field, uncoalesced. Undo correctness is fine (proven by `effects.spec.mjs`), but a single
  shadow adjustment can leave 5 history steps. Consider a coalesce key for shadow tweaks.
- **P3-6 Two-tab IndexedDB v4 upgrade is unhandled.** `openDB(...,4,...)` (`store.ts:81`) has
  no `blocked`/`blocking` handler; a stale tab holding v3 open can stall the new tab's DB
  promise, silently disabling autosave/projects until the old tab closes. Add a `blocked`
  callback.

---

## Flags probe (requested: can platform.cloud/billing appear enabled without backing?)

**No fake capability surfaced.** `platform.cloud`/`platform.billing` default off
(`flags.ts:19-23`) and, even if forced true via `localStorage`/env, nothing consumes them:
`projects()` is always the `LocalProjectProvider` and explicitly ignores the flag
(`projects.ts:53-59`, `void flag`), and autosave only reads `platform.enabled`
(`app.ts:269`). No cloud/billing UI, label, or state is derived from those flags, so a stray
override cannot present an unbacked cloud/billing surface. The resolution order in code
(overrides → localStorage → env → defaults, `flags.ts:59-66`) matches the documented "last
wins" intent. Minor: `ProjectProvider.kind` and the `proj-scope` copy ("Stored on this
device", hardcoded in `index.html`) are honest but the `kind` field is currently unused (dead
until the Supabase provider lands) — acceptable as a declared seam.

## Regression check on PROVEN_WORKING flows

- `#file-font` → `#file-fonts` rename plus new `#file-assets` input line up with the desk
  handlers (`desk.ts:359-363`, `931-940`); the previously-fixed desk-mount id mismatch stays
  fixed. OK.
- **Behavior change, not a regression:** `Ctrl+O` now opens the Projects dialog and `Ctrl+S`
  now "Save to Projects" (`desk.ts:1382-1389`); "Open File…" loses its former shortcut. Menu
  entries exist for both, so nothing is stranded, but the shortcut remap is a UX shift worth a
  release note. "Place…" and the new "Import Assets…" overlap (both `ingestFiles`) — mild
  duplication, not harmful.
- Command-bus, migration (`openBytes` now accepts v1–v4, `app.ts:1454`), and effect
  serialization are additive; the drop-shadow op is immutable and JSON-round-trips
  (`effects.test.mjs` 5/5).

## Evidence
- `node --test tests/flags.test.mjs tests/effects.test.mjs` → 8/8 pass.
- `effects.spec.mjs` asserts the shadow changes rendered pixels and undo clears it — but only
  on a **top-level vector**; it does not cover the group case (P1-1) or panel-thumbnail parity
  (P3-1), so those gaps are untested as well as unimplemented.
