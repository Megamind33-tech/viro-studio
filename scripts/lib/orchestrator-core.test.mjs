// Unit tests for the VIRO orchestrator-core lease/identity state machine (VIRO-0019).
// Run without the product app: node --test scripts/lib/
import test from "node:test";
import assert from "node:assert/strict";
import {
  newState,
  importManifest,
  claimPacket,
  heartbeat,
  advancePacket,
  rejectPacket,
  blockPacket,
  reapAssignment,
  staleAssignments,
  scopesOverlap,
  roleCanServe,
  depsSatisfied,
  conflictingPacket,
  teamBoard,
  assignmentBrief,
  IdentityConflictError,
  shortToken,
} from "./orchestrator-core.mjs";

const MIN = 60_000;
const ISO = (ms) => new Date(ms).toISOString();

function manifest(overrides = {}) {
  return {
    id: "VIRO-9001",
    title: "fixture packet",
    priority: "P2",
    domain: "editor-core",
    outcome: "fixture outcome",
    state: "ACTIVE",
    allowed_paths: ["tests/fixture-a-*"],
    depends_on: [],
    critic: { status: "NOT_APPLICABLE" },
    ...overrides,
  };
}

function freshState(...manifests) {
  const state = newState();
  for (const item of manifests) importManifest(state, item);
  // Delivery manifests enter at audit; move to build so a builder can claim them.
  for (const item of manifests) state.packets[item.id].stage = "build";
  return state;
}

// A state shaped exactly like the pre-VIRO-0019 code wrote it: claims carry `machine`
// but no session fields anywhere (agents, packets, leases, events).
function legacyState({ heartbeatAgeMs = 2 * MIN } = {}) {
  const state = newState();
  const now = Date.now();
  state.packets["VIRO-8001"] = {
    id: "VIRO-8001", title: "legacy queued", priority: "P2", domain: "editor-core", outcome: "o",
    scope: ["tests/legacy-a-*"], dependencies: [], critic_needed: true,
    stage: "build", status: "QUEUED",
    assigned_agent: null, assigned_role: null, work_branch: null, heartbeat_at: null,
    attempts: 0, evidence: [], last_handoff: null, rejection: null,
  };
  state.packets["VIRO-8002"] = {
    id: "VIRO-8002", title: "legacy active", priority: "P2", domain: "editor-core", outcome: "o",
    scope: ["tests/legacy-b-*"], dependencies: [], critic_needed: true,
    stage: "build", status: "ACTIVE",
    assigned_agent: "legacy-worker", assigned_role: "builder",
    work_branch: "agent/viro-8002/legacy-worker",
    heartbeat_at: ISO(now - heartbeatAgeMs),
    attempts: 0, evidence: [], last_handoff: null, rejection: null,
  };
  state.agents["legacy-worker"] = { role: "builder", machine: "pc-old", packet: "VIRO-8002", heartbeat_at: ISO(now - heartbeatAgeMs) };
  state.leases["VIRO-8002"] = {
    packet: "VIRO-8002", scope: ["tests/legacy-b-*"], acquired_at: ISO(now - 3 * MIN),
    current_agent: "legacy-worker", current_stage: "build",
  };
  state.events = [{ at: ISO(now - 3 * MIN), type: "packet.claimed", packet: "VIRO-8002", agent: "legacy-worker", role: "builder", machine: "pc-old" }];
  return state;
}

test("newState has the expected empty shape", () => {
  const state = newState();
  assert.equal(state.version, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.packets, {});
  assert.deepEqual(state.agents, {});
  assert.deepEqual(state.leases, {});
  assert.deepEqual(state.events, []);
});

test("scopesOverlap: disjoint test prefixes do not conflict", () => {
  assert.equal(scopesOverlap(["tests/autosave-*"], ["tests/import-*"]), false);
  assert.equal(scopesOverlap(["tests/autosave-recovery.spec.mjs"], ["tests/import-*"]), false);
  assert.equal(scopesOverlap(["tests/autosave-*", "tests/import-*"], ["tests/projects-*"]), false);
});

test("scopesOverlap: wildcard prefixes, nesting, and equality conflict", () => {
  assert.equal(scopesOverlap(["tests/autosave-*"], ["tests/autosave-*"]), true);
  assert.equal(scopesOverlap(["scripts/lib/**"], ["scripts/lib/orchestrator-core.mjs"]), true);
  assert.equal(scopesOverlap(["src/document/**"], ["src/document/command-bus.ts"]), true);
  assert.equal(scopesOverlap(["tests/import-*"], ["tests/import-*"]), true);
  assert.equal(scopesOverlap(["src/**"], ["docs/**"]), false);
});

