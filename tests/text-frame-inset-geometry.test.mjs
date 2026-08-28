/**
 * VIRO-0143 attempt-2 regression (verifier rejection fix): alignPen used to
 * receive `originX + x0` where it computed `room = measure - x0`, so the inset
 * origin cancelled for right-aligned lines (pen = measure - lineW, ink maxX
 * moved by -(left+right) instead of -right) and halved for centered lines
 * (-left/2). The fix splits pen origin from indent: room/slack reduce by the
 * indent alone, pen starts at originX + x0.
 *
 * These tests cross inset {left:30, right:10, top:20, bottom:15} x align
 * {left, right, center} on W=400 and assert EXACT ink edges and caret pens,
 * plus a proper port of the independent verifier probe's geometry checks
 * (exact valign dy, invalid-inset clamps, autoSize measurement exactness).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/text-frame-inset-geometry.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeFrame, measureAutoFit } from "../src/engine/type.ts";
import {
  inkBox,
  makeStory,
  makeTextFrame,
  renderFrame,
} from "./text-frame-harness.mjs";

const faces = await (await import("./text-frame-harness.mjs")).loadFaces();
const noto = faces["noto-sans"];

const W = 400;
const H = 320;
const INSET = { left: 30, right: 10, top: 20, bottom: 15 };
// originX + measure per align: left edge 30, right edge W-10, center (W-right+left)/2.
const LINE = "One measurable probe line."; // single line at every align, both measures
// Small enough that LINE stays one line at BOTH measures (400 and 360).
const SINGLE_LINE = { character: { size: 20, leading: 25 } };

const centers = (box) => (box.minX + box.maxX) / 2;

test("align x inset crossing: left-aligned ink starts exactly at the left inset (30)", () => {
  const story = makeStory(LINE, SINGLE_LINE);
  const zero = renderFrame(story, noto, W, H, makeTextFrame());
  const cut = renderFrame(story, noto, W, H, makeTextFrame({ inset: INSET }));
  assert.equal(cut.composed.lineCount, zero.composed.lineCount);
  assert.equal(cut.composed.lineCount, 1);
  const zeroBox = inkBox(zero.raw, W, H);
  const cutBox = inkBox(cut.raw, W, H);
  assert.ok(zeroBox && cutBox);
  assert.ok(Math.abs(cutBox.minX - 30) <= 2, `left ink edge ${cutBox.minX}, expected 30`);
  assert.ok(Math.abs(cutBox.minX - zeroBox.minX - 30) <= 2, "left edge must move exactly +30");
  // Data level: caret pen starts exactly on the inset origin.
  assert.equal(cut.composed.caretStops[0].x, zero.composed.caretStops[0].x + 30);
});

test("align x inset crossing: right-aligned ink ends exactly at the right inset edge (390)", () => {
  const story = makeStory(LINE, { ...SINGLE_LINE, paragraph: { align: "right" } });
  const zero = renderFrame(story, noto, W, H, makeTextFrame());
  const cut = renderFrame(story, noto, W, H, makeTextFrame({ inset: INSET }));
  assert.equal(cut.composed.lineCount, zero.composed.lineCount);
  assert.equal(cut.composed.lineCount, 1);
  const zeroBox = inkBox(zero.raw, W, H);
  const cutBox = inkBox(cut.raw, W, H);
  assert.ok(zeroBox && cutBox);
  // The regression: the edge used to land at measure (360) instead of the
  // measure's right edge inside the frame (390) — a -40 shift.
  assert.ok(Math.abs(cutBox.maxX - 390) <= 2, `right ink edge ${cutBox.maxX}, expected 390`);
  assert.ok(Math.abs(cutBox.maxX - zeroBox.maxX - -10) <= 2, "right edge must move exactly -10");
  // Data level: caret pen sits at originX + measure - lineW, i.e. -10 vs zero.
  const caretDelta = cut.composed.caretStops[0].x - zero.composed.caretStops[0].x;
  assert.ok(Math.abs(caretDelta - -10) <= 1e-6, `caret x moved ${caretDelta}, expected exactly -10`);
});

test("align x inset crossing: centered ink centers in the content box (210), not the frame (200-15)", () => {
  const story = makeStory(LINE, { ...SINGLE_LINE, paragraph: { align: "center" } });
  const zero = renderFrame(story, noto, W, H, makeTextFrame());
  const cut = renderFrame(story, noto, W, H, makeTextFrame({ inset: INSET }));
  assert.equal(cut.composed.lineCount, zero.composed.lineCount);
  assert.equal(cut.composed.lineCount, 1);
  const zeroBox = inkBox(zero.raw, W, H);
  const cutBox = inkBox(cut.raw, W, H);
  assert.ok(zeroBox && cutBox);
  // Content-box center = 30 + 360/2 = 210. The bug centered in [0, measure]:
  // (originX + measure)/2 - lineW/2 -> 195, off by -left/2.
  assert.ok(Math.abs(centers(cutBox) - 210) <= 2, `ink center ${centers(cutBox)}, expected 210`);
  assert.ok(
    Math.abs(centers(cutBox) - centers(zeroBox) - 10) <= 2,
    "center must move exactly +10 ((left-right)/2)",
  );
  const caretDelta = cut.composed.caretStops[0].x - zero.composed.caretStops[0].x;
  assert.ok(Math.abs(caretDelta - 10) <= 1e-6, `caret x moved ${caretDelta}, expected exactly +10`);
});

test("asymmetric inset moves the first baseline and caret row by EXACTLY the top inset", () => {
  const story = makeStory(LINE, SINGLE_LINE);
  const zero = composeFrame(noto, story, W, H, makeTextFrame());
  const cut = composeFrame(noto, story, W, H, makeTextFrame({ inset: INSET }));
  assert.equal(cut.firstBaselinePx, zero.firstBaselinePx + INSET.top);
  assert.equal(cut.caretStops[0].y, zero.caretStops[0].y + INSET.top);
  assert.equal(cut.caretStops[0].x, INSET.left);
  assert.equal(zero.caretStops[0].x, 0);
});

test("center-valign shifts the block by EXACTLY free/2; ink midpoint tracks it", () => {
  const story = makeStory("Center probe line one.\nLine two.\nLine three.");
  const top = renderFrame(story, noto, W, H, makeTextFrame());
  const center = renderFrame(story, noto, W, H, makeTextFrame({ verticalAlign: "center" }));
  const blockH = top.composed.heightPx;
  const expectedDy = (H - blockH) / 2;
  assert.ok(expectedDy > 20, "probe story must leave free space to center");
  assert.ok(
    Math.abs(center.composed.firstBaselinePx - (top.composed.firstBaselinePx + expectedDy)) < 1e-6,
  );
  const topBox = inkBox(top.raw, W, H);
  const centerBox = inkBox(center.raw, W, H);
  assert.ok(topBox && centerBox);
  const topMid = (topBox.minY + topBox.maxY) / 2;
  const centerMid = (centerBox.minY + centerBox.maxY) / 2;
  assert.ok(
    Math.abs(centerMid - (topMid + expectedDy)) <= 2,
    `ink midpoint moved ${centerMid - topMid}px, expected exactly ${expectedDy}px`,
  );
  assert.ok(Math.abs(centerMid - H / 2) <= 10, `centered midpoint ${centerMid} off frame centre`);
});

test("bottom-valign translates the block by EXACTLY the free space", () => {
  const story = makeStory("Bottom probe line one.\nLine two.\nLine three.");
  const top = composeFrame(noto, story, W, H, makeTextFrame());
  const bottom = composeFrame(noto, story, W, H, makeTextFrame({ verticalAlign: "bottom" }));
  const expectedDy = H - top.heightPx;
  assert.ok(expectedDy > 20, "probe story must leave free space at the bottom");
  assert.ok(
    Math.abs(bottom.firstBaselinePx - (top.firstBaselinePx + expectedDy)) < 1e-6,
    "bottom first baseline != top + free",
  );
});

test("invalid inset entries are treated as zero", () => {
  const story = makeStory("Clamp probe line one.\nLine two.");
  const zero = composeFrame(noto, story, W, H, makeTextFrame());
  const bad = composeFrame(
    noto,
    story,
    W,
    H,
    makeTextFrame({ inset: { left: -5, right: NaN, top: undefined, bottom: Infinity } }),
  );
  assert.equal(bad.firstBaselinePx, zero.firstBaselinePx);
  assert.equal(bad.lineCount, zero.lineCount);
});

test("autoSize height measures content + bottom inset exactly and refits without overflow", () => {
  const story = makeStory("Auto size probe line one.\nLine two.\nLine three.");
  const fitted = makeTextFrame({ autoSize: "height", inset: INSET });
  const layer = {
    id: "ly_fit_probe",
    name: "Fit",
    kind: "type-frame",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    parentId: null,
    storyId: story.id,
    nextFrameId: null,
    textFrame: fitted,
    transform: { x: 0, y: 0, w: W, h: H, rotation: 0 },
  };
  const fit = measureAutoFit(noto, story, layer);
  assert.ok(fit, "autoSize height must measure");
  assert.equal(fit.w, W);
  const refit = composeFrame(noto, story, fit.w, fit.h, fitted);
  assert.ok(!refit.overflow, "measured height must fit the story");
  assert.ok(
    Math.abs(refit.heightPx + INSET.bottom - fit.h) < 0.75,
    `measured h ${fit.h} != content ${refit.heightPx} + bottom inset ${INSET.bottom}`,
  );
  assert.equal(
    measureAutoFit(noto, story, { ...layer, textFrame: makeTextFrame({ autoSize: "none" }) }),
    null,
    "autoSize none must not measure",
  );
});
