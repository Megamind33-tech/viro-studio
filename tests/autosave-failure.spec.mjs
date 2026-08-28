/**
 * Autosave write-failure hardening acceptance (packet VIRO-0010).
 *
 * Simulates an IndexedDB write failure (quota / private mode / IO) AFTER a
 * good snapshot exists, through the app's own recovery-sink seam, and proves:
 *  1. the LAST GOOD snapshot stays intact in IndexedDB and is recoverable via
 *     the existing recovery prompt → Restore path;
 *  2. the failure surfaces a truthful status — no silent fake success;
 *  3. a failing autosave tick performs at most ONE whole-document
 *     serialization (critic P2-3: the old code cloned once per sink).
 *
 *   VIRO_URL=http://127.0.0.1:5175 node tests/autosave-failure.spec.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureServer } from "./server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");

const URL = process.env.VIRO_URL || "http://127.0.0.1:5173";

const results = [];
let failed = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
}

async function bootReady(page) {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean(window.__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

const server = await ensureServer();
const browser = await chromium.launch({
  args: [
    "--no-proxy-server",
    "--proxy-bypass-list=*",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await bootReady(page);

// Start from a clean slot so a leftover snapshot cannot mask the scenario.
await page.evaluate(async () => {
  await window.__press.discardRecovery();
});

const OPS = [
  { op: "press.add_rect", params: { x: 200, y: 200, w: 1200, h: 400, fill: "#E07A2F" }, reason: "good snapshot band" },
  { op: "press.add_type_frame", params: { x: 240, y: 260, w: 1000, h: 260, text: "LAST GOOD", size: 160 }, reason: "good snapshot wordmark" },
];

// ── a GOOD autosave first: the last good snapshot ──────────────────────────
const good = await page.evaluate(async (OPS) => {
  const P = window.__press;
  window.viroAnchor.applyDetailed(OPS);
  await P.writeRecovery();
  const mod = await import("/src/library/store.ts");
  const snap = await mod.getRecovery();
  return snap ? { layers: snap.doc?.pages?.[0]?.layers?.length ?? 0, savedAt: snap.savedAt } : null;
}, OPS);

check("good autosave persisted a snapshot to IndexedDB", good !== null && good.layers === 2, JSON.stringify(good));

// ── storage starts failing; a further edit must not clobber the good snapshot ──
const failure = await page.evaluate(async () => {
  const P = window.__press;
  P.recoverySink = () =>
    Promise.reject(Object.assign(new Error("simulated quota exceeded"), { name: "QuotaExceededError" }));
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 60, y: 700, w: 300, h: 200, fill: "#123456" }, reason: "post-failure edit" },
  ]);
  await P.writeRecovery();
  const mod = await import("/src/library/store.ts");
  const snap = await mod.getRecovery();
  return {
    status: P.status,
    storedLayers: snap ? (snap.doc?.pages?.[0]?.layers ?? []).length : null,
    storedSavedAt: snap ? snap.savedAt : null,
  };
});

check("failed autosave surfaces a truthful status message", /autosave failed/i.test(failure.status), failure.status);
check("failed autosave does not fake success", !/saved “|recovered “|autosav(ed|ing) 3|stored/i.test(failure.status.replace(/autosave failed/i, "")), failure.status);
check("last good snapshot is intact (not clobbered by the failed write)", failure.storedLayers === 2, `storedLayers=${failure.storedLayers}`);
check("last good snapshot is the pre-failure write (savedAt unchanged)", failure.storedSavedAt === good.savedAt, `${failure.storedSavedAt} vs ${good.savedAt}`);

// ── failing tick clones the document at most once (P2-3) ────────────────────
const cloneCount = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 400, y: 700, w: 300, h: 200, fill: "#654321" }, reason: "clone-count edit" },
  ]);
  const orig = JSON.stringify;
  let count = 0;
  JSON.stringify = function (value, ...rest) {
    if (value === P.doc) count++;
    return orig.apply(JSON, [value, ...rest]);
  };
  try {
    // Measure ONE tick: disarm the debounce this edit armed so a second,
    // scheduled tick cannot land inside the measurement window.
    if (P.autosaveTimer) {
      clearTimeout(P.autosaveTimer);
      P.autosaveTimer = 0;
    }
    await P.autosaveTick();
  } finally {
    JSON.stringify = orig;
    // The sink stays FAILING through pagehide: storage is still broken at
    // reload time, so the hide-flush must not be able to persist the newer
    // document behind the test's back.
  }
  return { count, status: P.status };
});
check("failing autosave tick serializes the document at most once", cloneCount.count <= 1, `clones=${cloneCount.count}`);
check("failing tick still announces the recovery failure", /autosave failed/i.test(cloneCount.status), cloneCount.status);

// ── reload: the existing recovery path must offer the LAST GOOD snapshot ────
await page.reload({ waitUntil: "domcontentloaded" });
await bootReady(page);

const afterReload = await page.evaluate(() => {
  const P = window.__press;
  const bar = document.getElementById("recover-bar");
  return {
    freshLayers: P.doc.pages[0].layers.length,
    pending: P.pendingRecovery ? { layers: (P.pendingRecovery.doc?.pages?.[0]?.layers ?? []).length } : null,
    barVisible: bar ? bar.hidden === false : false,
  };
});
check("reload does NOT auto-apply any of the unsaved post-failure edits", afterReload.freshLayers === 0, `freshLayers=${afterReload.freshLayers}`);
check("recovery detects the LAST GOOD snapshot (2 layers, not 3 or 4)", afterReload.pending !== null && afterReload.pending.layers === 2, JSON.stringify(afterReload.pending));
check("recovery prompt is visible", afterReload.barVisible === true);

await page.locator("[data-cmd=recover-restore]").click();
const afterRestore = await page.evaluate(() => {
  const P = window.__press;
  const layers = P.doc.pages[0].layers;
  return {
    layers: layers.length,
    hasWordmark: /LAST GOOD/.test(JSON.stringify(P.doc)),
    // The failed-write edits sat at x=60 and x=400 (both y=700, w=300).
    hasPostFailureLayer: layers.some((l) => l.x === 60 || (l.x === 400 && l.y === 700)),
  };
});
check("Restore brings back exactly the last good work", afterRestore.layers === 2 && afterRestore.hasWordmark, `layers=${afterRestore.layers}`);
check("restored document does not contain the failed-write edits", afterRestore.hasPostFailureLayer === false);

// ──────────────────────────────────────────────────────────────────────────────
console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
check("no page errors during failure/recovery flows", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