test("scopesOverlap: current prefix semantics keep narrowed per-packet test prefixes disjoint", () => {
  // Pinned live behavior: a glob's static prefix collides only through equality or a
  // directory-ancestor relation, so `dir/pfx-*` and `dir/pfx-file.ext` do NOT conflict.
  // This is what allows the Governor to hand disjoint `tests/<area>-*` leases per packet.
  assert.equal(scopesOverlap(["tests/autosave-*"], ["tests/autosave-recovery.spec.mjs"]), false);
  assert.equal(scopesOverlap(["tests/autosave-spec-*"], ["tests/autosave-*"]), false);
});

test("scopesOverlap: an empty string pattern conflicts conservatively; an empty list never does", () => {
  // Pinned live behavior: "" yields an empty static prefix -> conservative conflict,
  // while a packet that declares no paths at all overlaps nothing.
  assert.equal(scopesOverlap([""], ["tests/anything"]), true);
  assert.equal(scopesOverlap([], ["tests/anything"]), false);
});

test("roleCanServe at each pipeline stage", () => {
  const packet = (stage, domain = "editor-core") => ({ stage, domain, critic_needed: true });
  assert.equal(roleCanServe("gap-auditor", packet("audit")), true);
  assert.equal(roleCanServe("builder", packet("audit")), false);
  assert.equal(roleCanServe("verifier", packet("audit")), false);

  assert.equal(roleCanServe("editor-engineer", packet("build")), true);
  assert.equal(roleCanServe("builder", packet("build")), true); // builder fallback at build
  assert.equal(roleCanServe("verifier", packet("build")), false);
  assert.equal(roleCanServe("release-manager", packet("build")), false);

  assert.equal(roleCanServe("verifier", packet("verify")), true);
  assert.equal(roleCanServe("builder", packet("verify")), false);

  assert.equal(roleCanServe("critic", packet("critic")), true);
  assert.equal(roleCanServe("verifier", packet("critic")), false);

  assert.equal(roleCanServe("release-manager", packet("release")), true);
  assert.equal(roleCanServe("critic", packet("release")), false);

  assert.equal(roleCanServe("release-manager", packet("done")), false);
  assert.equal(roleCanServe("builder", packet("done")), false);
  assert.equal(roleCanServe(null, packet("build")), false);
});

test("depsSatisfied: DONE and RECONCILED satisfy; queued/blocked/unknown do not", () => {
  const state = newState();
  state.packets["VIRO-D1"] = { status: "DONE" };
  state.packets["VIRO-D2"] = { status: "RECONCILED" };
  state.packets["VIRO-Q1"] = { status: "QUEUED" };
  state.packets["VIRO-B1"] = { status: "BLOCKED" };
  assert.equal(depsSatisfied({ dependencies: [] }, state), true);
  assert.equal(depsSatisfied({ dependencies: ["VIRO-D1", "VIRO-D2"] }, state), true);
  assert.equal(depsSatisfied({ dependencies: ["VIRO-Q1"] }, state), false);
  assert.equal(depsSatisfied({ dependencies: ["VIRO-B1"] }, state), false);
  assert.equal(depsSatisfied({ dependencies: ["VIRO-MISSING"] }, state), false);
});

test("claim binds identity, creates the lease, and preserves acquired_at across handoffs", () => {
  const state = freshState(manifest());
  const packet = claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-aaa", ttlMinutes: 30 });
  assert.equal(packet.assigned_agent, "worker-a");
  assert.equal(packet.assigned_machine, "pc-1");
  assert.equal(packet.assigned_session, "sess-aaa");
  assert.equal(packet.status, "ACTIVE");
  assert.equal(packet.work_branch, "agent/viro-9001/worker-a");
  assert.equal(state.agents["worker-a"].session, "sess-aaa");
  assert.equal(state.leases["VIRO-9001"].current_agent, "worker-a");
  assert.equal(state.leases["VIRO-9001"].current_session, "sess-aaa");
  const acquired = state.leases["VIRO-9001"].acquired_at;

  advancePacket(state, { agentId: "worker-a", packetId: "VIRO-9001", evidence: ["proof"], session: "sess-aaa" });
  const again = claimPacket(state, { agentId: "worker-b", role: "verifier", machine: "pc-2", session: "sess-bbb", ttlMinutes: 30 });
  assert.equal(again.id, "VIRO-9001");
  assert.equal(state.leases["VIRO-9001"].acquired_at, acquired); // lease persists across handoffs
});

