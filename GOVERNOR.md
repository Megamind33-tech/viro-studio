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
CanvasKit-wasm, harfbuzzjs, lcms-wasm, onnxruntime-web, idb. No backend, no network calls
to any production SaaS API (repository network use is limited to asset/font/model loads and
orchestration/release tooling).

Two product screenshots were supplied depicting a hosted suite named "PRESS" with a
120,000-template library, stock photo/icon/illustration panels, AI "Quick Actions"
(Remove Background, Improve Lighting, Enhance Details, Magic Resize, Generate Similar),
Share/Export cloud actions, and a "Bebas Neue" type menu. Those SaaS/content surfaces remain
aspirational unless separately recorded below as implemented. They must never be fabricated.

What genuinely exists and works (traced + test-verified):

- Skia compositor rendering, HarfBuzz shaping, LittleCMS sRGB→Lab — smoke-proven (`tests/engines.mjs`).
- Versioned document model **v1..v6** with real migrations (`src/document/migrate.ts`).
- Command bus with typed commands, derived inverses, coalescing, undo/redo (`src/document/command-bus.ts`, `src/document/ui-commands.ts`).
- Editor tools wired to real handlers; visible editor commands must remain non-decorative.
- Real background removal via ONNX U²-Netp (`src/engine/cutout.ts`) — genuine tensor inference, gated on model availability.
- Real font registry: bundled Noto faces + user-uploaded fonts (IndexedDB) + optional Electron system fonts, with truthful source states (`src/engine/font-registry.ts`).
- Persistence: documents as `.press.json` files; user assets/fonts in IndexedDB (`src/library/store.ts`).
- Import: PSD, VDJ, Press JSON. Export: PNG, PDF with a real vector/raster report.
- Procedurally generated marks/stock + preset/template documents (`src/library/catalog.ts`, `src/document/presets.ts`) — limited breadth, not a fabricated marketplace.
- The "Anchor" API: a structured, previewable, auditable document-mutation op interface (`window.viroAnchor`) routed through the command bus — real, not an AI badge.
- **Boolean/Pathfinder Phase 0 + destructive Phase A are already delivered:** document-v6 multi-contour vectors, compound-path rendering, validation, Union/Subtract/Intersect/Exclude kernel, reversible `vector.boolean` command, undo/redo, save/reopen, and real Pathfinder UI. Commits `84936c2` and `9a22f8e` are ancestors of main; gap audit on 2026-08-27 proved the target state rather than rebuilding it.

Fixed during Sprint 0:

- **P0** desk-mount abort (`index.html` `#file-font`→`#file-fonts` + missing `#file-assets`) that silently killed menu/dialog/studio wiring.
- **P0** reopening a current-version document dropped layers because the open guard lagged the schema version.
- **P0** autosave + crash recovery to IndexedDB (a reload previously lost work), covered end-to-end.
- Test portability and headless stability improvements.

## Non-Negotiable Rules (binding)

1. Reality over appearance. A feature is real only when the full path works and is tested.
2. No fake data, fake fonts, decorative controls, fake thumbnails, or false success states.
3. No unsupported capability claims (no export format we cannot produce; no AI without a real model/service).
4. No scope/architecture/visual/terminology drift without an approved RFC.
5. Preserve working software; smallest safe change; regression tests before touching `PROVEN_WORKING`.
6. A smaller truthful product beats a larger fake one.
7. Fixtures live only under `tests/`/`fixtures/` and never leak into production.
8. A stale work packet is reconciled from evidence; agents must not manufacture implementation work merely to preserve an obsolete sequence.
9. Historical reconciliation is `RECONCILED`, not retroactive `DONE`: do not fabricate Builder/Verifier/Critic PASS verdicts for work that predates the packet.

## Architecture Direction

Keep the layered editor architecture already present and sound:
`document model (serializable, versioned) → command bus (reversible) → compositor (render) → chrome (DOM UI)`.
Persistence is decoupled (files + IndexedDB). Do not couple rendering to persistence. Do not
introduce a second state store, rendering engine, or icon library without an ADR. Electron features
degrade gracefully in the web build (feature-detected via `window.viroPress`).

For multi-contour vectors, `VectorLayer.contours` is authoritative when present/non-empty; legacy
`nodes`/`closed` remains the one-contour representation. Every renderer/exporter that claims vector
fidelity must consume that same topology rather than invent a parallel geometry model.

## Approved Technology Decisions

Editor: Vite 8 · TypeScript 7 · CanvasKit-wasm · harfbuzzjs · lcms-wasm · onnxruntime-web · idb · Electron 43 · Playwright + node:test. No new foundational dependency without an ADR. Node ≥ 20.

