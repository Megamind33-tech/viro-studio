# VIRO Studio — Agent Operating Contract

This repository is governed by `GOVERNOR.md`. Read it before planning, editing, reviewing, or reporting progress. `docs/AAA-BRIEF.md` governs visual quality. This file governs how agents deliver work.

## Prime directive

Agent activity is not progress. A change counts only when the running product gains a verified capability, removes a verified defect, or materially improves a measured quality attribute without regressing proven behavior.

Never report a feature as complete because UI exists, code compiles, a plan was written, or a builder says it works.

## Mandatory orchestration entry point

Before any non-trivial product work begins, use the resident orchestrator described in `docs/agents/ORCHESTRATOR.md`.

Shared work state is controlled by `scripts/viro-orchestrator.mjs`. No Builder, specialist engineer, Verifier, Critic, or Release Manager may begin a packet without a successful orchestrator claim and assignment brief.

The exhaustive unresolved-work inventory is `docs/agents/WORK-REGISTRY.md`. It is an inventory, not permission to self-select work. A registry item becomes executable only when the Governor activates it through a delivery manifest and the Orchestrator grants a conflict-free claim.

For any terminal-capable external worker (Claude Code, Cursor, Codex-style agents or another coding tool), use `docs/agents/UNIVERSAL-WORKER-PROMPT.md` as the standard reporting, handoff and redeployment contract.

The orchestrator owns coordination, not product judgment. It prevents duplicated work by maintaining a shared GitHub-backed queue, dependency graph, packet-level path leases, stable agent identities, handoffs and stale-worker recovery across computers and coding tools.

Required behavior:
- synchronize delivery manifests before assignment;
- check shared state for collisions;
- one agent may own only one packet at a time;
- overlapping packet scopes cannot run concurrently;
- the packet lease survives Builder → Verifier → Critic → Release handoffs;
- rejected work returns to the same packet rather than spawning a parallel rewrite;
- agents work on the branch and paths named in their assignment brief;
- after every handoff, the worker returns to the Orchestrator for redeployment instead of choosing its own next task;
- an agent may not redeploy itself into verifier/critic/release for a packet it built;
- external blockers and stale assignments return to Governor control.

## Mandatory pipeline

Every non-trivial task follows this sequence:

1. **Governor** — selects one measurable outcome and freezes scope.
2. **Gap Auditor** — establishes before-state from repository/runtime evidence.
3. **Builder** — implements only within its assigned domain and allowed paths.
4. **Verifier** — independently reproduces acceptance tests and regression gates.
5. **Critic** — independently judges product/UX quality and rejects weak or generic output.
6. **Release Manager** — integrates only when verifier and critic both pass, then records the before→after delta.

The resident Orchestrator routes the packet between these roles but may not perform their substantive responsibilities.

Builders may not verify or approve their own work. Critics may not repair the work they judge. The Governor may not silently broaden scope.

## No sideways development

Do not start unrelated features while an active P0/P1 work packet is PARTIAL or REJECTED. Finish, revert, or explicitly de-scope it through the Governor first.

Forbidden substitutes for completion:
- another audit of the same unresolved item;
- another architecture document without an implementation blocker that requires it;
- cosmetic relocation of existing UI;
- decorative controls, fake states, sample counts, fake success messages, placeholder features, mock production data;
- adding a new framework/state store/rendering engine to avoid finishing the current system;
- rewriting proven working code without a regression test and explicit reason.

## Work packet requirement

Before production code changes, create one delivery manifest under `docs/agents/deliveries/` using `docs/agents/DELIVERY.schema.json` as the contract. It must name:
- outcome and domain owner;
- before-state and target after-state;
- allowed production paths;
- dependencies when another packet must complete first;
- acceptance tests;
- evidence to capture;
- verifier and critic verdicts.

The GitHub gate rejects production changes that are not covered by a delivery manifest.

## Definition of done

A capability is DONE only when all applicable conditions are true:
- real interaction exists end-to-end;
- state is real, not decorative;
- persistence/save-reload is proven when state should persist;
- undo/redo is proven for document mutations;
- keyboard/accessibility/error/loading/empty behavior is handled where applicable;
- no new TODO/FIXME/HACK/"coming soon"/"not implemented" production theatre is introduced;
- no skipped tests are added;
- TypeScript, tests, and production build pass;
- runtime evidence exists for user-visible work;
- verifier verdict is PASS;
- critic verdict is PASS for user-visible work;
- the delivery manifest records a concrete before→after delta.

Otherwise classify the work as PARTIAL, BLOCKED, or REJECTED.

## Parallelism rule

Parallel agents must own disjoint production areas defined in `docs/agents/OWNERSHIP.md` and must also hold non-overlapping orchestrator leases. If two agents need the same file, the Governor serializes that work or assigns one integrator. Do not let teammates edit the same implementation surface concurrently.

## Required reading by role

- Orchestrator: `GOVERNOR.md`, `CLAUDE.md`, `docs/agents/ORCHESTRATOR.md`, `docs/agents/PIPELINE.md`, `docs/agents/OWNERSHIP.md`, `docs/agents/WORK-REGISTRY.md`
- Governor: `GOVERNOR.md`, `docs/agents/PIPELINE.md`, `docs/agents/OWNERSHIP.md`, `docs/agents/WORK-REGISTRY.md`, orchestrator state
- Auditor: above + relevant source/tests + current delivery manifests
- Builder: above + orchestrator assignment brief + assigned `.claude/agents/*.md` role file
- Verifier: `GOVERNOR.md`, delivery manifest, orchestrator evidence history, tests, runtime evidence
- Critic: `docs/AAA-BRIEF.md`, `docs/CRITIC.md`, delivery manifest, screenshots/runtime
- Release Manager: all verdicts + orchestrator evidence + CI result + before/after delta

## Reporting format

Every agent handoff ends with exactly these facts:
- `STATUS:` PASS | PARTIAL | BLOCKED | REJECTED | IDLE_NO_ASSIGNMENT
- `PACKET:` packet id or `none`
- `ROLE:` current orchestrator role
- `CHANGED:` concrete files or `none`
- `PROVED:` commands/evidence actually run or inspected
- `FAILED:` remaining failures or `none`
- `HANDOFF:` next orchestrator stage/role or `none`
- `REDEPLOYMENT:` new packet id or `IDLE_NO_ASSIGNMENT`

Do not use percentages unless they are derived from an explicit checklist with counted items.