test("claim refuses packets whose scope collides with an active lease", () => {
  const state = freshState(
    manifest({ id: "VIRO-9001", allowed_paths: ["tests/autosave-*"] }),
    manifest({ id: "VIRO-9002", allowed_paths: ["tests/autosave-*", "docs/autosave.md"] }),
    manifest({ id: "VIRO-9003", allowed_paths: ["tests/import-*"] }),
  );
  claimPacket(state, { agentId: "worker-a", role: "builder", preferredId: "VIRO-9001", machine: "pc-1", session: "s1", ttlMinutes: 30 });
  assert.equal(conflictingPacket(state.packets["VIRO-9002"], state).id, "VIRO-9001");
  assert.equal(conflictingPacket(state.packets["VIRO-9003"], state), null);
  assert.throws(
    () => claimPacket(state, { agentId: "worker-b", role: "builder", preferredId: "VIRO-9002", machine: "pc-2", session: "s2", ttlMinutes: 30 }),
    /No conflict-free packet/,
  );
  claimPacket(state, { agentId: "worker-b", role: "builder", preferredId: "VIRO-9003", machine: "pc-2", session: "s2", ttlMinutes: 30 });
});

test("duplicate live identity: same worker ID, different session, unexpired heartbeat is refused", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-live", ttlMinutes: 30 });
  const revision = state.revision;
  const events = state.events.length;
  assert.throws(
    () => claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-2", session: "sess-impersonator", ttlMinutes: 30 }),
    (error) => error instanceof IdentityConflictError && /duplicate live identity refused/.test(error.message),
  );
  // A refusal must not mutate shared state.
  assert.equal(state.revision, revision);
  assert.equal(state.events.length, events);
});

test("same session re-claim resumes the same assignment and refreshes the heartbeat", () => {
  const state = freshState(manifest());
  const first = claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-live", ttlMinutes: 30 });
  const resumed = claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-live", ttlMinutes: 30 });
  assert.equal(resumed.id, first.id);
  assert.equal(state.events.at(-1).type, "agent.session_resumed");
  assert.ok(Date.parse(state.agents["worker-a"].heartbeat_at) >= Date.parse(first.heartbeat_at));
});

test("same session from a different machine is refused (session is machine-bound)", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-live", ttlMinutes: 30 });
  assert.throws(
    () => claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-2", session: "sess-live", ttlMinutes: 30 }),
    (error) => error instanceof IdentityConflictError && /bound to machine 'pc-1'/.test(error.message),
  );
});

test("expired heartbeat with a different session demands a Governor reap instead of a silent takeover", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-old", ttlMinutes: 30 });
  state.packets["VIRO-9001"].heartbeat_at = ISO(Date.now() - 45 * MIN);
  state.agents["worker-a"].heartbeat_at = state.packets["VIRO-9001"].heartbeat_at;
  assert.throws(
    () => claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-2", session: "sess-new", ttlMinutes: 30 }),
    (error) => error instanceof IdentityConflictError && /heartbeat expired/.test(error.message) && /reap/.test(error.message),
  );
});

test("legacy claim without a session keeps the historical refusal message", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", ttlMinutes: 30 });
  assert.throws(
    () => claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-2", ttlMinutes: 30 }),
    (error) => !(error instanceof IdentityConflictError) && /already owns/.test(error.message),
  );
});

test("migration bridge: a session-less legacy assignment adopts identity on first re-claim, then is protected", () => {
  const state = legacyState();
  const adopted = claimPacket(state, { agentId: "legacy-worker", role: "builder", machine: "pc-old", session: "sess-adopted", ttlMinutes: 30 });
  assert.equal(adopted.id, "VIRO-8002");
  assert.equal(state.events.at(-1).type, "agent.session_adopted");
  assert.equal(state.agents["legacy-worker"].session, "sess-adopted");
  assert.equal(state.packets["VIRO-8002"].assigned_session, "sess-adopted");

  // After adoption a different live session under the same worker ID is refused.
  assert.throws(
    () => claimPacket(state, { agentId: "legacy-worker", role: "builder", machine: "pc-elsewhere", session: "sess-impersonator", ttlMinutes: 30 }),
    (error) => error instanceof IdentityConflictError && /duplicate live identity refused/.test(error.message),
  );
  // And the adopted session resumes normally.
  const resumed = claimPacket(state, { agentId: "legacy-worker", role: "builder", machine: "pc-old", session: "sess-adopted", ttlMinutes: 30 });
  assert.equal(resumed.id, "VIRO-8002");
  assert.equal(state.events.at(-1).type, "agent.session_resumed");
});

