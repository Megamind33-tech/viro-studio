# VIRO Studio Agent Delivery Pipeline

This is the execution system for all substantial work. It exists to prevent agent churn, repeated audits, decorative implementation, and false completion.

## 0. Delivery states

Every work packet has exactly one state:

- `QUEUED` — accepted but not started.
- `ACTIVE` — one owner is implementing it.
- `VERIFY` — builder has stopped; verifier owns it.
- `CRITIC` — functional verification passed; product/visual critic owns it.
- `REJECTED` — failed verification or critique; returns to the same builder unless Governor reassigns.
- `BLOCKED` — external dependency prevents progress; blocker must be concrete and evidenced.
- `DONE` — verifier PASS + critic PASS when applicable + CI PASS + recorded delta.

No other wording counts as status.

## 1. Governor gate

The Governor creates or approves a delivery manifest before implementation.

A valid work packet must contain one outcome that can be demonstrated in the running product. Examples:

- BAD: `Improve typography`.
- GOOD: `Imported user OTF/TTF fonts remain selectable after reload and render identically in editor and PDF export.`
- BAD: `Polish layers`.
- GOOD: `Layer rename, reorder, hide, lock, group, ungroup and multi-select persist through save/reopen and are undoable.`

The Governor rejects packets that:
- mix unrelated domains;
- introduce speculative architecture;
- do not identify before-state evidence;
- have no executable acceptance test;
- only create documentation, mocks, placeholders, or visual theatre unless documentation itself is the requested product.

## 2. Baseline gate

The Gap Auditor must prove the before-state before the Builder changes production code.

Evidence may include:
- failing automated test;
- reproducible runtime steps;
- source path proving capability is absent/partial;
- screenshot/crop proving visual defect;
- profiler measurement for performance work.

For defects, add a failing regression test first whenever practical.

The auditor writes only findings and acceptance criteria. It does not implement.

## 3. Ownership gate

The Governor assigns exactly one implementation owner per production surface. See `OWNERSHIP.md`.

Parallel work is allowed only when `allowed_paths` are disjoint. Shared-file work is serialized under one integrator.

A Builder must stop and return `BLOCKED` if the required fix crosses into a path owned by another active packet without Governor authorization.

## 4. Build gate

The Builder:

1. reads the manifest and relevant contracts;
2. implements the smallest complete vertical slice;
3. adds/updates automated tests;
4. runs targeted tests continuously;
5. runs full required gates before handoff;
6. captures runtime evidence for visible changes;
7. updates only the builder section of the manifest;
8. stops coding once the packet enters `VERIFY`.

A Builder is prohibited from changing its own acceptance criteria after implementation begins.

## 5. Verification gate

The Verifier receives the code cold. It does not trust the builder report.

It must:
- reproduce the acceptance steps independently;
- run the named targeted tests;
- run `npx tsc --noEmit`;
- run `npm test` unless the manifest explicitly documents a narrower temporary gate approved by Governor;
- run `npm run build`;
- inspect generated screenshots/evidence for visible changes;
- attempt at least one meaningful edge case not listed by the Builder.

Any unexplained failure means `REJECTED`.

Verifier does not fix implementation. It records precise failure reproduction and returns to Builder.

## 6. Critic gate

Required for any user-visible UI, interaction, visual output, templates, typography, canvas behavior, or workflow change.

The Critic follows `docs/CRITIC.md` plus packet-specific acceptance criteria. It judges the running application and evidence, not source intentions.

Automatic reject:
- generic AI-looking UI;
- native/browser chrome that violates the design contract;
- visual regression hidden behind functional success;
- extra decorative UI not required by the packet;
- unclear hierarchy, clipped text, broken density, placeholder imagery, fake counts/data;
- interaction that technically works but is materially worse than the previous build.

A critic cannot patch the issue it rejects.

## 7. Release gate

The Release Manager checks:

- manifest is valid and status is `DONE`;
- verifier PASS recorded with evidence;
- critic PASS recorded when required;
- CI green;
- no unrelated files changed;
- no temporary debug code, disabled tests, snapshots accepted blindly, or TODO theatre;
- before→after delta is concrete.

Then it may integrate the packet.

## 8. Delta ledger

Every completed packet must record:

| Field | Requirement |
|---|---|
| Before | Observable defect/missing behavior |
| After | Observable product behavior now present |
| Proof | Test, screenshot, runtime steps, measurement |
| Regression protection | Test or invariant that prevents silent loss |
| New debt | Explicitly stated, or `none` |

If `Before` and `After` are materially the same, the packet did not produce progress and cannot be DONE.

## 9. WIP limits

Default limits:
- P0: unlimited only when independent emergencies exist.
- P1: maximum 2 ACTIVE packets repository-wide.
- P2/P3: maximum 1 ACTIVE packet while a P0/P1 packet exists.
- Visual polish: maximum 1 ACTIVE packet, and it cannot pre-empt broken P0/P1 editor behavior.

The Governor may change limits only by recording the reason in the manifest.

## 10. Anti-loop rules

An agent must not:
- audit the same rejected item again unless new evidence exists;
- create a new plan to replace an active plan;
- rename/restructure modules as a proxy for product progress;
- create a parallel implementation of an existing subsystem to avoid fixing it;
- mark a feature `PROVEN_WORKING` based only on unit tests when the user path was not exercised;
- continue after three rejection cycles without Governor intervention.

After the third rejection of one packet, Governor must choose one: narrow scope, change builder, approve architecture change, or revert/de-scope.

## 11. Product progression board

`docs/agents/PRODUCT-DELTA.md` is the scoreboard. It is not a wishlist. Only verified packets change its counts/statuses.

The release question is always:

> What can a designer reliably do in this build that they could not reliably do in the previous accepted build?

If the answer is vague, do not release.