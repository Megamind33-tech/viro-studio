const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const STAGES = ["audit", "build", "verify", "critic", "release", "done"];

export const ROLE_STAGE = {
  governor: ["audit", "release"],
  "gap-auditor": ["audit"],
  builder: ["build"],
  "editor-engineer": ["build"],
  "ui-engineer": ["build"],
  "platform-engineer": ["build"],
  "research-architect": ["audit", "build"],
  verifier: ["verify"],
  critic: ["critic"],
  "release-manager": ["release"],
};

export const DOMAIN_ROLE = {
  "editor-core": "editor-engineer",
  "canvas-rendering": "editor-engineer",
  typography: "editor-engineer",
  "ui-ux": "ui-engineer",
  "assets-import": "builder",
  export: "builder",
  ai: "builder",
  platform: "platform-engineer",
  verification: "verifier",
  "research-architecture": "research-architect",
};

const TERMINAL = new Set(["DONE", "RECONCILED"]);

// Identity hardening (VIRO-0019): a claim is bound to machine + session evidence.
// The session token is an identity-disambiguation token, not an authentication secret:
// it is stored in the shared state on purpose so every worker can observe it.
export const DEFAULT_IDENTITY_TTL_MINUTES = 30;

export class IdentityConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdentityConflictError";
    this.identityConflict = true;
  }
}

