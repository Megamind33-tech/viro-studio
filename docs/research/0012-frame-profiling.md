# VIRO-0012 — 60-FPS interaction profiling: harness, baseline, bottleneck, fix

Packet: VIRO-0012 · Builder: `zcode-perf-pc2` (pc-cloud1) · Baseline commit: `14e2812`

## 1. Harness

`scripts/perf/` boots the **real editor** (vite web build of the worktree, Playwright
Chromium with SwiftShader — the same canvas path the CI suite exercises) and measures:

| Piece | File | What it does |
|---|---|---|
| Runner | `scripts/perf/run.mjs` | 13 scenarios: idle composite cost + live gestures (move, resize, pan, zoom) on 3 documents; writes `results/<label>.json` + a stdout table |
| Probe | `scripts/perf/lib/probe.js` | Injected into the live page; wraps the real `Compositor.draw` instance method to time every frame the app paints, records rAF deltas inside gesture windows, builds deterministic documents, and snapshots exact page pixels |
| Session | `scripts/perf/lib/session.mjs` | Browser launch (same flags as `playwright.config.ts`: SwiftShader, no proxy), fixed viewport 1440×900 dpr 1, fresh context per scenario |
| Server | `scripts/perf/lib/server.mjs` | Dev server on port 5174 (never collides with the Playwright suite on 5173) |
| Pixel proof | `scripts/perf/capture.mjs` | Builds the `shadow30` document, renders the page composite through the real shadow path, records exact SHA-256 of raw RGBA pixels (re-decoded from the PNG, not encoder-trusting) + a PNG for inspection |

Usage:

```bash
node scripts/perf/run.mjs --label baseline          # full 13-scenario run
node scripts/perf/run.mjs --label after --only idle/shadow30,g/shadow30/move
node scripts/perf/capture.mjs --name before          # pixel snapshot
node scripts/perf/capture.mjs --name after
node scripts/perf/capture.mjs compare before after   # exit 0 = pixel-identical
```

Determinism: scenario documents are built by pure arithmetic (no randomness) through the
app's own Anchor command path (`viroAnchor.applyDetailed` → `press.add_rect` ×30 →
`app.setDropShadow` ×30), one undo step, with intermediate repaints suppressed during setup
and exactly one composite at the end — the final document and composite are byte-identical
to the unsuppressed path. Gestures are real `page.mouse`/`page.mouse.wheel` input through
the app's own handlers (selection click → SE-handle drag for resize; hand tool for pan;
`wheel` events for the app's 1.08×/step zoom).

Documents:

- `starter` — the document the desk boots with.
- `plain30` — 30 vector rects in a 6-column grid (300×200 each, deterministic fills), no effects.
- `shadow30` — same geometry, each layer carrying the desk's default drop shadow
  (`offset 6,8 · blur 12 · opacity 0.45 · black`).

Note on absolute numbers: this machine renders through SwiftShader (software Skia). Absolute
ms are therefore ~10-100× a GPU target; the harness exists to compare runs **on the same
machine and browser build**, which is exactly how the baseline → fix comparison below is used.

## 2. Baseline (commit `14e2812`, before any production change)

Collected as one 13-scenario run (`results/baseline-run.log`); its final scenario
(`g/shadow30/zoom`) was killed by an external shell teardown and re-collected separately
(`results/baseline-zoom.json`) on the same commit, machine and browser. Idle = rAF-aligned
`Compositor.draw(doc)` samples after warm-up; gestures = real input, reporting per-frame
draw cost (`drawMs`) and rAF deltas (`frameMs`) inside the gesture window. All values ms.

### Idle composite cost

| scenario | doc | median | mean | p95 | max | n |
|---|---|---:|---:|---:|---:|---:|
| idle/starter | starter | 186.0 | 211.2 | 462.4 | 462.4 | 15 |
| idle/plain30 | plain30 | 165.8 | 159.4 | 189.5 | 189.5 | 15 |
| idle/shadow30 | shadow30 | **115 482.4** | 111 791.4 | 115 627.1 | 115 627.1 | 3 |

### Live gestures

| scenario | drawMs median | drawMs p95 | frameMs median | frameMs p95 | frameMs max | n draws / n frames |
|---|---:|---:|---:|---:|---:|---|
| g/starter/pan | 102.8 | 242.6 | 16.7 | 200.1 | 333.3 | 51 / 160 |
| g/starter/zoom | 122.9 | 248.7 | 50.0 | 249.9 | 266.7 | 13 / 40 |
| g/plain30/move | 76.3 | 164.7 | 16.7 | 133.4 | 333.2 | 51 / 155 |
| g/plain30/resize | 77.1 | 173.2 | 16.7 | 200.0 | 266.7 | 53 / 123 |
| g/plain30/pan | 70.0 | 130.0 | 16.7 | 116.7 | 199.9 | 51 / 219 |
| g/plain30/zoom | 140.8 | 185.3 | 33.3 | 249.9 | 283.3 | 13 / 50 |
| g/shadow30/move | 104 327.2 | 117 097.2 | 16.7 | 33.4 * | 117 211.9 | 11 / 369 |
| g/shadow30/resize | 90 166.4 | 131 007.9 | 16.7 | 83.4 * | 131 511.5 | 13 / 334 |
| g/shadow30/pan | 85 476.1 | 118 763.3 | 16.7 | 101 812.6 | 118 828.6 | 11 / 73 |
| g/shadow30/zoom | 91 683.7 | 95 562.8 | 16.7 | 92 546.3 | 95 679.5 | 4 / 38 |

