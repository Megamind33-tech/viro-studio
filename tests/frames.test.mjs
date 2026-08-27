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
  clearGuides,
  fillImageFrame,
  removeGuide,
  setGuideOffset,
  snapCandidateLines,
  validateDocument,
} from "../src/document/factory.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";
import { resolveMoveSnap } from "../src/document/multi-transform.ts";

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

test("snapCandidateLines includes page edges, layer bounds, and visible guides", () => {
  let doc = addEmptyImageFrame(documentFromPreset(PRESETS[0]), 40, 80, 200, 120);
  doc = addGuide(doc, "v", 50);
  doc = addGuide(doc, "h", 30);
  const page = doc.pages[0];
  const withGuides = snapCandidateLines(page, new Set(), true);
  assert.ok(withGuides.xs.includes(50), "vertical guide offset must be a snap X");
  assert.ok(withGuides.ys.includes(30), "horizontal guide offset must be a snap Y");
  assert.ok(withGuides.xs.includes(0) && withGuides.xs.includes(page.widthPx), "page left/right");
  assert.ok(withGuides.ys.includes(0) && withGuides.ys.includes(page.heightPx), "page top/bottom");
  const frame = page.layers.find((l) => l.kind === "image-frame");
  assert.ok(frame);
  assert.ok(withGuides.xs.includes(frame.transform.x));
  assert.ok(withGuides.ys.includes(frame.transform.y));
  const without = snapCandidateLines(page, new Set(), false);
  assert.equal(without.xs.includes(50), false);
  assert.equal(without.ys.includes(30), false);
});

test("a move snaps onto a ruler guide the same way it snaps to a page edge", () => {
  let doc = addEmptyImageFrame(documentFromPreset(PRESETS[0]), 45, 10, 40, 40);
  doc = addGuide(doc, "v", 50);
  const page = doc.pages[0];
  const layer = page.layers.find((l) => l.kind === "image-frame");
  const cand = snapCandidateLines(page, new Set([layer.id]), true);
  const snap = resolveMoveSnap(layer.transform, 0, 0, cand.xs, cand.ys, 8);
  assert.equal(snap.guideX, 50);
  assert.equal(layer.transform.x + snap.ox, 50);
});

test("setGuideOffset mutates the named guide and stays valid", () => {
  let doc = addGuide(documentFromPreset(PRESETS[0]), "v", 10);
  const id = doc.pages[0].guides[0].id;
  const next = setGuideOffset(doc, id, 88);
  assert.equal(next.pages[0].guides[0].offset, 88);
  assert.deepEqual(validateDocument(next), []);
  assert.equal(doc.pages[0].guides[0].offset, 10, "input document must not be mutated");
});

test("removeGuide and clearGuides empty the page guide list", () => {
  let doc = addGuide(documentFromPreset(PRESETS[0]), "v", 10);
  doc = addGuide(doc, "h", 20);
  const id = doc.pages[0].guides[0].id;
  const afterOne = removeGuide(doc, id);
  assert.equal(afterOne.pages[0].guides.length, 1);
  const empty = clearGuides(afterOne);
  assert.equal(empty.pages[0].guides.length, 0);
  assert.deepEqual(validateDocument(empty), []);
});
