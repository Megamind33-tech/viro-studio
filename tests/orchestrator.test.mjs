import test from "node:test";
import assert from "node:assert/strict";
import {
  newState,
  importManifest,
  scopesOverlap,
  claimPacket,
  advancePacket,
  rejectPacket,
  reconcilePacket,
  selectablePackets,
  requiredRole,
} from "../scripts/lib/orchestrator-core.mjs";

function manifest(id, {
  priority = "P1",
  domain = "editor-core",
  allowed_paths = ["src/document/**"],
  depends_on = [],
  critic = false,
  state = "QUEUED",
} = {}) {
  return {
    id,
    title: `${id} concrete delivery packet`,
    priority,
    domain,
    state,
    outcome: `${id} produces one measurable product delta with independent proof.`,
    allowed_paths,
    depends_on,
    critic: { status: critic ? "PENDING" : "NOT_APPLICABLE" },
  };
}

test("scope overlap is conservative for exact paths, directories and globs", () => {
  assert.equal(scopesOverlap(["src/document/**"], ["src/document/types.ts"]), true);
  assert.equal(scopesOverlap(["src/engine/compositor.ts"], ["src/engine/compositor.ts"]), true);
  assert.equal(scopesOverlap(["src/chrome/**"], ["src/platform/**"]), false);
  assert.equal(scopesOverlap(["tests/**"], ["tests/orchestrator.test.mjs"]), true);
});

test("a packet keeps its lease across handoffs so overlapping work cannot enter", () => {
  const state = newState();
  importManifest(state, manifest("VIRO-1000"));
  importManifest(state, manifest("VIRO-1001", { allowed_paths: ["src/document/types.ts"] }));

  claimPacket(state, { agentId: "audit-a", role: "gap-auditor", preferredId: "VIRO-1000" });
  advancePacket(state, { agentId: "audit-a", packetId: "VIRO-1000", evidence: ["before-state recorded"] });

  assert.equal(state.packets["VIRO-1000"].stage, "build");
  assert.ok(state.leases["VIRO-1000"]);
  assert.throws(
    () => claimPacket(state, { agentId: "audit-b", role: "gap-auditor", preferredId: "VIRO-1001" }),
    /No conflict-free packet/,
  );

  claimPacket(state, { agentId: "builder-a", role: "editor-engineer", preferredId: "VIRO-1000" });
  advancePacket(state, { agentId: "builder-a", packetId: "VIRO-1000", evidence: ["implementation commit abc123"] });
  assert.equal(state.packets["VIRO-1000"].stage, "verify");
  assert.ok(state.leases["VIRO-1000"]);

  claimPacket(state, { agentId: "verify-a", role: "verifier", preferredId: "VIRO-1000" });
  rejectPacket(state, { agentId: "verify-a", packetId: "VIRO-1000", reason: "round-trip assertion failed" });
  assert.equal(state.packets["VIRO-1000"].stage, "build");
  assert.equal(state.packets["VIRO-1000"].attempts, 1);
  assert.ok(state.leases["VIRO-1000"]);
  assert.throws(
    () => claimPacket(state, { agentId: "audit-b", role: "gap-auditor", preferredId: "VIRO-1001" }),
    /No conflict-free packet/,
  );
});

