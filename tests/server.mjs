/**
 * Shared dev-server guard for the standalone slice tests.
 *
 * The Playwright suite manages its own webServer, but these scripts run under
 * plain node, so `npm test` from a clean checkout has to bring the server up
 * itself. If one is already listening we reuse it and leave it alone.
 *
 * Retry exists because of a real failure: in the full `npm test` chain
 * Playwright tears its server down, then each slice script spawns and kills its
 * own vite. The second spawn could hit `--strictPort` while 5173 was still
 * being released, so the script waited the full timeout and failed even though
 * it passed in isolation.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const URL_ = process.env.VIRO_URL || "http://127.0.0.1:5173";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function reachable(timeoutMs = 1500) {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnVite() {
  return spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vite", "--mode", "web", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    { cwd: ROOT, stdio: "ignore", shell: process.platform === "win32" },
  );
}

export async function ensureServer() {
  if (await reachable()) return { url: URL_, stop: () => {} };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const child = spawnVite();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await reachable()) {
        return {
          url: URL_,
          stop: () => {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          },
        };
      }
      // The previous vite may still hold the port; a dead child means
      // --strictPort refused, so back off and try again rather than burning
      // the whole deadline.
      if (child.exitCode !== null) break;
      await sleep(400);
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    if (attempt < 3) await sleep(1500);
  }
  throw new Error(`dev server did not come up at ${URL_} after 3 attempts`);
}
