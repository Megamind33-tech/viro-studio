/**
 * VIRO-0005 — vector PDF export must preserve compound boolean geometry.
 *
 * Before this fix, `src/export/pdf.ts` emitVector() walked only legacy
 * `layer.nodes`. A boolean-op result carries `nodes: []` with all geometry in
 * `contours[]`, so every compound layer was silently absent from the PDF
 * (report.vectorPaths stayed 0, no rasterFallback was recorded either).
 *
 * These tests drive the real exporter end-to-end (no mocking of pdf-lib) and
 * decode the saved PDF's content stream back out to assert the actual `m`/`c`/
 * `h`/fill operators that landed on the page, the same reproduction method the
 * gap audit used.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/pdf-compound.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFDocument, PDFArray, decodePDFRawStream } from "pdf-lib";
import { subtractVectors, booleanCombineVectors } from "../src/document/boolean-ops.ts";
import { exportPagePdf } from "../src/export/pdf.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert.ok(existsSync(ckWasm), "canvaskit.wasm missing");
const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const rectNodes = (w, h) => {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
};

function vectorRect(id, x, y, w, h, fill = { r: 0, g: 0, b: 0, a: 1 }) {
  return {
    id,
    kind: "vector",
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: rectNodes(w, h),
    fill,
    stroke: null,
  };
}

function docWithLayer(layer, pageW = 400, pageH = 400) {
  return {
    version: 6,
    name: "VIRO-0005 fixture",
    ppi: 72,
    color: { workingSpace: "sRGB", intent: "perceptual", iccProfileName: null },
    pages: [
      {
        id: "p1",
        name: "Page 1",
        widthPx: pageW,
        heightPx: pageH,
        bleedPx: 0,
        columnCount: 1,
        columnGutter: 0,
        background: { r: 1, g: 1, b: 1, a: 0 },
        layers: [layer],
      },
    ],
    spreads: [],
    stories: [],
    swatches: [],
    activePageId: "p1",
    activeLayerIds: [],
    assets: {},
  };
}

/** Reload the saved PDF and decode its page content stream(s) back to text. */
async function contentText(bytes) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const raws =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i))
      : [contents];
  let text = "";
  for (const raw of raws) {
    if (!raw) continue;
    const decoded = decodePDFRawStream(raw).decode();
    text += Buffer.from(decoded).toString("latin1") + "\n";
  }
  return text;
}

function tokenCounts(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const count = (tok) => tokens.filter((t) => t === tok).length;
  return {
    m: count("m"),
    c: count("c"),
    h: count("h"),
    f: count("f"),
    fStar: count("f*"),
    S: count("S"),
    B: count("B"),
    BStar: count("B*"),
    w: count("w"),
  };
}

/* ------------------------------------------------------------------ *
 * Legacy single-contour regression (must stay byte-identical in shape)
 * ------------------------------------------------------------------ */

test("legacy single-contour vector exports one moveTo, nonzero fill, unchanged topology", async () => {
  const layer = vectorRect("rect", 50, 50, 200, 200);
  const { bytes, report } = await exportPagePdf({ doc: docWithLayer(layer), face: null });
  const counts = tokenCounts(await contentText(bytes));

  // Matches the audit's own measured baseline for a single-contour control rect.
  assert.equal(counts.m, 1, "one subpath");
  assert.equal(counts.c, 4, "3 loop curves + 1 closing curve");
  assert.equal(counts.h, 1, "closed path");
  assert.equal(counts.f, 1, "plain nonzero fill, not even-odd");
  assert.equal(counts.fStar, 0, "single contour must not switch to even-odd");
  assert.equal(report.vectorPaths, 1);
  assert.deepEqual(report.rasterFallbacks, []);
});

/* ------------------------------------------------------------------ *
 * Compound geometry: subtract-produced ring
 * ------------------------------------------------------------------ */

