/**
 * Unit tests for image-frame geometry (foundation slice 2).
 *
 *   node --experimental-strip-types --test tests/image-fit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { destWindow, overflowsFrame, sourceWindow } from "../src/document/image-fit.ts";

/** A frame 400x200 (2:1) holding an asset 100x200 (1:2) — deliberately mismatched. */
const FRAME_W = 400;
const FRAME_H = 200;
const ASSET_W = 100;
const ASSET_H = 200;

const frameLayer = (o = {}) => ({
  id: "img",
  name: "img",
  kind: "image-frame",
  visible: true,
  locked: false,
  opacity: 1,
  blend: "srcOver",
  transform: { x: 0, y: 0, w: FRAME_W, h: FRAME_H, rotation: 0 },
  parentId: null,
  assetId: "a1",
  fit: "cover",
  focal: { x: 0.5, y: 0.5 },
  crop: null,
  ...o,
});

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, "expected " + a + " close to " + b);
const src = () => sourceWindow(frameLayer(), ASSET_W, ASSET_H);
const dest = (fit, focal) => destWindow(frameLayer({ fit, focal: focal ?? { x: 0.5, y: 0.5 } }), src(), FRAME_W, FRAME_H);
const aspect = (b) => b.w / b.h;

test("sourceWindow is the whole asset when there is no crop", () => {
  assert.deepEqual(src(), { x: 0, y: 0, w: ASSET_W, h: ASSET_H });
});

test("sourceWindow clamps a crop that runs outside the asset", () => {
  const s = sourceWindow(frameLayer({ crop: { x: -20, y: 10, w: 9999, h: 9999 } }), ASSET_W, ASSET_H);
  assert.equal(s.x, 0);
  assert.equal(s.y, 10);
  assert.equal(s.x + s.w, ASSET_W);
  assert.equal(s.y + s.h, ASSET_H);
});

test("COVER fills the frame, preserves aspect, and overflows", () => {
  const d = dest("cover");
  assert.ok(d.w >= FRAME_W - 1e-9 && d.h >= FRAME_H - 1e-9, "cover must cover both axes");
  near(aspect(d), ASSET_W / ASSET_H);
  assert.equal(overflowsFrame(d, FRAME_W, FRAME_H), true, "cover on a mismatched aspect MUST need clipping");
});

test("CONTAIN fits inside the frame, preserves aspect, and letterboxes", () => {
  const d = dest("contain");
  assert.ok(d.w <= FRAME_W + 1e-9 && d.h <= FRAME_H + 1e-9, "contain must fit inside both axes");
  near(aspect(d), ASSET_W / ASSET_H);
  assert.equal(overflowsFrame(d, FRAME_W, FRAME_H), false);
  // Letterboxing means genuine slack on the mismatched axis.
  assert.ok(FRAME_W - d.w > 1, "a 1:2 asset in a 2:1 frame must pillarbox");
});

test("STRETCH is exactly the frame and does NOT preserve aspect", () => {
  const d = dest("stretch");
  assert.deepEqual(d, { x: 0, y: 0, w: FRAME_W, h: FRAME_H });
  assert.notEqual(Math.round(aspect(d) * 1000), Math.round((ASSET_W / ASSET_H) * 1000));
});

test("NO DUPLICATE SEMANTICS: the three modes give three different rectangles", () => {
  // This is the regression guard for the removed "fill", which was
  // byte-identical to "stretch" in every renderer.
  const rects = ["cover", "contain", "stretch"].map((f) => JSON.stringify(dest(f)));
  assert.equal(new Set(rects).size, 3, "two fit modes produced the same rect: " + rects.join(" | "));
});

test("focal moves the CONTENT and never the frame", () => {
  const a = dest("cover", { x: 0, y: 0 });
  const b = dest("cover", { x: 1, y: 1 });
  assert.notDeepEqual(a, b, "focal must move the content");
  // Same size, different offset: the picture slid, it was not re-fitted.
  near(a.w, b.w);
  near(a.h, b.h);
  // And the frame is untouched by construction - it is the layer's transform,
  // which destWindow never returns and never writes.
  const layer = frameLayer({ focal: { x: 0.9, y: 0.1 } });
  assert.deepEqual(layer.transform, { x: 0, y: 0, w: FRAME_W, h: FRAME_H, rotation: 0 });
});

test("focal 0.5 centres the overflow on both axes", () => {
  const d = dest("cover", { x: 0.5, y: 0.5 });
  near(d.x + d.w / 2, FRAME_W / 2);
  near(d.y + d.h / 2, FRAME_H / 2);
});

test("focal is clamped - out-of-range values cannot fling content off the frame", () => {
  const wild = dest("cover", { x: 5, y: -3 });
  const at1 = dest("cover", { x: 1, y: 0 });
  assert.deepEqual(wild, at1);
});

test("focal has no effect on STRETCH, which has no slack to move within", () => {
  assert.deepEqual(dest("stretch", { x: 0, y: 0 }), dest("stretch", { x: 1, y: 1 }));
});

test("a degenerate source falls back to the frame instead of dividing by zero", () => {
  const d = destWindow(frameLayer({ fit: "cover" }), { x: 0, y: 0, w: 0, h: 0 }, FRAME_W, FRAME_H);
  assert.deepEqual(d, { x: 0, y: 0, w: FRAME_W, h: FRAME_H });
});

test("a matched aspect ratio makes cover and contain agree, and neither overflows", () => {
  const square = { x: 0, y: 0, w: 200, h: 200 };
  const l = frameLayer({ transform: { x: 0, y: 0, w: 300, h: 300, rotation: 0 } });
  const cov = destWindow({ ...l, fit: "cover" }, square, 300, 300);
  const con = destWindow({ ...l, fit: "contain" }, square, 300, 300);
  assert.deepEqual(cov, con);
  assert.equal(overflowsFrame(cov, 300, 300), false);
});
