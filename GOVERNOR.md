# GOVERNOR.md — VIRO Press Product Constitution

> This is the single authoritative direction file. Only the Governor edits it.
> It is an enforceable engineering contract, not an inspirational document.
> When reality and appearance conflict, reality wins.

Last updated: 2026-08-26 · Sprint 0 (Forensic Audit) · Branch: `cursor/env-setup-and-desk-mount-fix-1726`

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
to any API (verified: repo-wide search for `fetch(`/`/api/`/`supabase`/`stripe`/`auth` finds
only asset/font/model loads and doc strings).

Two product screenshots were supplied depicting a hosted suite named "PRESS" with a
120,000-template library, stock photo/icon/illustration panels, AI "Quick Actions"
(Remove Background, Improve Lighting, Enhance Details, Magic Resize, Generate Similar),
Share/Export cloud actions, and a "Bebas Neue" type menu. **None of these strings or
surfaces exist in the codebase** (verified by search). They are aspirational and are treated
as such: they do not represent implemented capability and must never be faked to match.

What genuinely exists and works (traced + test-verified):

- Skia compositor rendering, HarfBuzz shaping, LittleCMS sRGB→Lab — smoke-proven (`tests/engines.mjs`).
- Versioned document model (`v1..v4`) with real migrations (`src/document/migrate.ts`).
- Command bus with typed commands, inverses, coalescing, undo/redo (`src/document/command-bus.ts`, 242 unit tests pass).
- Editor tools wired 1:1 to handlers: all 44 `data-cmd` controls in `index.html` have real handlers in `src/chrome/desk.ts` (verified) — no dead menu items.
- Real background removal via ONNX U²-Netp (`src/engine/cutout.ts`) — genuine tensor inference, gated on model availability.
- Real font registry: bundled Noto faces + user-uploaded fonts (IndexedDB) + optional Electron system fonts, with truthful source states (`src/engine/font-registry.ts`).
- Persistence: documents as `.press.json` files; user assets/fonts in IndexedDB (`src/library/store.ts`).
- Import: PSD, VDJ, Press JSON. Export: PNG, PDF (with a real vector/raster report), tested.
- Procedurally generated marks/stock + preset/template documents (`src/library/catalog.ts`, `src/document/presets.ts`) — honestly labelled "Not a Canva Elements rail".
- The "Anchor" API: a structured, previewable, auditable document-mutation op interface (`window.viroAnchor`) routed through the command bus — real, not an AI badge.

Fixed during Sprint 0 (this branch):

- **P0** desk-mount abort (`index.html` `#file-font`→`#file-fonts` + missing `#file-assets`) that silently killed all menu/dialog/studio wiring.
- **P0** reopening a current-version (v4) document dropped all layers (`openBytes` guard capped at v3).
- **P0 (new capability)** autosave + crash recovery to IndexedDB (was absent; a reload lost all work). Tested end-to-end (`tests/recovery.spec.mjs`).
- Test portability (hardcoded `C:/viro studio` paths) and headless flakiness (`retries`).

## Non-Negotiable Rules (from the mandate; binding)

1. Reality over appearance. A feature is real only when the full path works and is tested (§1, §40, §77).
2. No fake data, fake fonts, decorative controls, fake thumbnails, or false success states (§12, §51–66, §79, §80).
3. No unsupported capability claims (no export format we cannot produce; no AI without a real model/service).
4. No scope/architecture/visual/terminology drift without an approved RFC (§68–76).
5. Preserve working software; smallest safe change; regression tests before touching `PROVEN_WORKING` (§11, §78).
6. A smaller truthful product beats a larger fake one (§45).
7. Fixtures live only under `tests/`/`fixtures/` and never leak into production (§53).

## Architecture Direction

Keep the layered editor architecture already present and sound:
`document model (serializable, versioned) → command bus (reversible) → compositor (render) →
chrome (DOM UI)`. Persistence is decoupled (files + IndexedDB). Do not couple rendering to
persistence. Do not introduce a second state store, rendering engine, or icon library
without an ADR. Electron features degrade gracefully in the web build (feature-detected via
`window.viroPress`).

## Approved Technology Decisions

Vite 8 · TypeScript 7 · CanvasKit-wasm · harfbuzzjs · lcms-wasm · onnxruntime-web · idb ·
Electron 43 · Playwright + node:test for tests. No new foundational dependency without an ADR
(§71). Node ≥ 20.

## Feature Truth Ledger

| Feature | Classification | Evidence |
| --- | --- | --- |
| Skia compositor / HarfBuzz / LittleCMS | PROVEN_WORKING | `tests/engines.mjs`, editor renders |
| Document model + migrations (v1..v4) | PROVEN_WORKING | `tests/*`, `migrate.ts` |
| Command bus + undo/redo | PROVEN_WORKING | 242 unit tests |
| Editor tools (move/marquee/crop/pen/shape/text/hand/zoom/eyedropper/…) | PROVEN_WORKING | `desk.ts` 1:1 handler map; chrome E2E |
| New / Open / Place / Save (.press.json) | PROVEN_WORKING | chrome + slice E2E |
| Import PSD/VDJ/PressJSON | WORKING_WITH_DEFECTS→PROVEN | reopen bug fixed this sprint |
| Export PNG / PDF | PROVEN_WORKING | chrome E2E + pdf report |
| Background removal (U²-Netp) | PROVEN_WORKING (gated) | `cutout.ts`, availability-gated UI |
| Font registry (bundled/user/system) | PROVEN_WORKING | `font-registry.ts`, slice E2E |
| Autosave + crash recovery | PROVEN_WORKING (new) | `tests/recovery.spec.mjs` 13/13 + demo video |
| Anchor op API (preview/apply/audit) | PROVEN_WORKING | `tests/anchor-bus.spec.mjs` |
| Templates/presets + procedural marks | PARTIALLY_IMPLEMENTED | real generators; catalog breadth limited |
| Accounts / auth / sessions | ABSENT | no code |
| Cloud storage / sync / multi-device | ABSENT | no code |
| Collaboration / comments / presence / versions | ABSENT | no code |
| Client portal | ABSENT | no code |
| Admin platform | ABSENT | no code |
| Billing / subscriptions / entitlements | ABSENT | no code |
| Template marketplace ("120k templates"), stock photos/icons | ABSENT (aspirational screenshot) | no code |
| AI beyond background removal | ABSENT (aspirational screenshot) | no code |
| Notifications / sharing / integrations | ABSENT | no code |

