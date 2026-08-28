# Orchestrator Worker Identity — Session-Bound Claims (VIRO-0019)

Status: delivered by VIRO-0019 (builder `zcode-govtool-pc2`, machine `pc-cloud1`).
Scope: `scripts/lib/orchestrator-core.mjs`, `scripts/lib/git-control-store.mjs` (untouched),
`scripts/viro-orchestrator.mjs`, `scripts/viro-orchestrator-git.mjs`, `scripts/viro-release.mjs`.

## Problem

Before VIRO-0019, a worker identity was a convention: `claim --agent ID --role ROLE --machine NAME`
recorded the machine as evidence but nothing validated it, and nothing bound a *session* to a claim.
Two live processes on two machines could operate under the same worker ID (one clobbering the
other's heartbeat), and the only protection was the single-assignment rule
("`X` already owns `Y`"). Mandate 2026-08-27 §14 required authenticated-feeling identity evidence
without introducing an auth service.

## Session-token scheme

- A claim carries `machine` + `session`. Each transport CLI mints a fresh token per claim
  (`crypto.randomUUID()`) unless `--session TOKEN` is supplied.
- The claim output prints the token. Hardened workers pass it back via `--session` on
  `heartbeat`, `advance`, `reject`, and on re-`claim`.
- Storage is additive: `agents[ID].{machine, session}`, `packets[ID].{assigned_machine,
  assigned_session}`, `leases[ID].current_session`. `packet.claimed`, `agent.session_resumed`,
  `agent.session_adopted`, `agent.heartbeat`, `packet.advanced`, `packet.rejected`, and
  `release.approved` events record `machine`/`session` where applicable.
- `brief` returns an `identity` block (`machine`, `session`, `session_display`, `heartbeat_at`);
  the team board adds `machine`, `session` (8-char prefix), and `heartbeat` columns.
- The token is an **identity-disambiguation token, not an authentication secret**. It is stored
  in the shared state deliberately so every worker can observe who holds what. It must never be
  presented as an auth capability; the CAS guards (`--force-with-lease`, Contents-API blob SHA)
  remain the write-integrity mechanism.

### Enforcement rules (orchestrator-core)

`claim` for a worker ID that already owns a packet evaluates session evidence against the stored
record, using the configured TTL (`lease_ttl_minutes`, currently 30):

| Stored evidence | Incoming session | Heartbeat | Result |
| --- | --- | --- | --- |
| session `S` | `S`, same machine | any | **Resume**: idempotent, refreshes heartbeat (`agent.session_resumed`). |
| session `S` | `S`, different machine | any | **Refused** (`IdentityConflictError`): a session is machine-bound. |
| session `S` | different token | unexpired | **Refused**: `duplicate live identity refused: worker 'X' already owns P under session '…' …` Exit code 1, no state mutation. |
| session `S` | different token | expired | **Refused**: stale assignment must be reaped by the Governor; no silent takeover. |
| none (legacy state) | any token | any | **Adopt** (`agent.session_adopted`): one-time migration bridge, then fully protected. |
| any | no `--session` (old worker) | any | Legacy behavior: fresh claims proceed; re-claims get the historic "`X` already owns `Y`" error. |

`heartbeat` / `advance` / `reject` enforce the same rule when a `--session` token is supplied:
mismatch with the stored live session is refused. Omitting `--session` keeps legacy behavior, so
a pre-identity worker can always finish its handoff. `viro-release.mjs approve` accepts an
optional `--session` and refuses a mismatch against the stored release-manager session.

Refusals throw `IdentityConflictError` **before any state mutation**: the transports only write
state when the mutation succeeds, so a refused duplicate leaves revision, events, and heartbeats
untouched (unit-tested).

## Compatibility contract

Both directions, no big-bang:

1. **New code + old state (pre-identity state file).** All new fields are optional and default to
   `null`. Legacy agent records without `session` are "unverified": enforcement degrades to the
   historic behavior, and the first re-claim *adopts* the presented token (migration bridge).
   Unit-tested against a constructed pre-change fixture (`legacyState()` in
   `scripts/lib/orchestrator-core.test.mjs`) covering load, `importManifest`, `heartbeat`,
   `advance`, `reject`, `claim`, and lease `acquired_at` preservation.
2. **Old code + new state.** Old workers never send `--session`; every new check is skipped.
   Old transports `JSON.parse`/`JSON.stringify` the whole draft, so unknown fields ride through
   writes untouched. Proven live: the pre-merge orchestrator at `main` 72b05f0 heartbeated the
   new-schema VIRO-0019 assignment and all identity fields survived.
3. **Schema discipline.** No field was removed or renamed; `normalizePacket` continues to pass
   through unknown packet fields because packets are mutated in place (never wholesale-replaced
   after import).

## Migration path (no big-bang)

- Existing live assignments keep working unchanged (rule table, last row).
- Identity attaches lazily: each assignment becomes session-protected on its first post-merge
  re-claim (`agent.session_adopted`) or at its next natural claim.
- Workers should start passing `--session` as they pick up the new code; the brief's rules list
  reminds them. There is no cut-over commit at which old workers break.

## Known limitations (recorded, not silently ignored)

- `scopesOverlap` pins conservative prefix semantics: a glob's static prefix conflicts only via
  equality or directory-ancestor relations (`tests/autosave-*` and `tests/autosave-recovery.spec.mjs`
  are treated as disjoint). This is what lets the Governor hand disjoint `tests/<area>-*` leases
  per packet; tightening it later would re-shape live leases and is out of VIRO-0019 scope.
- The session token protects against *accidental* duplicate identities, not a malicious impersonator
  who reads the shared branch; real auth remains a hosted-platform concern (ADR 0004).
- REST transport could not be exercised live in the build environment (no `GITHUB_TOKEN`);
  it shares 100% of the identity logic through `orchestrator-core` and parses cleanly
  (`node --check`). The Git transport was proven live end-to-end.

## Test + evidence entry points

- Unit tests: `node --test scripts/lib/` (23 tests; on Windows/Node 24 the directory arg is
  dispatched through `scripts/lib/package.json` `main` → same suite).
- Duplicate-refusal live dry-run transcript: see `docs/agents/deliveries/VIRO-0019.json`
  `delta.proof` and the packet events on `viro-agent-control`.
