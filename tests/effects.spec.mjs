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

// Gradient overlay must actually render over the layer silhouette.
const grad = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 200, y: 1400, w: 900, h: 500, fill: "#cccccc" }, reason: "gradient fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setGradientOverlay(id, {
    type: "gradient-overlay",
    enabled: true,
    angle: 90,
    stops: [
      { offset: 0, color: { r: 0.9, g: 0.3, b: 0.1, a: 1 } },
      { offset: 1, color: { r: 0.1, g: 0.1, b: 0.5, a: 1 } },
    ],
    opacity: 1,
  });
  const stored = P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "gradient-overlay" && e.enabled);
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undoCleared = !P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "gradient-overlay" && e.enabled);
  return { stored: !!stored, changed: typeof before === "string" && before !== after, undoCleared, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("gradient overlay is stored on the layer", grad.stored === true);
check("gradient overlay actually renders (not decorative)", grad.changed === true, `before=${grad.beforeLen}B after=${grad.afterLen}B`);
check("undo removes the gradient overlay", grad.undoCleared === true);

// Stroke/outline effect must actually render a ring around the layer silhouette.
const stroke = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 1400, y: 300, w: 500, h: 500, fill: "#4488cc" }, reason: "stroke fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setStrokeEffect(id, { type: "stroke", enabled: true, color: { r: 0.9, g: 0.1, b: 0.1, a: 1 }, width: 30, opacity: 1 });
  const stored = P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "stroke" && e.enabled);
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undoCleared = !P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "stroke" && e.enabled);
  return { stored: !!stored, changed: typeof before === "string" && before !== after, undoCleared, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("stroke effect is stored on the layer", stroke.stored === true);
check("stroke effect actually renders (not decorative)", stroke.changed === true, `before=${stroke.beforeLen}B after=${stroke.afterLen}B`);
check("undo removes the stroke effect", stroke.undoCleared === true);

// Outer glow must actually render a soft halo behind the layer.
const glow = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 1400, y: 1400, w: 500, h: 400, fill: "#222222" }, reason: "glow fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setOuterGlow(id, { type: "outer-glow", enabled: true, color: { r: 1, g: 0.85, b: 0.2, a: 1 }, blur: 60, opacity: 1 });
  const stored = P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "outer-glow" && e.enabled);
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undoCleared = !P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "outer-glow" && e.enabled);
  return { stored: !!stored, changed: typeof before === "string" && before !== after, undoCleared, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("outer glow is stored on the layer", glow.stored === true);
check("outer glow actually renders (not decorative)", glow.changed === true, `before=${glow.beforeLen}B after=${glow.afterLen}B`);
check("undo removes the outer glow", glow.undoCleared === true);

const inner = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 200, y: 200, w: 700, h: 700, fill: "#f2d4a0" }, reason: "inner-shadow fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setInnerShadow(id, { type: "inner-shadow", enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 24, offsetY: 32, blur: 28, opacity: 0.85 });
  const stored = P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "inner-shadow" && e.enabled);
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undoCleared = !P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "inner-shadow" && e.enabled);
  return { stored: !!stored, changed: typeof before === "string" && before !== after, undoCleared, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("inner shadow is stored on the layer", inner.stored === true);
check("inner shadow actually renders (not decorative)", inner.changed === true, `before=${inner.beforeLen}B after=${inner.afterLen}B`);
check("undo removes the inner shadow", inner.undoCleared === true);

const longS = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 400, y: 400, w: 400, h: 400, fill: "#e07a2f" }, reason: "long-shadow fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setLongShadow(id, { type: "long-shadow", enabled: true, color: { r: 0.05, g: 0.05, b: 0.08, a: 1 }, angle: 135, length: 80, opacity: 0.7 });
  const stored = P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "long-shadow" && e.enabled);
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undoCleared = !P.doc.pages[0].layers.find((l) => l.id === id)?.effects?.some((e) => e.type === "long-shadow" && e.enabled);
  return { stored: !!stored, changed: typeof before === "string" && before !== after, undoCleared, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("3D long shadow is stored on the layer", longS.stored === true);
check("3D long shadow actually renders (not decorative)", longS.changed === true, `before=${longS.beforeLen}B after=${longS.afterLen}B`);
check("undo removes the 3D long shadow", longS.undoCleared === true);

const under = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_type_frame", params: { x: 200, y: 400, w: 1400, h: 280, text: "UNDERLINE", size: 96, leading: 110 }, reason: "underline fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.setCharacter({ underline: true });
  const stored = P.doc.stories.find((s) => s.id === P.doc.pages[0].layers.find((l) => l.id === id)?.storyId)?.character.underline;
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undoCleared = !P.doc.stories.find((s) => s.id === P.doc.pages[0].layers.find((l) => l.id === id)?.storyId)?.character.underline;
  return { stored: !!stored, changed: typeof before === "string" && before !== after, undoCleared, beforeLen: (before || "").length, afterLen: (after || "").length };
});