test("heartbeat/advance/reject enforce the session when one is supplied", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-real", ttlMinutes: 30 });
  state.packets["VIRO-9001"].stage = "build"; // still build so reject-vs-stage ordering is visible

  assert.throws(() => heartbeat(state, "worker-a", { session: "sess-fake" }), IdentityConflictError);
  heartbeat(state, "worker-a"); // legacy caller without a session still works
  heartbeat(state, "worker-a", { session: "sess-real" });

  assert.throws(
    () => advancePacket(state, { agentId: "worker-a", packetId: "VIRO-9001", evidence: ["proof"], session: "sess-fake" }),
    IdentityConflictError,
  );
  const advanced = advancePacket(state, { agentId: "worker-a", packetId: "VIRO-9001", evidence: ["proof"], session: "sess-real" });
  assert.equal(advanced.stage, "verify");
  const advanceEvent = state.events.find((event) => event.type === "packet.advanced");
  assert.equal(advanceEvent.machine, "pc-1");
  assert.equal(advanceEvent.session, "sess-real");

  claimPacket(state, { agentId: "worker-v", role: "verifier", machine: "pc-9", session: "sess-verify", ttlMinutes: 30 });
  assert.throws(
    () => rejectPacket(state, { agentId: "worker-v", packetId: "VIRO-9001", reason: "not good", session: "sess-fake" }),
    IdentityConflictError,
  );
  const rejected = rejectPacket(state, { agentId: "worker-v", packetId: "VIRO-9001", reason: "regression found", session: "sess-verify" });
  assert.equal(rejected.stage, "build");
  assert.equal(rejected.attempts, 1);
  const rejectEvent = state.events.find((event) => event.type === "packet.rejected");
  assert.equal(rejectEvent.session, "sess-verify");
  assert.equal(rejectEvent.machine, "pc-9");
});

test("staleAssignments honours the 30-minute TTL", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "s", ttlMinutes: 30 });
  const now = Date.now();

  state.packets["VIRO-9001"].heartbeat_at = ISO(now - 29 * MIN);
  assert.deepEqual(staleAssignments(state, 30, now), []);

  state.packets["VIRO-9001"].heartbeat_at = ISO(now - 31 * MIN);
  assert.deepEqual(staleAssignments(state, 30, now).map((p) => p.id), ["VIRO-9001"]);

  // Unassigned or terminal packets are never stale.
  const quiet = freshState(manifest({ id: "VIRO-9004" }));
  quiet.packets["VIRO-9004"].heartbeat_at = ISO(now - 999 * MIN);
  assert.deepEqual(staleAssignments(quiet, 30, now), []);
});

test("reapAssignment releases the lease, blocks the packet, and frees the scope", () => {
  const state = freshState(
    manifest({ id: "VIRO-9001", allowed_paths: ["tests/reap-*"] }),
    manifest({ id: "VIRO-9002", allowed_paths: ["tests/reap-*"] }),
  );
  claimPacket(state, { agentId: "worker-a", role: "builder", preferredId: "VIRO-9001", machine: "pc-1", session: "s1", ttlMinutes: 30 });
  state.packets["VIRO-9001"].heartbeat_at = ISO(Date.now() - 31 * MIN);
  assert.equal(staleAssignments(state, 30).map((p) => p.id).includes("VIRO-9001"), true);

  const reaped = reapAssignment(state, { packetId: "VIRO-9001", by: "governor", reason: "stale agent lease" });
  assert.equal(reaped.status, "BLOCKED");
  assert.equal(state.leases["VIRO-9001"], undefined);
  assert.equal(state.agents["worker-a"], undefined);
  assert.equal(reaped.assigned_agent, null);
  assert.equal(conflictingPacket(state.packets["VIRO-9002"], state), null); // lease released
  const reapEvent = state.events.find((event) => event.type === "assignment.reaped");
  assert.equal(reapEvent.agent, "worker-a");

  // A blocked packet is not claimable until the Governor unblocks it.
  assert.throws(
    () => claimPacket(state, { agentId: "worker-b", role: "builder", preferredId: "VIRO-9001", machine: "pc-2", session: "s2", ttlMinutes: 30 }),
    /No conflict-free packet/,
  );
});

