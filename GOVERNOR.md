# GOVERNOR.md — VIRO Press Product Constitution

> This is the single authoritative direction file. Only the Governor edits it.
> It is an enforceable engineering contract, not an inspirational document.
> When reality and appearance conflict, reality wins.

Last updated: 2026-08-27 · Boolean packet reconciliation · Branch: `governor/reconcile-boolean-packets`

---

## Product Mission

VIRO Press is a **professional, single-user, local-first design editor** for print/screen
layout, built on real engines — Skia/CanvasKit (compositor), HarfBuzz (text shaping),
LittleCMS (color) — running in the browser and in an Electron desktop shell. It is
explicitly **not** a hosted multi-tenant SaaS today: there is no server, account system,
database, billing, or cloud in the repository.

The mission is to make that editor genuinely excellent and trustworthy: create/open a
document, do real design work with real tools, never lose work, import/export accurately,
and trust that every visible control does what it claims.

Any expansion into a hosted platform (accounts, cloud storage, collaboration, billing,
admin, template marketplace) is a **major architecture decision requiring owner input**
(hosting, payment provider, legal/PCI scope, data residency, budget) and MUST enter via an
Architecture RFC (§34). It will not be fabricated to match aspirational screenshots.

## Current Product State (evidence-based)

Repository: `github.com/Megamind33-tech/viro-studio` · `package.json` name `viro-press` ·
~21k lines of TypeScript under `src/`. Stack: Vite 8, TypeScript 7, `vite-plugin-electron`,
CanvasKit-wasm, harfbuzzjs, lcms-wasm, onnxruntime-web, idb. No hosted production backend;
network calls in product code remain asset/font/model loads rather than fabricated SaaS state.

Two product screenshots were supplied depicting a hosted suite named "PRESS" with a
120,000-template library, stock photo/icon/illustration panels, AI "Quick Actions"
(Remove Background, Improve Lighting, Enhance Details, Magic Resize, Generate Similar),
Share/Export cloud actions, and a "Bebas Neue" type menu. Those surfaces remain aspirational
unless explicitly classified as implemented below; they must never be faked to match screenshots.

What genuinely exists and works (traced + test-verified):

- Skia compositor rendering, HarfBuzz shaping, LittleCMS sRGB→Lab — smoke-proven (`tests/engines.mjs`).
- Versioned document model (`v1..v6`) with real migrations (`src/document/migrate.ts`).
- Command bus with typed commands, inverses, coalescing, undo/redo (`src/document/command-bus.ts`; current gap audit reported 316/316 unit tests green).
- Editor tools wired 1:1 to handlers: visible controls in `index.html` have real handlers — no dead menu items are acceptable.
- Real background removal via ONNX U²-Netp (`src/engine/cutout.ts`) — genuine tensor inference, gated on model availability.
- Real font registry: bundled Noto faces + user-uploaded fonts (IndexedDB) + optional Electron system fonts, with truthful source states (`src/engine/font-registry.ts`).
- Persistence: documents as `.press.json` files; user assets/fonts in IndexedDB (`src/library/store.ts`).
- Import: PSD, VDJ, Press JSON. Export: PNG, PDF (with a real vector/raster report), tested generally.
- Procedurally generated marks/stock + preset/template documents (`src/library/catalog.ts`, `src/document/presets.ts`) — honestly limited rather than represented as a marketplace.
- The "Anchor" API: a structured, previewable, auditable document-mutation op interface (`window.viroAnchor`) routed through the command bus — real, not an AI badge.
- **Pathfinder Boolean Phase 0 + destructive Phase A are already delivered:** document-v6 multi-contour vectors, v5→v6 widening, compound EvenOdd rendering, contour validation, Union/Subtract/Intersect/Exclude kernel, reversible `vector.boolean`, undo/redo, save/reopen, and real Pathfinder controls. Commits `84936c2` and `9a22f8e` are ancestors of main.

Fixed during Sprint 0:

