#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { approvalIsFresh, evaluateCheckRuns, validateReleasePacket } from "./lib/release-gate.mjs";

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

function required(flags, key) {
  const value = flags[key];
  if (!value || value === true) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  return String(value);
}

function evidenceList(value) {
  if (!value || value === true) return [];
  return String(value).split("||").map((item) => item.trim()).filter(Boolean);
}

function detectRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (match) return `${match[1]}/${match[2]}`;
  } catch {
    // Explicit --repo remains available.
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

class GitHubReleaseStore {
  constructor({ repo, token, config }) {
    if (!repo) throw new Error("Repository not detected; set GITHUB_REPOSITORY or pass --repo owner/name");
    if (!token) throw new Error("GITHUB_TOKEN is required for release automation");
    this.repo = repo;
    this.owner = repo.split("/")[0];
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
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    if (!response.ok) throw new HttpError(response.status, body?.message ?? response.statusText, body);
    return body;
  }

  async readState() {
    const branch = this.config.control_branch;
    const file = this.config.state_path.split("/").map(encodeURIComponent).join("/");
    const body = await this.request(`/repos/${this.repo}/contents/${file}?ref=${encodeURIComponent(branch)}`);
    const json = Buffer.from(body.content.replaceAll("\n", ""), "base64").toString("utf8");
    return { state: JSON.parse(json), sha: body.sha };
  }

  async writeState(state, sha, message) {
    const branch = this.config.control_branch;
    const file = this.config.state_path.split("/").map(encodeURIComponent).join("/");
    return this.request(`/repos/${this.repo}/contents/${file}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        branch,
        sha,
        content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8").toString("base64"),
      }),
    });
  }

  async mutate(label, mutation, retries = 7) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const { state, sha } = await this.readState();
      const draft = structuredClone(state);
      const result = await mutation(draft);
      try {
        await this.writeState(draft, sha, `orchestrator: ${label}`);
        return { state: draft, result };
      } catch (error) {
        lastError = error;
        if (!(error instanceof HttpError) || ![409, 422].includes(error.status)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
    throw new Error(`release state update lost concurrency race: ${lastError?.message}`);
  }

  async branch(branch) {
    return this.request(`/repos/${this.repo}/branches/${encodeURIComponent(branch)}`);
  }

  async findOpenPullRequest(branch) {
    const params = new URLSearchParams({ state: "open", base: "main", head: `${this.owner}:${branch}`, per_page: "20" });
    const pulls = await this.request(`/repos/${this.repo}/pulls?${params}`);
    return pulls.find((pr) => pr.head?.ref === branch && pr.base?.ref === "main") ?? null;
  }

  async ensurePullRequest(packet) {
    await this.branch(packet.work_branch);
    let pr = await this.findOpenPullRequest(packet.work_branch);
    if (pr) return pr;
    pr = await this.request(`/repos/${this.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: `${packet.id}: ${packet.title}`,
        head: packet.work_branch,
        base: "main",
        body: `Automated VIRO delivery PR for ${packet.id}.\n\nOutcome: ${packet.outcome}\n\nThis PR may merge only through the resident Orchestrator release gate.`,
        maintainer_can_modify: true,
      }),
    });
    return pr;
  }

  async pullRequest(number) {
    return this.request(`/repos/${this.repo}/pulls/${number}`);
  }

  async checkRuns(sha) {
    const body = await this.request(`/repos/${this.repo}/commits/${sha}/check-runs?per_page=100`);
    return body.check_runs ?? [];
  }

  async mergePullRequest(pr, packet) {
    return this.request(`/repos/${this.repo}/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: JSON.stringify({
        sha: pr.head.sha,
        merge_method: this.config.release?.merge_method ?? "squash",
        commit_title: `${packet.id}: ${packet.title}`,
        commit_message: `Approved and automatically merged by the VIRO resident Orchestrator after independent release gates.`,
      }),
    });
  }

  async deleteBranch(branch) {
    try {
      await this.request(`/repos/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "DELETE" });
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return true;
      console.warn(`warning: merged but could not delete branch ${branch}: ${error.message}`);
      return false;
    }
  }
}

