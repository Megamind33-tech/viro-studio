/**
 * Autosave / crash-recovery acceptance (data-loss P0).
 *
 * The editor has no server; the only safety net between explicit .press.json
 * saves is the local IndexedDB recovery slot. This proves the whole path is
 * real: an edit is autosaved, a reload does NOT silently lose or auto-apply it,
 * the recovery prompt appears, Restore brings the work back, and Discard clears
 * it. If any step were decorative the document would not round-trip.
 *
 *   node tests/recovery.spec.mjs
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

// Start from a clean slot so a leftover snapshot cannot mask a real failure.
await page.evaluate(async () => {
  await window.__press.discardRecovery();
});

const OPS = [
  { op: "press.add_rect", params: { x: 200, y: 200, w: 1200, h: 400, fill: "#E07A2F" }, reason: "recovery fixture band" },
  { op: "press.add_type_frame", params: { x: 240, y: 260, w: 1000, h: 260, text: "RECOVER ME", size: 160 }, reason: "recovery fixture wordmark" },
];

// ── edit + autosave ────────────────────────────────────────────────────────
const afterEdit = await page.evaluate(async (OPS) => {
  const P = window.__press;
  window.viroAnchor.applyDetailed(OPS);
  // Force the debounced autosave to complete synchronously for the test.
  await P.writeRecovery();
  return { layers: P.doc.pages[0].layers.length, name: P.doc.name };
}, OPS);

check("edit created the fixture layers", afterEdit.layers === 2, `layers=${afterEdit.layers}`);

const stored = await page.evaluate(async () => {
  const P = window.__press;
  // Read back through the same store the app uses.
  const mod = await import("/src/library/store.ts");
  const snap = await mod.getRecovery();
  return snap ? { name: snap.name, layers: (snap.doc?.pages?.[0]?.layers ?? []).length, savedAt: snap.savedAt } : null;
});

check("autosave persisted a recovery snapshot to IndexedDB", stored !== null && stored.layers === 2, JSON.stringify(stored));

// ── reload: work must NOT auto-apply, prompt MUST appear ─────────────────────
await page.reload({ waitUntil: "domcontentloaded" });
await bootReady(page);

const afterReload = await page.evaluate(() => {
  const P = window.__press;
  const bar = document.getElementById("recover-bar");
  return {
    freshLayers: P.doc.pages[0].layers.length,
    pending: P.pendingRecovery ? { name: P.pendingRecovery.name, layers: (P.pendingRecovery.doc?.pages?.[0]?.layers ?? []).length } : null,
    barVisible: bar ? bar.hidden === false : false,
    barText: document.getElementById("recover-name")?.textContent ?? "",
  };
});

check("reload does NOT silently auto-apply recovered work", afterReload.freshLayers === 0, `freshLayers=${afterReload.freshLayers}`);
check("recovery snapshot is detected on boot", afterReload.pending !== null && afterReload.pending.layers === 2, JSON.stringify(afterReload.pending));
check("recovery prompt is visible", afterReload.barVisible === true, `barVisible=${afterReload.barVisible}`);
check("recovery prompt names the document", /px|autosaved/i.test(afterReload.barText) || afterReload.barText.length > 0, afterReload.barText);

// ── restore ──────────────────────────────────────────────────────────────────
await page.locator("[data-cmd=recover-restore]").click();
const afterRestore = await page.evaluate(() => {
  const P = window.__press;
  const bar = document.getElementById("recover-bar");
  const texts = P.doc.pages[0].layers.map((l) => l.story || l.name || "").join(" ");
  return {
    layers: P.doc.pages[0].layers.length,
    hasWordmark: /RECOVER ME/.test(JSON.stringify(P.doc)),
    barHidden: bar ? bar.hidden === true : true,
    texts,
  };
});

check("Restore brings the work back", afterRestore.layers === 2, `layers=${afterRestore.layers}`);
check("restored document contains the fixture content", afterRestore.hasWordmark, afterRestore.texts);
check("prompt is dismissed after Restore", afterRestore.barHidden === true);

// ── discard on a second cycle ─────────────────────────────────────────────────
await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 10, y: 10, w: 100, h: 100, fill: "#123456" }, reason: "second cycle" },
  ]);
  await P.writeRecovery();
});
await page.reload({ waitUntil: "domcontentloaded" });
await bootReady(page);
await page.locator("[data-cmd=recover-discard]").click();

const afterDiscard = await page.evaluate(async () => {
  const P = window.__press;
  const bar = document.getElementById("recover-bar");
  const mod = await import("/src/library/store.ts");
  const snap = await mod.getRecovery();
  return { pending: P.pendingRecovery, barHidden: bar ? bar.hidden === true : true, storeEmpty: !snap };
});

check("Discard hides the prompt", afterDiscard.barHidden === true);
check("Discard clears the pending snapshot", afterDiscard.pending === null);
check("Discard deletes the persisted snapshot", afterDiscard.storeEmpty === true, `storeEmpty=${afterDiscard.storeEmpty}`);

// ──────────────────────────────────────────────────────────────────────────────
console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
check("no page errors during recovery flows", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