test("blockPacket releases the assignment and the lease as a Governor-controlled recovery path", () => {
  const state = freshState(manifest({ id: "VIRO-9005", allowed_paths: ["tests/block-*"] }));
  claimPacket(state, { agentId: "worker-a", role: "builder", preferredId: "VIRO-9005", machine: "pc-1", session: "s1", ttlMinutes: 30 });
  const blocked = blockPacket(state, { packetId: "VIRO-9005", reason: "external blocker", by: "governor" });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(state.leases["VIRO-9005"], undefined);
  assert.equal(state.agents["worker-a"], undefined);
  assert.equal(blocked.assigned_agent, null);
});

test("backward compatibility: legacy pre-session state loads and operates under the new code", () => {
  const state = legacyState();
  importManifest(state, manifest({ id: "VIRO-8001", allowed_paths: ["tests/legacy-a-*"] }));
  assert.equal(state.packets["VIRO-8001"].scope.length, 1); // queued + unleased manifest stays mutable

  // Legacy assigned worker (no session anywhere) can heartbeat and advance under new code.
  heartbeat(state, "legacy-worker");
  assert.ok(Date.parse(state.packets["VIRO-8002"].heartbeat_at) > Date.now() - MIN);
  const advanced = advancePacket(state, { agentId: "legacy-worker", packetId: "VIRO-8002", evidence: ["legacy proof"] });
  assert.equal(advanced.stage, "verify");

  // A new worker with a session can claim the released packet; lease acquired_at is preserved.
  const acquired = state.leases["VIRO-8002"].acquired_at;
  claimPacket(state, { agentId: "fresh-verifier", role: "verifier", machine: "pc-new", session: "sess-new", ttlMinutes: 30 });
  assert.equal(state.leases["VIRO-8002"].acquired_at, acquired);
  assert.equal(state.leases["VIRO-8002"].current_session, "sess-new");
  rejectPacket(state, { agentId: "fresh-verifier", packetId: "VIRO-8002", reason: "compat proof rejection" });
  assert.equal(state.packets["VIRO-8002"].attempts, 1);

  // Legacy queued packet remains claimable by a builder with session identity.
  const claim = claimPacket(state, { agentId: "new-builder", role: "builder", preferredId: "VIRO-8001", machine: "pc-new", session: "sess-b2", ttlMinutes: 30 });
  assert.equal(claim.assigned_session, "sess-b2");
});

test("backward compatibility: legacy callers (no session) can operate new-schema state", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-real", ttlMinutes: 30 });
  // An old-code worker sends no session; it must still be able to heartbeat and advance.
  heartbeat(state, "worker-a");
  assert.equal(state.agents["worker-a"].session, "sess-real"); // identity record untouched by legacy calls
  const advanced = advancePacket(state, { agentId: "worker-a", packetId: "VIRO-9001", evidence: ["old worker handoff"] });
  assert.equal(advanced.stage, "verify");
  assert.equal(advanced.assigned_session, "sess-real"); // packet evidence rides through the handoff
  // New identity fields ride through a JSON write/read round trip untouched.
  const round = JSON.parse(JSON.stringify(state));
  assert.equal(round.packets["VIRO-9001"].assigned_session, "sess-real");
  assert.equal(round.leases["VIRO-9001"].current_session, "sess-real");
  assert.equal(round.events.some((event) => event.type === "packet.claimed" && event.session === "sess-real"), true);
});

test("identity fields appear in packet events, briefs, and the team board", () => {
  const state = freshState(manifest());
  claimPacket(state, { agentId: "worker-a", role: "builder", machine: "pc-1", session: "sess-board-99", ttlMinutes: 30 });
  const claimed = state.events.find((event) => event.type === "packet.claimed");
  assert.equal(claimed.machine, "pc-1");
  assert.equal(claimed.session, "sess-board-99");

  const brief = assignmentBrief(state, "worker-a");
  assert.equal(brief.identity.machine, "pc-1");
  assert.equal(brief.identity.session, "sess-board-99");
  assert.equal(brief.identity.heartbeat_at, state.packets["VIRO-9001"].heartbeat_at);
  assert.ok(brief.rules.some((rule) => /--session/.test(rule)));

  const row = teamBoard(state).find((entry) => entry.id === "VIRO-9001");
  assert.equal(row.machine, "pc-1");
  assert.equal(row.session, shortToken("sess-board-99"));
  assert.equal(row.heartbeat, state.packets["VIRO-9001"].heartbeat_at);
});

test("shortToken keeps board output readable without hiding the token entirely", () => {
  assert.equal(shortToken("abcdefgh12345678"), "abcdefgh…");
  assert.equal(shortToken("short"), "short");
  assert.equal(shortToken(null), "—");
});