Hosted platform (approved 2026-08-26 via **ADR 0004**, phased + flag-gated):
- Frontend host: **Cloudflare Pages**.
- Auth / DB / Storage / server functions: **Supabase**, region **`eu-west-2` (London)**.
- Payments: **Lenco Pay**, server-side only; subscription/entitlement state is owned by our backend.
- Card data never touches our systems; provider-hosted/tokenized collection only.
- Platform rollout remains gated by provisioning, security and legal truth; missing credentials may not be replaced with fake UI.

## Feature Truth Ledger

| Feature | Classification | Evidence |
| --- | --- | --- |
| Skia compositor / HarfBuzz / LittleCMS | PROVEN_WORKING | `tests/engines.mjs`, editor renders |
| Document model + migrations (v1..v6) | PROVEN_WORKING | `src/document/types.ts`, `migrate.ts`, migration/round-trip tests |
| Command bus + undo/redo | PROVEN_WORKING | command-bus + UI-command regression suite |
| Editor tools | PROVEN_WORKING | real handler wiring + E2E coverage |
| New / Open / Place / Save (.press.json) | PROVEN_WORKING | chrome + slice E2E |
| Import PSD/VDJ/PressJSON | PROVEN_WORKING with hardening backlog | import/reopen tests |
| Export PNG / PDF generally | PROVEN_WORKING WITH KNOWN P1 DEFECT | real exporter + report; VIRO-0005 tracks compound-path vector PDF fidelity |
| Compound multi-contour PDF vector export | PARTIAL / P1 | `src/export/pdf.ts::emitVector` still walks legacy `layer.nodes`/`layer.closed`, not authoritative `layer.contours` |
| Background removal (U²-Netp) | PROVEN_WORKING (gated) | `cutout.ts`, availability-gated UI |
| Font registry (bundled/user/system) | PROVEN_WORKING | `font-registry.ts`, slice E2E |
| Autosave + crash recovery | PROVEN_WORKING | recovery E2E |
| Feature flags (platform.enabled/cloud/billing) | PROVEN_WORKING | flags tests |
| Local Projects library (save/list/open/rename/delete) | PROVEN_WORKING | projects E2E |
| Project thumbnails rendered from real page | PROVEN_WORKING | compositor thumbnail path + projects E2E |
| Anchor op API (preview/apply/audit) | PROVEN_WORKING | anchor command/E2E tests |
| Layer effects: stroke/outline + outer glow | PROVEN_WORKING | pixel-diff + undo tests |
| Vector stroke styling: dash / cap / join (doc v5) | PROVEN_WORKING | stroke-style tests + migration invariant |
| Multi-select transform & smart guides | PROVEN_WORKING | unit + pixel-diff E2E |
| Multi-contour vector model / v5→v6 widening | PROVEN_WORKING | commit `84936c2`; `Contour`, `VectorLayer.contours`, migration, validation, canvas rendering tests |
| Pathfinder Boolean kernel (Union/Subtract/Intersect/Exclude) | PROVEN_WORKING | `src/document/boolean-ops.ts`, boolean unit tests |
| Reversible `vector.boolean` command + undo/redo | PROVEN_WORKING | `src/document/ui-commands.ts`, command tests |
| Pathfinder UI controls | PROVEN_WORKING | `index.html` Unite/Minus Front/Intersect/Exclude + runtime E2E |
| Frontend hosting config | PROVEN_WORKING (config; deploy owner-gated) | build/deploy config + runbook |
| Templates/presets + procedural marks | PARTIALLY_IMPLEMENTED | real generators; catalog breadth limited |
| Accounts / auth / sessions | ABSENT | no production backend |
| Cloud storage / sync / multi-device | ABSENT | provisioning/build pending |
| Collaboration / comments / presence / versions | ABSENT | no code |
| Client portal | ABSENT | no code |
| Admin platform | ABSENT | no code |
| Billing / subscriptions / entitlements | ABSENT | no production entitlement backend |
| Template marketplace / large stock catalog | ABSENT | no provider/catalog implementation |
| AI beyond background removal | ABSENT | no approved real model/service implementation |
| Notifications / sharing / integrations | ABSENT | no code |

No `DECORATIVE_ONLY` control is acceptable in the shipping editor. If a control is found ahead of capability, it is a defect, not roadmap progress.

## Production Scope (what the product IS, today)

A local design editor: documents, pages/artboards, layers, vector + basic raster tooling,
typography, color, effects, background removal, import/export, local asset/font library,
autosave/recovery, and destructive Pathfinder Boolean operations. This is the surface we harden.
SaaS surfaces remain gated until their real dependencies exist.

## Quality Gates

