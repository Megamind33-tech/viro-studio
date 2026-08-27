/**
 * Local projects (multi-document library) acceptance — ADR 0004 P1/P2 local-first.
 *
 * Proves the whole path is real, not decorative: an edited document is saved as a
 * project with a REAL page-rendered thumbnail, survives a reload, is listed and
 * re-openable from the Projects dialog with its content intact, and can be
 * renamed and deleted. No cloud, no fixtures — genuine IndexedDB persistence.
 *
 *   node tests/projects.spec.mjs
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

const OPS = [
  { op: "press.add_rect", params: { x: 200, y: 200, w: 1200, h: 400, fill: "#E07A2F" }, reason: "projects fixture band" },
  { op: "press.add_type_frame", params: { x: 240, y: 260, w: 1000, h: 260, text: "PROJECT TEST", size: 160 }, reason: "projects fixture wordmark" },
];

// ── edit + explicit save to Projects ──────────────────────────────────────────
const afterSave = await page.evaluate(async (OPS) => {
  const P = window.__press;
  window.viroAnchor.applyDetailed(OPS);
  await P.saveProjectNow();
  const list = await P.listProjects();
  return {
    currentId: P.currentProjectId,
    count: list.length,
    first: list[0]
      ? { name: list[0].name, hasThumb: typeof list[0].thumbnail === "string", thumbHead: (list[0].thumbnail || "").slice(0, 22), updatedAt: list[0].updatedAt }
      : null,
  };
}, OPS);

check("editing then Save creates a project", afterSave.count === 1 && !!afterSave.currentId, JSON.stringify(afterSave));
check("project thumbnail is a real PNG rendered from the page", afterSave.first?.hasThumb && afterSave.first.thumbHead.startsWith("data:image/png"), afterSave.first?.thumbHead);

const savedId = afterSave.currentId;

// ── reload: project persists ──────────────────────────────────────────────────
await page.reload({ waitUntil: "domcontentloaded" });
await bootReady(page);
await page.evaluate(() => window.__press.discardRecovery()); // keep the test focused on Projects

const afterReload = await page.evaluate(async () => {
  const P = window.__press;
  const list = await P.listProjects();
  return { count: list.length, id: list[0]?.id ?? null, freshLayers: P.doc.pages[0].layers.length, currentId: P.currentProjectId };
});

check("project survives reload (persisted in IndexedDB)", afterReload.count === 1 && afterReload.id === savedId, JSON.stringify(afterReload));
check("reload starts on a fresh document, not silently reopened", afterReload.freshLayers === 0 && afterReload.currentId === null, JSON.stringify(afterReload));

// ── open from the Projects dialog (real UI) ────────────────────────────────────
await page.locator("[data-menu=file]").click();
await page.locator("[data-flyout=file] [data-cmd=projects]").click();
await page.locator("#projects-grid .proj-card").first().waitFor({ state: "visible", timeout: 10_000 });
const dialogState = await page.evaluate(() => {
  const dlg = document.getElementById("dlg-projects");
  return {
    visible: dlg ? dlg.hidden === false : false,
    cards: document.querySelectorAll("#projects-grid .proj-card").length,
    hasThumbImg: !!document.querySelector("#projects-grid .proj-thumb img"),
  };
});
check("Projects dialog opens and lists the project card", dialogState.visible && dialogState.cards === 1, JSON.stringify(dialogState));
check("project card shows the rendered thumbnail image", dialogState.hasThumbImg === true);

await page.locator("[data-proj-open]").click();
await page.locator("#dlg-projects").waitFor({ state: "hidden", timeout: 10_000 });
const afterOpen = await page.evaluate(() => {
  const P = window.__press;
  const dlg = document.getElementById("dlg-projects");
  return {
    dialogHidden: dlg ? dlg.hidden === true : true,
    layers: P.doc.pages[0].layers.length,
    hasContent: /PROJECT TEST/.test(JSON.stringify(P.doc)),
    currentId: P.currentProjectId,
  };
});
check("opening a project loads its content", afterOpen.layers === 2 && afterOpen.hasContent, JSON.stringify(afterOpen));
check("opening sets the current project and closes the dialog", afterOpen.currentId === savedId && afterOpen.dialogHidden, JSON.stringify(afterOpen));

// ── rename + delete (via the same app API the UI calls) ────────────────────────
const afterRename = await page.evaluate(async (id) => {
  const P = window.__press;
  await P.renameProject(id, "Renamed Project");
  const list = await P.listProjects();
  return list[0]?.name ?? null;
}, savedId);
check("rename updates the project name", afterRename === "Renamed Project", String(afterRename));

const afterDelete = await page.evaluate(async (id) => {
  const P = window.__press;
  await P.deleteProject(id);
  const list = await P.listProjects();
  return { count: list.length, currentId: P.currentProjectId };
}, savedId);
check("delete removes the project", afterDelete.count === 0, JSON.stringify(afterDelete));

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
check("no page errors during project flows", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
