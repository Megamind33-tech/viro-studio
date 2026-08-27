# VIRO Studio — Product Delta Scoreboard

This file is changed only from verified delivery manifests. It is not a subjective maturity percentage and it is not a roadmap.

## Current verified baseline

Based on `GOVERNOR.md` at pipeline installation:

| Product area | State | Next meaningful progression target |
|---|---|---|
| Document model / migrations | PROVEN_WORKING | preserve invariants while new model capabilities land |
| Command bus / undo-redo | PROVEN_WORKING | ensure every new document mutation is reversible |
| Canvas/editor tools | PROVEN_WORKING with depth gaps | close tool-depth gaps through end-to-end packets, not new decorative tools |
| Typography / font registry | PROVEN_WORKING with depth gaps | improve professional text editing/export fidelity from measured defects |
| Persistence / recovery | PROVEN_WORKING | multi-document/cloud evolution only behind verified architecture |
| PNG/PDF export | PROVEN_WORKING | fidelity and additional formats only when fully real/tested |
| Background removal | PROVEN_WORKING, availability-gated | improve only with real model evidence |
| Templates/presets | PARTIAL | raise breadth and design quality using real editable content |
| Boolean path operations | EXPERIMENT / pending progression | finish approved proof/model sequence before unrelated vector expansion |
| Accounts/auth | ABSENT | platform packet only after real provisioning |
| Cloud sync | ABSENT | platform packet only after auth/RLS truth exists |
| Billing/entitlements | ABSENT | server-verified flow only; no client theatre |
| Collaboration | ABSENT | do not expose until real architecture exists |
| AI beyond background removal | ABSENT | do not expose without a real engine/service |

## Accepted-build ledger

Add one row only when a delivery packet reaches `DONE`.

| Delivery | Area | Before | After | Proof | Regressions protected |
|---|---|---|---|---|---|
| PIPELINE-BOOTSTRAP | Delivery system | agents had guidance but no enforceable role/manifest/CI progression gate | repository has explicit ownership, delivery manifests, independent verification/critique, and CI anti-theatre gate | pipeline files + CI | delivery-policy checker |

## Release-level question

For each candidate release, answer in one sentence:

**What can a designer reliably accomplish in this accepted build that was impossible, unreliable, or materially worse in the previous accepted build?**

If the answer only mentions refactors, prompts, plans, rearranged UI, agent count, or internal activity, the release has no product delta.