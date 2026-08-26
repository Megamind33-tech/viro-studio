/**
 * Boolean path operations — ADR 0005 Phase-0 proof-of-model spike.
 *
 * Proves the multi-contour model end-to-end in the real editor:
 *  - a `subtract` of two overlapping rects produces a v6 multi-contour layer;
 *  - the result RENDERS with the hole visible (pixel sample at the page centre
 *    flips from the fill colour to the page background — a decorative/no-op
 *    boolean would leave the centre filled and fail here);
 *  - one undo restores both operands as a single history step;
 *  - the result round-trips through save/open as v6 unchanged;
 *  - an existing single-contour vector still renders (no regression).
 *
 *   node tests/booleans.spec.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ensureServer } from "./server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");

const ARTIFACTS = "/opt/cursor/artifacts";
try {
  mkdirSync(ARTIFACTS, { recursive: true });
} catch {
  // artifacts dir is best-effort
}

const URL = process.env.VIRO_URL || "http://127.0.0.1:5173";

const results = [];
let failed = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
}

function savePng(name, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return;
  try {
    writeFileSync(join(ARTIFACTS, name), Buffer.from(dataUrl.split(",")[1], "base64"));
  } catch {
    // best-effort
  }
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
  const pg = P.doc.pages[0];
  const W = pg.widthPx;
  const H = pg.heightPx;
  const S = Math.min(W, H) * 0.6; // outer rect edge
  const I = Math.min(W, H) * 0.25; // inner (hole) edge
  const cx = W / 2;
  const cy = H / 2;

  // Sample a rendered thumbnail at a fractional position and return [r,g,b,a].
  const sample = (dataUrl, fx, fy) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const px = g.getImageData(Math.round(fx * img.width), Math.round(fy * img.height), 1, 1).data;
        resolve([px[0], px[1], px[2], px[3]]);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });

  // `applyDetailed`, `subtractSelected` and `undo` each replace P.doc, so the
  // page must be re-read fresh after every mutation (a captured reference goes
  // stale). Inner rect FIRST (drawn beneath), outer rect SECOND (topmost).
  // Subtract = topmost (outer) minus the one beneath (inner) → a centred hole.
  const curLayers = () => P.doc.pages[0].layers;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: cx - I / 2, y: cy - I / 2, w: I, h: I, fill: "#2266cc" }, reason: "inner (hole) operand" },
    { op: "press.add_rect", params: { x: cx - S / 2, y: cy - S / 2, w: S, h: S, fill: "#E07A2F" }, reason: "outer operand" },
  ]);
  const innerId = curLayers()[curLayers().length - 2].id;
  const outerId = curLayers()[curLayers().length - 1].id;
  const layerCountBefore = curLayers().length;

  const beforeThumb = P.compositor.thumbnailDataUrl(P.doc, 512);
  const centreBefore = await sample(beforeThumb, 0.5, 0.5); // covered by the solid outer rect

  // Select both operands and run the real proof boolean.
  P.doc.activeLayerIds = [innerId, outerId];
  const ok = P.subtractSelected();

  const resultLayer = curLayers()[curLayers().length - 1];
  const contours = resultLayer?.contours?.length ?? 0;
  const layerCountAfter = curLayers().length;

  const afterThumb = P.compositor.thumbnailDataUrl(P.doc, 512);
  const centreAfter = await sample(afterThumb, 0.5, 0.5); // now inside the hole → page background
  // A point out at 0.5 ± 0.2 of the page sits in the ring (outer extends to 0.3, inner to 0.125).
  const ringAfter = await sample(afterThumb, 0.5 + 0.2 * (Math.min(W, H) / W), 0.5);

  // One undo must restore BOTH operands (single history step).
  P.undo();
  const layerCountUndo = curLayers().length;
  const operandsBack =
    curLayers().some((l) => l.id === innerId) && curLayers().some((l) => l.id === outerId);

  // Round-trip the (redone) result through the real open path.
  P.doc.activeLayerIds = [innerId, outerId];
  P.subtractSelected();
  const redoneResult = curLayers()[curLayers().length - 1];
  const contoursJson = JSON.stringify(redoneResult.contours);
  const bytes = new TextEncoder().encode(JSON.stringify(P.doc)).buffer;
  await P.openBytes("booleans.vdj", bytes);
  const reopened = P.doc.pages[0].layers[P.doc.pages[0].layers.length - 1];
  const reopenedContoursJson = JSON.stringify(reopened.contours);

  return {
    ok,
    contours,
    layerCountBefore,
    layerCountAfter,
    layerCountUndo,
    operandsBack,
    centreBefore,
    centreAfter,
    ringAfter,
    version: P.doc.version,
    roundTripped: contoursJson === reopenedContoursJson,
    reopenedContours: reopened.contours?.length ?? 0,
    beforeThumb,
    afterThumb,
  };
});

savePng("booleans-before-solid-rect.png", out.beforeThumb);
savePng("booleans-after-hole.png", out.afterThumb);

const isFill = (px) => px && px[0] > 150 && px[1] > 60 && px[1] < 170 && px[2] < 90; // copper #E07A2F-ish
const isBackground = (px) => px && px[0] > 220 && px[1] > 220 && px[2] > 220; // white page

check("subtractSelected succeeded", out.ok === true);
check("result is a multi-contour compound path (outer ring + hole)", out.contours === 2, `contours=${out.contours}`);
check("subtract consumed both operands into one layer", out.layerCountAfter === out.layerCountBefore - 1, `before=${out.layerCountBefore} after=${out.layerCountAfter}`);
check("before subtract, page centre is the solid fill colour", isFill(out.centreBefore), `centre=${JSON.stringify(out.centreBefore)}`);
check("after subtract, the HOLE is visible at page centre (background shows)", isBackground(out.centreAfter), `centre=${JSON.stringify(out.centreAfter)}`);
check("after subtract, the RING is still filled off-centre", isFill(out.ringAfter), `ring=${JSON.stringify(out.ringAfter)}`);
check("one undo restores BOTH operands (single history step)", out.operandsBack === true && out.layerCountUndo === out.layerCountBefore, `undoCount=${out.layerCountUndo}`);
check("document is v6 after opening a compound-path file", out.version === 6, `version=${out.version}`);
check("multi-contour result round-trips through save/open unchanged", out.roundTripped === true && out.reopenedContours === 2, `reopenedContours=${out.reopenedContours}`);

// Existing single-contour vector still renders (no regression to the legacy path).
const single = await page.evaluate(async () => {
  const P = window.__press;
  const sample = (dataUrl, fx, fy) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const px = g.getImageData(Math.round(fx * img.width), Math.round(fy * img.height), 1, 1).data;
        resolve([px[0], px[1], px[2], px[3]]);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  const pg0 = P.doc.pages[0];
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: pg0.widthPx * 0.4, y: pg0.heightPx * 0.4, w: pg0.widthPx * 0.2, h: pg0.heightPx * 0.2, fill: "#33aa55" }, reason: "single-contour regression" },
  ]);
  // Re-read fresh: applyDetailed replaced P.doc.
  const freshLayers = P.doc.pages[0].layers;
  const layer = freshLayers[freshLayers.length - 1];
  const isSingle = !layer.contours;
  const thumb = P.compositor.thumbnailDataUrl(P.doc, 512);
  const centre = await sample(thumb, 0.5, 0.5);
  return { isSingle, centre };
});
check("a fresh rect is still a single-contour vector (no contours[])", single.isSingle === true);
check("single-contour vector still renders filled (legacy path intact)", single.centre && single.centre[1] > 120 && single.centre[0] < 140, `centre=${JSON.stringify(single.centre)}`);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
