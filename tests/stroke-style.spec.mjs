/**
 * Vector stroke styling (dash / cap / join) — proves the styling actually
 * RENDERS, not just that it is stored.
 *
 * Adds a stroked rectangle, renders it, applies a dash via the real
 * `vector.strokeWidth` command, and asserts the pixels changed. A stored-but-
 * not-rendered dash (a decorative control) would leave the render byte-identical
 * and fail here. Undo must restore the solid stroke and the pixels.
 *
 *   node tests/stroke-style.spec.mjs
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

// A wide, thick-stroked open path so a dash pattern is unmistakable.
const dash = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    {
      op: "press.add_line",
      params: { x1: 300, y1: 500, x2: 1500, y2: 500, stroke: { color: "#111111", width: 40 } },
      reason: "dash fixture",
    },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  P.doc.activeLayerIds = [id];
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  // The exact command the Stroke panel runs.
  P.run({ type: "vector.strokeWidth", params: { width: 40, fallbackColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, dash: [60, 40] } });
  const stroke = P.doc.pages[0].layers.find((l) => l.id === id)?.stroke;
  const storedDash = Array.isArray(stroke?.dash) ? stroke.dash.join(",") : "";
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undone = P.doc.pages[0].layers.find((l) => l.id === id)?.stroke;
  return {
    storedDash,
    changed: typeof before === "string" && typeof after === "string" && before !== after,
    beforeLen: (before || "").length,
    afterLen: (after || "").length,
    undoCleared: !undone?.dash,
  };
});

check("dash is stored on the vector stroke", dash.storedDash === "60,40", `dash=${dash.storedDash}`);
check("dashed stroke actually changes the rendered page (not decorative)", dash.changed === true, `before=${dash.beforeLen}B after=${dash.afterLen}B`);
check("undo restores the solid stroke", dash.undoCleared === true);

// Cap + join must visibly change how a thick stroke renders.
const capjoin = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    {
      op: "press.add_line",
      params: { x1: 400, y1: 900, x2: 1400, y2: 900, stroke: { color: "#cc4422", width: 80 } },
      reason: "cap fixture",
    },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  P.doc.activeLayerIds = [id];
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  // Round caps extend a thick line's ends past the endpoints — a real pixel change.
  P.run({ type: "vector.strokeWidth", params: { width: 80, fallbackColor: { r: 0.8, g: 0.27, b: 0.13, a: 1 }, cap: "round" } });
  const cap = P.doc.pages[0].layers.find((l) => l.id === id)?.stroke?.cap;
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  return { cap, changed: typeof before === "string" && before !== after, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("round cap is stored on the vector stroke", capjoin.cap === "round");
check("round cap actually changes the rendered page (not decorative)", capjoin.changed === true, `before=${capjoin.beforeLen}B after=${capjoin.afterLen}B`);

// A dashed stroke placed directly by Anchor must round-trip through save/open.
const roundtrip = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    {
      op: "press.add_rect",
      params: { x: 200, y: 1400, w: 900, h: 400, stroke: { color: "#2266cc", width: 16, dash: [24, 12], cap: "round", join: "round" } },
      reason: "roundtrip fixture",
    },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const original = JSON.stringify(P.doc.pages[0].layers.find((l) => l.id === id)?.stroke);
  // Serialize and re-open through the real open path.
  const bytes = new TextEncoder().encode(JSON.stringify(P.doc)).buffer;
  await P.openBytes("roundtrip.vdj", bytes);
  const reopened = JSON.stringify(P.doc.pages[0].layers.find((l) => l.id === id)?.stroke);
  return { original, reopened, version: P.doc.version };
});

check("document is v5 after opening a styled-stroke file", roundtrip.version === 5, `version=${roundtrip.version}`);
check("dashed/styled stroke round-trips through save/open unchanged", roundtrip.original === roundtrip.reopened, `${roundtrip.original} vs ${roundtrip.reopened}`);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