- **P0** desk-mount abort (`index.html` `#file-font`→`#file-fonts` + missing `#file-assets`) that silently killed all menu/dialog/studio wiring.
- **P0** reopening a current-version document dropped layers because the open guard lagged the schema version.
- **P0 (new capability)** autosave + crash recovery to IndexedDB (was absent; a reload lost all work). Tested end-to-end (`tests/recovery.spec.mjs`).
- Test portability (hardcoded local paths) and headless flakiness improvements.

## Non-Negotiable Rules (from the mandate; binding)

1. Reality over appearance. A feature is real only when the full path works and is tested (§1, §40, §77).
2. No fake data, fake fonts, decorative controls, fake thumbnails, or false success states (§12, §51–66, §79, §80).
3. No unsupported capability claims (no export format we cannot produce; no AI without a real model/service).
4. No scope/architecture/visual/terminology drift without an approved RFC (§68–76).
5. Preserve working software; smallest safe change; regression tests before touching `PROVEN_WORKING` (§11, §78).
6. A smaller truthful product beats a larger fake one (§45).
7. Fixtures live only under `tests/`/`fixtures/` and never leak into production (§53).
8. When a gap audit proves a packet's before-state is stale, reconcile the packet instead of deploying a Builder merely to preserve an obsolete sequence.
9. Historical reconciliation is `RECONCILED`, not retroactive `DONE`: do not fabricate Builder/Verifier/Critic PASS verdicts for work that predates packet activation.

## Architecture Direction

Keep the layered editor architecture already present and sound:
`document model (serializable, versioned) → command bus (reversible) → compositor (render) →
chrome (DOM UI)`. Persistence is decoupled (files + IndexedDB). Do not couple rendering to
persistence. Do not introduce a second state store, rendering engine, or icon library
without an ADR. Electron features degrade gracefully in the web build (feature-detected via
`window.viroPress`).

`VectorLayer.contours` is authoritative for compound/multi-contour vectors when present. Legacy
`nodes`/`closed` remains the one-contour compatibility representation. Renderers/exporters must
consume the same topology rather than invent a second geometry model.

## Approved Technology Decisions

Editor (unchanged): Vite 8 · TypeScript 7 · CanvasKit-wasm · harfbuzzjs · lcms-wasm ·
onnxruntime-web · idb · Electron 43 · Playwright + node:test. No new foundational dependency
without an ADR (§71). Node ≥ 20.

Hosted platform (approved 2026-08-26 via **ADR 0004**, phased + flag-gated):
- Frontend host: **Cloudflare Pages** (static SPA, free, African edge).
- Auth / DB / Storage / server functions: **Supabase** (Postgres + RLS + Auth + Storage +
  Edge Functions), region **`eu-west-2` (London)** — closest selected strong-protection region.
- Payments: **Lenco Pay** (Collections + signed webhooks; Virtual Accounts optional),
  server-side only. Subscription/entitlement state machine is **owned by our backend** because
  Lenco exposes discrete collections/transfers, not a native recurring primitive.
- Card data never touches our systems; provider-hosted/tokenized collection only.
- Budget starts on free tiers; paid scaling steps require explicit operational evidence. See ADR 0004.

## Feature Truth Ledger

