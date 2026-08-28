/**
 * Acceptance 2 (VIRO-0143): verticalAlign "center" centers the composed block
 * between the frame top and bottom; "bottom" sits it on the foot. "justify"
 * (vertical justification) is a documented engine fallback to "top" for now.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/text-frame-valign.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  inkBox,
  makeTextFrame,
  renderFrame,
  saveShot,
} from "./text-frame-harness.mjs";

const faces = await (await import("./text-frame-harness.mjs")).loadFaces();
const noto = faces["noto-sans"];

const W = 300;
const H = 300;
const TEXT = "Vertical center\nin a square frame.";

test("center centers the composed block between frame top and bottom", () => {
  const story = {
    id: "st_valign",
    text: TEXT,
    character: { fontId: "noto-sans", size: 28, leading: 34, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 }, otFeatures: [] },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
    runs: [],
    paragraphRuns: [],
  };
  const top = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: "top" }));
  const center = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: "center" }));

  // Data view: the shift is exactly half the free space in the content box.
  const blockH = top.composed.heightPx; // zero inset: block spans [0, heightPx]
  const expectedBaseline = top.composed.firstBaselinePx + (H - blockH) / 2;
  assert.ok(
    Math.abs(center.composed.firstBaselinePx - expectedBaseline) < 1e-6,
    `baseline ${center.composed.firstBaselinePx} != centered ${expectedBaseline}`,
  );
  // Caret geometry follows the shift so editing hits what you see.
  assert.equal(center.composed.caretStops[0].y, center.composed.firstBaselinePx);

  // Pixel view: the ink block's vertical midpoint sits at the frame midpoint.
  const box = inkBox(center.raw, W, H);
  assert.ok(box, "centered render has ink");
  const inkMid = (box.minY + box.maxY) / 2;
  assert.ok(
    Math.abs(inkMid - H / 2) <= 4,
    `ink midpoint ${inkMid} not centered in frame of ${H} (tolerance 4)`,
  );
  assert.ok(box.minY > top.composed.firstBaselinePx, "centered block starts below the top-set block");

  assert.notEqual(center.png.length, 0);
  saveShot("valign-center.png", center.png);
});

test("bottom sits the block on the frame foot", () => {
  const story = {
    id: "st_valign",
    text: TEXT,
    character: { fontId: "noto-sans", size: 28, leading: 34, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 }, otFeatures: [] },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
    runs: [],
    paragraphRuns: [],
  };
  const bottom = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: "bottom" }));
  const box = inkBox(bottom.raw, W, H);
  assert.ok(box, "bottom render has ink");
  assert.ok(
    box.maxY >= H * 0.9,
    `ink bottom ${box.maxY} is not near the frame foot ${H}`,
  );
  saveShot("valign-bottom.png", bottom.png);
});

test("overflowing text under center/bottom keeps top-aligned geometry", () => {
  const story = {
    id: "st_valign",
    text: Array.from({ length: 20 }, (_, i) => `Overflow line ${i + 1}`).join("\n"),
    character: { fontId: "noto-sans", size: 28, leading: 34, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 }, otFeatures: [] },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
    runs: [],
    paragraphRuns: [],
  };
  const top = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: "top" }));
  assert.ok(top.composed.overflow, "precondition: story overflows the frame");
  for (const va of ["center", "bottom"]) {
    const shifted = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: va }));
    assert.equal(shifted.composed.firstBaselinePx, top.composed.firstBaselinePx);
    assert.equal(shifted.composed.lineCount, top.composed.lineCount);
    assert.ok(shifted.composed.overflow);
  }
});

test("verticalAlign 'justify' is a documented fallback to top", () => {
  const story = {
    id: "st_valign",
    text: TEXT,
    character: { fontId: "noto-sans", size: 28, leading: 34, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 }, otFeatures: [] },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
    runs: [],
    paragraphRuns: [],
  };
  const top = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: "top" }));
  const justify = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: "justify" }));
  assert.equal(justify.composed.firstBaselinePx, top.composed.firstBaselinePx);
  assert.equal(justify.png.length, top.png.length);
});
