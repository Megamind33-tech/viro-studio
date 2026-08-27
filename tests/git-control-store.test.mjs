import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitControlStore } from "../scripts/lib/git-control-store.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viro-git-control-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(root, ["init", "--bare", origin]);
  git(work, ["init"]);
  git(work, ["config", "user.name", "VIRO Test"]);
  git(work, ["config", "user.email", "viro-test@example.invalid"]);
  fs.writeFileSync(path.join(work, "README.md"), "fixture\n");
  git(work, ["add", "README.md"]);
  git(work, ["commit", "-m", "fixture"]);
  git(work, ["branch", "-M", "main"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "main"]);
  git(work, ["branch", "viro-agent-control"]);
  git(work, ["push", "origin", "viro-agent-control"]);
  return { root, work };
}

const config = {
  control_branch: "viro-agent-control",
  state_path: ".viro-control/state.json",
};

test("git control transport writes shared state without an HTTP API", async (t) => {
  const { root, work } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new GitControlStore({ root: work, config });

  const first = store.read();
  assert.equal(first.state.revision, 0);

  await store.mutate("test mutation", (state) => {
    state.revision += 1;
    state.events.push({ type: "test.git-transport" });
  });

  const second = store.read();
  assert.equal(second.state.revision, 1);
  assert.equal(second.state.events.at(-1).type, "test.git-transport");
  const remoteText = git(work, ["show", `origin/viro-agent-control:${config.state_path}`]);
  assert.equal(JSON.parse(remoteText).revision, 1);
});

test("git control transport rejects a stale writer with force-with-lease", async (t) => {
  const { root, work } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new GitControlStore({ root: work, config });

  const stale = store.read();
  await store.mutate("winning mutation", (state) => {
    state.revision += 1;
  });

  const staleDraft = structuredClone(stale.state);
  staleDraft.revision += 99;
  assert.throws(
    () => store.write(staleDraft, stale.baseCommit, "orchestrator: stale writer"),
    /push|rejected|stale|status/i,
  );

  const current = store.read();
  assert.equal(current.state.revision, 1);
});