| Feature | Classification | Evidence |
| --- | --- | --- |
| Skia compositor / HarfBuzz / LittleCMS | PROVEN_WORKING | `tests/engines.mjs`, editor renders |
| Document model + migrations (v1..v6) | PROVEN_WORKING | `tests/*`, `migrate.ts`, v5→v6 migration invariant |
| Command bus + undo/redo | PROVEN_WORKING | command-bus/UI-command tests; gap audit reported unit 316/316 |
| Editor tools (move/marquee/crop/pen/shape/text/hand/zoom/eyedropper/…) | PROVEN_WORKING | real handler map; chrome E2E |
| New / Open / Place / Save (.press.json) | PROVEN_WORKING | chrome + slice E2E |
| Import PSD/VDJ/PressJSON | WORKING_WITH_DEFECTS→PROVEN | reopen bug fixed; hardening remains backlog |
| Export PNG / PDF | PROVEN_WORKING WITH KNOWN P1 DEFECT | real exporter/report; VIRO-0005 tracks compound-path vector PDF fidelity |
| Compound multi-contour PDF vector export | PARTIAL / P1 | `src/export/pdf.ts::emitVector` walks legacy `layer.nodes`/`layer.closed`, not authoritative `layer.contours` |
| Background removal (U²-Netp) | PROVEN_WORKING (gated) | `cutout.ts`, availability-gated UI |
| Font registry (bundled/user/system) | PROVEN_WORKING | `font-registry.ts`, slice E2E |
| Autosave + crash recovery | PROVEN_WORKING (new) | `tests/recovery.spec.mjs` 13/13 + demo video |
| Feature flags (platform.enabled/cloud/billing) | PROVEN_WORKING (new) | `tests/flags.test.mjs` 3/3 |
| Local Projects library (dashboard: save/list/open/rename/delete) | PROVEN_WORKING (new) | `tests/projects.spec.mjs` 11/11 + demo video |
| Project thumbnails (rendered from real page) | PROVEN_WORKING (new) | `compositor.thumbnailDataUrl`; projects E2E asserts real PNG |
| Anchor op API (preview/apply/audit) | PROVEN_WORKING | `tests/anchor-bus.spec.mjs` |
| Layer effects: stroke/outline + outer glow (leaf + group) | PROVEN_WORKING (new) | `tests/effects.*` pixel-diff + undo, `tests/effects.test.mjs` |
| Vector stroke styling: dash / cap / join (doc v5) | PROVEN_WORKING (new) | `tests/stroke-style.*` pixel-diff + v5 round-trip, migration invariant in `tests/transform.test.mjs` |
| Multi-select transform & smart guides | PROVEN_WORKING (new) | RFC-6; pure math in `src/document/multi-transform.ts`; unit + E2E |
| Multi-contour vector model / v5→v6 widening | PROVEN_WORKING | commit `84936c2`; types/migration/factory/compositor + tests |
| Pathfinder Boolean kernel: Unite/Minus Front/Intersect/Exclude | PROVEN_WORKING | `src/document/boolean-ops.ts`, Boolean unit tests |
| Reversible `vector.boolean` command + undo/redo | PROVEN_WORKING | `src/document/ui-commands.ts`, command tests |
| Pathfinder UI controls | PROVEN_WORKING | `index.html` real controls + Boolean runtime E2E |
| Frontend hosting (Cloudflare Pages config) | PROVEN_WORKING (config; deploy owner-gated) | build emits `dist`, boots under CSP, `docs/deploy/cloudflare-pages.md` |
| Templates/presets + procedural marks | PARTIALLY_IMPLEMENTED | real generators; catalog breadth limited |
| Accounts / auth / sessions | ABSENT | no production backend |
| Cloud storage / sync / multi-device | ABSENT | no production sync |
| Collaboration / comments / presence / versions | ABSENT | no code |
| Client portal | ABSENT | no code |
| Admin platform | ABSENT | no code |
| Billing / subscriptions / entitlements | ABSENT | no production entitlement backend |
| Template marketplace ("120k templates"), stock photos/icons | ABSENT | no provider/catalog implementation |
| AI beyond background removal | ABSENT | no approved real model/service implementation |
| Notifications / sharing / integrations | ABSENT | no code |

No `DECORATIVE_ONLY` controls are acceptable in the shipping editor UI. If a control appears ahead
of capability, that is a defect, not roadmap progress.

## Production Scope (what the product IS, today)

A local design editor: documents, pages/artboards, layers, vector + basic raster tooling,
typography, color, effects, background removal, import/export, local asset/font library,
autosave/recovery, plus destructive Pathfinder Boolean operations. This is the surface we harden.
SaaS surfaces remain out of scope until real prerequisites exist.

## Quality Gates

- `npm test` (engines + unit + chrome E2E + slice suites) must pass for release candidates.
- `npm run build` (web + Electron) must succeed.
- `npx tsc --noEmit` clean. No TS suppressions as fixes; no disabled tests to pass CI.
- New UI → manual/visual evidence. New logic → automated test. Touching `PROVEN_WORKING` → regression test first.
- Export-fidelity changes require artifact-level proof, not merely successful serialization.
- Governor scoring ≥ 34/40, no category < 3; data-integrity/editor-core ≥ 4 (§4).

