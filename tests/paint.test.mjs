/**
 * Vector fill paint — solid vs linear/radial gradient (document v7).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/paint.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyVectorFill, setVectorFill } from "../src/document/ops.ts";
import { isGradientFill, isSolidFill, linearGradientFill, fillExportRgb } from "../src/document/paint.ts";
import { validateVectorFill, validateDocument } from "../src/document/factory.ts";
import { DOC_VERSION, migrateDocument, needsMigration } from "../src/document/migrate.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";

const COPPER = { r: 0.878, g: 0.478, b: 0.184, a: 1 };
const INK = { r: 0.12, g: 0.12, b: 0.14, a: 1 };

function rectNodes(w, h) {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
}

function docWithRect() {
  const doc = documentFromPreset(PRESETS[0]);
  doc.pages[0].layers.push({
    id: "L1",
    name: "rect",
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: rectNodes(100, 100),
    fill: { r: 1, g: 0, b: 0, a: 1 },
    stroke: null,
  });
  doc.activeLayerIds = ["L1"];
  return doc;
}

test("isGradientFill discriminates a linear fill from a solid {r,g,b,a}", () => {
  assert.equal(isGradientFill({ r: 1, g: 0, b: 0, a: 1 }), false);
  assert.equal(isSolidFill({ r: 1, g: 0, b: 0, a: 1 }), true);
  const g = linearGradientFill(COPPER, INK, 90);
  assert.equal(isGradientFill(g), true);
  assert.equal(isSolidFill(g), false);
  assert.equal(g.stops.length, 2);
});

test("setVectorFill stores a gradient and JSON round-trips it", () => {
  const fill = linearGradientFill(COPPER, INK, 45);
  const next = setVectorFill(docWithRect(), "L1", fill);
  const stored = next.pages[0].layers.find((l) => l.id === "L1")?.fill;
  assert.equal(isGradientFill(stored), true);
  assert.equal(stored.type, "linear");
  assert.equal(stored.angle, 45);
  const round = JSON.parse(JSON.stringify(next));
  assert.deepEqual(round.pages[0].layers.find((l) => l.id === "L1").fill, stored);
  assert.deepEqual(validateDocument(next), []);
});

test("applyVectorFill is one undo-sized mutation of the selection", () => {
  const doc = docWithRect();
  const next = applyVectorFill(doc, linearGradientFill(COPPER, INK, 90));
  assert.notEqual(next, doc);
  assert.equal(isGradientFill(next.pages[0].layers.find((l) => l.id === "L1").fill), true);
  assert.equal(isSolidFill(doc.pages[0].layers.find((l) => l.id === "L1").fill), true);
});

test("validateVectorFill rejects a one-stop gradient", () => {
  const errs = validateVectorFill({ type: "linear", angle: 0, stops: [{ offset: 0, color: COPPER }] }, "x");
  assert.ok(errs.some((e) => /at least 2/.test(e)), errs.join(" | "));
});

test("fillExportRgb is the start stop — PDF's honest fallback", () => {
  const g = linearGradientFill(COPPER, INK, 90);
  assert.deepEqual(fillExportRgb(g), COPPER);
  assert.deepEqual(fillExportRgb(INK), INK);
});

test("MIGRATION INVARIANT v6 -> v7: a solid fill is not rewritten", () => {
  const doc = docWithRect();
  doc.version = 6;
  const before = JSON.parse(JSON.stringify(doc.pages[0].layers[0].fill));
  assert.equal(needsMigration(doc), true);
  const r = migrateDocument(doc);
  assert.equal(r.from, 6);
  assert.equal(r.to, DOC_VERSION);
  assert.equal(r.gradientFillsStamped, 1);
  assert.equal(doc.version, DOC_VERSION);
  assert.deepEqual(doc.pages[0].layers[0].fill, before);
  assert.equal(isGradientFill(doc.pages[0].layers[0].fill), false);
});
