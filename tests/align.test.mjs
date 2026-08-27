/**
 * Unit tests for layer alignment & distribution geometry.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/align.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { alignLayers, distributeLayers } from "../src/document/ops.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";

function rect(id, x, y, w, h) {
  return {
    id,
    name: id,
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: [],
    fill: { r: 1, g: 0, b: 0, a: 1 },
    stroke: null,
  };
}

/** A: [0,0,100,100]  B: [200,50,100,100]  C: [400,100,200,100] */
function doc3() {
  const d = documentFromPreset(PRESETS[0]);
  d.pages[0].layers.push(rect("A", 0, 0, 100, 100), rect("B", 200, 50, 100, 100), rect("C", 400, 100, 200, 100));
  return d;
}
const xs = (d) => d.pages[0].layers.filter((l) => l.id.length === 1).map((l) => l.transform.x);
const ys = (d) => d.pages[0].layers.filter((l) => l.id.length === 1).map((l) => l.transform.y);
const ids = ["A", "B", "C"];

test("align left moves every layer's left edge to the min", () => {
  assert.deepEqual(xs(alignLayers(doc3(), ids, "left")), [0, 0, 0]);
});

test("align right moves every right edge to the max (600)", () => {
  assert.deepEqual(xs(alignLayers(doc3(), ids, "right")), [500, 500, 400]);
});

test("align horizontal centers to the selection center (300)", () => {
  assert.deepEqual(xs(alignLayers(doc3(), ids, "center-h")), [250, 250, 200]);
});

test("align top/bottom operate on Y", () => {
  assert.deepEqual(ys(alignLayers(doc3(), ids, "top")), [0, 0, 0]);
  assert.deepEqual(ys(alignLayers(doc3(), ids, "bottom")), [100, 100, 100]);
});

test("distribute horizontally evenly spaces centers (B recentred to 275)", () => {
  const out = distributeLayers(doc3(), ids, "h");
  assert.deepEqual(xs(out), [0, 225, 400]);
});

test("align is immutable and a no-op below two layers", () => {
  const d = doc3();
  alignLayers(d, ids, "left");
  assert.equal(d.pages[0].layers.find((l) => l.id === "B").transform.x, 200);
  assert.deepEqual(xs(alignLayers(doc3(), ["A"], "left")), [0, 200, 400]);
});

test("distribute is a no-op below three layers", () => {
  assert.deepEqual(xs(distributeLayers(doc3(), ["A", "B"], "h")), [0, 200, 400]);
});