async function loadConfig() {
  const raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  return {
    control_branch: "viro-agent-control",
    state_path: ".viro-control/state.json",
    release: {
      target_branch: "main",
      merge_method: "squash",
      delete_branch: true,
      required_checks: ["Delivery policy", "Product regression gates"],
      ...(raw.release ?? {}),
    },
    ...raw,
    release: {
      target_branch: "main",
      merge_method: "squash",
      delete_branch: true,
      required_checks: ["Delivery policy", "Product regression gates"],
      ...(raw.release ?? {}),
    },
  };
}

function appendEvent(state, event) {
  state.revision = Number(state.revision ?? 0) + 1;
  state.updated_at = new Date().toISOString();
  state.events ??= [];
  state.events.push({ at: state.updated_at, ...event });
  if (state.events.length > 300) state.events = state.events.slice(-300);
}

function clearAgent(state, packet) {
  if (packet.assigned_agent && state.agents?.[packet.assigned_agent]) delete state.agents[packet.assigned_agent];
  packet.assigned_agent = null;
  packet.assigned_role = null;
  packet.heartbeat_at = null;
  const lease = state.leases?.[packet.id];
  if (lease) {
    lease.current_agent = null;
    lease.current_stage = "release";
  }
}

async function recordApproval(store, { packetId, agentId, evidence, pr }) {
  return store.mutate(`approve release ${packetId}`, (state) => {
    const packet = state.packets?.[packetId];
    const errors = validateReleasePacket(packet, { agentId, requireAssignment: true });
    if (errors.length) throw new Error(`release approval rejected: ${errors.join("; ")}`);
    if (!evidence.length) throw new Error("release approval requires concrete evidence");

    const now = new Date().toISOString();
    packet.evidence ??= [];
    packet.evidence.push(...evidence.map((item) => ({ stage: "release", by: agentId, item, at: now })));
    packet.release_approval = {
      status: "APPROVED",
      by: agentId,
      at: now,
      pr_number: pr.number,
      pr_url: pr.html_url,
      head_sha: pr.head.sha,
      base: "main",
      evidence,
    };
    packet.status = "RELEASE";
    packet.last_handoff = { from: "release", to: "merge-gate", by: agentId, at: now, evidence };
    clearAgent(state, packet);
    appendEvent(state, { type: "release.approved", packet: packetId, by: agentId, pr: pr.number, head_sha: pr.head.sha });
    return packet.release_approval;
  });
}

async function markApprovalStale(store, packetId, reason) {
  return store.mutate(`invalidate release approval ${packetId}`, (state) => {
    const packet = state.packets?.[packetId];
    if (!packet?.release_approval || packet.release_approval.status === "MERGED") return null;
    packet.release_approval.status = "STALE";
    packet.release_approval.stale_reason = reason;
    packet.release_approval.stale_at = new Date().toISOString();
    appendEvent(state, { type: "release.approval_stale", packet: packetId, reason });
    return packet.release_approval;
  });
}

async function finalizeMerged(store, packetId, pr, mergeSha) {
  return store.mutate(`finalize merged release ${packetId}`, (state) => {
    const packet = state.packets?.[packetId];
    if (!packet) throw new Error(`Unknown packet ${packetId}`);
    if (packet.status === "DONE" && packet.merge?.sha === mergeSha) return packet;
    if (!packet.release_approval || packet.release_approval.pr_number !== pr.number) throw new Error("release approval missing or PR mismatch during merge finalization");

    const now = new Date().toISOString();
    packet.stage = "done";
    packet.status = "DONE";
    packet.merge = { pr_number: pr.number, pr_url: pr.html_url, sha: mergeSha, merged_at: now, base: "main", head: packet.work_branch };
    packet.release_approval.status = "MERGED";
    packet.release_approval.merged_at = now;
    packet.release_approval.merge_sha = mergeSha;
    packet.last_handoff = { from: "merge-gate", to: "done", by: "orchestrator-auto-merge", at: now, evidence: [`merged PR #${pr.number} as ${mergeSha}`] };
    if (packet.assigned_agent && state.agents?.[packet.assigned_agent]) delete state.agents[packet.assigned_agent];
    packet.assigned_agent = null;
    packet.assigned_role = null;
    packet.heartbeat_at = null;
    if (state.leases) delete state.leases[packet.id];
    appendEvent(state, { type: "release.merged", packet: packetId, pr: pr.number, merge_sha: mergeSha });
    return packet;
  });
}

