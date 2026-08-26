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

Editor (unchanged): Vite 8 · TypeScript 7 · CanvasKit-wasm · harfbuzzjs · lcms-wasm ·
onnxruntime-web · idb · Electron 43 · Playwright + node:test. No new foundational dependency
without an ADR (§71). Node ≥ 20.

Hosted platform (approved 2026-08-26 via **ADR 0004**, phased + flag-gated):
- Frontend host: **Cloudflare Pages** (static SPA, free, African edge).
- Auth / DB / Storage / server functions: **Supabase** (Postgres + RLS + Auth + Storage +
  Edge Functions), region **`eu-west-2` (London)** — closest strong-protection region to
  Nigeria (`af-south-1` unavailable on Supabase).
- Payments: **Lenco Pay** (Collections + signed webhooks; Virtual Accounts optional),
  server-side only. Subscription/entitlement state machine is **owned by our backend** because
  Lenco exposes discrete collections/transfers, not native recurring billing.
- Card data never touches our systems (Lenco hosted/tokenized collection → SAQ-A-equivalent scope).
- Budget: $0 to launch (free tiers); first paid step ≈ $25/mo (Supabase Pro) at scale, plus
  Lenco per-transaction fees. See ADR 0004 for evidence and the phased plan.

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
| Feature flags (platform.enabled/cloud/billing) | PROVEN_WORKING (new) | `tests/flags.test.mjs` 3/3 |
| Local Projects library (dashboard: save/list/open/rename/delete) | PROVEN_WORKING (new) | `tests/projects.spec.mjs` 11/11 + demo video |
| Project thumbnails (rendered from real page) | PROVEN_WORKING (new) | `compositor.thumbnailDataUrl`; projects E2E asserts real PNG |
| Anchor op API (preview/apply/audit) | PROVEN_WORKING | `tests/anchor-bus.spec.mjs` |
| Layer effects: stroke/outline + outer glow (leaf + group) | PROVEN_WORKING (new) | `tests/effects.*` pixel-diff + undo, `tests/effects.test.mjs` |
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
Platform work (ADR 0004) adopts OWASP ASVS 5.0 L2 baseline: server-side authorization for every
privileged op (Supabase RLS + Edge Functions), tenant scoping (`org_id`) on every tenant query,
Lenco webhooks verified (HMAC-SHA512 `X-Lenco-Signature`), idempotent (`event_id`/`reference`
unique) and replay-safe, entitlement derived only from provider-confirmed state (never a redirect).
The Lenco secret token and Supabase service-role key live only in Edge Function env, never the
client bundle. None of these may be stubbed as "done".

## Performance Budgets

Editor pointer feedback immediate; move/resize local (no network — trivially satisfied);
60 FPS target for common canvas interactions on target hardware; avoid full-document
re-render for localized edits (compositor already coalesces repaints per frame). Autosave is
debounced (1200 ms) and off the interaction path.

## Current Sprint — Sprint 0 done; platform P1/P2 (local-first) delivered

Objectives met: forensic audit; GOVERNOR.md + terminology lock; environment productionized
(build-tested); P0 desk-mount and doc-reopen fixes; autosave/recovery; ADR 0004 platform
architecture accepted; **P1 foundation** (feature flags + local project store + PlatformClient
seam) and **P2 local shell/dashboard** (multi-project persistence, Projects dialog, real
page-rendered thumbnails) built and tested locally while cloud/payment provisioning is pending.
Measurable targets: `npm test` green (245 unit, 5 chrome, 8/8 slices incl. projects 11/11 &
recovery 13/13); build green; `tsc` clean.

Next (unblocks on owner provisioning per ADR 0004): P1 cloud (Supabase Auth + RLS +
authorization/tenant tests), P2 cloud sync of the same project model, P3 Lenco entitlements.

## Active Risks

- **Appearance/reality gap (HIGH):** supplied screenshots imply a SaaS that does not exist.
  Mitigation: this ledger; the platform is now RFC-approved (ADR 0004) and built phased + flag-gated,
  not faked.
- **Data residency / NDPA (HIGH, legal):** Nigerian PII stored cross-border (Supabase `eu-west-2`)
  requires an NDPC-approved CBDTI (Supabase DPA + SCCs), a DPIA, and a ROPA entry. Owner/legal
  actions; engineering will not flag compliance "done" without them.
- **Subscription-on-collections (MED):** Lenco has no native recurring billing, so renewals use a
  fresh collection (checkout link) or virtual-account top-ups. Do not present "auto-renew" unless
  card tokenization is confirmed on the Lenco account (open question in ADR 0004).
- Autosave stores full-document snapshots (incl. embedded image dataURLs) in IndexedDB — large
  documents could hit quota. Mitigation: failures degrade to in-memory (no false success). P2 cloud
  persistence must store binary assets in Storage, not inline JSONB.
- Single recovery slot (no per-document identity) — acceptable for single-window local use.

## Blockers

