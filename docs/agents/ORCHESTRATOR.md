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

Worker: `scripts/viro-orchestrator.mjs`

Pure scheduling/lease logic: `scripts/lib/orchestrator-core.mjs`

Shared runtime state is stored on the dedicated GitHub branch `viro-agent-control` at `.viro-control/state.json` by default. This is intentional: the coordination state is shared by every computer but is not mixed into product commits on `main`.

Writes use GitHub's Contents API with the current blob SHA. If two machines update the same state concurrently, one update wins and the loser reloads the current state before retrying. This prevents silent last-writer-wins assignment races.

A `GITHUB_TOKEN` with repository Contents read/write permission is required for state-changing commands.

## State machine

`AUDIT → BUILD → VERIFY → CRITIC → RELEASE → DONE`

When the delivery manifest marks Critic as `NOT_APPLICABLE`, the worker routes:

`VERIFY → RELEASE`

A rejection from Verify, Critic or Release routes the same packet back to BUILD and increments its attempt count. It does not create a competing packet.

## Packet leases

The lease is the central anti-conflict mechanism.

When a packet is first claimed, its `allowed_paths` become a shared lease. The lease stays active across agent handoffs, including periods where no agent is currently assigned. It is released only when:

- the packet reaches DONE;
- the Governor blocks the packet; or
- the Governor explicitly reaps an abandoned assignment and inspects it before reassignment.

A second packet whose declared paths overlap an existing lease cannot be claimed.

This means a Builder cannot finish, hand off to Verifier, and have another Builder start changing the same files while verification is still happening.

## Dependency graph

Delivery manifests may declare `depends_on` packet IDs. A downstream packet is not claimable until every dependency is DONE.

Use dependencies for real ordering constraints, not to create a long speculative roadmap. File leases handle collision; dependencies handle logical prerequisites.

## Agent identity and WIP

Each agent uses a stable ID such as `claude-editor-pc1` or `cursor-ui-pc2`.

One agent may hold only one packet at a time. The system is intentionally optimized for completion rather than maximum agent occupancy.

## Commands

Bootstrap once after the pipeline is merged:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs bootstrap
```

Import/synchronize delivery manifests:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs sync
```

See the team board and run integrity checks:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs status
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs check
```

Claim work:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs claim \
  --agent claude-editor-pc1 \
  --role editor-engineer \
  --packet VIRO-0002
```

Read the exact assignment contract:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs brief --agent claude-editor-pc1
```

Record liveness during long work:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs heartbeat --agent claude-editor-pc1
```

Handoff with evidence:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs advance \
  --agent claude-editor-pc1 \
  --packet VIRO-0002 \
  --evidence "commit abc123||migration test green||rendering evidence inspected"
```

Reject back to Build:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs reject \
  --agent verifier-pc3 \
  --packet VIRO-0002 \
  --reason "save/reopen loses the inner contour"
```

Block an externally constrained packet:

```bash
GITHUB_TOKEN=... node scripts/viro-orchestrator.mjs block \
  --packet VIRO-0100 \
  --reason "provider credentials not provisioned"
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
2. use the shared orchestrator state;
3. use a unique stable agent ID;
4. stay inside the assigned scope;
5. hand off through the state machine.

This is the seam that allows VIRO's development team to span multiple computers and AI coding tools without letting those tools independently govern the product.