async function tryMergePacket(store, config, packetId) {
  const { state } = await store.readState();
  const packet = state.packets?.[packetId];
  const errors = validateReleasePacket(packet);
  if (errors.length) return { packet: packetId, status: "BLOCKED", reason: errors.join("; ") };
  if (packet.status === "DONE") return { packet: packetId, status: "DONE", merge: packet.merge ?? null };
  if (packet.release_approval?.status !== "APPROVED") return { packet: packetId, status: "NOT_APPROVED" };

  let pr = await store.pullRequest(packet.release_approval.pr_number);
  if (pr.merged) {
    const mergeSha = pr.merge_commit_sha;
    await finalizeMerged(store, packetId, pr, mergeSha);
    if (config.release.delete_branch) await store.deleteBranch(packet.work_branch);
    return { packet: packetId, status: "MERGED", pr: pr.number, merge_sha: mergeSha, reconciled: true };
  }

  const freshness = approvalIsFresh(packet, pr);
  if (!freshness.fresh) {
    await markApprovalStale(store, packetId, freshness.reason);
    return { packet: packetId, status: "STALE_APPROVAL", reason: freshness.reason };
  }

  const checks = evaluateCheckRuns(await store.checkRuns(pr.head.sha), config.release.required_checks);
  if (!checks.ready) {
    return { packet: packetId, status: "APPROVED_WAITING_CI", checks };
  }

  pr = await store.pullRequest(pr.number);
  const freshAgain = approvalIsFresh(packet, pr);
  if (!freshAgain.fresh) {
    await markApprovalStale(store, packetId, freshAgain.reason);
    return { packet: packetId, status: "STALE_APPROVAL", reason: freshAgain.reason };
  }
  if (pr.mergeable === false || ["dirty", "blocked"].includes(pr.mergeable_state)) {
    return { packet: packetId, status: "MERGE_BLOCKED", reason: `GitHub merge state ${pr.mergeable_state ?? "unknown"}` };
  }

  const merged = await store.mergePullRequest(pr, packet);
  if (!merged?.merged) return { packet: packetId, status: "MERGE_BLOCKED", reason: merged?.message ?? "GitHub refused merge" };
  await finalizeMerged(store, packetId, pr, merged.sha);
  if (config.release.delete_branch) await store.deleteBranch(packet.work_branch);
  return { packet: packetId, status: "MERGED", pr: pr.number, merge_sha: merged.sha };
}

async function approve(store, config, flags) {
  const packetId = required(flags, "packet");
  const agentId = required(flags, "agent");
  const evidence = evidenceList(flags.evidence);
  const { state } = await store.readState();
  const packet = state.packets?.[packetId];
  const errors = validateReleasePacket(packet, { agentId, requireAssignment: true });
  if (errors.length) throw new Error(errors.join("; "));

  const pr = await store.ensurePullRequest(packet);
  await recordApproval(store, { packetId, agentId, evidence, pr });
  const result = await tryMergePacket(store, config, packetId);
  console.log(JSON.stringify(result, null, 2));
}

async function sweep(store, config) {
  const { state } = await store.readState();
  const ids = Object.values(state.packets ?? {})
    .filter((packet) => packet.stage === "release" && packet.release_approval?.status === "APPROVED")
    .map((packet) => packet.id);

  const results = [];
  for (const id of ids) {
    try {
      results.push(await tryMergePacket(store, config, id));
    } catch (error) {
      results.push({ packet: id, status: "ERROR", reason: error.message });
    }
  }
  console.log(JSON.stringify({ inspected: ids.length, results }, null, 2));
  if (results.some((result) => result.status === "ERROR")) process.exitCode = 1;
}

function help() {
  console.log(`VIRO automatic release worker\n\nCommands:\n  approve --agent ID --packet VIRO-0002 --evidence "proof one||proof two"\n  sweep\n\napprove records independent release-manager approval, ensures a PR to main exists, and merges immediately if required CI is green. If CI is pending, the packet remains APPROVED and the GitHub workflow later calls sweep automatically. A changed PR head invalidates approval.`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (["help", "-h", "--help"].includes(command)) return help();
  const config = await loadConfig();
  const repo = flags.repo ? String(flags.repo) : detectRepo();
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const store = new GitHubReleaseStore({ repo, token, config });

  if (command === "approve") return approve(store, config, flags);
  if (command === "sweep") return sweep(store, config);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`release error: ${error.message}`);
  process.exitCode = 1;
});
