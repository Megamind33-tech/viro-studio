# VIRO Studio — Master Work Registry

This registry is the exhaustive unresolved-work inventory against the current `GOVERNOR.md` truth ledger and accepted ADR/RFC direction as of 2026-08-27.

It is not permission to start everything. The Governor controls priority and the Orchestrator controls claims, dependencies, leases, and deployment. If work is not represented here or in an approved delivery manifest, an agent must not invent it.

## Status vocabulary

- **ACTIVE/READY** — may be claimed when the Orchestrator says it is conflict-free and dependencies are satisfied.
- **QUEUED** — known work, but must wait for the named dependency or Governor activation.
- **PROVISIONING_BLOCKED** — architecture is approved but external account/secrets/config are missing.
- **OWNER_BLOCKED** — explicit owner/legal/commercial decision or action is required.
- **RFC_BLOCKED** — product is absent and requires an approved architecture/product RFC before implementation.
- **PROVEN** — already working; only regression/hardening packets may touch it.

## Micro-agent rule

A micro-agent is deliberately narrow. It receives one role, one packet, one leased scope, and one measurable outcome. It does not redesign adjacent systems. The `micro-agent` names below are capability profiles; the actual worker ID should identify the tool and machine, e.g. `cursor-geometry-pc2`.

| Work ID | Work | State | Dependency / blocker | Orchestrator role | Smallest suitable micro-agent | Normal scope |
|---|---|---|---|---|---|---|
| VIRO-0002 | Multi-contour vector model + v5→v6 migration proof | READY | none; current approved editor progression | editor-engineer | geometry/migration agent | `src/document/**`, compositor touchpoints, tests |
| VIRO-0003 | Boolean geometry kernel: Union/Subtract/Intersect/Exclude with deterministic fixtures | QUEUED | VIRO-0002 DONE | editor-engineer | geometry-ops agent | new/targeted document geometry module + tests |
| VIRO-0004 | Boolean command-bus integration with reversible undo/redo | QUEUED | VIRO-0003 DONE | editor-engineer | command-bus agent | command modules + tests |
| VIRO-0005 | Boolean rendering/export fidelity across PNG/PDF | QUEUED | VIRO-0004 DONE | editor-engineer | render/export fidelity agent | compositor/export + tests |
| VIRO-0006 | Boolean UI wiring and shortcuts; no decorative controls | QUEUED | VIRO-0005 DONE | ui-engineer | editor-chrome wiring agent | `src/chrome/**`, `index.html`, UI tests |
| VIRO-0007 | Boolean-path independent end-to-end acceptance | QUEUED | VIRO-0006 DONE | verifier | E2E verifier agent | `tests/**`, evidence only |
| VIRO-0010 | Autosave large-document quota/error hardening | QUEUED | Governor activation after P1 editor packet | editor-engineer | persistence stress agent | recovery/store paths + tests |
| VIRO-0011 | Replace single recovery slot with document-identity recovery model | QUEUED | VIRO-0010 DONE or Governor reprioritization | editor-engineer | recovery-model agent | persistence/document identity + tests |
| VIRO-0012 | 60-FPS interaction profiling on common canvas operations | QUEUED | Governor activation | editor-engineer | performance profiler agent | measurement harness, localized fixes only |
| VIRO-0013 | Import parser fuzz/negative tests for PSD/VDJ/PressJSON | QUEUED | Governor activation | builder | import-hardening agent | `src/import/**`, tests/fixtures |
| VIRO-0014 | Font/image/import sanitization regression hardening | QUEUED | Governor activation | builder | input-security agent | import/font/image validation + tests |
| VIRO-0015 | PNG/PDF export regression corpus and fidelity report expansion | QUEUED | Governor activation | builder | export-QA agent | `src/export/**`, tests/fixtures |
| VIRO-0016 | Accessibility/keyboard audit of existing editor chrome; fix proven defects only | QUEUED | Governor activation | ui-engineer | accessibility agent | `src/chrome/**`, `index.html`, tests |
| VIRO-0017 | UI visual-polish defect sweep against AAA brief without layout invention | QUEUED | Governor activation and no unresolved higher-priority packet | ui-engineer | visual-polish agent | existing UI/CSS surfaces only |
| VIRO-0018 | Template/preset breadth expansion using truthful real templates/assets | QUEUED | approved content brief/assets; no fake thumbnails | builder | template-content agent | presets/catalog/assets + tests |
| VIRO-0020 | Supabase project provisioning/config verification | PROVISIONING_BLOCKED | `SUPABASE_URL`, anon/service keys, eu-west-2 project | platform-engineer | platform-provisioning agent | config/deploy docs; no fake backend |
| VIRO-0021 | Supabase Auth session adapter behind platform flags | PROVISIONING_BLOCKED | VIRO-0020 + secrets | platform-engineer | auth adapter agent | `src/platform/**`, auth tests |
| VIRO-0022 | Tenant/org schema + RLS policies + authorization tests | PROVISIONING_BLOCKED | VIRO-0020; accepted ADR 0004 | platform-engineer | RLS/security agent | backend schema/policies/tests |
| VIRO-0023 | Cloud project metadata sync using existing project model | QUEUED | VIRO-0021 + VIRO-0022 | platform-engineer | sync-metadata agent | platform sync modules/tests |
| VIRO-0024 | Binary asset storage/sync; remove need for inline cloud JSONB assets | QUEUED | VIRO-0023 | platform-engineer | storage-sync agent | storage/platform/library seam + tests |
| VIRO-0025 | Offline/reconnect conflict policy and deterministic sync tests | QUEUED | VIRO-0023 | platform-engineer | sync-conflict agent | sync state machine + tests |
| VIRO-0026 | Multi-device project open/save acceptance | QUEUED | VIRO-0024 + VIRO-0025 | verifier | cloud E2E verifier agent | tests/evidence only |
| VIRO-0030 | Lenco credential/webhook endpoint provisioning | PROVISIONING_BLOCKED | `LENCO_API_TOKEN`, webhook registration | platform-engineer | payments-provisioning agent | server config/docs only |
| VIRO-0031 | Signed Lenco webhook verification + replay/idempotency protection | PROVISIONING_BLOCKED | VIRO-0030 | platform-engineer | webhook-security agent | backend function + tests |
| VIRO-0032 | Backend-owned subscription/entitlement state machine | QUEUED | VIRO-0031 + auth/RLS | platform-engineer | entitlement agent | platform/backend state machine + tests |
| VIRO-0033 | Checkout/renewal flow with truthful non-auto-renew semantics | QUEUED | VIRO-0032; tokenization question resolved if auto-renew claimed | platform-engineer | billing-flow agent | checkout/client/server seam + tests |
| VIRO-0034 | Billing/entitlement adversarial acceptance | QUEUED | VIRO-0033 | verifier | payments verifier agent | tests/evidence only |
| VIRO-0040 | NDPC cross-border transfer/DPIA/ROPA engineering checklist integration | OWNER_BLOCKED | owner/legal completion of CBDTI/DPA/SCC/DPIA/ROPA | research-architect | compliance-evidence agent | docs/checklists only; cannot declare legal compliance |
| VIRO-0050 | Collaboration model: presence/comments/version semantics RFC | RFC_BLOCKED | explicit Governor/owner approval | research-architect | collaboration architect agent | `docs/research/**`, ADR/RFC only |
| VIRO-0051 | Collaboration backend implementation | RFC_BLOCKED | VIRO-0050 approved + cloud foundation | platform-engineer | realtime-collab agent | only after approved packet |
| VIRO-0060 | Client portal product/authorization RFC | RFC_BLOCKED | owner scope + permissions model | research-architect | portal architect agent | docs only |
| VIRO-0061 | Client portal implementation | RFC_BLOCKED | VIRO-0060 approved + auth/RLS | platform-engineer | portal implementation agent | only after approved packet |
| VIRO-0070 | Admin platform roles/audit/privilege RFC | RFC_BLOCKED | owner scope + security model | research-architect | admin-security architect | docs only |
| VIRO-0071 | Admin platform implementation | RFC_BLOCKED | VIRO-0070 approved + auth/RLS | platform-engineer | admin implementation agent | only after approved packet |
| VIRO-0080 | Template marketplace/provider/data-rights RFC | RFC_BLOCKED | owner commercial/content decision | research-architect | marketplace architect | docs only |
| VIRO-0081 | Marketplace implementation | RFC_BLOCKED | VIRO-0080 approved + cloud/billing | platform-engineer | marketplace agent | only after approved packet |
| VIRO-0090 | Stock photo/icon/illustration provider selection + licensing RFC | RFC_BLOCKED | owner provider/licensing decision | research-architect | content-provider researcher | docs only |
| VIRO-0091 | Stock provider integration | RFC_BLOCKED | VIRO-0090 approved | builder | stock-integration agent | provider adapter + truthful UI/tests |
| VIRO-0100 | AI capability inventory/model/provider decision for Improve Lighting / Enhance Details / Magic Resize / Generate Similar | RFC_BLOCKED | owner cost/privacy/model decision | research-architect | AI capability researcher | docs/evidence only |
| VIRO-0101 | First approved AI capability implementation | RFC_BLOCKED | VIRO-0100 approved and real model/service available | builder | AI inference/integration agent | one capability only, gated + tested |
| VIRO-0110 | Sharing model + permissions RFC | RFC_BLOCKED | auth/cloud + owner sharing semantics | research-architect | sharing architect | docs only |
| VIRO-0111 | Sharing implementation | RFC_BLOCKED | VIRO-0110 approved | platform-engineer | sharing agent | platform/UI seam + tests |
| VIRO-0120 | Notifications event model/channel RFC | RFC_BLOCKED | owner channel/provider decisions | research-architect | notification architect | docs only |
| VIRO-0121 | Notifications implementation | RFC_BLOCKED | VIRO-0120 approved | platform-engineer | notifications agent | provider/backend/UI + tests |
| VIRO-0130 | External integrations framework RFC | RFC_BLOCKED | owner target integrations | research-architect | integrations architect | docs only |
| VIRO-0131 | First approved external integration | RFC_BLOCKED | VIRO-0130 approved | platform-engineer | integration adapter agent | one integration per packet |