Direction is now decided (ADR 0004): Cloudflare Pages + Supabase (`eu-west-2`) + Lenco Pay,
free-tier budget. Remaining blockers are **provisioning + legal**, not direction. Backend/payment
code will not run end-to-end (and will not be merged as "working") until these are supplied by the
owner — requested via the environment setup-actions channel:

- Secrets: `LENCO_API_TOKEN` (server-side), `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`.
- Accounts/config: create the Lenco Pay API key and register the webhook URL with `support@lenco.ng`;
  create the Supabase project in `eu-west-2`; create the Cloudflare Pages project.
- Legal: execute the Supabase DPA + SCCs; complete a DPIA and ROPA; publish a privacy policy;
  NDPC registration / DPO as required. (Owner/legal — not engineering.)
- Open question for owner: does the Lenco account support card tokenization for true auto-renewal?

## Research Decisions

- ACCEPTED: autosave/crash-recovery (data-loss P0) — implemented this sprint.
- ACCEPTED (phased, flag-gated — ADR 0004): hosted platform on Cloudflare Pages + Supabase
  (`eu-west-2`) + Lenco Pay. Owner direction received 2026-08-26. Build order P1 foundation →
  P2 cloud documents → P3 entitlements/Lenco → P4 collaboration/admin/client portal.
- DEFERRED (needs RFC + owner): expanded curated template families (§57) with a real
  thumbnail-render pipeline (§61); OpenType/variable-font UI.
- REJECTED: fabricating template counts, fonts, AI actions, or SaaS dashboards to match screenshots.

## Release Gates

P0 = 0, P1 = 0 · all quality gates green · no unresolved hard-stop flag (§82) ·
editor persistence loop (create→edit→save→reload→recover→export) passes repeatedly ·
accessibility pass on core editor journeys (keyboard operability) · security review of file
parsers. Platform surfaces are gated behind their own RFC + tests and are not required for a
truthful editor release.

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
  parity. Tracked for the next hardening pass; none are P0/P1.

## Decision Log

- 2026-08-26 — Delivered RFC-3 additive layer effects **Stroke/outline** and **Outer glow**
  (`docs/research/0001-next-editor-features.md`), reusing the `effects[]` list and the
  `withDropShadow`/`drawGradientOverlay` composition seam. No schema bump: effects are additive
  and forward/backward-safe (old builds ignore an unknown effect), matching the drop-shadow
  precedent. Stroke renders by dilating the layer silhouette (`ImageFilter.MakeDilate` +
  `ColorFilter.MakeBlend SrcIn`); outer glow is a zero-offset `MakeDropShadowOnly` in the glow
  colour. Both compose for leaves and groups via a shared `withEffects` wrapper, and effects are
  folded into `hashLayer` so panel thumbnails invalidate. Proven with pixel-diff E2E (renders +
  undo clears) and unit tests. Migration impact: none (additive, versionless). Owner: engineering.
- 2026-08-26 — Governor established; forensic audit completed. Owner: Governor.
- 2026-08-26 — Ruled the two supplied screenshots aspirational; SaaS surfaces classified ABSENT,
  not decorative, and explicitly out of scope pending an owner-approved platform RFC. Rationale:
  no backing code exists and fabricating it violates §12/§42/§51/§83.
- 2026-08-26 — Fixed P0 desk-mount and P0 doc-reopen defects; made slice tests portable; added
  Playwright retries for headless SwiftShader. Migration impact: none (bug fixes).
- 2026-08-26 — Implemented autosave + crash recovery (IndexedDB, DB v3, backward-compatible
  upgrade). Dirtiness driven by a new monotonic command-bus revision so all mutation paths are
  covered. Migration impact: additive object store; no destructive change.
- 2026-08-26 — **Platform direction decided** by owner and recorded in **ADR 0004**: Cloudflare
  Pages (frontend) + Supabase `eu-west-2` (auth/DB/storage/functions) + **Lenco Pay** (payments),
  free-tier budget. Rationale grounded in verified vendor docs (Lenco API, Supabase/Cloudflare free
  tiers) and NDPA 2023/GAID 2025 residency law. Subscription state machine owned by our backend
  (Lenco has no recurring primitive). Build is phased and behind a `platform.enabled` flag; the
  local editor is unaffected. Owner. Migration impact: additive (new Supabase schema, expand-only);
  no change to the existing editor or document schema. Remaining blockers are provisioning + legal
  (see Blockers), not direction.
- 2026-08-26 — Delivered ADR 0004 **P1/P2 local-first** while provisioning is pending: feature-flag
  system (`platform.enabled` on; `platform.cloud`/`platform.billing` off), local project library
  (IndexedDB `documents` store, DB v4), a `ProjectProvider` seam the Supabase provider will
  implement unchanged, and real page-rendered thumbnails (GOVERNOR.md §15/§61). The app is now a
  multi-project local editor; the cloud layer becomes a sync provider behind the same seam. Owner.
  Migration impact: additive IndexedDB store; no destructive change; editor untouched.