- `npm test` must pass for release candidates; a scoped audit may report narrower commands only if it explicitly says the full suite was not run.
- `npm run build` must succeed.
- `npx tsc --noEmit` clean. No TS suppressions as fixes; no disabled tests to pass CI.
- New UI → manual/visual evidence. New logic → automated test. Touching `PROVEN_WORKING` → regression test first.
- Export fidelity work requires artifact-level proof, not merely successful serialization.
- Governor scoring ≥ 34/40, no category < 3; data-integrity/editor-core ≥ 4.

## UX Rules

Photoshop-class dark desk (tokens: panels `#2B2B2B`/`#323232`, pasteboard `#1F1F1F`,
accent copper `#E07A2F` only on active tool/selection, Segoe UI, radius 0–2px). Prioritise
workspace density in the editor; honest empty states over fake content; every tool has a distinct
semantic icon, name, and shortcut. No demo-style descriptive prose in production UI.

## Security Rules

Today's threat surface is a client-side app: sanitize imported/parsed files (PSD/VDJ/JSON/fonts/images)
defensively; never `eval`; keep secrets out of the bundle.

Platform work (ADR 0004) adopts an OWASP ASVS L2-oriented baseline: server-side authorization for
every privileged op, tenant scoping on every tenant query, signed/idempotent/replay-safe Lenco
webhooks, and entitlements derived only from provider-confirmed state. Provider secrets remain
server-side. None of these may be stubbed as "done".

## Performance Budgets

Editor pointer feedback immediate; move/resize local; 60 FPS target for common canvas interactions
on target hardware; avoid full-document re-render for localized edits. Autosave is debounced and off
the interaction path.

## Current Sprint — Boolean reconciliation complete; P1 export fidelity next

The 2026-08-27 gap audit proved that the planned VIRO-0002/0003/0004/0006 Boolean sequence had
already landed on main before the orchestration packet was activated. The correct Governor action is
reconciliation, not another implementation cycle:

- **VIRO-0002** — `RECONCILED` as already delivered historically.
- **VIRO-0003** Boolean kernel — `PROVEN`.
- **VIRO-0004** reversible command/undo-redo — `PROVEN`.
- **VIRO-0006** Pathfinder UI — `PROVEN`.
- Existing Boolean runtime acceptance (canvas hole, undo, save/reopen) — `PROVEN`.
- **VIRO-0005** — current executable **P1**: make vector PDF export consume authoritative compound contours and prove canvas/PDF parity.

RFC-1/2/3/4/6 are delivered. **RFC-5 Phase 0 and destructive Phase A are delivered and test-proven.**
**Phase B live/non-destructive booleans remains deferred** pending a later ADR.

After VIRO-0005, continue the evidence-ranked hardening queue. Cloud work remains blocked on owner
provisioning; it must not displace an executable local-editor P1 merely to keep platform agents busy.

## Active Risks

- **Compound-path PDF fidelity (P1):** canvas uses authoritative `VectorLayer.contours`; PDF `emitVector()` currently walks only legacy `layer.nodes`. Boolean holes/disjoint pieces may therefore export incorrectly. Mitigation: VIRO-0005; smallest exporter-only change + targeted regression proof.
- **Appearance/reality gap (HIGH):** aspirational SaaS screenshots exceed implemented platform scope. Mitigation: truth ledger + feature gates; never fake surfaces.
- **Data residency / NDPA (HIGH, legal):** cross-border PII deployment requires owner/legal completion of the applicable data-transfer/privacy obligations. Engineering will not mark compliance done without evidence.
- **Subscription-on-collections (MED):** do not present auto-renew unless provider account capability is actually confirmed.
- Autosave stores full-document snapshots including embedded image data URLs; large documents may hit quota. Failures must degrade truthfully.
- Single recovery slot remains a hardening item.

## Blockers

Hosted direction is decided (ADR 0004); remaining blockers are provisioning + legal, not product-direction excuses. Backend/payment work must not be represented as operational until the required accounts/config/secrets exist.

- Supabase project/config and credentials for real Auth/RLS/storage work.
- Lenco server credential/webhook registration for real payment/entitlement work.
- Owner-authenticated Cloudflare go-live deployment where required.
- Legal/privacy execution appropriate to the selected hosted regions/providers.
- Provider confirmation if true recurring/tokenized card renewal is ever claimed.

## Research Decisions

