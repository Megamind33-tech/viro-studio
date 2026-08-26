# VIRO Press visual QA

**Pass/fail: PASS. 7/7 scenes drive, zero console errors, 21 layers built
through real Anchor ops, and the shape tools build real geometry under test.**

Date: 2026-08-25 (third pass). Workspace: `C:\viro studio`.
Harnesses: `tests/shots.mjs` (full frames), `tests/critic-shots.mjs` (2× crops),
`tests/tools-verify.mjs` (drives tools, asserts on the document graph).

> Supersedes the second-pass record. Several defects it listed as open are now
> fixed and verified; do not quote its "Known-open defects" table.

## What actually ran

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **Clean.** |
| `node tests/shots.mjs` | **7/7 scenes ok, `errors: []`, layerCount 21.** |
| `node tests/tools-verify.mjs` | **4/4 tool cases pass, `errors: []`.** |
| Zoom agreement (tab / Navigator / status) | 23.8% / 23.8% / 23.8% — agree. |

## Fixed since the second pass (verified by looking, not asserted)

1. **Native OS chrome is gone.** Every `<select>`, `<input type=range>` and
   `<input type=checkbox>` is now drawn by `src/chrome/controls.ts`. Blend mode
   opens a real custom popup; the RGB sliders carry live gradient tracks (drag G
   to 223 and the R track repaints green→yellow); the blue Navigator thumb is
   gone. Evidence: `tests/qa-shots/zoom/f-blend-open.png`, `i-color-dragged.png`.
2. **Page is centred**, **rulers are real** (hierarchical ticks, numeric labels,
   origin), and **content is clipped to the page** — the second pass listed all
   three as open. Evidence: `tests/qa-shots/30-content.png`.
3. **Type is legible at fit zoom.** The Anchor-composed cover sets a masthead,
   deck and two justified body columns that all read at 23.8%.
4. **Toolbox: 8 → 10 tools**, in three separator-delimited groups. Ellipse and
   Line are new and genuinely wired end to end.

## The `TOOLS` honesty gate

`src/chrome/desk.ts` holds `const TOOLS: ToolId[]`. A toolbox button whose
`data-tool` is not in that array is silently inert. **A tool belongs in that
array only once it is wired end to end in `PressApp`** — that is what stops a
button in the markup becoming theatre. Ellipse and Line were dead buttons until
they were added to it, and nothing on screen said so; only driving them did.

## Fixed engine defect: `Aborted()` under drag

A pointer-move drag called `emit()` synchronously per event, re-compositing the
whole 2480×3508 page and allocating a fresh Skia surface every time. The WASM
heap exhausted and CanvasKit aborted (`RuntimeError: Aborted()`), which could
also swallow the layer the drag was building — the likely cause of the
intermittent `layerCount: 0` seen in earlier runs.

Two fixes, both in place:
- `Compositor.requestOverlayRepaint()` — rAF-throttled, reuses the page
  composite. Correct for anything that moves without changing the document
  (shape preview, marquee, ruler rule).
- `PressApp.emitSoon()` — rAF-coalesced full repaint, now used by all four
  pointer-move paths that *do* mutate the document.

## Fixed in the fourth pass (after the adversarial critic review)

The critic's full report ranked 11 regions and returned **REJECT**. These are closed:

1. **The right dock sheared its own labels.** With five panels open, "Weight" and
   "Folio" were sliced in half by the next group's tab strip, and the Color
   panel lost its G row, B row and hex field entirely. Cause: `.group` had
   `min-height: 0` and no shrink guard, so groups crushed below their content
   while `.tabs` held its full 22px — and because children shrank instead of
   overflowing, `.studios { overflow }` never engaged. Groups now size to
   content (`flex: 0 0 auto`), clip their own overflow, and the dock scrolls.
2. **The Navigator was a painted lie.** `.nav-page` was a hardcoded `#d8d8d8`
   rectangle — provably identical with and without artwork. It now paints a
   real `pageThumb()` composite. Verified in `critic-shots/c40-content.png`:
   the rectangle on the page appears in the proxy, at the right position.
3. **Layer rows had no thumbnails.** Now a 32px cell rendering a real
   `layerThumb()`, on a light checkerboard, in 38px rows. The visibility toggle
   was the radio glyph `◉`; it is a drawn eye now.
4. **The status bar shipped build telemetry** — `TYPE_RGB_8→TYPE_Lab_16` and
   `not FOGRA-certified`, an application apologising for itself in its own
   chrome. It now reads `Doc: 33.2M/90.4M`, as Photoshop does.
5. **Dropdown arrows were stroked `⌄` chevrons** — a web tell. Solid 7×4
   triangles now, in both enabled and disabled states.

Note on thumbnails: `layerThumb`/`pageThumb` already existed in the compositor
and were **called from nowhere**. The engine capability was built and never
wired. A first attempt drew them on a *dark* checkerboard, which swallowed the
near-black type and hairline rules these thumbnails mostly hold and made every
row look empty; Photoshop's transparency checker is light for exactly this
reason.

## Known-open defects

Ranked, from the critic's report. Observed, not speculated.

| # | Defect | Owner |
|---|---|---|
| 1 | **Toolbox still ~57% dead rail, and no flyouts.** Rect/Ellipse/Line take three top-level slots where Photoshop has one slot with a flyout. Closing the void honestly means *implementing* more tools (`roundrect`, `polygon`, `eyedropper`, `rotate` are declared in `ToolId` and unbuilt) or docking the rail to its content — not drawing more icons. | chrome |
| 2 | **History rows are inert `<div>`s.** Only "New snapshot" is a button. A History panel whose purpose is clicking a row to scrub back, where rows do nothing, is theatre. | chrome |
| 3 | **Palette drift.** ~20 hardcoded greys sit alongside the tokens; `#232323` is the most-used colour in the stylesheet and is not one. `--raised` and `--pasteboard` are declared and **never used**. The app is built on a parallel ramp that resembles its own palette. | chrome |
| 4 | **Rulers are two-tier, not three.** No mid tick at 60% height, so the ruler reads as a repeating comb. | compositor |
| 5 | **Color panel geometry.** Gradient track is a ~3px hairline where a Color panel wants ~11px; the SV square and hue strip are not edge-aligned; the swatch wells are unbordered and vanish at near-black. | chrome |
| 6 | **Options bar** has no tool-preset picker, and renders five empty wells with nothing selected instead of reading as disabled. | chrome |
| 7 | Scrollbar styling is unverified: this headless Chromium uses overlay scrollbars, so `::-webkit-scrollbar` rules never render and no screenshot can prove them either way. | — |

## Harness reliability

Playwright's 30s navigation default is too tight when Vite has just
re-optimised dependencies or the machine is loaded; it produced spurious
"harness failed" results unrelated to the app. All three harnesses now pass
`timeout: 120000` to `page.goto`.

## Policy (unchanged, still binding)

- **Honesty over theatre.** Incomplete tools are hidden, never stubbed. A
  missing feature is acceptable; a fake one is not.
- **No Canva DNA.** No Inter, no `#5350FF`, no `Generate` / `Looks` / `Animate`.
- Tokens: panels `#2B2B2B` / `#323232`, pasteboard `#1F1F1F`, copper `#E07A2F`
  only on active tool and selection. Segoe UI. Radius 0–2px.
- Do not invent npm package names. See `VERSIONS.md`.

## Reproduce

The dev server already runs on 5173; do not start a second one.

```
npx tsc --noEmit
node tests/shots.mjs
node tests/tools-verify.mjs
node tests/critic-shots.mjs
```