test("subtract ring (2 contours) exports both contours with even-odd fill, not silently dropped", async () => {
  const outer = vectorRect("outer", 100, 100, 200, 200);
  const inner = vectorRect("inner", 150, 150, 100, 100);
  const page = { id: "p", layers: [outer, inner] };
  const result = subtractVectors(ck, page, outer, inner);
  assert.ok(result, "subtract must produce a result layer");
  assert.equal(result.contours.length, 2, "outer ring + one hole contour");
  assert.equal(result.nodes.length, 0, "legacy nodes field is empty on a v6 compound result");

  const { bytes, report } = await exportPagePdf({ doc: docWithLayer(result), face: null });
  const counts = tokenCounts(await contentText(bytes));

  assert.equal(counts.m, 2, "both contours must be emitted, not just the first/none");
  assert.equal(counts.h, 2, "both contours are closed");
  assert.equal(counts.fStar, 1, "compound fill must use even-odd so the hole reads as a hole");
  assert.equal(counts.f, 0, "must not fall back to the plain nonzero fill operator");
  assert.equal(report.vectorPaths, 1, "the compound layer counts as one vector path, not zero");
  assert.deepEqual(report.rasterFallbacks, [], "boolean geometry must not manufacture a raster fallback");
});

/* ------------------------------------------------------------------ *
 * Compound geometry: disjoint union
 * ------------------------------------------------------------------ */

test("disjoint union (2 contours) exports every drawable contour", async () => {
  const left = vectorRect("left", 0, 0, 100, 100);
  const right = vectorRect("right", 200, 0, 100, 100);
  const page = { id: "p", layers: [left, right] };
  const result = booleanCombineVectors(ck, page, [left, right], "union");
  assert.ok(result);
  assert.equal(result.contours.length, 2);

  const { bytes, report } = await exportPagePdf({ doc: docWithLayer(result), face: null });
  const counts = tokenCounts(await contentText(bytes));

  assert.equal(counts.m, 2, "legacy exporter would have emitted 0 — nodes is empty on this result");
  assert.equal(counts.fStar, 1);
  assert.equal(report.vectorPaths, 1);
  assert.deepEqual(report.rasterFallbacks, []);
});

/* ------------------------------------------------------------------ *
 * Stroke preservation on compound geometry
 * ------------------------------------------------------------------ */

test("stroke-only compound vector strokes without filling, and does not rasterize", async () => {
  const outer = vectorRect("outer", 100, 100, 200, 200);
  const inner = vectorRect("inner", 150, 150, 100, 100);
  const page = { id: "p", layers: [outer, inner] };
  const result = subtractVectors(ck, page, outer, inner);
  assert.ok(result);
  result.fill = null;
  result.stroke = { color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, width: 4 };

  const { bytes, report } = await exportPagePdf({ doc: docWithLayer(result), face: null });
  const counts = tokenCounts(await contentText(bytes));

  assert.equal(counts.m, 2);
  assert.equal(counts.S, 1, "stroke-only paints with S");
  assert.equal(counts.f, 0);
  assert.equal(counts.fStar, 0);
  assert.equal(counts.B, 0);
  assert.equal(counts.BStar, 0);
  assert.equal(counts.w, 1, "stroke width is emitted");
  assert.equal(report.vectorPaths, 1);
  assert.deepEqual(report.rasterFallbacks, []);
});

test("fill+stroke compound vector uses even-odd fill-and-stroke and keeps the stroke", async () => {
  const outer = vectorRect("outer", 100, 100, 200, 200);
  const inner = vectorRect("inner", 150, 150, 100, 100);
  const page = { id: "p", layers: [outer, inner] };
  const result = subtractVectors(ck, page, outer, inner);
  assert.ok(result);
  result.stroke = { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 };

  const { bytes, report } = await exportPagePdf({ doc: docWithLayer(result), face: null });
  const counts = tokenCounts(await contentText(bytes));

  assert.equal(counts.BStar, 1, "fill+stroke on a compound path must use the even-odd fill-and-stroke operator");
  assert.equal(counts.B, 0, "must not use the nonzero fill-and-stroke operator");
  assert.equal(counts.f, 0);
  assert.equal(counts.fStar, 0);
  assert.equal(counts.S, 0);
  assert.equal(counts.w, 1);
  assert.equal(report.vectorPaths, 1);
  assert.deepEqual(report.rasterFallbacks, []);
});
