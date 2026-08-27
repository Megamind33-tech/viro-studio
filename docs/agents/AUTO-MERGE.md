# VIRO Automatic Merge Contract

The resident Orchestrator owns merges to `main`. Individual builders, auditors, verifiers, critics, and coding tools do not merge their own work.

## Release state machine

`BUILD → VERIFY → CRITIC (when applicable) → RELEASE REVIEW → RELEASE APPROVED → CI GREEN → AUTO MERGE → DONE`

`DONE` means GitHub has returned a real merge SHA for the packet PR. Release approval alone is not DONE.

## Automatic merge authority

Only the `release-manager` may approve a packet for merge, and only while it owns that packet's `release` stage. Approval is performed with:

```bash
node scripts/viro-release.mjs approve \
  --agent "$WORKER_ID" \
  --packet <PACKET_ID> \
  --evidence "<release proof 1>||<release proof 2>"
```

The release worker:

1. confirms the packet is genuinely in `release`;
2. confirms independent verifier evidence exists;
3. confirms critic evidence exists when the packet is user-visible;
4. requires a concrete evidence payload from the release manager;
5. ensures an open PR from the packet branch to `main` exists;
6. records the exact PR number and release-candidate head SHA;
7. releases the release-manager agent for redeployment while retaining the packet's scope lease;
8. evaluates the required GitHub checks;
9. merges automatically when the checks are green;
10. records the merge SHA in shared Orchestrator state;
11. only then sets the packet to `DONE` and releases its file/domain lease.

## Required checks

The default merge gate requires:

- `Delivery policy`
- `Product regression gates`

If `state-machine` (the Orchestrator Integrity check) is present on the PR, it also becomes mandatory and must succeed.

Required checks are configured under `.viro/orchestrator.json`.

## CI-pending behavior

If release approval arrives before CI is complete, the packet remains:

- stage: `release`
- status: `RELEASE`
- release approval: `APPROVED`
- lease: retained

The release manager is freed for other work. `.github/workflows/auto-merge-approved.yml` listens for successful completion of the delivery/integrity workflows and runs:

```bash
node scripts/viro-release.mjs sweep
```

The sweep merges every approved packet whose exact approved SHA now has all required green gates.

If CI was already green when approval was submitted, `approve` merges immediately; no second human/agent action is required.

## SHA binding — no bait-and-switch

Release approval is bound to the exact PR head SHA seen at approval time.

If any worker pushes another commit after approval:

- the approval becomes `STALE`;
- automatic merge is refused;
- the packet remains unmerged;
- fresh release review is required for the new SHA.

An approval for commit A can never authorize commit B.

## Conflict / branch protection behavior

The GitHub merge endpoint remains authoritative for mergeability and repository rules. If the PR has conflicts, is blocked by branch protection, or GitHub refuses the merge, the packet stays out of `DONE` and retains its lease until the condition is resolved.

The Orchestrator must never bypass GitHub branch protection or force-push `main` to simulate a release.

## Branch cleanup

After a successful merge, the packet branch is deleted when `release.delete_branch` is enabled. Failure to delete a branch does not invalidate an already successful merge, but it is reported as cleanup debt.

## Non-negotiable role separation

- Builder: implements and pushes; never merges.
- Verifier: proves or rejects; never merges or repairs.
- Critic: judges user-facing quality; never merges or repairs.
- Release Manager: approves the exact release candidate; never manually merges.
- Orchestrator Release Worker: performs the merge after all gates are satisfied.

This keeps `main` as the product record of independently approved work rather than a shared scratch branch.
