/**
 * Drop-shadow layer effect — proves it actually RENDERS, not just stored.
 *
 * Renders the page before and after enabling a drop shadow and asserts the
 * pixels changed. A stored-but-not-rendered effect (a decorative control) would
 * leave the render byte-identical and fail here.
 *
 *   node tests/effects.spec.mjs
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
  args: ["--no-proxy-server", "--proxy-bypass-list=*", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await bootReady(page);

const out = await page.evaluate(async () => {
  const P = window.__press;
  // A red rectangle with clear space around it, so a shadow has room to show.
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 400, y: 400, w: 600, h: 600, fill: "#E07A2F" }, reason: "effects fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setDropShadow(id, { type: "drop-shadow", enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 40, offsetY: 40, blur: 30, opacity: 0.8 });
  const stored = P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "drop-shadow" && e.enabled);
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  // Undo must remove it and restore the render.
  P.undo();
  const afterUndo = P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "drop-shadow" && e.enabled);
  return {
    stored: !!stored,
    changed: typeof before === "string" && typeof after === "string" && before !== after,
    beforeLen: (before || "").length,
    afterLen: (after || "").length,
    undoCleared: !afterUndo,
  };
});

check("drop shadow is stored on the layer", out.stored === true);
check("drop shadow actually changes the rendered page (not decorative)", out.changed === true, `before=${out.beforeLen}B after=${out.afterLen}B`);
check("undo removes the drop shadow", out.undoCleared === true);

// Group case — the Critic found the effect was decorative on groups. Prove it renders.
const grp = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 300, y: 300, w: 300, h: 300, fill: "#3388ff" }, reason: "group child a" },
    { op: "press.add_rect", params: { x: 800, y: 800, w: 300, h: 300, fill: "#33cc88" }, reason: "group child b" },
  ]);
  const layers = P.doc.pages[0].layers;
  const a = layers[layers.length - 2].id;
  const b = layers[layers.length - 1].id;
  P.doc.activeLayerIds = [a, b];
  P.group();
  const group = P.doc.pages[0].layers.find((l) => l.kind === "group");
  if (!group) return { ok: false };
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setDropShadow(group.id, { type: "drop-shadow", enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 40, offsetY: 40, blur: 30, opacity: 0.85 });
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  return { ok: true, changed: typeof before === "string" && before !== after, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("group can receive a drop shadow", grp.ok === true);
check("group drop shadow actually renders (was decorative — now fixed)", grp.changed === true, `before=${grp.beforeLen}B after=${grp.afterLen}B`);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