No `DECORATIVE_ONLY` controls found in the shipping editor UI (all `data-cmd` handled).

## Production Scope (what the product IS, today)

A local design editor: documents, pages/artboards, layers, vector + basic raster tooling,
typography, color, effects, background removal, import/export, local asset/font library,
autosave/recovery. This is the surface we harden. The SaaS surfaces are out of scope until an
owner-approved platform RFC lands.

## Quality Gates

- `npm test` (engines + 242 unit + 5 chrome E2E + 7 slice scripts incl. recovery) must pass.
- `npm run build` (web + Electron) must succeed.
- `npx tsc --noEmit` clean. No TS suppressions as fixes; no disabled tests to pass CI.
- New UI → manual/visual evidence. New logic → automated test. Touching `PROVEN_WORKING` → regression test first.
- Governor scoring ≥ 34/40, no category < 3; data-integrity/editor-core ≥ 4 (§4).

## UX Rules

Photoshop-class dark desk (tokens: panels `#2B2B2B`/`#323232`, pasteboard `#1F1F1F`,
accent copper `#E07A2F` only on active tool/selection, Segoe UI, radius 0–2px). Prioritise
workspace density in the editor; honest empty states over fake content; every tool has a
distinct semantic icon, name, and shortcut. No demo-style descriptive prose in production UI.

## Security Rules

Today's threat surface is a client-side app: sanitize imported/parsed files (PSD/VDJ/JSON/
fonts/images) defensively; never `eval`; keep secrets out of the bundle (none exist).
Any future server work adopts OWASP ASVS 5.0 L2 baseline, server-side authorization for every
privileged op, tenant scoping on every tenant query, verified/idempotent payment webhooks —
none of which may be stubbed as "done".

## Performance Budgets

Editor pointer feedback immediate; move/resize local (no network — trivially satisfied);
60 FPS target for common canvas interactions on target hardware; avoid full-document
re-render for localized edits (compositor already coalesces repaints per frame). Autosave is
debounced (1200 ms) and off the interaction path.

## Current Sprint — Sprint 0 (Forensic Audit) → transitioning to Sprint 3 (Editor Core hardening)

Objectives met: forensic audit; GOVERNOR.md; environment productionized (build-tested);
P0 desk-mount and doc-reopen fixes; autosave/recovery implemented + tested.
Measurable targets hit: `npm test` green; build green; recovery E2E 13/13.

## Active Risks

- **Appearance/reality gap (HIGH):** supplied screenshots imply a SaaS that does not exist.
  Risk that stakeholders expect those features. Mitigation: this ledger; RFC-gated build-out.
- Autosave stores full-document snapshots (incl. embedded image dataURLs) in IndexedDB — large
  documents could hit quota. Mitigation: failures degrade to in-memory (no false success);
  future work: delta snapshots / quota handling (P2).
- Single recovery slot (no per-document identity) — acceptable for single-window local use;
  revisit if multi-window/multi-doc lands.

## Blockers

- **Platform build-out (accounts/cloud/billing/admin/collaboration/template-marketplace/AI)**
  requires OWNER DECISIONS: target hosting, backend stack, payment provider, data residency,
  legal/PCI posture, budget. Cannot proceed without these (§46 carve-out). Not a code blocker;
  a direction blocker. Do not fabricate.

## Research Decisions

- ACCEPTED: autosave/crash-recovery (data-loss P0) — implemented this sprint.
- DEFERRED (needs RFC + owner): hosted platform surfaces; expanded curated template families
  (§57) with a real thumbnail-render pipeline (§61); OpenType/variable-font UI.
- REJECTED: fabricating template counts, fonts, AI actions, or SaaS dashboards to match screenshots.

## Release Gates

P0 = 0, P1 = 0 · all quality gates green · no unresolved hard-stop flag (§82) ·
editor persistence loop (create→edit→save→reload→recover→export) passes repeatedly ·
accessibility pass on core editor journeys (keyboard operability) · security review of file
parsers. Platform surfaces are gated behind their own RFC + tests and are not required for a
truthful editor release.

## Violations

None recorded this sprint. (Any agent output breaching this constitution is logged here with
the relevant hard-stop flag.)

## Decision Log

- 2026-08-26 — Governor established; forensic audit completed. Owner: Governor.
- 2026-08-26 — Ruled the two supplied screenshots aspirational; SaaS surfaces classified ABSENT,
  not decorative, and explicitly out of scope pending an owner-approved platform RFC. Rationale:
  no backing code exists and fabricating it violates §12/§42/§51/§83.
- 2026-08-26 — Fixed P0 desk-mount and P0 doc-reopen defects; made slice tests portable; added
  Playwright retries for headless SwiftShader. Migration impact: none (bug fixes).
- 2026-08-26 — Implemented autosave + crash recovery (IndexedDB, DB v3, backward-compatible
  upgrade). Dirtiness driven by a new monotonic command-bus revision so all mutation paths are
  covered. Migration impact: additive object store; no destructive change.
