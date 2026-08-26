/**
 * Rounded-rect and polygon geometry — real editable paths, not icons.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/shapes.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { addVectorPolygon, addVectorRoundRect, addVectorStar, polygonNodes, roundRectNodes, starNodes } from "../src/document/factory.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";

const FILL = { r: 0.88, g: 0.48, b: 0.18, a: 1 };

test("roundRectNodes has 8 cubic nodes and clamps radius to half the short edge", () => {
  const nodes = roundRectNodes(200, 80, 400);
  assert.equal(nodes.length, 8);
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 200);
  assert.equal(Math.min(...ys), 0);
  assert.equal(Math.max(...ys), 80);
});

test("roundRectNodes with zero radius is a plain rectangle", () => {
  const nodes = roundRectNodes(100, 50, 0);
  assert.equal(nodes.length, 4);
});

test("polygonNodes(6) is a hexagon with the first vertex at 12 o'clock", () => {
  const nodes = polygonNodes(100, 100, 6);
  assert.equal(nodes.length, 6);
  assert.ok(Math.abs(nodes[0].x - 50) < 1e-6);
  assert.ok(Math.abs(nodes[0].y - 0) < 1e-6);
});

test("addVectorRoundRect commits a closed vector named Rounded rectangle", () => {
  const doc = addVectorRoundRect(documentFromPreset(PRESETS[0]), 10, 20, 200, 100, FILL, 24);
  const layer = doc.pages[0].layers[doc.pages[0].layers.length - 1];
  assert.equal(layer.kind, "vector");
  assert.equal(layer.name, "Rounded rectangle");
  assert.equal(layer.closed, true);
  assert.equal(layer.nodes.length, 8);
  assert.equal(doc.activeLayerIds[0], layer.id);
});

test("addVectorPolygon names a triangle and a hexagon honestly", () => {
  let doc = addVectorPolygon(documentFromPreset(PRESETS[0]), 0, 0, 80, 80, FILL, 3);
  assert.equal(doc.pages[0].layers.at(-1).name, "Triangle");
  assert.equal(doc.pages[0].layers.at(-1).nodes.length, 3);
  doc = addVectorPolygon(doc, 90, 0, 80, 80, FILL, 6);
  assert.equal(doc.pages[0].layers.at(-1).name, "6-gon");
  assert.equal(doc.pages[0].layers.at(-1).nodes.length, 6);
});

test("starNodes(5) has 10 vertices and a tip at 12 o'clock", () => {
  const nodes = starNodes(100, 100, 5);
  assert.equal(nodes.length, 10);
  assert.ok(Math.abs(nodes[0].x - 50) < 1e-6);
  assert.ok(Math.abs(nodes[0].y - 0) < 1e-6);
});

test("addVectorStar commits a closed 5-point star", () => {
  const doc = addVectorStar(documentFromPreset(PRESETS[0]), 10, 20, 120, 120, FILL, 5);
  const layer = doc.pages[0].layers.at(-1);
  assert.equal(layer.kind, "vector");
  assert.equal(layer.name, "5-point star");
  assert.equal(layer.closed, true);
  assert.equal(layer.nodes.length, 10);
});