## UX Rules

Photoshop-class dark desk (tokens: panels `#2B2B2B`/`#323232`, pasteboard `#1F1F1F`,
accent copper `#E07A2F` only on active tool/selection, Segoe UI, radius 0–2px). Prioritise
workspace density in the editor; honest empty states over fake content; every tool has a
distinct semantic icon, name, and shortcut. No demo-style descriptive prose in production UI.

## Security Rules

Today's threat surface is a client-side app: sanitize imported/parsed files (PSD/VDJ/JSON/
fonts/images) defensively; never `eval`; keep secrets out of the bundle.
Platform work (ADR 0004) adopts OWASP ASVS 5.0 L2 baseline: server-side authorization for every
privileged op (Supabase RLS + Edge Functions), tenant scoping (`org_id`) on every tenant query,
Lenco webhooks verified, idempotent and replay-safe, entitlement derived only from provider-confirmed
state. Provider secrets remain server-side. None of these may be stubbed as "done".

## Performance Budgets

Editor pointer feedback immediate; move/resize local (no network — trivially satisfied);
60 FPS target for common canvas interactions on target hardware; avoid full-document
re-render for localized edits (compositor already coalesces repaints per frame). Autosave is
debounced and off the interaction path.

## Current Sprint — Sprint 0 done; Boolean queue reconciled; VIRO-0005 is current P1

Objectives already met: forensic audit; GOVERNOR.md + terminology lock; environment productionized;
P0 desk-mount and doc-reopen fixes; autosave/recovery; ADR 0004 platform architecture accepted;
P1 local foundation (feature flags + local project store + PlatformClient seam) and P2 local shell/
dashboard (multi-project persistence, Projects dialog, real page-rendered thumbnails).

Editor feature RFCs (`docs/research/0001-next-editor-features.md`): RFC-1/2/3/4/6 are delivered and
test-verified. **RFC-5 Phase 0 and destructive Phase A are also delivered and test-proven**: the
2026-08-27 VIRO-0002 gap audit established that commits `84936c2` and `9a22f8e` landed before the
orchestration packet was activated. **Phase B live/non-destructive booleans remains DEFERRED**.

Governor reconciliation:
- VIRO-0002 → `RECONCILED` (historical target already landed; no Builder cycle).
- VIRO-0003 Boolean kernel → `PROVEN`.
- VIRO-0004 command-bus/undo-redo integration → `PROVEN`.
- VIRO-0006 Pathfinder UI → `PROVEN`.
- existing Boolean runtime acceptance → `PROVEN`.
- **VIRO-0005 → READY / P1:** preserve authoritative compound contours in vector PDF export.

Next after VIRO-0005: evidence-ranked local hardening, while cloud Auth/RLS/sync and Lenco work
remain gated on owner provisioning per ADR 0004.

## Active Risks

- **Compound-path PDF fidelity (P1):** canvas renders authoritative `VectorLayer.contours`, while
  `src/export/pdf.ts::emitVector` currently walks only legacy `layer.nodes`/`layer.closed`. Boolean
  holes/disjoint pieces can therefore be correct on canvas yet export incorrectly in vector PDF.
  Mitigation: VIRO-0005; exporter-only scope + targeted PDF artifact proof.
- **Appearance/reality gap (HIGH):** supplied screenshots imply a SaaS that does not exist.
  Mitigation: truth ledger; platform remains phased + flag-gated, not faked.
- **Data residency / privacy (HIGH, legal):** hosted PII deployment requires owner/legal completion
  of applicable data-transfer/privacy obligations. Engineering will not flag compliance "done" without evidence.
- **Subscription-on-collections (MED):** do not present "auto-renew" unless provider capability is confirmed.
- Autosave stores full-document snapshots (incl. embedded image dataURLs) in IndexedDB — large
documents could hit quota. Mitigation: failures degrade truthfully; future cloud storage should not
store large binary assets inline in JSONB.
- Single recovery slot (no per-document identity) — acceptable for current local use, but tracked.

## Blockers

Direction is decided (ADR 0004): Cloudflare Pages + Supabase + Lenco Pay. Remaining hosted blockers
are **provisioning + legal**, not direction. Backend/payment code will not run end-to-end (and will
not be merged as "working") until required accounts/config/secrets exist.

