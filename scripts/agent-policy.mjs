import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const fail = (message) => {
  console.error(`AGENT POLICY FAIL: ${message}`);
  process.exitCode = 1;
};

const validStates = new Set(["QUEUED", "ACTIVE", "VERIFY", "CRITIC", "REJECTED", "BLOCKED", "DONE"]);
const validDomains = new Set(["editor-core", "canvas-rendering", "typography", "ui-ux", "assets-import", "export", "ai", "platform", "verification", "research-architecture"]);
const verdictStates = new Set(["PENDING", "PASS", "PARTIAL", "BLOCKED", "REJECTED", "NOT_APPLICABLE"]);

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const base = process.env.AGENT_POLICY_BASE || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "HEAD~1");
const changed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
const production = changed.filter((p) =>
  p === "index.html" || p === "package.json" || p === "package-lock.json" || p.startsWith("src/") || p.startsWith("electron/") || p.startsWith("public/") || p.startsWith("vite.config")
);

const deliveryDir = "docs/agents/deliveries";
const deliveryFiles = existsSync(deliveryDir)
  ? readdirSync(deliveryDir).filter((f) => /^VIRO-\d+\.json$/.test(f)).map((f) => join(deliveryDir, f))
  : [];

const manifests = [];
for (const path of deliveryFiles) {
  let m;
  try {
    m = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${path} is not valid JSON: ${err.message}`);
    continue;
  }
  manifests.push({ path, m });
  for (const key of ["id", "title", "priority", "domain", "state", "outcome", "before", "after", "allowed_paths", "acceptance", "evidence", "builder", "verifier", "critic", "delta"]) {
    if (!(key in m)) fail(`${path} missing required field ${key}`);
  }
  if (!/^VIRO-\d{4,}$/.test(m.id || "")) fail(`${path} has invalid id`);
  if (!validStates.has(m.state)) fail(`${path} has invalid state ${m.state}`);
  if (!validDomains.has(m.domain)) fail(`${path} has invalid domain ${m.domain}`);
  if (!Array.isArray(m.allowed_paths) || m.allowed_paths.length === 0) fail(`${path} must declare allowed_paths`);
  if (!Array.isArray(m.acceptance) || m.acceptance.length === 0) fail(`${path} must declare acceptance criteria`);
  if (!Array.isArray(m.evidence) || m.evidence.length === 0) fail(`${path} must declare evidence`);
  for (const who of ["builder", "verifier", "critic"]) {
    if (!m[who] || !verdictStates.has(m[who].status)) fail(`${path} has invalid ${who}.status`);
  }
  if (m.state === "DONE") {
    if (m.verifier?.status !== "PASS") fail(`${path} is DONE without verifier PASS`);
    if (!["PASS", "NOT_APPLICABLE"].includes(m.critic?.status)) fail(`${path} is DONE without critic PASS/NOT_APPLICABLE`);
    if (!m.delta || !m.delta.before || !m.delta.after || m.delta.before.trim() === m.delta.after.trim()) fail(`${path} is DONE without a concrete before→after delta`);
    if (!Array.isArray(m.delta.proof) || m.delta.proof.length === 0) fail(`${path} is DONE without delta proof`);
  }
}

function pathCovered(path, allowed) {
  return allowed.some((rule) => {
    if (rule.endsWith("/**")) return path.startsWith(rule.slice(0, -3));
    if (rule.endsWith("/*")) return path.startsWith(rule.slice(0, -1));
    return path === rule;
  });
}

if (production.length) {
  const changedManifestPaths = changed.filter((p) => /^docs\/agents\/deliveries\/VIRO-\d+\.json$/.test(p));
  const active = manifests.filter(({ path, m }) => changedManifestPaths.includes(path) && ["ACTIVE", "VERIFY", "CRITIC", "DONE"].includes(m.state));
  if (!active.length) fail(`production files changed (${production.join(", ")}) without a changed ACTIVE/VERIFY/CRITIC/DONE delivery manifest`);
  for (const path of production) {
    if (!active.some(({ m }) => pathCovered(path, m.allowed_paths || []))) fail(`${path} is outside every changed delivery manifest allowed_paths`);
  }
}

const diff = git(["diff", "--unified=0", `${base}...HEAD`, "--", "src", "electron", "index.html"]);
const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
const theatre = /\b(TODO|FIXME|HACK|coming soon|not implemented|placeholder)\b/i;
for (const line of added) {
  if (theatre.test(line)) fail(`new production theatre marker detected: ${line.slice(1).trim()}`);
}

const testDiff = git(["diff", "--unified=0", `${base}...HEAD`, "--", "tests"]);
for (const line of testDiff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))) {
  if (/\.(skip|only)\s*\(|\bskip\s*:\s*true\b/.test(line)) fail(`new skipped/focused test detected: ${line.slice(1).trim()}`);
}

if (!process.exitCode) {
  console.log(`AGENT POLICY PASS: ${production.length} production file(s), ${manifests.length} delivery manifest(s) inspected.`);
}