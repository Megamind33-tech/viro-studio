import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newState } from "./orchestrator-core.mjs";

function runGit(root, args, { input = undefined, env = {} } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function isRace(error) {
  const text = `${error?.message ?? ""}\n${error?.stderr ?? ""}`.toLowerCase();
  return text.includes("stale info") || text.includes("fetch first") || text.includes("non-fast-forward") || text.includes("rejected");
}

export class GitControlStore {
  constructor({ root = process.cwd(), config, remote = "origin" }) {
    if (!config?.control_branch || !config?.state_path) throw new Error("GitControlStore requires control_branch and state_path");
    this.root = root;
    this.config = config;
    this.remote = remote;
  }

  remoteRef() {
    return `refs/remotes/${this.remote}/${this.config.control_branch}`;
  }

  branchRef() {
    return `refs/heads/${this.config.control_branch}`;
  }

  refresh() {
    try {
      runGit(this.root, ["fetch", "--quiet", this.remote, this.config.control_branch]);
    } catch (error) {
      throw new Error(
        `Git transport could not fetch ${this.remote}/${this.config.control_branch}. ` +
        `The fallback requires normal authenticated git fetch/push access: ${error.message}`,
      );
    }
  }

  read() {
    this.refresh();
    const baseCommit = runGit(this.root, ["rev-parse", this.remoteRef()]);
    try {
      const raw = runGit(this.root, ["show", `${baseCommit}:${this.config.state_path}`]);
      return { state: JSON.parse(raw), baseCommit };
    } catch (error) {
      const text = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
      if (/does not exist|exists on disk, but not in|path .* not in/i.test(text)) {
        return { state: newState(), baseCommit };
      }
      throw error;
    }
  }

  write(state, baseCommit, message) {
    const indexPath = path.join(
      os.tmpdir(),
      `viro-control-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const identity = {
      GIT_INDEX_FILE: indexPath,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "VIRO Orchestrator",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "orchestrator@viro.local",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "VIRO Orchestrator",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "orchestrator@viro.local",
    };

    try {
      const body = `${JSON.stringify(state, null, 2)}\n`;
      const blob = runGit(this.root, ["hash-object", "-w", "--stdin"], { input: body });
      runGit(this.root, ["read-tree", baseCommit], { env: identity });
      runGit(
        this.root,
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${this.config.state_path}`],
        { env: identity },
      );
      const tree = runGit(this.root, ["write-tree"], { env: identity });
      const commit = runGit(
        this.root,
        ["commit-tree", tree, "-p", baseCommit, "-m", message],
        { env: identity },
      );
      runGit(
        this.root,
        [
          "push",
          "--quiet",
          `--force-with-lease=${this.branchRef()}:${baseCommit}`,
          this.remote,
          `${commit}:${this.branchRef()}`,
        ],
      );
      return commit;
    } finally {
      try { fs.unlinkSync(indexPath); } catch { /* temporary index may already be absent */ }
    }
  }

  async mutate(label, mutation, retries = 7) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const { state, baseCommit } = this.read();
      const draft = structuredClone(state);
      const result = await mutation(draft);
      try {
        const commit = this.write(draft, baseCommit, `orchestrator: ${label}`);
        return { state: draft, result, commit };
      } catch (error) {
        lastError = error;
        if (!isRace(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 80 * attempt));
      }
    }
    throw new Error(`Git control-state update lost the concurrency race after ${retries} attempts: ${lastError?.message}`);
  }
}