check("underline is stored on the story", under.stored === true);
check("underline actually renders (not decorative)", under.changed === true, `before=${under.beforeLen}B after=${under.afterLen}B`);
check("undo removes the underline", under.undoCleared === true);

const fillG = await page.evaluate(async () => {
  const P = window.__press;
  window.viroAnchor.applyDetailed([
    { op: "press.add_rect", params: { x: 200, y: 200, w: 1200, h: 800, fill: "#e07a2f" }, reason: "gradient-fill fixture" },
  ]);
  const layers = P.doc.pages[0].layers;
  const id = layers[layers.length - 1].id;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.applyLinearFill();
  const fill = P.doc.pages[0].layers.find((l) => l.id === id)?.fill;
  const stored = fill && fill.type === "linear" && Array.isArray(fill.stops) && fill.stops.length >= 2;
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.undo();
  const undone = P.doc.pages[0].layers.find((l) => l.id === id)?.fill;
  const undoCleared = undone && typeof undone.r === "number" && !undone.type;
  return {
    stored: !!stored,
    changed: typeof before === "string" && before !== after,
    undoCleared: !!undoCleared,
    version: P.doc.version,
    beforeLen: (before || "").length,
    afterLen: (after || "").length,
  };
});

check("linear gradient fill is stored on the vector", fillG.stored === true);
check("linear gradient fill actually renders (not a solid alias)", fillG.changed === true, `before=${fillG.beforeLen}B after=${fillG.afterLen}B`);
check("undo restores the solid fill", fillG.undoCleared === true);
check("document is v7 after a gradient fill", fillG.version === 7, `version=${fillG.version}`);

const frameG = await page.evaluate(async () => {
  const P = window.__press;
  const before = P.compositor.thumbnailDataUrl(P.doc, 256);
  P.run({ type: "image.addFrame", params: { x: 200, y: 300, w: 900, h: 600 } });
  const layer = P.doc.pages[0].layers.find((l) => l.name === "Frame" && l.kind === "image-frame");
  const after = P.compositor.thumbnailDataUrl(P.doc, 256);
  const layerThumb = layer ? P.compositor.layerThumb(P.doc, layer.id, 128) : null;
  const tab = document.getElementById("tab-layers")?.textContent ?? "";
  P.run({ type: "page.guide", params: { axis: "v", offset: 480 } });
  const guides = P.doc.pages[0].guides;
  P.undo();
  const guidesAfterUndo = P.doc.pages[0].guides.length;
  P.undo();
  const frameGone = !P.doc.pages[0].layers.some((l) => l.id === layer?.id);
  return {
    stored: !!layer && layer.assetId === null,
    changed: typeof before === "string" && typeof after === "string" && before !== after,
    layerThumb: typeof layerThumb === "string" && layerThumb.startsWith("data:image/png") && layerThumb.length > 200,
    layerThumbLen: (layerThumb || "").length,
    tab,
    guideCount: guides.length,
    guideAxis: guides[guides.length - 1]?.axis,
    guideOffset: guides[guides.length - 1]?.offset,
    guidesAfterUndo,
    frameGone,
    beforeLen: (before || "").length,
    afterLen: (after || "").length,
    tools: {
      frame: Boolean(document.querySelector('#toolbox [data-tool="frame"]')),
      rotate: Boolean(document.querySelector('#toolbox [data-tool="rotate"]')),
      guide: Boolean(document.querySelector('#toolbox [data-tool="guide"]')),
    },
  };
});

