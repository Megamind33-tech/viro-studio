#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  importManifest,
  claimPacket,
  heartbeat,
  advancePacket,
  rejectPacket,
  blockPacket,
  unblockPacket,
  reconcilePacket,
  staleAssignments,
  reapAssignment,
  teamBoard,
  assignmentBrief,
  activePackets,
  leasedPackets,
  scopesOverlap,
  requiredRole,
} from "./lib/orchestrator-core.mjs";
import { GitControlStore } from "./lib/git-control-store.mjs";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, ".viro", "orchestrator.json");

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replaceAll("-", "_");
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function requireFlag(flags, key) {
  const value = flags[key];
  if (!value || value === true) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  return String(value);
}

function splitEvidence(value) {
  if (!value || value === true) return [];
  return String(value).split("||").map((item) => item.trim()).filter(Boolean);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function loadConfig() {
  const config = await readJson(CONFIG_PATH);
  return {
    version: 1,
    control_branch: "viro-agent-control",
    state_path: ".viro-control/state.json",
    lease_ttl_minutes: 90,
    delivery_directory: "docs/agents/deliveries",
    ...config,
  };
}

async function manifestsFromDisk(config) {
  const dir = path.join(ROOT, config.delivery_directory);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^VIRO-\d+\.json$/i.test(entry.name)) continue;
    manifests.push(await readJson(path.join(dir, entry.name)));
  }
  return manifests;
}

function printBoard(state, ttlMinutes) {
  console.table(teamBoard(state));
  const stale = staleAssignments(state, ttlMinutes);
  if (stale.length) console.log(`Stale assignments: ${stale.map((p) => p.id).join(", ")}`);
}

function validateState(state) {
  const errors = [];
  const leased = leasedPackets(state);
  for (let i = 0; i < leased.length; i += 1) {
    for (let j = i + 1; j < leased.length; j += 1) {
      if (scopesOverlap(leased[i].scope, leased[j].scope)) {
        errors.push(`scope lease collision: ${leased[i].id} <-> ${leased[j].id}`);
      }
    }
  }

  const active = activePackets(state);
  const agentIds = new Set();
  for (const packet of active) {
    if (!packet.assigned_agent) continue;
    if (agentIds.has(packet.assigned_agent)) errors.push(`duplicate assignment: ${packet.assigned_agent}`);
    agentIds.add(packet.assigned_agent);
    const needed = requiredRole(packet);
    if (packet.assigned_role !== needed && !(packet.stage === "build" && packet.assigned_role === "builder")) {
      errors.push(`role mismatch: ${packet.id} needs ${needed}, has ${packet.assigned_role}`);
    }
    if (!state.leases[packet.id]) errors.push(`missing scope lease: ${packet.id}`);
  }
  return errors;
}

