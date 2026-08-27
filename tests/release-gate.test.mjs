import test from "node:test";
import assert from "node:assert/strict";
import { approvalIsFresh, evaluateCheckRuns, validateReleasePacket } from "../scripts/lib/release-gate.mjs";

function packet(overrides = {}) {
  return {
    id: "VIRO-9000",
    stage: "release",
    status: "RELEASE",
    assigned_agent: "release-pc1",
    assigned_role: "release-manager",
    work_branch: "agent/viro-9000",
    critic_needed: false,
    evidence: [{ stage: "verify", by: "verifier-pc2", item: "all acceptance tests pass" }],
    ...overrides,
  };
}

function check(name, conclusion = "success", status = "completed") {
  return { name, conclusion, status, id: Math.random(), completed_at: "2026-08-27T16:00:00Z" };
}

test("release approval requires independent verifier evidence and assigned release manager", () => {
  assert.deepEqual(validateReleasePacket(packet(), { agentId: "release-pc1", requireAssignment: true }), []);
  assert.match(
    validateReleasePacket(packet({ evidence: [] }), { agentId: "release-pc1", requireAssignment: true }).join(";"),
    /verifier evidence/,
  );
  assert.match(
    validateReleasePacket(packet({ assigned_agent: "someone-else" }), { agentId: "release-pc1", requireAssignment: true }).join(";"),
    /not assigned/,
  );
});

test("critic evidence is mandatory when the packet is user-visible", () => {
  const missing = packet({ critic_needed: true });
  assert.match(validateReleasePacket(missing).join(";"), /critic evidence/);
  const complete = packet({
    critic_needed: true,
    evidence: [
      { stage: "verify", by: "v", item: "green" },
      { stage: "critic", by: "c", item: "AAA brief accepted" },
    ],
  });
  assert.deepEqual(validateReleasePacket(complete), []);
});

test("required CI checks must all exist and succeed", () => {
  const required = ["Delivery policy", "Product regression gates"];
  assert.equal(evaluateCheckRuns([check("Delivery policy"), check("Product regression gates")], required).ready, true);

  const missing = evaluateCheckRuns([check("Delivery policy")], required);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ["Product regression gates"]);

  const failed = evaluateCheckRuns([check("Delivery policy"), check("Product regression gates", "failure")], required);
  assert.equal(failed.ready, false);
  assert.deepEqual(failed.failed, ["Product regression gates:failure"]);
});

test("orchestrator integrity becomes mandatory whenever its state-machine check is present", () => {
  const result = evaluateCheckRuns([
    check("Delivery policy"),
    check("Product regression gates"),
    check("state-machine", "failure"),
  ], ["Delivery policy", "Product regression gates"]);
  assert.equal(result.ready, false);
  assert.deepEqual(result.failed, ["state-machine:failure"]);
});

test("a new commit after approval invalidates release approval", () => {
  const p = packet({
    release_approval: {
      status: "APPROVED",
      pr_number: 77,
      head_sha: "abc",
    },
  });
  const freshPr = { number: 77, head: { sha: "abc" }, base: { ref: "main" } };
  assert.equal(approvalIsFresh(p, freshPr).fresh, true);

  const changedPr = { number: 77, head: { sha: "def" }, base: { ref: "main" } };
  const stale = approvalIsFresh(p, changedPr);
  assert.equal(stale.fresh, false);
  assert.match(stale.reason, /head changed/);
});
