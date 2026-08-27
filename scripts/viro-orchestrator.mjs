#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  newState,
  importManifest,
  claimPacket,
  heartbeat,
  advancePacket,
  rejectPacket,
  blockPacket,
  unblockPacket,
  staleAssignments,
  reapAssignment,
  teamBoard,
  assignmentBrief,
  activePackets,
  scopesOverlap,
  requiredRole,
} from "./lib/orchestrator-core.mjs";

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

function detectRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (match) return `${match[1]}/${match[2]}`;
  } catch {
    // Explicit --repo remains available when git metadata is unavailable.
  }
  return null;
}

class HttpError extends Error {
  constructor(status, message, body = null) {
    super(`${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

class GitHubStateStore {
  constructor({ repo, token, config }) {
    if (!repo) throw new Error("Repository not detected; set GITHUB_REPOSITORY or pass --repo owner/name");
    if (!token) throw new Error("GITHUB_TOKEN is required for shared orchestration state");
    this.repo = repo;
    this.token = token;
    this.config = config;
    this.apiRoot = process.env.GITHUB_API_URL || "https://api.github.com";
  }

  async request(endpoint, options = {}) {
    const response = await fetch(`${this.apiRoot}${endpoint}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    let body = null;
    const text = await response.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) throw new HttpError(response.status, body?.message ?? response.statusText, body);
    return body;
  }

  async ensureControlBranch() {
    const branch = this.config.control_branch;
    try {
      await this.request(`/repos/${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      return;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
    }
    const repoInfo = await this.request(`/repos/${this.repo}`);
    const base = await this.request(`/repos/${this.repo}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`);
    try {
      await this.request(`/repos/${this.repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
      });
    } catch (error) {
      if (!(error instanceof HttpError) || ![409, 422].includes(error.status)) throw error;
    }
  }

  async read() {
    await this.ensureControlBranch();
    const branch = this.config.control_branch;
    const file = this.config.state_path.split("/").map(encodeURIComponent).join("/");
    try {
      const body = await this.request(`/repos/${this.repo}/contents/${file}?ref=${encodeURIComponent(branch)}`);
      const json = Buffer.from(body.content.replaceAll("\n", ""), "base64").toString("utf8");
      return { state: JSON.parse(json), sha: body.sha };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return { state: newState(), sha: null };
      throw error;
    }
  }

  async write(state, sha, message) {
    const branch = this.config.control_branch;
    const file = this.config.state_path.split("/").map(encodeURIComponent).join("/");
    const payload = {
      message,
      branch,
      content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8").toString("base64"),
    };
    if (sha) payload.sha = sha;
    return this.request(`/repos/${this.repo}/contents/${file}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  async mutate(label, mutation, retries = 7) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const { state, sha } = await this.read();
      const draft = structuredClone(state);
      const result = await mutation(draft);
      try {
        await this.write(draft, sha, `orchestrator: ${label}`);
        return { state: draft, result };
      } catch (error) {
        lastError = error;
        if (!(error instanceof HttpError) || ![409, 422].includes(error.status)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 80 * attempt));
      }
    }
    throw new Error(`Shared-state update lost the concurrency race after ${retries} attempts: ${lastError?.message}`);
  }
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

function printBoard(state) {
  console.table(teamBoard(state));
  const stale = staleAssignments(state, 90);
  if (stale.length) console.log(`Stale assignments: ${stale.map((p) => p.id).join(", ")}`);
}

function validateState(state) {
  const errors = [];
  const active = activePackets(state);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      if (scopesOverlap(active[i].scope, active[j].scope)) {
        errors.push(`scope collision: ${active[i].id} <-> ${active[j].id}`);
      }
    }
  }
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
  console.log(`VIRO resident orchestrator\n\nCommands:\n  bootstrap\n  sync\n  status\n  check\n  claim --agent ID --role ROLE [--packet VIRO-0002] [--machine NAME]\n  brief --agent ID\n  heartbeat --agent ID\n  advance --agent ID --packet VIRO-0002 --evidence "proof one||proof two"\n  reject --agent ID --packet VIRO-0002 --reason "specific failure"\n  block --packet VIRO-0002 --reason "external blocker"\n  unblock --packet VIRO-0002\n  reap --packet VIRO-0002 --reason "agent disappeared"\n\nShared writes require GITHUB_TOKEN with repository Contents read/write permission.\nAll machines must point at the same GitHub repository; the control state lives on the configured control branch.`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (["help", "-h", "--help"].includes(command)) return help();
  const config = await loadConfig();
  const repo = flags.repo ? String(flags.repo) : detectRepo();
  const store = new GitHubStateStore({ repo, token: process.env.GITHUB_TOKEN, config });

  if (command === "bootstrap") {
    await store.ensureControlBranch();
    const { state, sha } = await store.read();
    if (!sha) await store.write(state, null, "orchestrator: bootstrap shared state");
    console.log(`Shared control plane ready: ${repo}#${config.control_branch}:${config.state_path}`);
    return;
  }

  if (command === "sync") {
    const manifests = await manifestsFromDisk(config);
    const { state } = await store.mutate("sync delivery manifests", (draft) => {
      for (const manifest of manifests) importManifest(draft, manifest);
      return manifests.map((m) => m.id);
    });
    console.log(`Synced ${manifests.length} delivery manifest(s).`);
    printBoard(state);
    return;
  }

  if (command === "status") {
    const { state } = await store.read();
    printBoard(state);
    return;
  }

  if (command === "check") {
    const { state } = await store.read();
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
    const { state } = await store.read();
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

  if (command === "reap") {
    const packetId = requireFlag(flags, "packet");
    const reason = flags.reason ? String(flags.reason) : "stale agent lease";
    const { state } = await store.read();
    const stale = new Set(staleAssignments(state, config.lease_ttl_minutes).map((p) => p.id));
    if (!stale.has(packetId) && !flags.force) throw new Error(`${packetId} is not stale; pass --force only after Governor review`);
    await store.mutate(`reap ${packetId}`, (draft) => reapAssignment(draft, { packetId, reason }));
    console.log(`${packetId}: assignment released and packet blocked for Governor review.`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`orchestrator error: ${error.message}`);
  process.exitCode = 1;
});