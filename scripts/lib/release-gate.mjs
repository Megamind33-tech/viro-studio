const SUCCESS = new Set(["success"]);

export function latestCheckRuns(checkRuns = []) {
  const byName = new Map();
  for (const run of checkRuns) {
    if (!run?.name) continue;
    const prior = byName.get(run.name);
    const runTime = Date.parse(run.completed_at ?? run.started_at ?? run.created_at ?? 0) || Number(run.id ?? 0);
    const priorTime = prior ? (Date.parse(prior.completed_at ?? prior.started_at ?? prior.created_at ?? 0) || Number(prior.id ?? 0)) : -1;
    if (!prior || runTime >= priorTime) byName.set(run.name, run);
  }
  return [...byName.values()];
}

export function evaluateCheckRuns(checkRuns = [], requiredNames = []) {
  const latest = latestCheckRuns(checkRuns);
  const byName = new Map(latest.map((run) => [run.name, run]));
  const missing = [];
  const pending = [];
  const failed = [];

  for (const name of requiredNames) {
    const run = byName.get(name);
    if (!run) {
      missing.push(name);
      continue;
    }
    if (run.status !== "completed") {
      pending.push(name);
      continue;
    }
    if (!SUCCESS.has(run.conclusion)) failed.push(`${name}:${run.conclusion ?? "unknown"}`);
  }

  // If the orchestration integrity gate is present for this PR, it becomes mandatory.
  const integrity = byName.get("state-machine");
  if (integrity) {
    if (integrity.status !== "completed") pending.push("state-machine");
    else if (!SUCCESS.has(integrity.conclusion)) failed.push(`state-machine:${integrity.conclusion ?? "unknown"}`);
  }

  return {
    ready: missing.length === 0 && pending.length === 0 && failed.length === 0,
    missing,
    pending,
    failed,
    observed: latest.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion ?? null })),
  };
}

export function validateReleasePacket(packet, { agentId = null, requireAssignment = false } = {}) {
  const errors = [];
  if (!packet) return ["packet not found"];
  if (packet.stage !== "release") errors.push(`packet stage is ${packet.stage}, expected release`);
  if (!["QUEUED", "RELEASE"].includes(packet.status)) errors.push(`packet status is ${packet.status}, expected QUEUED/RELEASE`);
  if (requireAssignment) {
    if (packet.assigned_role !== "release-manager") errors.push(`assigned role is ${packet.assigned_role ?? "none"}, expected release-manager`);
    if (!agentId || packet.assigned_agent !== agentId) errors.push(`packet is not assigned to release manager ${agentId ?? "<missing>"}`);
  }

  const verifyProof = (packet.evidence ?? []).some((entry) => entry.stage === "verify");
  if (!verifyProof) errors.push("no verifier evidence recorded");
  if (packet.critic_needed) {
    const criticProof = (packet.evidence ?? []).some((entry) => entry.stage === "critic");
    if (!criticProof) errors.push("critic evidence required but not recorded");
  }
  if (!packet.work_branch) errors.push("packet has no work branch");
  return errors;
}

export function approvalIsFresh(packet, pullRequest) {
  const approval = packet?.release_approval;
  if (!approval || approval.status !== "APPROVED") return { fresh: false, reason: "release is not approved" };
  if (!pullRequest) return { fresh: false, reason: "pull request missing" };
  if (approval.pr_number !== pullRequest.number) return { fresh: false, reason: "approval PR number does not match" };
  if (approval.head_sha !== pullRequest.head?.sha) return { fresh: false, reason: "PR head changed after release approval" };
  if (pullRequest.base?.ref !== "main") return { fresh: false, reason: `PR base is ${pullRequest.base?.ref ?? "unknown"}, expected main` };
  return { fresh: true, reason: null };
}