\* For move/resize the rAF recorder keeps ticking through most of the window because each
~100 s draw blocks the main thread only after queued input is consumed; the tail is where
the stall lands (max ≈ 130 s). Median frame time is misleading there — the draw column is
the honest signal.

## 3. Bottleneck attribution

`plain30` and `shadow30` are geometrically identical; the only difference is 30 enabled
drop shadows. Idle composite cost: **165.8 ms → 115 482.4 ms (≈ 700×)**. The entire delta
is the shadow pre-pass:

`withDropShadow` (`src/engine/compositor.ts:1652`) calls `sk.saveLayer(paint)` with an
image filter and **no bounds**, so the layer covers the current clip — the whole page rect
set by `compositePage` (`compositor.ts:1591`). Per shadowed layer, per composite, that is a
full-page offscreen (A4 @150 dpi ≈ 2480×3508 RGBA ≈ 35 MB) **plus** a `MakeDropShadowOnly`
blur convolution over it. `compositePage` runs on every `emit()` and, via `emitSoon`, on
every frame of a drag — so a shadowed document is ~0.01 FPS during interaction on this
machine (frame budget 16.7 ms, measured 85 000-131 000 ms p95 draws). This is
`docs/reviews/sprint-critic-01.md` P2-1, now quantified.

Secondary observation (not in scope): even without shadows, a full-page composite costs
~165 ms under SwiftShader; the engine's cache/coalescing layers keep live gestures at
16.7-50 ms median frames, which is acceptable for the software path but confirms the
60-FPS conversation on GPU hardware is dominated by whether per-frame work is bounded —
which is precisely what the shadow fix below restores.

## 4. The one compositor change: bound the shadow saveLayer

**Change:** `withDropShadow` now passes explicit bounds to its `saveLayer` — the layer's
drawn extent (`layerBounds`, already used for thumbnails/hit-testing) expanded by the
spread that the shadow and any nested effects can push pixels: `3σ` of the shadow blur
(Skia's blur kernel is truncated at 3σ), `|offset|`, `1.5×` glow blur and the stroke-effect
dilation when those effects are enabled (they draw *inside* the shadow layer), half the
vector stroke width, and a 2 px anti-alias epsilon. If `layerBounds` cannot produce finite
bounds (empty group, non-finite transform) the code falls back to the old unbounded layer.
No other saveLayer path (group opacity, glow, stroke) is touched.

**Why pixel-identical:** Skia clips layer *content* to the saveLayer bounds; the image
filter's own outward growth (the shadow extending past the box) is applied when the layer
composites and does not depend on the clip. The bounds are strictly a superset of
everything the pre-pass can draw, so no content is newly clipped and every pixel's blur
neighbourhood is unchanged.

**Proof:** `capture.mjs compare before after` on the `shadow30` document — exact raw-RGBA
SHA-256 of the full page composite, before vs after — plus the full gate suite.

## 5. After-fix results (commit `5e06ef1`, same machine/browser, same harness settings)

Pixel proof (full page, `shadow30`, raw RGBA re-decoded from the composite):
`capture.mjs compare before after` → both `2480×3508`,
sha-256 `0fa979a3fc68810c0e8b8801690bf2281220d171023d9aa54546ba0622b4b44c` — **PIXEL-IDENTICAL**.

| scenario | drawMs median before → after | × | frameMs p95 before → after |
|---|---:|---:|---:|
| idle/shadow30 | 115 482.4 → **908.9** | **127×** | — |
| g/shadow30/move | 104 327.2 → 922.3 | 113× | 117 211.9 → 1 216.6 max |
| g/shadow30/resize | 90 166.4 → 972.5 | 93× | 131 511.5 → 2 416.6 max |
| g/shadow30/pan | 85 476.1 → 897.8 | 95× | 118 828.6 → 1 116.5 max |
| g/shadow30/zoom | 91 683.7 → 930.2 | 99× | 95 679.5 → 1 000.0 max |
| idle/plain30 | 165.8 → 163.8 | 1.0× (unchanged) | — |
| plain30 gestures | 70.0-140.8 → 61.5-125.9 | ~1× (within run noise) | no regression |

After fix, `shadow30` interaction frame p95 is 1.0-2.4 s vs 95-131 s before — the
difference between unusable and laggy-but-working under a software rasterizer. Remaining
headroom (each bounded blur still costs ~25 ms × 30 layers under SwiftShader; a
GPU/hardware target would be far cheaper) is real but out of scope for this packet's
one-change budget.

## 6. Verdict

**FIX SHIPPED** — the measured bottleneck (unbounded shadow `saveLayer`, sprint-critic-01
P2-1) was real, catastrophic (~700× idle-composite inflation, ~0.01 FPS interaction on a
30-layer shadowed document), and the minimal bound delivers 93-127× on the affected paths
with a bit-exact page composite (sha-256 equal before/after) and no regression on
non-shadow scenarios.

Gates at handoff: `npx tsc --noEmit` clean · `npm run test:unit` green · `npm run build`
green · repo effects pixel-diff E2E (`tests/effects.spec.mjs`) green on the changed
compositor. Production delta: `src/engine/compositor.ts` only (shadow `saveLayer` bounds +
`page` threading to `withEffects`/`withDropShadow`/`drawLayerWithEffects`).
