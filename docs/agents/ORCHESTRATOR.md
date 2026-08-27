# VIRO Resident Orchestrator

The Orchestrator is the repository's internal work-control plane. It exists to make multiple AI agents behave as one engineering team instead of a collection of independent coders.

It does **not** replace the Governor, Builder, Verifier, Critic or Release Manager. It routes work between them and prevents conflicting ownership.

## Why this exists

A multi-agent system fails when two workers can independently decide:

- what to work on;
- which files they may change;
- whether a neighboring defect is now part of their scope;
- whether their own implementation is acceptable;
- whether a rejected implementation should be replaced by a parallel rewrite.

The resident worker removes those freedoms from individual agents. Work comes from delivery manifests and moves through a shared state machine.

## Shared control plane

Configuration: `.viro/orchestrator.json`

Primary REST worker: `scripts/viro-orchestrator.mjs`

Git-transport worker: `scripts/viro-orchestrator-git.mjs`

Pure scheduling/lease logic: `scripts/lib/orchestrator-core.mjs`

Git transport store: `scripts/lib/git-control-store.mjs`

Shared runtime state is stored on the dedicated GitHub branch `viro-agent-control` at `.viro-control/state.json` by default. This is intentional: coordination state is shared by every computer but is not mixed into product commits on `main`.

There is **one state, not one state per transport**.

### REST transport

`scripts/viro-orchestrator.mjs` uses GitHub's Contents API with the current blob SHA. If two machines update the same state concurrently, one update wins and the loser reloads the current state before retrying. This requires direct GitHub API access plus a `GITHUB_TOKEN` with repository Contents read/write permission.

### Git transport

Some cloud coding environments can use the repository's authenticated git remote but deny direct `api.github.com` fetches. Those workers use `scripts/viro-orchestrator-git.mjs`.

The Git transport reads the exact same `viro-agent-control` branch, creates a state-only commit with git plumbing, and pushes with:

`git push --force-with-lease=refs/heads/viro-agent-control:<observed-base-sha>`

`--force-with-lease` is the compare-and-swap guard. A stale worker cannot overwrite newer shared state. On a race it must fetch, re-evaluate the mutation and retry.

The Git transport is a connectivity fallback, not permission to bypass the Orchestrator. If neither REST nor authenticated git fetch/push can safely read/write the shared state, the worker may inspect/research but must not start non-trivial implementation.

## State machine

New delivery:

`AUDIT → BUILD → VERIFY → CRITIC → RELEASE APPROVAL → AUTO MERGE → DONE`

When the manifest marks Critic `NOT_APPLICABLE`:

`VERIFY → RELEASE APPROVAL → AUTO MERGE → DONE`

`advance` may not move a release packet directly to `DONE`. Only the release worker may set `DONE`, and only after GitHub returns a real merge SHA for `main`.

A rejection from Verify, Critic or Release routes the same packet back to BUILD and increments its attempt count. It does not create a competing packet.

### Historical reconciliation

A gap audit may prove that the packet's stated before-state is stale because the target already landed on `main` before packet activation. In that case the Governor may mark the packet `RECONCILED` with concrete commit/source/test evidence.

`RECONCILED` is terminal and satisfies historical dependency edges, but it is **not** retroactive pipeline completion. Builder and Verifier are `NOT_APPLICABLE`; their PASS verdicts must never be fabricated.

Use reconciliation to remove obsolete work from the executable queue, then activate the smallest real remaining gap.

## Packet leases

The lease is the central anti-conflict mechanism.

When a packet is first claimed, its `allowed_paths` become a shared lease. The lease stays active across agent handoffs, including periods where no agent is currently assigned. It is released only when:

- the packet is actually merged and becomes `DONE`;
- the packet is truthfully `RECONCILED` as historical work;
- the Governor blocks the packet; or
- the Governor explicitly reaps an abandoned assignment and inspects it before reassignment.

A second packet whose declared paths overlap an existing lease cannot be claimed.

