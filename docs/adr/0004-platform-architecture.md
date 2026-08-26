# ADR 0004 — Hosted platform architecture (accounts, cloud, payments)

Status: **ACCEPTED (phased, flag-gated)** · 2026-08-26 · Supersedes the "platform build-out"
blocker in `GOVERNOR.md`. Owner direction received; see Decision Log.

This ADR is the Architecture RFC required by GOVERNOR.md §34 before any hosted-platform
build-out. It records evidence-based technology decisions. No production SaaS code ships
until the provisioning + legal actions in §"Blocking owner actions" are complete — we will
not fabricate a backend or fake compliance to make screens look done (GOVERNOR.md §12/§42/§80).

## Problem

VIRO Press is today a single-user, local, client-only editor. The product owner has directed
us to build the hosted platform (accounts, cloud documents, entitlements, paid plans) on
**free/affordable infrastructure**, using **Lenco (Lenco Pay)** as the payment provider,
with a data-residency/legal posture appropriate for Nigerian/African users.

## Evidence (researched 2026-08-26)

- **Lenco Pay API** — `https://lenco-api.readme.io`. Bearer-token auth (`Authorization: Bearer <token>`),
  **server-side only** ("never expose your secret key on the frontend"). Endpoints include
  `/collections` (accept payments: card, mobile money, bank transfer/virtual account),
  `/transfer` + `/transfer/bulk` (payouts), `/virtual-accounts` (static/dynamic), `/bills`,
  `/recipients`, `/banks`, `/resolve` (account verification), `/transactions` and
  `/transaction-by-reference/:reference` (idempotent lookup / polling).
  **Webhooks**: register an HTTPS URL via `support@lenco.ng`; endpoint is an unauthenticated
  POST that must return `200/201/202`; verify the `X-Lenco-Signature` header — an **HMAC-SHA512**
  of the raw payload signed with `webhook_hash_key` (a SHA256 of the API token); Lenco retries
  for 24h and recommends polling transaction status as a fallback. Events include
  `collection.successful|failed|settled`, `transfer.successful|failed`, `virtual-account.transaction`.
  **Critical limitation:** no native subscription/recurring-billing primitive is documented —
  Lenco confirms discrete collections/transfers. Recurring billing and entitlements must be
  implemented in our backend on top of one-time collections + reference-based reconciliation.
- **Cloudflare Pages** (frontend host) — free tier: unlimited bandwidth + requests for static
  assets, 300+ city CDN (edge PoPs near Lagos/Johannesburg), 500 builds/mo, 25 MiB max asset,
  no card required. Ideal for the static Vite/Skia SPA.
- **Supabase** (backend/DB/auth/storage) — free tier: Postgres 500 MB, 1 GB storage, 50k MAU,
  Auth, Storage, Row-Level Security, Edge Functions (500k/mo), Realtime; 2 projects, pauses
  after 1 week inactivity. Runs on AWS; **no `af-south-1`** for projects — closest strong-protection
  region to Nigeria is EU (**`eu-west-2` London** chosen). Pro is $25/mo when limits are exceeded.
- **NDPA 2023 + GAID 2025** — cross-border transfer of Nigerian personal data is prohibited by
  default; lawful only via an NDPC adequacy decision, an NDPC-approved Cross-Border Data Transfer
  Instrument (SCCs/DPA), or narrow derogations. Cross-border transfer is a "high-risk" activity
  requiring a DPIA and a ROPA entry. Neither the US nor (definitively) the EU is on an NDPC
  adequacy list yet, so an executed DPA + SCCs with the infra vendor is the practical basis.

## Decision (approved stack)

| Layer | Choice | Rationale | Cost |
| --- | --- | --- | --- |
| Frontend host | **Cloudflare Pages** | Static Vite/Skia SPA; unlimited free bandwidth; African edge | $0 |
| Auth / DB / Storage / server fns | **Supabase** (`eu-west-2`) | One managed platform: Postgres + RLS (tenancy), Auth, Storage, Edge Functions, Realtime | $0 → $25/mo (Pro) |
| Payments | **Lenco Pay** (Collections + Webhooks; Virtual Accounts optional) | Owner-mandated; real server-side API with signed webhooks | Per Lenco pricing (transaction fees) |
| Subscription/entitlement engine | **Our backend** (Supabase Postgres + Edge Functions) | Lenco has no recurring primitive; we own the state machine | $0 |
| Secrets | Supabase Edge Function env / Cloudflare secrets | Lenco token + service-role key never in the bundle | $0 |

**Estimated budget:** $0 to launch (all free tiers). First paid step ≈ **$25/mo** (Supabase Pro)
once the DB exceeds 500 MB / storage exceeds 1 GB / to stop free-tier pausing. Cloudflare Pages
remains $0. Plus Lenco per-transaction fees (owner to confirm from Lenco Pay pricing).

### Architecture boundaries (preserve the editor)

The existing editor architecture is unchanged: `document model → command bus → compositor →
chrome`. The platform is **additive and behind feature flags** (GOVERNOR.md §12B):

- The client stays a static SPA. Cloud features call Supabase via a thin `PlatformClient`
  behind a `platform.enabled` flag; when off, the app behaves exactly as today (local-only).
- Local autosave/recovery (ADR-less, shipped this branch) remains the offline safety net; cloud
  persistence is layered on top, not a replacement.