- ACCEPTED: autosave/crash-recovery — implemented.
- ACCEPTED (phased, flag-gated — ADR 0004): Cloudflare Pages + Supabase + Lenco Pay; hosted phases remain provisioning-gated.
- **ACCEPTED + DELIVERED (ADR 0005 Phase 0 + destructive Phase A):** Boolean path operations on the multi-contour subpath model, with v5→v6 widening, migration invariant, compound rendering, real Union/Subtract/Intersect/Exclude commands, undo/redo and Pathfinder UI. The 2026-08-27 gap audit reconciled the stale queue to this repository truth.
- **DEFERRED:** ADR 0005 Phase B live/non-destructive booleans; requires a later ADR and may not be inferred from destructive Pathfinder support.
- DEFERRED (needs RFC + owner): expanded curated template/provider families; OpenType/variable-font UI.
- REJECTED: fabricating template counts, fonts, AI actions, cloud state, billing, collaboration, or SaaS dashboards to match screenshots.

## Release Gates

Release target: P0 = 0 and P1 = 0; all required quality gates green; no unresolved hard-stop flag;
editor persistence loop passes; accessibility and parser-security gates pass for the intended release
surface. **Current state is not P1=0 because VIRO-0005 is open.**

For orchestrated work, `DONE` is allowed only after independent gates, release-manager approval of
the exact candidate SHA, required GitHub checks, a real merge to `main`, and recording of the merge
SHA. `RECONCILED` is reserved for historical targets proven to have landed before packet activation.

## Violations

- 2026-08-26 — `DECORATIVE_FUNCTION_VIOLATION` (P1), found by the Principal Critic pod: Drop Shadow was enabled for group layers while the group render path ignored effects. **RESOLVED** same day with real group effects + pixel-diff coverage.

## Open review findings — backlog

- P2: shadow `saveLayer` is unbounded → up to a full-page offscreen + blur per shadowed layer per composite; bound it to layer box + spread.
- P2: two tabs on the same project last-write-wins; add a revision guard/advisory lock.
- P2: autosave deep-clones the whole doc (embedded images) twice per tick; move to a worker or diff.
- P3: recovery-restore loses project identity; deleting the open project re-creates it on next edit; no project name-length cap; per-field shadow undo entries; panel-thumb shadow parity.

## Decision Log

- **2026-08-27 — Governor reconciled stale Boolean orchestration after VIRO-0002 gap audit.** Main already contains commit `84936c2` (document v6 multi-contour model/migration/render/validation) and `9a22f8e` (destructive Pathfinder booleans + real UI), both predating packet activation. Audit evidence reported `npx tsc --noEmit` exit 0, unit 316/316, build exit 0, engines PASS and Boolean runtime E2E 17/17. Governor decision: do not deploy a Builder to VIRO-0002; classify VIRO-0002 `RECONCILED`, VIRO-0003/0004/0006 and existing runtime Boolean acceptance `PROVEN`, and activate VIRO-0005 for the distinct remaining defect: `src/export/pdf.ts::emitVector` does not yet consume authoritative `VectorLayer.contours`. No historical Builder/Verifier PASS is fabricated. Owner: Governor.
- 2026-08-26 — **Ratified ADR 0005 (boolean path operations)**. Original decision accepted the multi-contour subpath representation and v5→v6 widening behind Phase-0 proof, with destructive Phase A contingent on acceptance criteria and live/non-destructive Phase B deferred. **Current status supersedes the then-future wording: Phase 0 + destructive Phase A have since landed and are proven; Phase B remains deferred.**
- 2026-08-26 — Delivered RFC-6 **multi-select transform & smart guides**. Group move/scale/rotate coalesce into one history step; smart guides/snapping render on the overlay pass; covered by unit and pixel-diff E2E tests. Migration impact: none.
- 2026-08-26 — Implemented and validated **Cloudflare frontend hosting config** repo-side. Go-live remains owner-authenticated/provisioning work.
- 2026-08-26 — Delivered RFC-4 **dashed/styled vector strokes** as document v4→v5 widening; migration invariant and stroke-style tests cover it.
- 2026-08-26 — Delivered RFC-3 additive layer effects **Stroke/outline** and **Outer glow**, including group composition and regression tests.
- 2026-08-26 — Governor established; forensic audit completed.
- 2026-08-26 — Ruled aspirational SaaS screenshots non-authoritative; absent SaaS surfaces may not be fabricated.
- 2026-08-26 — Fixed P0 desk-mount and document-reopen defects; improved test portability/headless stability.
- 2026-08-26 — Implemented autosave + crash recovery (IndexedDB, backward-compatible upgrade).
- 2026-08-26 — **Platform direction decided** by owner and recorded in ADR 0004: Cloudflare Pages + Supabase + Lenco Pay, phased and feature-gated; provisioning/legal remain blockers.
- 2026-08-26 — Delivered ADR 0004 **P1/P2 local-first foundation** while provisioning is pending: feature flags, local project library/provider seam, and real page-rendered thumbnails.