test("release review cannot mark DONE or release the lease before a real merge", () => {
  const state = newState();
  importManifest(state, manifest("VIRO-2000"));
  importManifest(state, manifest("VIRO-2001", { allowed_paths: ["src/document/types.ts"] }));

  claimPacket(state, { agentId: "a1", role: "gap-auditor", preferredId: "VIRO-2000" });
  advancePacket(state, { agentId: "a1", packetId: "VIRO-2000", evidence: ["audit evidence"] });
  claimPacket(state, { agentId: "b1", role: "editor-engineer", preferredId: "VIRO-2000" });
  advancePacket(state, { agentId: "b1", packetId: "VIRO-2000", evidence: ["build evidence"] });

  assert.equal(requiredRole(state.packets["VIRO-2000"]), "verifier");
  assert.throws(
    () => claimPacket(state, { agentId: "b1", role: "editor-engineer", preferredId: "VIRO-2000" }),
    /No conflict-free packet/,
  );

  claimPacket(state, { agentId: "v1", role: "verifier", preferredId: "VIRO-2000" });
  advancePacket(state, { agentId: "v1", packetId: "VIRO-2000", evidence: ["test suite green"] });
  assert.equal(state.packets["VIRO-2000"].stage, "release");
  assert.ok(state.leases["VIRO-2000"]);

  claimPacket(state, { agentId: "r1", role: "release-manager", preferredId: "VIRO-2000" });
  assert.throws(
    () => advancePacket(state, { agentId: "r1", packetId: "VIRO-2000", evidence: ["release review passed"] }),
    /viro-release/,
  );
  assert.equal(state.packets["VIRO-2000"].stage, "release");
  assert.notEqual(state.packets["VIRO-2000"].status, "DONE");
  assert.ok(state.leases["VIRO-2000"]);
  assert.equal(selectablePackets(state, "gap-auditor", "VIRO-2001").length, 0);
});

test("dependency graph prevents downstream packet from starting early", () => {
  const state = newState();
  importManifest(state, manifest("VIRO-3000", { allowed_paths: ["src/engine/**"] }));
  importManifest(state, manifest("VIRO-3001", {
    allowed_paths: ["src/chrome/**"],
    depends_on: ["VIRO-3000"],
  }));

  assert.equal(selectablePackets(state, "gap-auditor", "VIRO-3001").length, 0);
  state.packets["VIRO-3000"].status = "DONE";
  state.packets["VIRO-3000"].stage = "done";
  assert.equal(selectablePackets(state, "gap-auditor", "VIRO-3001").length, 1);
});

test("historical reconciliation is terminal, satisfies dependencies, and does not fake delivery roles", () => {
  const state = newState();
  importManifest(state, manifest("VIRO-3500", { allowed_paths: ["src/document/**"] }));
  importManifest(state, manifest("VIRO-3501", {
    allowed_paths: ["src/export/**"],
    depends_on: ["VIRO-3500"],
  }));

  reconcilePacket(state, {
    packetId: "VIRO-3500",
    evidence: ["commit deadbeef is already an ancestor of main", "regression suite proves target state"],
  });

  assert.equal(state.packets["VIRO-3500"].status, "RECONCILED");
  assert.equal(state.packets["VIRO-3500"].stage, "done");
  assert.equal(state.leases["VIRO-3500"], undefined);
  assert.equal(selectablePackets(state, "gap-auditor", "VIRO-3500").length, 0);
  assert.equal(selectablePackets(state, "gap-auditor", "VIRO-3501").length, 1);
});

test("a RECONCILED manifest updates an idle blocked packet during sync", () => {
  const state = newState();
  importManifest(state, manifest("VIRO-3600"));
  state.packets["VIRO-3600"].status = "BLOCKED";
  state.packets["VIRO-3600"].rejection = { reason: "stale before-state" };
  importManifest(state, manifest("VIRO-3600", { state: "RECONCILED" }));
  assert.equal(state.packets["VIRO-3600"].status, "RECONCILED");
  assert.equal(state.packets["VIRO-3600"].rejection, null);
});

test("one agent cannot own two packets", () => {
  const state = newState();
  importManifest(state, manifest("VIRO-4000", { allowed_paths: ["src/document/**"] }));
  importManifest(state, manifest("VIRO-4001", { allowed_paths: ["src/chrome/**"] }));
  claimPacket(state, { agentId: "one-worker", role: "gap-auditor", preferredId: "VIRO-4000" });
  assert.throws(
    () => claimPacket(state, { agentId: "one-worker", role: "gap-auditor", preferredId: "VIRO-4001" }),
    /already owns/,
  );
});