check("empty picture box is stored as an image-frame with no asset", frameG.stored === true);
check("empty picture box actually draws (copper X, not a missing thumbnail)", frameG.changed === true, `before=${frameG.beforeLen}B after=${frameG.afterLen}B`);
check("empty picture box has a real layer thumbnail (not a missing-icon)", frameG.layerThumb === true, `len=${frameG.layerThumbLen}`);
check("Layers tab lists the new frame", /Layers\s*\(\d+\)/.test(frameG.tab), `tab=${JSON.stringify(frameG.tab)}`);
check("vertical guide is stored on the page", frameG.guideAxis === "v" && frameG.guideOffset === 480, `guides=${frameG.guideCount}`);
check("undo removes the guide then the frame", frameG.guidesAfterUndo === frameG.guideCount - 1 && frameG.frameGone === true);
check("toolbox has Frame, Rotate, and Guide tools", frameG.tools.frame && frameG.tools.rotate && frameG.tools.guide);

const guideOps = await page.evaluate(() => {
  const P = window.__press;
  P.run({ type: "page.guide", params: { axis: "v", offset: 240 } });
  P.run({ type: "page.guide", params: { axis: "h", offset: 180 } });
  const ids = P.doc.pages[0].guides.map((g) => g.id);
  const beforeMove = P.doc.pages[0].guides.find((g) => g.id === ids[0])?.offset;
  P.run({ type: "page.guideMove", params: { id: ids[0], offset: 400 } });
  const moved = P.doc.pages[0].guides.find((g) => g.id === ids[0])?.offset;
  const countBeforeClear = P.doc.pages[0].guides.length;
  P.run({ type: "page.guidesClear", params: {} });
  const afterClear = P.doc.pages[0].guides.length;
  P.undo();
  const afterUndo = P.doc.pages[0].guides.length;
  return {
    beforeMove,
    moved,
    countBeforeClear,
    afterClear,
    afterUndo,
    clearBtn: Boolean(document.querySelector('[data-cmd="view-clear-guides"]')),
    snapBtn: Boolean(document.querySelector('[data-cmd="view-snap"]')),
    snapOn: P.snapEnabled === true,
  };
});

check("page.guideMove writes a new offset", guideOps.moved === 400 && guideOps.beforeMove === 240, `before=${guideOps.beforeMove} after=${guideOps.moved}`);
check("page.guidesClear drops every guide", guideOps.afterClear === 0 && guideOps.countBeforeClear >= 2, `before=${guideOps.countBeforeClear} after=${guideOps.afterClear}`);
check("undo restores guides after Clear Guides", guideOps.afterUndo === guideOps.countBeforeClear, `undo=${guideOps.afterUndo}`);
check("View menu has Clear Guides and Snap to Guides", guideOps.clearBtn && guideOps.snapBtn && guideOps.snapOn === true);

const jpegG = await page.evaluate(() => {
  const P = window.__press;
  const bytes = P.compositor.snapshotPageJpeg(P.doc);
  const jpegBtn = Boolean(document.querySelector('[data-cmd="export-jpeg"]'));
  const pdfBtn = Boolean(document.querySelector('[data-cmd="export-pdf"]'));
  return {
    jpegBtn,
    pdfBtn,
    magic: bytes && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    len: bytes ? bytes.length : 0,
  };
});

check("File menu has Export JPEG and Export PDF", jpegG.jpegBtn && jpegG.pdfBtn);
check("JPEG snapshot is a real JFIF/JPEG (FF D8 FF), not a renamed PNG", jpegG.magic === true, `len=${jpegG.len}`);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
