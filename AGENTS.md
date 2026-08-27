# VIRO Agent Entry Contract

This repository uses a shared resident work orchestrator. These rules apply to every coding agent or human automation that is not already governed by a more specific tool file.

Before modifying product code:

1. Read `GOVERNOR.md`, `CLAUDE.md`, and `docs/agents/ORCHESTRATOR.md`.
2. Use a stable worker identity that names the tool and seat, for example `codex-editor-pc3`.
3. Synchronize and check the shared control plane:
   - `node scripts/viro-orchestrator.mjs sync`
   - `node scripts/viro-orchestrator.mjs check`
4. Claim exactly one packet with the role you are actually serving.
5. Read your assignment with `brief --agent <id>`.
6. Modify only the paths in that assignment. Repository visibility is not edit permission.
7. Record heartbeats during long work.
8. Hand off with concrete evidence. Do not mark your own work verified.

If a claim is refused because another packet owns overlapping scope, do not work around the lease, create a duplicate implementation, or switch to a neighboring file to achieve the same change. The collision is intentional and must be resolved by the Governor/Orchestrator.

If `GITHUB_TOKEN` or shared-state access is unavailable, do not begin non-trivial product edits. You may inspect or research, but implementation must wait until the packet can be claimed.

A rejected packet returns to Build under the same packet ID. Do not spawn a parallel rewrite.

The objective is not maximum agent utilization. The objective is one coherent product advanced through conflict-free, independently verified deltas.