This means a Builder cannot finish, hand off to Verifier, and have another Builder start changing the same files while verification is still happening.

## Dependency graph

Delivery manifests may declare `depends_on` packet IDs. A downstream packet is not claimable until every dependency is terminal as `DONE` or `RECONCILED`.

Use dependencies for real ordering constraints, not to create a long speculative roadmap. File leases handle collision; dependencies handle logical prerequisites.

## Agent identity and WIP

Each agent uses a stable ID such as `claude-editor-pc1` or `cursor-ui-pc2`.

One agent may hold only one packet at a time. The system is intentionally optimized for completion rather than maximum agent occupancy.

## Choosing a transport

Prefer REST:

```bash
node scripts/viro-orchestrator.mjs sync
node scripts/viro-orchestrator.mjs check
```

If direct GitHub API access is blocked/403 but the git remote can fetch and push, use Git transport for the whole session:

```bash
node scripts/viro-orchestrator-git.mjs sync
node scripts/viro-orchestrator-git.mjs check
```

Do not alternate transports casually inside one assignment. Both are concurrency-safe, but keeping one transport for a session makes incident evidence simpler.

## Common commands

The examples below use `$ORCH`; set it conceptually to either:

- `node scripts/viro-orchestrator.mjs`, or
- `node scripts/viro-orchestrator-git.mjs`.

Claim work:

```bash
$ORCH claim --agent claude-export-pc1 --role builder --packet VIRO-0005
```

Read the exact assignment contract:

```bash
$ORCH brief --agent claude-export-pc1
```

Record liveness during long work:

```bash
$ORCH heartbeat --agent claude-export-pc1
```

Handoff with evidence:

```bash
$ORCH advance \
  --agent claude-export-pc1 \
  --packet VIRO-0005 \
  --evidence "commit abc123||targeted PDF test green||single-contour regression green"
```

Reject back to Build:

```bash
$ORCH reject \
  --agent verifier-pc3 \
  --packet VIRO-0005 \
  --reason "exported subtract ring fills its centre in PDF"
```

Block an externally constrained packet:

```bash
$ORCH block \
  --packet VIRO-0100 \
  --reason "provider credentials not provisioned"
```

Governor historical reconciliation through Git transport when appropriate:

```bash
node scripts/viro-orchestrator-git.mjs reconcile \
  --packet VIRO-0002 \
  --by governor \
  --evidence "84936c2 is ancestor of main||boolean regression evidence proves target state"
```

## What an agent receives

A claim produces a dedicated work-branch name and a scope lease. `brief` returns:

- packet ID and title;
- desired product outcome;
- current pipeline stage;
- required role;
- work branch;
- allowed paths;
- dependencies;
- previous rejection/evidence;
- team rules.

That brief is the agent's work contract. A worker must not treat repository browsing as permission to modify neighboring surfaces.

## Conflict policy

When work overlaps, do not split the same file between agents by function or line number. Serialize it under one packet/integrator. File-level parallelism on shared architectural seams creates merge success but semantic conflict.

The worker is deliberately conservative with glob overlap. When uncertain, it treats scopes as conflicting. Losing some parallelism is cheaper than reconciling two incompatible implementations.

## Stale workers

A heartbeat older than the configured TTL is reported as stale, but the worker does not automatically reassign it. The Governor must inspect the branch/worktree and explicitly reap the assignment. Reaping blocks the packet and releases its lease for a deliberate recovery decision.

This prevents a slow machine from being mistaken for a dead worker and duplicated by another agent.

## Tool neutrality

The worker does not care whether the implementation agent is Claude Code, Cursor, Codex, another coding tool, or a human developer. The only requirements are:

1. use the same repository;
2. use the same `viro-agent-control` shared state through a supported transport;
3. use a unique stable agent ID;
4. stay inside the assigned scope;
5. hand off through the state machine;
6. never fabricate work when a gap audit proves the target is already delivered.

This is the seam that allows VIRO's development team to span multiple computers and AI coding tools without letting those tools independently govern the product.