## PROVEN surfaces — do not create replacement work

These are already classified as working by the Governor and are not open-ended rewrite invitations: Skia compositor, HarfBuzz shaping, LittleCMS color conversion, document migrations through v5, command bus/undo-redo, current editor tool wiring, local New/Open/Place/Save, PSD/VDJ/PressJSON import, PNG/PDF export, background removal, font registry, autosave/crash recovery, feature flags, local Projects library + real thumbnails, Anchor operation API, layer effects, vector stroke styling, and multi-select transform/smart guides.

A micro-agent may touch a PROVEN surface only when an active packet names a concrete defect, regression, security problem, or measurable performance/fidelity target and leases the exact paths.

## Assignment order

1. Finish active P0/P1 packets before unrelated work.
2. Follow dependency edges.
3. Prefer the smallest packet that produces an independently testable delta.
4. Allow parallel work only when leased scopes are disjoint.
5. Never turn a BLOCKED/RFC_BLOCKED row into production work by inventing credentials, providers, product rules, or placeholder UI.
6. When a new unresolved capability is discovered, report it to the Governor/Orchestrator for registry insertion before implementation.

## Redeployment rule

After every handoff, rejection, or completed assignment, the worker returns to the Orchestrator. It does not choose its own next task. A builder may be redeployed to another build-stage packet, but it may not become verifier/critic/release-manager for the packet it just built.
