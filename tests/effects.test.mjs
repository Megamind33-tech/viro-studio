/**
 * Unit tests for the drop-shadow layer effect op.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/effects.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  setLayerDropShadow,
  setLayerGradientOverlay,
  setLayerInnerShadow,
  setLayerLongShadow,
  setLayerOuterGlow,
  setLayerStrokeEffect,
} from "../src/document/ops.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";

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
    nodes: [],
    fill: { r: 1, g: 0, b: 0, a: 1 },
    stroke: null,
  });
  return doc;
}

const SHADOW = { type: "drop-shadow", enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 6, offsetY: 8, blur: 12, opacity: 0.45 };

test("adds a drop-shadow effect to the layer", () => {
  const doc = docWithRect();
  const next = setLayerDropShadow(doc, "L1", SHADOW);
  const fx = next.pages[0].layers[0].effects;
  assert.equal(fx.length, 1);
  assert.equal(fx[0].type, "drop-shadow");
  assert.equal(fx[0].enabled, true);
  assert.equal(fx[0].offsetY, 8);
});

test("is immutable — the input document is untouched", () => {
  const doc = docWithRect();
  setLayerDropShadow(doc, "L1", SHADOW);
  assert.equal(doc.pages[0].layers[0].effects, undefined);
});

test("replaces the existing drop-shadow rather than stacking duplicates", () => {
  let doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  doc = setLayerDropShadow(doc, "L1", { ...SHADOW, blur: 30 });
  const fx = doc.pages[0].layers[0].effects.filter((e) => e.type === "drop-shadow");
  assert.equal(fx.length, 1);
  assert.equal(fx[0].blur, 30);
});

test("null clears the drop-shadow effect", () => {
  let doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  doc = setLayerDropShadow(doc, "L1", null);
  const fx = doc.pages[0].layers[0].effects.filter((e) => e.type === "drop-shadow");
  assert.equal(fx.length, 0);
});

test("effect survives a JSON round-trip (serializable)", () => {
  const doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round.pages[0].layers[0].effects, [SHADOW]);
});

const GRAD = {
  type: "gradient-overlay",
  enabled: true,
  angle: 90,
  stops: [
    { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
    { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
  ],
  opacity: 1,
};

test("drop shadow and gradient overlay coexist in the effects list", () => {
  let doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  doc = setLayerGradientOverlay(doc, "L1", GRAD);
  const fx = doc.pages[0].layers[0].effects;
  assert.equal(fx.length, 2);
  assert.ok(fx.find((e) => e.type === "drop-shadow"));
  assert.ok(fx.find((e) => e.type === "gradient-overlay"));
});

test("clearing gradient overlay leaves the drop shadow intact", () => {
  let doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  doc = setLayerGradientOverlay(doc, "L1", GRAD);
  doc = setLayerGradientOverlay(doc, "L1", null);
  const fx = doc.pages[0].layers[0].effects;
  assert.equal(fx.length, 1);
  assert.equal(fx[0].type, "drop-shadow");
});

const STROKE = { type: "stroke", enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, width: 6, opacity: 1 };
const GLOW = { type: "outer-glow", enabled: true, color: { r: 1, g: 0.9, b: 0.4, a: 1 }, blur: 16, opacity: 0.85 };

test("adds a stroke effect to the layer", () => {
  const next = setLayerStrokeEffect(docWithRect(), "L1", STROKE);
  const fx = next.pages[0].layers[0].effects;
  assert.equal(fx.length, 1);
  assert.equal(fx[0].type, "stroke");
  assert.equal(fx[0].width, 6);
});

test("replaces the existing stroke rather than stacking duplicates", () => {
  let doc = setLayerStrokeEffect(docWithRect(), "L1", STROKE);
  doc = setLayerStrokeEffect(doc, "L1", { ...STROKE, width: 20 });
  const fx = doc.pages[0].layers[0].effects.filter((e) => e.type === "stroke");
  assert.equal(fx.length, 1);
  assert.equal(fx[0].width, 20);
});

test("null clears the stroke effect", () => {
  let doc = setLayerStrokeEffect(docWithRect(), "L1", STROKE);
  doc = setLayerStrokeEffect(doc, "L1", null);
  assert.equal(doc.pages[0].layers[0].effects.filter((e) => e.type === "stroke").length, 0);
});

test("adds an outer glow effect to the layer", () => {
  const next = setLayerOuterGlow(docWithRect(), "L1", GLOW);
  const fx = next.pages[0].layers[0].effects;
  assert.equal(fx.length, 1);
  assert.equal(fx[0].type, "outer-glow");
  assert.equal(fx[0].blur, 16);
});

test("null clears the outer glow effect", () => {
  let doc = setLayerOuterGlow(docWithRect(), "L1", GLOW);
  doc = setLayerOuterGlow(doc, "L1", null);
  assert.equal(doc.pages[0].layers[0].effects.filter((e) => e.type === "outer-glow").length, 0);
});

test("all four effects coexist independently in the effects list", () => {
  let doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  doc = setLayerGradientOverlay(doc, "L1", GRAD);
  doc = setLayerStrokeEffect(doc, "L1", STROKE);
  doc = setLayerOuterGlow(doc, "L1", GLOW);
  const fx = doc.pages[0].layers[0].effects;
  assert.equal(fx.length, 4);
  for (const t of ["drop-shadow", "gradient-overlay", "stroke", "outer-glow"]) {
    assert.ok(fx.find((e) => e.type === t), `missing ${t}`);
  }
});

test("clearing the stroke leaves the other three effects intact", () => {
  let doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  doc = setLayerGradientOverlay(doc, "L1", GRAD);
  doc = setLayerStrokeEffect(doc, "L1", STROKE);
  doc = setLayerOuterGlow(doc, "L1", GLOW);
  doc = setLayerStrokeEffect(doc, "L1", null);
  const fx = doc.pages[0].layers[0].effects;
  assert.equal(fx.length, 3);
  assert.equal(fx.filter((e) => e.type === "stroke").length, 0);
});

test("stroke and glow survive a JSON round-trip (serializable)", () => {
  let doc = setLayerStrokeEffect(docWithRect(), "L1", STROKE);
  doc = setLayerOuterGlow(doc, "L1", GLOW);
  const round = JSON.parse(JSON.stringify(doc));
  const fx = round.pages[0].layers[0].effects;
  assert.deepEqual(fx.find((e) => e.type === "stroke"), STROKE);
  assert.deepEqual(fx.find((e) => e.type === "outer-glow"), GLOW);
});

const INNER = { type: "inner-shadow", enabled: true, color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 2, offsetY: 4, blur: 8, opacity: 0.55 };
const LONG = { type: "long-shadow", enabled: true, color: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, angle: 135, length: 28, opacity: 0.55 };

test("adds an inner-shadow effect to the layer", () => {
  const next = setLayerInnerShadow(docWithRect(), "L1", INNER);
  const fx = next.pages[0].layers[0].effects;
  assert.equal(fx.length, 1);
  assert.equal(fx[0].type, "inner-shadow");
  assert.equal(fx[0].offsetY, 4);
});

test("replaces the existing inner-shadow rather than stacking duplicates", () => {
  let doc = setLayerInnerShadow(docWithRect(), "L1", INNER);
  doc = setLayerInnerShadow(doc, "L1", { ...INNER, blur: 22 });
  const fx = doc.pages[0].layers[0].effects.filter((e) => e.type === "inner-shadow");
  assert.equal(fx.length, 1);
  assert.equal(fx[0].blur, 22);
});

test("null clears the inner-shadow effect", () => {
  let doc = setLayerInnerShadow(docWithRect(), "L1", INNER);
  doc = setLayerInnerShadow(doc, "L1", null);
  assert.equal(doc.pages[0].layers[0].effects.filter((e) => e.type === "inner-shadow").length, 0);
});

test("adds a long-shadow effect to the layer", () => {
  const next = setLayerLongShadow(docWithRect(), "L1", LONG);
  const fx = next.pages[0].layers[0].effects;
  assert.equal(fx[0].type, "long-shadow");
  assert.equal(fx[0].length, 28);
});

test("null clears the long-shadow effect", () => {
  let doc = setLayerLongShadow(docWithRect(), "L1", LONG);
  doc = setLayerLongShadow(doc, "L1", null);
  assert.equal(doc.pages[0].layers[0].effects.filter((e) => e.type === "long-shadow").length, 0);
});

test("inner and long shadows coexist with drop shadow and survive JSON", () => {
  let doc = setLayerDropShadow(docWithRect(), "L1", SHADOW);
  doc = setLayerInnerShadow(doc, "L1", INNER);
  doc = setLayerLongShadow(doc, "L1", LONG);
  const fx = doc.pages[0].layers[0].effects;
  assert.equal(fx.length, 3);
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round.pages[0].layers[0].effects, fx);
});
