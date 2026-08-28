/**
 * VIRO-0011 DRAFT — document-identity recovery model (browser E2E).
 * Uncommitted prep draft: encodes the TARGET API against REAL IndexedDB and is
 * expected RED on current main. Do not treat as a gate.
 *
 * Proves the three identity rules end-to-end on the real store:
 *  1. two documents edited in sequence keep independent recovery snapshots;
 *  2. restore preserves project identity (critic P3-2);
 *  3. deleting a project also deletes its recovery record and its identity is
 *     never reused — a deleted document cannot resurrect.
 *
 *   VIRO_URL=http://127.0.0.1:<port> node tests/recovery-identity.spec.mjs
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

// Clean slate: every pending recovery record, any identity.
await page.evaluate(async () => {
  await window.__press.discardAllRecoveries();
});

// ── document A: edits + durable project + recovery record under A's identity ──
const docA = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 200, y: 200, w: 600, h: 300, fill: "#E07A2F" }, reason: "A band" },
    { op: "press.add_type_frame", params: { x: 240, y: 260, w: 500, h: 200, text: "DOC A", size: 120 }, reason: "A wordmark" },
  ]);
  await P.saveProjectNow();
  const idA = P.currentProjectId;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 900, y: 200, w: 300, h: 200, fill: "#123456" }, reason: "A extra" },
  ]);
  await P.writeRecovery();
  return { idA, layers: P.doc.pages[0].layers.length };
});
check("document A autosaved under its project identity", /^proj_/.test(docA.idA) && docA.layers === 3, JSON.stringify(docA));

// ── document B: a second document, edited in sequence ─────────────────────────
const docB = await page.evaluate(async () => {
  const P = window.__press;
  await P.newProject();
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 100, y: 100, w: 200, h: 200, fill: "#654321" }, reason: "B rect" },
  ]);
  await P.saveProjectNow();
  await P.writeRecovery();
  return { idB: P.currentProjectId };
});

// Re-read the store in a second evaluate for clear assertions.
const store = await page.evaluate(async (idA) => {
  const mod = await import("/src/library/store.ts");
  const list = await mod.listRecovery();
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  return {
    count: list.length,
    a: byId[idA] ? byId[idA].doc.pages[0].layers.length : null,
    b: byId[window.__press.currentProjectId] ? byId[window.__press.currentProjectId].doc.pages[0].layers.length : null,
  };
}, docA.idA);

check("two sequentially edited documents keep independent snapshots", store.count === 2, JSON.stringify(store));
check("snapshot A is intact after B's autosave", store.a === 3, `aLayers=${store.a}`);
check("snapshot B has its own content", store.b === 1, `bLayers=${store.b}`);
check("identities differ between the two documents", docB.idB !== docA.idA, `${docA.idA} vs ${docB.idB}`);

// ── reload: both recoveries surface; restore preserves project identity ───────
await page.reload({ waitUntil: "domcontentloaded" });
await bootReady(page);

const boot = await page.evaluate(() => {
  const P = window.__press;
  return {
    pending: (P.pendingRecoveries || []).map((r) => r.id),
    head: P.pendingRecovery ? P.pendingRecovery.id : null,
    freshLayers: P.doc.pages[0].layers.length,
  };
});
check("boot lists both pending recoveries", boot.pending.length === 2 && boot.pending.includes(docA.idA) && boot.pending.includes(docB.idB), JSON.stringify(boot));
check("recover-bar shows the newest record", boot.head === boot.pending[0], JSON.stringify(boot));
check("reload does not auto-apply any recovery", boot.freshLayers === 0, `freshLayers=${boot.freshLayers}`);

const restored = await page.evaluate(async (idA) => {
  const P = window.__press;
  const ok = P.restoreRecovery(idA);
  const mod = await import("/src/library/store.ts");
  const rec = await mod.getProject(idA);
  return {
    ok,
    layers: P.doc.pages[0].layers.length,
    identity: P.currentProjectId,
    createdAt: P.projectCreatedAt,
    storedCreatedAt: rec ? rec.createdAt : null,
    hasWordmark: /DOC A/.test(JSON.stringify(P.doc)),
  };
}, docA.idA);
check("restoreRecovery(idA) restores A's content", restored.ok === true && restored.layers === 3 && restored.hasWordmark, JSON.stringify(restored));
check("restore preserves project identity (P3-2)", restored.identity === docA.idA, restored.identity);
check("restore preserves the project's creation timestamp", restored.createdAt === restored.storedCreatedAt, `${restored.createdAt} vs ${restored.storedCreatedAt}`);

// ── deleting a project must not resurrect it through recovery ─────────────────
const deleted = await page.evaluate(async (idA) => {
  const P = window.__press;
  await P.deleteProject(idA);
  const mod = await import("/src/library/store.ts");
  const rec = await mod.getProject(idA);
  const snap = await mod.getRecovery(idA);
  return { projectGone: !rec, recoveryGone: !snap };
}, docA.idA);
check("deleteProject removes the project record", deleted.projectGone === true);
check("deleteProject also removes the recovery record", deleted.recoveryGone === true);

const afterDelete = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 50, y: 50, w: 120, h: 120, fill: "#2468AC" }, reason: "post-delete edit" },
  ]);
  await P.writeRecovery();
  const mod = await import("/src/library/store.ts");
  const list = await mod.listRecovery();
  return {
    identity: P.currentProjectId,
    listIds: list.map((r) => r.id),
  };
});
check("editing after delete mints a new identity, never the deleted one", /^proj_/.test(afterDelete.identity) && afterDelete.identity !== docA.idA, afterDelete.identity);
check("the deleted identity never reappears in the store", !afterDelete.listIds.includes(docA.idA), JSON.stringify(afterDelete.listIds));

// ── cleanup ───────────────────────────────────────────────────────────────────
await page.evaluate(async () => {
  await window.__press.discardAllRecoveries();
});
await page.evaluate(async (idB) => {
  await window.__press.deleteProject(idB);
}, docB.idB);

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
check("no page errors during identity recovery flows", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
