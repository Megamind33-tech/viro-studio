/**
 * Runner for the foundation slice acceptance scripts.
 *
 * Starts ONE dev server, runs the acceptance scripts against it, then stops it. Each
 * script managing its own server did not survive the full `npm test` chain:
 * the first script's teardown left port 5173 in a state where node's fetch
 * reported the next server reachable while Chromium's navigation still timed
 * out. One server for the whole slice removes the race entirely.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureServer } from "./server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = [
  // slice 1 - hierarchical transforms
  "group-transform.spec.mjs",
  "group-parity.spec.mjs",
  // slice 2 - image-frame clipping and fit semantics
  "image-frame.spec.mjs",
  // slice 3 - typed command bus
  "command-bus.spec.mjs",
  // slice 4 - Anchor routed through the bus
  "anchor-bus.spec.mjs",
  // audited desktop integration - the File menu reaches the preload bridge
  "electron-bridge.spec.mjs",
  // data-loss P0 - autosave to IndexedDB and crash/reload recovery
  "recovery.spec.mjs",
  // local-first platform (ADR 0004) - projects library + real thumbnails
  "projects.spec.mjs",
];

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "tests", script)], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const server = await ensureServer();
let failed = 0;
try {
  for (const script of SCRIPTS) {
    console.log(`\n--- ${script} ---`);
    const code = await run(script);
    if (code !== 0) failed++;
  }
} finally {
  server.stop();
}

console.log(`\nfoundation slices: ${SCRIPTS.length - failed}/${SCRIPTS.length} scripts passed`);
process.exit(failed ? 1 : 0);
