/**
 * Dev server for the perf harness — same guard pattern as tests/server.mjs,
 * but on the perf worker's own port (5174) so it never collides with the
 * Playwright suite's server on 5173.
 */
import { spawn, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const PERF_PORT = Number(process.env.VIRO_PERF_PORT || 5174);
export const PERF_URL = process.env.VIRO_PERF_URL || `http://127.0.0.1:${PERF_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(timeoutMs = 1500) {
  try {
    const res = await fetch(PERF_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnVite() {
  return spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vite", "--mode", "web", "--host", "127.0.0.1", "--port", String(PERF_PORT), "--strictPort"],
    { cwd: ROOT, stdio: "ignore", shell: process.platform === "win32" },
  );
}

/** On Windows the spawn runs through a shell, so killing the shell orphans the
 * real vite child — exactly the zombie that wedged port 5174 once. Kill the
 * whole process tree instead. */
function stopTree(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
    } else {
      child.kill();
    }
  } catch {
    /* already gone */
  }
}

export async function ensurePerfServer() {
  if (await reachable()) return { url: PERF_URL, stop: () => {} };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const child = spawnVite();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await reachable()) {
        return {
          url: PERF_URL,
          stop: () => stopTree(child),
        };
      }
      if (child.exitCode !== null) break;
      await sleep(400);
    }
    stopTree(child);
    if (attempt < 3) await sleep(1500);
  }
  throw new Error(`perf dev server did not come up at ${PERF_URL} after 3 attempts`);
}
