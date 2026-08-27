# VIRO Agent Entry Contract

This repository uses a shared resident work orchestrator. These rules apply to every coding agent or human automation that is not already governed by a more specific tool file.

Before modifying product code:

1. Read `GOVERNOR.md`, `CLAUDE.md`, `docs/agents/ORCHESTRATOR.md`, `docs/agents/OWNERSHIP.md`, `docs/agents/WORK-REGISTRY.md`, and `docs/agents/AUTO-MERGE.md`.
2. Use `docs/agents/UNIVERSAL-WORKER-PROMPT.md` as the standard operating prompt for terminal-capable coding tools.
3. Use a stable worker identity that names the tool and seat, for example `codex-editor-pc3`.
4. Synchronize and check the shared control plane:
   - `node scripts/viro-orchestrator.mjs sync`
   - `node scripts/viro-orchestrator.mjs check`
5. Claim exactly one packet with the role you are actually serving.
6. Read your assignment with `brief --agent <id>`.
7. Modify only the paths in that assignment. Repository visibility is not edit permission.
8. Record heartbeats during long work.
9. Hand off with concrete evidence. Do not mark your own work verified.
10. After handoff, return to the Orchestrator for redeployment. Do not choose the next registry item yourself.

The Master Work Registry is an inventory, not an open buffet. A row in `docs/agents/WORK-REGISTRY.md` becomes executable only when the Governor activates it as a delivery manifest and the Orchestrator grants a conflict-free claim.

If a claim is refused because another packet owns overlapping scope, do not work around the lease, create a duplicate implementation, or switch to a neighboring file to achieve the same change. The collision is intentional and must be resolved by the Governor/Orchestrator.

If `GITHUB_TOKEN` or shared-state access is unavailable, do not begin non-trivial product edits. You may inspect or research, but implementation must wait until the packet can be claimed.

A rejected packet returns to Build under the same packet ID. Do not spawn a parallel rewrite.

An agent that built a packet may not redeploy itself as verifier, critic, or release manager for that same packet. Independent gates remain independent even when the same underlying AI product is available on several machines.

## Merge authority

No worker manually merges a packet to `main`.

Builders, auditors, verifiers, critics, research agents, and ordinary engineers have zero merge authority.

A Release Manager may approve an exact release-candidate SHA only after the required independent gates. It must submit approval through:

`node scripts/viro-release.mjs approve --agent <id> --packet <packet> --evidence "..."`

The resident Orchestrator release worker then merges automatically when the required GitHub checks are green. If checks are pending, `.github/workflows/auto-merge-approved.yml` re-evaluates approved packets after successful workflow completion. A new commit after approval invalidates the approval.

A packet is `DONE` only after the Orchestrator records a real GitHub merge SHA. Approval without merge is still `RELEASE`.

The objective is not maximum agent utilization. The objective is one coherent product advanced through conflict-free, independently verified deltas that enter `main` only through the controlled automatic release path.
