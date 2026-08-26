/**
 * Unit tests for the drop-shadow layer effect op.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/effects.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setLayerDropShadow } from "../src/document/ops.ts";
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