function help() {
  console.log(`VIRO resident orchestrator — git transport\n\nUse this when the environment can git fetch/push but blocks direct api.github.com access.\nIt writes the exact same shared state on the viro-agent-control branch and uses git --force-with-lease as the concurrency guard.\n\nCommands:\n  sync\n  status\n  check\n  claim --agent ID --role ROLE [--packet VIRO-0005] [--machine NAME]\n  brief --agent ID\n  heartbeat --agent ID\n  advance --agent ID --packet VIRO-0005 --evidence "proof one||proof two"\n  reject --agent ID --packet VIRO-0005 --reason "specific failure"\n  block --packet VIRO-0005 --reason "external blocker"\n  unblock --packet VIRO-0005\n  reconcile --packet VIRO-0002 --evidence "commit proof||test proof" [--by governor]\n  reap --packet VIRO-0005 --reason "agent disappeared"\n\nNo GITHUB_TOKEN or direct REST egress is required. Normal authenticated git fetch/push permission is required.`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (["help", "-h", "--help"].includes(command)) return help();
  const config = await loadConfig();
  const store = new GitControlStore({ root: ROOT, config, remote: flags.remote ? String(flags.remote) : "origin" });

  if (command === "sync") {
    const manifests = await manifestsFromDisk(config);
    const { state } = await store.mutate("sync delivery manifests via git", (draft) => {
      for (const manifest of manifests) importManifest(draft, manifest);
      return manifests.map((m) => m.id);
    });
    console.log(`Synced ${manifests.length} delivery manifest(s) through git transport.`);
    printBoard(state, config.lease_ttl_minutes);
    return;
  }

  if (command === "status") {
    const { state } = store.read();
    printBoard(state, config.lease_ttl_minutes);
    return;
  }

  if (command === "check") {
    const { state } = store.read();
    const errors = validateState(state);
    const stale = staleAssignments(state, config.lease_ttl_minutes);
    if (stale.length) errors.push(`stale assignments require Governor decision: ${stale.map((p) => p.id).join(", ")}`);
    if (errors.length) {
      console.error(errors.map((e) => `- ${e}`).join("\n"));
      process.exitCode = 1;
    } else console.log("Orchestration state is conflict-free.");
    return;
  }

  if (command === "claim") {
    const agentId = requireFlag(flags, "agent");
    const role = requireFlag(flags, "role");
    const preferredId = flags.packet ? String(flags.packet) : null;
    const machine = flags.machine ? String(flags.machine) : process.env.HOSTNAME ?? null;
    const { result } = await store.mutate(`claim ${preferredId ?? "next"} for ${agentId}`, (draft) =>
      claimPacket(draft, { agentId, role, preferredId, machine }),
    );
    console.log(JSON.stringify({ packet: result.id, stage: result.stage, branch: result.work_branch, scope: result.scope }, null, 2));
    return;
  }

  if (command === "brief") {
    const agentId = requireFlag(flags, "agent");
    const { state } = store.read();
    console.log(JSON.stringify(assignmentBrief(state, agentId), null, 2));
    return;
  }

  if (command === "heartbeat") {
    const agentId = requireFlag(flags, "agent");
    const { result } = await store.mutate(`heartbeat ${agentId}`, (draft) => heartbeat(draft, agentId));
    console.log(`${result.id}: heartbeat recorded.`);
    return;
  }

  if (command === "advance") {
    const agentId = requireFlag(flags, "agent");
    const packetId = requireFlag(flags, "packet");
    const evidence = splitEvidence(flags.evidence);
    const { result } = await store.mutate(`advance ${packetId}`, (draft) =>
      advancePacket(draft, { agentId, packetId, evidence }),
    );
    console.log(`${packetId}: moved to ${result.stage}; next role is ${requiredRole(result) ?? "none"}.`);
    return;
  }

  if (command === "reject") {
    const agentId = requireFlag(flags, "agent");
    const packetId = requireFlag(flags, "packet");
    const reason = requireFlag(flags, "reason");
    const { result } = await store.mutate(`reject ${packetId}`, (draft) => rejectPacket(draft, { agentId, packetId, reason }));
    console.log(`${packetId}: rejected to build attempt ${result.attempts}.`);
    return;
  }

  if (command === "block") {
    const packetId = requireFlag(flags, "packet");
    const reason = requireFlag(flags, "reason");
    await store.mutate(`block ${packetId}`, (draft) => blockPacket(draft, { packetId, reason }));
    console.log(`${packetId}: BLOCKED.`);
    return;
  }

  if (command === "unblock") {
    const packetId = requireFlag(flags, "packet");
    await store.mutate(`unblock ${packetId}`, (draft) => unblockPacket(draft, { packetId }));
    console.log(`${packetId}: returned to queue.`);
    return;
  }

  if (command === "reconcile") {
    const packetId = requireFlag(flags, "packet");
    const evidence = splitEvidence(flags.evidence);
    const by = flags.by ? String(flags.by) : "governor";
    const { result } = await store.mutate(`reconcile ${packetId}`, (draft) => reconcilePacket(draft, { packetId, evidence, by }));
    console.log(`${result.id}: RECONCILED as already delivered; dependency edges are satisfied.`);
    return;
  }

  if (command === "reap") {
    const packetId = requireFlag(flags, "packet");
    const reason = flags.reason ? String(flags.reason) : "stale agent lease";
    const { state } = store.read();
    const stale = new Set(staleAssignments(state, config.lease_ttl_minutes).map((p) => p.id));
    if (!stale.has(packetId) && !flags.force) throw new Error(`${packetId} is not stale; pass --force only after Governor review`);
    await store.mutate(`reap ${packetId}`, (draft) => reapAssignment(draft, { packetId, reason }));
    console.log(`${packetId}: assignment released and packet blocked for Governor review.`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`orchestrator git transport error: ${error.message}`);
  process.exitCode = 1;
});
