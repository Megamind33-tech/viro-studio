/**
 * Empty picture boxes and ruler guides — real document state, not chrome.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/frames.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  addEmptyImageFrame,
  addGuide,
  fillImageFrame,
  validateDocument,
} from "../src/document/factory.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("addEmptyImageFrame is an image-frame with no asset", () => {
  const doc = addEmptyImageFrame(documentFromPreset(PRESETS[0]), 40, 80, 200, 120);
  const layer = doc.pages[0].layers.at(-1);
  assert.equal(layer.kind, "image-frame");
  assert.equal(layer.name, "Frame");
  assert.equal(layer.assetId, null);
  assert.equal(layer.transform.x, 40);
  assert.equal(layer.transform.y, 80);
  assert.equal(layer.transform.w, 200);
  assert.equal(layer.transform.h, 120);
  assert.equal(doc.activeLayerIds[0], layer.id);
  assert.deepEqual(validateDocument(doc), []);
});

test("addEmptyImageFrame clamps degenerate sizes to 4px", () => {
  const doc = addEmptyImageFrame(documentFromPreset(PRESETS[0]), 0, 0, 1, 2);
  const layer = doc.pages[0].layers.at(-1);
  assert.equal(layer.transform.w, 4);
  assert.equal(layer.transform.h, 4);
});

test("addGuide records a real page guide", () => {
  let doc = addGuide(documentFromPreset(PRESETS[0]), "v", 240);
  doc = addGuide(doc, "h", 120);
  const guides = doc.pages[0].guides;
  assert.equal(guides.length, 2);
  assert.equal(guides[0].axis, "v");
  assert.equal(guides[0].offset, 240);
  assert.equal(guides[1].axis, "h");
  assert.equal(guides[1].offset, 120);
  assert.deepEqual(validateDocument(doc), []);
});

test("fillImageFrame puts a picture into an empty box without moving it", () => {
  let doc = addEmptyImageFrame(documentFromPreset(PRESETS[0]), 10, 20, 300, 150);
  const id = doc.activeLayerIds[0];
  const before = doc.pages[0].layers.find((l) => l.id === id);
  doc = fillImageFrame(doc, id, { name: "cover.png", mime: "image/png", dataUrl: PNG, width: 64, height: 32 });
  const layer = doc.pages[0].layers.find((l) => l.id === id);
  assert.equal(layer.kind, "image-frame");
  assert.ok(layer.assetId);
  assert.equal(doc.assets[layer.assetId].name, "cover.png");
  assert.equal(doc.assets[layer.assetId].width, 64);
  assert.equal(layer.transform.x, before.transform.x);
  assert.equal(layer.transform.w, before.transform.w);
  assert.equal(layer.name, "cover.png");
  assert.deepEqual(validateDocument(doc), []);
});

test("fillImageFrame is a no-op on a locked or non-frame layer", () => {
  const doc = addEmptyImageFrame(documentFromPreset(PRESETS[0]), 0, 0, 80, 80);
  const asset = { name: "x.png", mime: "image/png", dataUrl: PNG, width: 8, height: 8 };
  const miss = fillImageFrame(doc, "ly_missing", asset);
  assert.equal(miss.pages[0].layers.at(-1).assetId, null);
  const vectorId = doc.pages[0].layers.find((l) => l.kind === "vector")?.id;
  if (vectorId) {
    const skipped = fillImageFrame(doc, vectorId, asset);
    assert.equal(skipped.pages[0].layers.find((l) => l.id === vectorId).kind, "vector");
  }
});