- Secrets/config for Supabase real Auth/RLS/storage work.
- Lenco server credential + webhook registration for payment/entitlement work.
- Cloudflare frontend hosting config is repo-side; owner-authenticated go-live remains external.
- Legal/privacy execution appropriate to the selected providers/regions.
- Open provider question: whether true recurring/tokenized renewal is supported on the actual account.

## Research Decisions

- ACCEPTED: autosave/crash-recovery (data-loss P0) — implemented.
- ACCEPTED (phased, flag-gated — ADR 0004): hosted platform on Cloudflare Pages + Supabase + Lenco Pay. Build order P1 foundation → P2 cloud documents → P3 entitlements/Lenco → P4 collaboration/admin/client portal; external provisioning still gates hosted execution.
- **ACCEPTED + DELIVERED (ADR 0005 Phase 0 + destructive Phase A):** Boolean path operations on the multi-contour subpath model, carried by v5→v6 widening, with migration invariant, multi-contour render, real destructive operations and Pathfinder controls. The 2026-08-27 gap audit reconciled the stale queue to repository truth. **Phase B live/non-destructive booleans remains DEFERRED to a later ADR.**
- DEFERRED (needs RFC + owner): expanded curated template families (§57) with a real thumbnail-render pipeline (§61); OpenType/variable-font UI.
- REJECTED: fabricating template counts, fonts, AI actions, or SaaS dashboards to match screenshots.

## Release Gates

Release target: P0 = 0, P1 = 0 · all quality gates green · no unresolved hard-stop flag (§82) ·
editor persistence loop (create→edit→save→reload→recover→export) passes repeatedly ·
accessibility pass on core editor journeys · security review of file parsers. Platform surfaces are
gated behind their own RFC + tests and are not required for a truthful editor release.

**Current state is not P1=0 because VIRO-0005 is open.** For orchestrated work, `DONE` additionally
requires independent gates, release-manager approval of the exact candidate SHA, required GitHub
checks, a real merge into `main`, and the Orchestrator recording the merge SHA. `RECONCILED` is
reserved for historical targets that demonstrably landed before packet activation.

## Violations

- 2026-08-26 — `DECORATIVE_FUNCTION_VIOLATION` (P1), found by the Principal Critic pod
  (`docs/reviews/sprint-critic-01.md`): the Drop Shadow toggle was enabled for group layers but
  the group render path ignored effects, so it stored + showed lit yet rendered nothing.
  **RESOLVED** same day: groups now render effects via a shared `withDropShadow` wrapper; covered
  by an E2E pixel-diff on a grouped selection. XSS probe on project names: PASS (`esc()` covers
  `renderProjects`).

## Open review findings (from `docs/reviews/sprint-critic-01.md`) — backlog

- P2: shadow `saveLayer` is unbounded → up to a full-page offscreen + blur per shadowed layer per
  composite; bound to the layer box + spread (perf on large/many-layer docs).
- P2: two tabs on the same project last-write-wins; add a revision guard / advisory lock.
- P2: autosave deep-clones the whole doc (embedded images) twice per tick; move to a worker or
  diff. P3 papercuts: recovery-restore loses project identity; deleting the open project re-creates
  it on next edit; no project name-length cap; per-field shadow undo entries; panel-thumb shadow
  parity. Tracked for the next hardening pass; none are P0/P1 except the separately recorded
  VIRO-0005 export-fidelity defect.

## Decision Log