- All privileged/tenant operations run server-side (RLS policies + Edge Functions), never via a
  client-trusted path (GOVERNOR.md §19/§20/§26).

### Data model (multi-tenant, RLS-enforced) — design sketch

`organizations`, `memberships (user↔org, role)`, `documents (org_id, owner_id, current_version)`,
`document_versions (document_id, doc jsonb, created_at)`, `assets (org_id, storage_path, meta)`,
`plans`, `subscriptions (org_id, plan, status, current_period_end, provider='lenco')`,
`payments (org_id, lenco_reference UNIQUE, status, amount, currency, raw jsonb)`,
`webhook_events (provider, signature, event_id UNIQUE, received_at, processed_at)`,
`audit_log`. Every tenant table carries `org_id`; RLS restricts rows to the caller's org.
Documents stored as versioned JSONB (reuses the existing `PressDocument` schema + `migrateDocument`).

### Payments as a state machine (GOVERNOR.md §21) — honest to Lenco's capabilities

Subscription status ∈ `trialing | active | past_due | cancelled | unpaid | expired`.

1. **Checkout**: server creates a Lenco **collection** with a unique `reference`; user pays
   (card / mobile money / bank transfer / virtual account) on Lenco's hosted flow.
2. **Confirmation** is provider-driven only: entitlement flips to `active` **on a
   signature-verified `collection.successful` webhook**, idempotent by `reference`
   (`webhook_events.event_id UNIQUE`), with a polling fallback via `/transaction-by-reference`.
   A successful redirect alone never grants entitlement.
3. **Renewal**: because Lenco has no card-on-file recurring primitive (confirmed by docs), each
   cycle requires a fresh collection — implemented as (a) a renewal checkout link before
   `current_period_end`, and/or (b) a dedicated **virtual account** per org that the customer
   tops up (credit → `virtual-account.transaction` webhook → extend period). **OPEN QUESTION**
   for the owner: does the Lenco account support card tokenization for true auto-renewal? If
   not, we ship link/VA renewal and say so — no fake "auto-renew".
4. **Failure/lapse**: no confirmation by `current_period_end` → `past_due` → grace period →
   `expired`; entitlements downgrade to the free tier. All transitions audited.
5. **Cancel/upgrade/downgrade**: handled in our DB; proration only if the owner requires it.

PCI scope: card data is entered on **Lenco's** side (hosted/tokenized), never on ours —
targeting SAQ-A-equivalent scope. We never store PAN (GOVERNOR.md §21/§26).

## Data-residency & legal posture (must be satisfied before storing real user PII)

1. Store Nigerian users' PII in Supabase **`eu-west-2`** (strong protection, low latency to NG).
2. Execute the **Supabase DPA incorporating SCCs** and record it; add to the ROPA the vendors
   (Supabase, Cloudflare, Lenco), the data categories, and the transfer basis (CBDTI/SCCs).
3. Conduct a **DPIA** (cross-border transfer is "high-risk" under GAID) and file as required.
4. Publish a privacy policy + consent capture at sign-up; support data-subject rights (access,
   deletion — the app already supports account-scoped data) and breach-notification procedures.
5. Keep card data out of scope by using Lenco hosted collection.
6. Register with the **NDPC** and appoint a DPO if thresholds are met.

These are **owner/legal actions**; engineering will not mark compliance "done" without them.

## Phased migration (no big bang — GOVERNOR.md §33/§34)

- **P1 Foundation (flag off in prod):** Supabase project (`eu-west-2`), schema migrations
  (`expand` only), Auth (email + magic link), `PlatformClient`, RLS policies + authorization
  tests, ROPA/DPA in place.
- **P2 Cloud documents:** save/load `PressDocument` versions to Postgres+Storage behind the flag;
  server-rendered thumbnail pipeline (GOVERNOR.md §15/§61); migrate local docs opt-in.
- **P3 Entitlements + Lenco:** plans/subscriptions tables; Edge Function webhook receiver
  (signature-verified, idempotent, replay-safe) + polling reconciliation; checkout; entitlement
  gating; full billing-lifecycle integration tests (GOVERNOR.md §21).
- **P4 Collaboration/admin/client portal:** only after P1–P3 are hardened; each its own RFC scope.

## Risks

- **Subscription-on-collections** complexity (no native recurring) — mitigated by explicit
  renewal UX; do not fake auto-renew.
- **Free-tier limits** (Supabase 500 MB / pause) — fine for MVP; documents with embedded image
  dataURLs are large, so P2 must store binary assets in Storage/R2, not inline JSONB.
- **Residency** — EU is not a confirmed NDPC-adequate region; rely on SCCs/DPA + DPIA; revisit if
  a regulator requires in-country hosting.
- **Vendor lock-in** — Supabase is standard Postgres; keep SQL portable; storage abstracted.

## Acceptance criteria (per phase, before flag-on)

Authorization tests for every privileged endpoint; tenant-isolation tests (cross-org access
denied); billing integration tests (successful/failed/duplicate/delayed webhook, cancel,
lapse→expire); create→edit→cloud-save→reload→recover→export passes; no secret in the client
bundle; DPA/SCCs/DPIA/ROPA on file. Governor score ≥ 34/40, security & data-integrity ≥ 4.

## Blocking owner actions (recorded via setup-actions)

Backend/payment code cannot run end-to-end until these exist (secrets + accounts + legal). They
are requested through the environment setup-actions channel; see GOVERNOR.md Blockers.