export function shortToken(token) {
  const text = String(token ?? "");
  if (!text) return "—";
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function normalizeTtlMinutes(ttlMinutes) {
  return Math.max(1, Number(ttlMinutes) || DEFAULT_IDENTITY_TTL_MINUTES);
}

// "legacy"      -> caller supplied no session (old worker); no enforcement, historic behavior.
// "unverified"  -> caller supplied a session but the stored record has none (legacy state); no enforcement.
// "match"       -> supplied session equals the stored session.
// "mismatch"    -> supplied session differs from the stored session.
function sessionMode(record, session) {
  if (!session) return "legacy";
  if (!record?.session) return "unverified";
  return record.session === String(session) ? "match" : "mismatch";
}

function assertSession(record, agentId, session) {
  const mode = sessionMode(record, session);
  if (mode === "match" || mode === "legacy" || mode === "unverified") return;
  throw new IdentityConflictError(
    `identity conflict: worker '${agentId}' is live under session '${shortToken(record.session)}' ` +
    `from machine '${record?.machine ?? "unknown"}'; the supplied session '${shortToken(session)}' does not match, ` +
    `so the operation was refused. Resume with the original --session token or wait for the Governor to reap the assignment.`,
  );
}

export function newState() {
  return {
    version: 1,
    revision: 0,
    updated_at: new Date(0).toISOString(),
    packets: {},
    agents: {},
    leases: {},
    events: [],
  };
}

export function normalizePacket(manifest) {
  const criticNeeded = manifest.critic?.status !== "NOT_APPLICABLE";
  const terminal = TERMINAL.has(manifest.state);
  return {
    id: manifest.id,
    title: manifest.title,
    priority: manifest.priority ?? "P2",
    domain: manifest.domain,
    outcome: manifest.outcome,
    scope: [...new Set(manifest.allowed_paths ?? [])],
    dependencies: [...new Set(manifest.depends_on ?? [])],
    critic_needed: criticNeeded,
    stage: terminal ? "done" : "audit",
    status: manifest.state === "BLOCKED" ? "BLOCKED" : terminal ? manifest.state : "QUEUED",
    assigned_agent: null,
    assigned_role: null,
    work_branch: null,
    heartbeat_at: null,
    attempts: 0,
    evidence: [],
    last_handoff: null,
    rejection: null,
  };
}

function staticPrefix(pattern) {
  const clean = String(pattern).replaceAll("\\", "/").replace(/^\.\//, "");
  const wildcard = clean.search(/[?*[{]/);
  const prefix = wildcard === -1 ? clean : clean.slice(0, wildcard);
  return prefix.replace(/\/+$/, "");
}

export function scopesOverlap(left = [], right = []) {
  for (const a of left) {
    for (const b of right) {
      const pa = staticPrefix(a);
      const pb = staticPrefix(b);
      if (!pa || !pb) return true;
      if (pa === pb) return true;
      if (pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)) return true;
    }
  }
  return false;
}

export function depsSatisfied(packet, state) {
  return packet.dependencies.every((id) => TERMINAL.has(state.packets[id]?.status));
}

export function requiredRole(packet) {
  if (packet.stage === "audit") return "gap-auditor";
  if (packet.stage === "build") return DOMAIN_ROLE[packet.domain] ?? "builder";
  if (packet.stage === "verify") return "verifier";
  if (packet.stage === "critic") return "critic";
  if (packet.stage === "release") return "release-manager";
  return null;
}

export function roleCanServe(role, packet) {
  if (!role || !packet || packet.stage === "done") return false;
  const required = requiredRole(packet);
  if (role === required) return true;
  if (packet.stage === "build" && role === "builder") return true;
  return false;
}

export function activePackets(state) {
  return Object.values(state.packets).filter((packet) =>
    ["ACTIVE", "VERIFY", "CRITIC", "RELEASE"].includes(packet.status),
  );
}

export function leasedPackets(state) {
  return Object.keys(state.leases)
    .map((id) => state.packets[id])
    .filter(Boolean);
}

export function conflictingPacket(packet, state) {
  return leasedPackets(state).find(
    (other) => other.id !== packet.id && scopesOverlap(packet.scope, other.scope),
  ) ?? null;
}

export function selectablePackets(state, role, preferredId = null) {
  let packets = Object.values(state.packets).filter((packet) => {
    if (["DONE", "RECONCILED", "BLOCKED"].includes(packet.status)) return false;
    if (packet.assigned_agent) return false;
    if (!depsSatisfied(packet, state)) return false;
    if (!roleCanServe(role, packet)) return false;
    if (conflictingPacket(packet, state)) return false;
    return true;
  });
  if (preferredId) packets = packets.filter((packet) => packet.id === preferredId);
  return packets.sort((a, b) => {
    const p = (PRIORITY[a.priority] ?? 99) - (PRIORITY[b.priority] ?? 99);
    if (p !== 0) return p;
    return a.id.localeCompare(b.id);
  });
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function stamp(state, type, detail) {
  const at = new Date().toISOString();
  state.revision += 1;
  state.updated_at = at;
  state.events.push({ at, type, ...detail });
  if (state.events.length > 300) state.events = state.events.slice(-300);
  return at;
}

export function importManifest(state, manifest) {
  if (!manifest?.id) throw new Error("Manifest is missing id");
  const incoming = normalizePacket(manifest);
  const current = state.packets[incoming.id];
  if (!current) {
    state.packets[incoming.id] = incoming;
    stamp(state, "packet.imported", { packet: incoming.id });
    return { changed: true, packet: incoming };
  }

  current.title = incoming.title;
  current.priority = incoming.priority;
  current.outcome = incoming.outcome;
  current.dependencies = incoming.dependencies;
  current.critic_needed = incoming.critic_needed;

  if (incoming.status === "RECONCILED") {
    if (current.assigned_agent) throw new Error(`${current.id} cannot be reconciled while assigned to ${current.assigned_agent}`);
    current.domain = incoming.domain;
    current.scope = incoming.scope;
    current.stage = "done";
    current.status = "RECONCILED";
    current.rejection = null;
    delete state.leases[current.id];
    stamp(state, "packet.reconciled_from_manifest", { packet: current.id });
    return { changed: true, packet: current };
  }

  const mutable = current.status === "QUEUED" && !current.assigned_agent && !state.leases[current.id];
  if (mutable) {
    current.domain = incoming.domain;
    current.scope = incoming.scope;
  }
  return { changed: false, packet: current };
}

export function claimPacket(state, { agentId, role, preferredId = null, machine = null, session = null, ttlMinutes = DEFAULT_IDENTITY_TTL_MINUTES } = {}) {
  if (!agentId) throw new Error("agentId is required");
  if (!ROLE_STAGE[role]) throw new Error(`Unknown role: ${role}`);
  const existing = Object.values(state.packets).find((p) => p.assigned_agent === agentId);
  if (existing) {
    const record = state.agents[agentId] ?? null;
    const mode = sessionMode(record, session);
    const ttl = normalizeTtlMinutes(ttlMinutes) * 60_000;
    const age = existing.heartbeat_at ? Date.now() - Date.parse(existing.heartbeat_at) : Infinity;
    const live = Number.isFinite(age) && age <= ttl;

    if (mode === "match") {
      if (machine && record?.machine && machine !== record.machine) {
        throw new IdentityConflictError(
          `identity conflict: session '${shortToken(session)}' for worker '${agentId}' is bound to machine '${record.machine}', ` +
          `but this claim came from machine '${machine}'; the same session token may not be used from two machines.`,
        );
      }
      // Same live session re-claiming: idempotent resume, refresh the heartbeat.
      const resumedAt = stamp(state, "agent.session_resumed", {
        packet: existing.id,
        agent: agentId,
        role,
        machine: machine ?? record?.machine ?? null,
        session,
      });
      existing.heartbeat_at = resumedAt;
      if (record) record.heartbeat_at = resumedAt;
      if (state.leases[existing.id]) state.leases[existing.id].heartbeat_at = resumedAt;
      return existing;
    }
    if (mode === "unverified") {
      // Migration bridge (VIRO-0019, no big-bang): the assignment predates session
      // identity. Adopt the presented session/machine and bind the identity going
      // forward; after this one-time adoption the assignment is fully session-protected.
      const adoptedAt = stamp(state, "agent.session_adopted", {
        packet: existing.id,
        agent: agentId,
        role,
        machine: machine ?? record?.machine ?? null,
        session,
      });
      existing.assigned_session = session;
      existing.assigned_machine = machine ?? record?.machine ?? existing.assigned_machine ?? null;
      existing.heartbeat_at = adoptedAt;
      if (record) {
        record.session = session;
        record.machine = machine ?? record.machine ?? null;
        record.heartbeat_at = adoptedAt;
      }
      if (state.leases[existing.id]) {
        state.leases[existing.id].current_session = session;
        state.leases[existing.id].heartbeat_at = adoptedAt;
      }
      return existing;
    }
    if (mode === "mismatch" && live) {
      throw new IdentityConflictError(
        `duplicate live identity refused: worker '${agentId}' already owns ${existing.id} under session ` +
        `'${shortToken(record?.session)}' from machine '${record?.machine ?? "unknown"}' with an unexpired heartbeat ` +
        `(${existing.heartbeat_at}, TTL ${normalizeTtlMinutes(ttlMinutes)}m). A second live claim with a different ` +
        `session token cannot take this identity; resume with the original --session token, or let the heartbeat ` +
        `expire and ask the Governor to reap the assignment.`,
      );
    }
    if (mode === "mismatch") {
      throw new IdentityConflictError(
        `identity conflict: worker '${agentId}' still owns ${existing.id} but its heartbeat expired ` +
        `(${existing.heartbeat_at ?? "never"}). The stale assignment must be reviewed and reaped by the Governor ` +
        `before this worker identity can be reused.`,
      );
    }
    throw new Error(`${agentId} already owns ${existing.id}; finish the handoff first`);
  }

  const candidates = selectablePackets(state, role, preferredId);
  const packet = candidates[0];
  if (!packet) {
    const requested = preferredId ? ` ${preferredId}` : "";
    throw new Error(`No conflict-free packet${requested} is claimable by ${role}`);
  }

  const now = stamp(state, "packet.claimed", { packet: packet.id, agent: agentId, role, machine, session: session ?? null });
  packet.assigned_agent = agentId;
  packet.assigned_role = role;
  packet.assigned_machine = machine ?? null;
  packet.assigned_session = session ?? null;
  packet.heartbeat_at = now;
  packet.status = packet.stage === "verify" ? "VERIFY" : packet.stage === "critic" ? "CRITIC" : packet.stage === "release" ? "RELEASE" : "ACTIVE";
  packet.work_branch = packet.work_branch ?? `agent/${packet.id.toLowerCase()}/${slug(agentId)}`;
  state.agents[agentId] = { role, machine, session: session ?? null, packet: packet.id, heartbeat_at: now };
  const existingLease = state.leases[packet.id];
  state.leases[packet.id] = {
    packet: packet.id,
    scope: packet.scope,
    acquired_at: existingLease?.acquired_at ?? now,
    current_agent: agentId,
    current_stage: packet.stage,
    current_session: session ?? null,
  };
  return packet;
}

export function heartbeat(state, agentId, { session = null } = {}) {
  const agent = state.agents[agentId];
  if (!agent?.packet) throw new Error(`${agentId} has no active assignment`);
  assertSession(agent, agentId, session);
  const packet = state.packets[agent.packet];
  if (!packet || packet.assigned_agent !== agentId) throw new Error("Assignment state is inconsistent");
  const now = stamp(state, "agent.heartbeat", { agent: agentId, packet: packet.id, session: session ?? agent.session ?? null, machine: agent.machine ?? null });
  agent.heartbeat_at = now;
  packet.heartbeat_at = now;
  if (state.leases[packet.id]) state.leases[packet.id].heartbeat_at = now;
  return packet;
}

function clearAssignment(state, packet) {
  if (packet.assigned_agent) delete state.agents[packet.assigned_agent];
  packet.assigned_agent = null;
  packet.assigned_role = null;
  packet.heartbeat_at = null;
  if (state.leases[packet.id]) {
    state.leases[packet.id].current_agent = null;
    state.leases[packet.id].current_stage = packet.stage;
  }
}

export function advancePacket(state, { agentId, packetId, evidence = [], session = null }) {
  const packet = state.packets[packetId];
  if (!packet) throw new Error(`Unknown packet ${packetId}`);
  if (packet.assigned_agent !== agentId) throw new Error(`${agentId} does not own ${packetId}`);
  const agentRecord = state.agents[agentId] ?? null;
  assertSession(agentRecord, agentId, session ?? packet.assigned_session ?? null);
  const role = packet.assigned_role;
  if (!roleCanServe(role, packet)) throw new Error(`${role} cannot complete stage ${packet.stage}`);
  const proof = Array.isArray(evidence) ? evidence.filter(Boolean) : [String(evidence)].filter(Boolean);
  if (!proof.length) throw new Error("At least one concrete evidence item is required for handoff");
  const actorMachine = agentRecord?.machine ?? packet.assigned_machine ?? null;
  const actorSession = session ?? agentRecord?.session ?? packet.assigned_session ?? null;
  packet.evidence.push(...proof.map((item) => ({ stage: packet.stage, by: agentId, item, at: new Date().toISOString() })));

  const from = packet.stage;
  if (from === "audit") packet.stage = "build";
  else if (from === "build") packet.stage = "verify";
  else if (from === "verify") packet.stage = packet.critic_needed ? "critic" : "release";
  else if (from === "critic") packet.stage = "release";
  else if (from === "release") {
    throw new Error("release stage cannot advance directly to DONE; use viro-release approval so DONE is recorded only after a real merge to main");
  } else throw new Error(`Cannot advance stage ${from}`);

  packet.last_handoff = { from, to: packet.stage, by: agentId, at: new Date().toISOString(), evidence: proof };
  packet.rejection = null;
  clearAssignment(state, packet);
  packet.status = "QUEUED";
  stamp(state, "packet.advanced", { packet: packet.id, from, to: packet.stage, by: agentId, machine: actorMachine, session: actorSession });
  return packet;
}

export function rejectPacket(state, { agentId, packetId, reason, session = null }) {
  const packet = state.packets[packetId];
  if (!packet) throw new Error(`Unknown packet ${packetId}`);
  if (packet.assigned_agent !== agentId) throw new Error(`${agentId} does not own ${packetId}`);
  const agentRecord = state.agents[agentId] ?? null;
  assertSession(agentRecord, agentId, session ?? packet.assigned_session ?? null);
  if (!["verify", "critic", "release"].includes(packet.stage)) throw new Error(`Stage ${packet.stage} cannot reject work`);
  if (!String(reason ?? "").trim()) throw new Error("A specific rejection reason is required");
  const rejectedAt = new Date().toISOString();
  packet.rejection = { by: agentId, role: packet.assigned_role, stage: packet.stage, reason: String(reason), at: rejectedAt };
  packet.attempts += 1;
  packet.stage = "build";
  packet.status = "QUEUED";
  packet.last_handoff = { from: "rejected", to: "build", by: agentId, at: rejectedAt, evidence: [String(reason)] };
  clearAssignment(state, packet);
  stamp(state, "packet.rejected", {
    packet: packet.id,
    by: agentId,
    reason: String(reason),
    machine: agentRecord?.machine ?? packet.assigned_machine ?? null,
    session: session ?? agentRecord?.session ?? packet.assigned_session ?? null,
  });
  return packet;
}

export function blockPacket(state, { packetId, reason, by = "governor" }) {
  const packet = state.packets[packetId];
  if (!packet) throw new Error(`Unknown packet ${packetId}`);
  if (!String(reason ?? "").trim()) throw new Error("A blocker reason is required");
  clearAssignment(state, packet);
  packet.status = "BLOCKED";
  packet.rejection = { by, stage: packet.stage, reason: String(reason), at: new Date().toISOString() };
  delete state.leases[packet.id];
  stamp(state, "packet.blocked", { packet: packet.id, by, reason: String(reason) });
  return packet;
}

export function reconcilePacket(state, { packetId, evidence = [], by = "governor" }) {
  const packet = state.packets[packetId];
  if (!packet) throw new Error(`Unknown packet ${packetId}`);
  if (packet.assigned_agent) throw new Error(`${packetId} cannot be reconciled while assigned to ${packet.assigned_agent}`);
  if (TERMINAL.has(packet.status)) throw new Error(`${packetId} is already terminal (${packet.status})`);
  const proof = Array.isArray(evidence) ? evidence.filter(Boolean) : [String(evidence)].filter(Boolean);
  if (!proof.length) throw new Error("Historical reconciliation requires concrete commit/test evidence");
  const at = new Date().toISOString();
  packet.evidence ??= [];
  packet.evidence.push(...proof.map((item) => ({ stage: "reconcile", by, item, at })));
  packet.stage = "done";
  packet.status = "RECONCILED";
  packet.rejection = null;
  packet.last_handoff = { from: "historical", to: "done", by, at, evidence: proof };
  delete state.leases[packet.id];
  stamp(state, "packet.reconciled", { packet: packet.id, by, evidence: proof });
  return packet;
}

export function unblockPacket(state, { packetId, by = "governor" }) {
  const packet = state.packets[packetId];
  if (!packet) throw new Error(`Unknown packet ${packetId}`);
  if (packet.status !== "BLOCKED") throw new Error(`${packetId} is not blocked`);
  packet.status = "QUEUED";
  packet.rejection = null;
  stamp(state, "packet.unblocked", { packet: packet.id, by });
  return packet;
}

export function staleAssignments(state, ttlMinutes, now = Date.now()) {
  const ttl = Math.max(1, Number(ttlMinutes) || 90) * 60_000;
  return activePackets(state).filter((packet) => {
    if (!packet.assigned_agent || !packet.heartbeat_at) return false;
    return now - Date.parse(packet.heartbeat_at) > ttl;
  });
}

export function reapAssignment(state, { packetId, by = "governor", reason = "stale agent lease" }) {
  const packet = state.packets[packetId];
  if (!packet) throw new Error(`Unknown packet ${packetId}`);
  if (!packet.assigned_agent) throw new Error(`${packetId} has no assigned agent`);
  const oldAgent = packet.assigned_agent;
  clearAssignment(state, packet);
  packet.status = "BLOCKED";
  delete state.leases[packet.id];
  packet.rejection = { by, stage: packet.stage, reason, at: new Date().toISOString() };
  stamp(state, "assignment.reaped", { packet: packet.id, agent: oldAgent, by, reason });
  return packet;
}

export function teamBoard(state) {
  return Object.values(state.packets)
    .sort((a, b) => (PRIORITY[a.priority] ?? 99) - (PRIORITY[b.priority] ?? 99) || a.id.localeCompare(b.id))
    .map((packet) => ({
      id: packet.id,
      priority: packet.priority,
      domain: packet.domain,
      stage: packet.stage,
      status: packet.status,
      owner: packet.assigned_agent ?? "—",
      role: packet.assigned_role ?? requiredRole(packet) ?? "—",
      machine: packet.assigned_machine ?? "—",
      session: shortToken(packet.assigned_session),
      heartbeat: packet.heartbeat_at ?? "—",
      leased: state.leases[packet.id] ? "yes" : "no",
      dependencies: packet.dependencies.join(",") || "—",
      branch: packet.work_branch ?? "—",
      attempts: packet.attempts,
    }));
}

export function assignmentBrief(state, agentId) {
  const agent = state.agents[agentId];
  if (!agent?.packet) throw new Error(`${agentId} has no active assignment`);
  const packet = state.packets[agent.packet];
  return {
    packet: packet.id,
    title: packet.title,
    outcome: packet.outcome,
    stage: packet.stage,
    role: packet.assigned_role,
    branch: packet.work_branch,
    scope: packet.scope,
    dependencies: packet.dependencies,
    identity: {
      agent: agentId,
      machine: agent.machine ?? null,
      session: agent.session ?? null,
      session_display: shortToken(agent.session),
      heartbeat_at: packet.heartbeat_at,
      ttl_minutes_hint: DEFAULT_IDENTITY_TTL_MINUTES,
    },
    prior_rejection: packet.rejection,
    prior_evidence: packet.evidence,
    rules: [
      "Work only inside the leased scope.",
      "Do not duplicate another packet's responsibility.",
      "Do not broaden scope without Governor intervention.",
      "Do not approve your own work.",
      "Handoff requires concrete evidence, not a completion claim.",
      "Pass your claim's --session token on every subsequent command; a different live session under your worker ID is refused.",
    ],
  };
}