- 2026-08-27 — **Governor reconciled stale Boolean orchestration after VIRO-0002 gap audit.** Main already contains commit `84936c2` (document-v6 multi-contour model/migration/render/validation) and `9a22f8e` (destructive Pathfinder booleans + real UI), both predating packet activation. Audit evidence reported `npx tsc --noEmit` exit 0, unit 316/316, build exit 0, engines PASS and Boolean runtime E2E 17/17; the auditor explicitly did not claim the unrun Chrome/slice suites. Governor decision: do not deploy a Builder to VIRO-0002; classify VIRO-0002 `RECONCILED`, VIRO-0003/0004/0006 and existing runtime Boolean acceptance `PROVEN`, and activate VIRO-0005 for the distinct remaining defect: `src/export/pdf.ts::emitVector` does not consume authoritative `VectorLayer.contours`. Historical Builder/Verifier PASS is not fabricated. Owner: Governor.
- 2026-08-26 — **Ratified ADR 0005 (boolean path operations)** (`docs/adr/0005-boolean-path-operations.md`).
  Governor decision at ratification: **EXPERIMENT → ACCEPT the multi-contour subpath model; DEFER live/non-destructive booleans**. ACCEPT the compound-path *subpath* representation (optional `contours[]` with the legacy single `nodes`/`closed` preserved as the one-contour case) as the committed evolution of `VectorLayer`. The ratification required a v5→v6 widening migration under the four-point serialization contract and a Phase-0 pixel-identical-reopen proof before destructive Phase A. **Current status supersedes the then-future wording: Phase 0 + destructive Phase A have since landed and are proven; Phase B remains deferred.**
- 2026-08-26 — Delivered RFC-6 **multi-select transform & smart guides**
  (`docs/research/0001-next-editor-features.md`; commits `3d4cbce`, `c3fdbcd`, `b3fa75c`). Group
  move/scale/rotate coalesce into **one** history step; smart guides with snapping render on the overlay
  pass; the transform hot path is allocation-free (pure math in `src/document/multi-transform.ts`). No
  schema change (transform-only, versionless); the existing single-selection drag stays `PROVEN_WORKING`
  (regression-preserved). Proven with units (`tests/multi-transform.test.mjs` 16/16) and pixel-diff E2E
  (`tests/multi-transform.spec.mjs` 11/11). Migration impact: none. Owner: engineering.
- 2026-08-26 — Implemented and validated the **Cloudflare Pages frontend hosting config** repo-side
  (commit `5f7b223`): `wrangler.jsonc`, `public/_headers`, `public/_redirects`,
  `docs/deploy/cloudflare-pages.md`, and a deploy script. Build emits a complete `dist/`; go-live remains
  an owner-authenticated external step. Migration impact: none. Owner: engineering (config); owner (deploy auth).
- 2026-08-26 — Delivered RFC-4 **dashed / styled vector strokes** (dash, cap, join) as document
  **v4→v5** (`docs/research/0001-next-editor-features.md`). Widened `VectorLayer.stroke` with optional
  dash/cap/join data under the serialization contract; migration invariant and stroke-style tests
  preserve existing output. Migration impact: v4→v5 widening stamp, no pixels move. Owner: engineering.
- 2026-08-26 — Delivered RFC-3 additive layer effects **Stroke/outline** and **Outer glow**
  (`docs/research/0001-next-editor-features.md`), reusing the effects list/composition seam with leaf +
  group coverage and pixel-diff/unit tests. Migration impact: none. Owner: engineering.
- 2026-08-26 — Governor established; forensic audit completed. Owner: Governor.
- 2026-08-26 — Ruled the supplied SaaS screenshots aspirational; absent surfaces classified ABSENT,
  not decorative, and explicitly out of scope until real architecture/dependencies exist.
- 2026-08-26 — Fixed P0 desk-mount and P0 doc-reopen defects; made slice tests portable; improved
  Playwright reliability. Migration impact: none (bug fixes).
- 2026-08-26 — Implemented autosave + crash recovery (IndexedDB, backward-compatible upgrade).
  Dirtiness is driven by command-bus revision so mutation paths are covered. Migration impact: additive.
- 2026-08-26 — **Platform direction decided** by owner and recorded in **ADR 0004**: Cloudflare
  Pages (frontend) + Supabase (auth/DB/storage/functions) + **Lenco Pay** (payments), phased and
  feature-gated. Remaining blockers are provisioning + legal, not direction.
- 2026-08-26 — Delivered ADR 0004 **P1/P2 local-first** while provisioning is pending: feature-flag
  system, local project library, `ProjectProvider` seam, and real page-rendered thumbnails. The cloud
  layer can later implement the same seam without replacing the local editor. Migration impact: additive.
