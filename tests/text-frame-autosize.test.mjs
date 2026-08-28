/**
 * Acceptance 3 (VIRO-0143), scoped by the lease: autoSize "height" is proven as
 * READ-ONLY MEASUREMENT in the engine. Applying a measurement resizes layer
 * geometry, i.e. document state, which requires a reversible bus command.
 * The commands registry (src/document/ui-commands.ts) and its parity test
 * (tests/ui-commands.test.mjs) are OUTSIDE this packet's lease, so the command
 * is specified in docs/agents/deliveries/VIRO-0143.json instead of hacked in.
 * These tests pin the measurement contract that command must satisfy:
 *
 *   fit = measureAutoFit(...)      →  recompose at (fit.w, fit.h)
 *   ⇒ overflow false, same lineCount, same first baseline, same glyphs
 *   ⇒ re-measuring at the fit size is a fixed point (undo returns to it).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/text-frame-autosize.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { measureAutoFit } from "../src/engine/type.ts";
import {
  makeTextFrame,
  renderFrame,
} from "./text-frame-harness.mjs";

const faces = await (await import("./text-frame-harness.mjs")).loadFaces();
const noto = faces["noto-sans"];

const layerOf = (w, h, textFrame) => ({
  id: "ly_fit",
  name: "Fit",
  kind: "type-frame",
  visible: true,
  locked: false,
  opacity: 1,
  blend: "srcOver",
  parentId: null,
  storyId: "st_tf",
  nextFrameId: null,
  textFrame,
  transform: { x: 0, y: 0, w, h, rotation: 0 },
});

const story = {
  id: "st_tf",
  text: "Auto size grows the frame foot to swallow the overflow. ".repeat(4),
  character: { fontId: "noto-sans", size: 24, leading: 29, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 }, otFeatures: [] },
  paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
  runs: [],
  paragraphRuns: [],
};

test("non-height autoSize modes are not measured (null)", () => {
  assert.equal(measureAutoFit(noto, story, layerOf(420, 100, undefined)), null);
  assert.equal(
    measureAutoFit(noto, story, layerOf(420, 100, makeTextFrame({ autoSize: "none" }))),
    null,
  );
  assert.equal(
    measureAutoFit(noto, story, layerOf(420, 100, makeTextFrame({ autoSize: "width" }))),
    null,
  );
  assert.equal(
    measureAutoFit(noto, story, layerOf(420, 100, makeTextFrame({ autoSize: "both" }))),
    null,
  );
});

test("autoSize height: fit height swallows the overflow at an unchanged measure", () => {
  const tf = makeTextFrame({ autoSize: "height" });
  const W = 420;
  const H = 100;
  const before = renderFrame(story, noto, W, H, tf);
  assert.ok(before.composed.overflow, "precondition: story overflows");

  const fit = measureAutoFit(noto, story, layerOf(W, H, tf));
  assert.ok(fit, "height auto-size must produce a measurement");
  assert.equal(fit.w, W, "height auto-size keeps the measure");
  assert.ok(fit.h > H, `fit height ${fit.h} should grow past ${H}`);
  // The measurement sees the FULL story even from a frame that is currently
  // clipping it: it does not depend on the frame's current height.
  const taller = measureAutoFit(noto, story, layerOf(W, 1000, tf));
  assert.ok(Math.abs(taller.h - fit.h) < 1e-9, "measurement must be height-independent");

  // Recomposing at the fit size: every dropped line now fits, nothing moves.
  const after = renderFrame(story, noto, fit.w, fit.h, tf);
  assert.equal(after.composed.overflow, false);
  assert.ok(after.composed.lineCount > before.composed.lineCount);
  assert.equal(after.composed.firstBaselinePx, before.composed.firstBaselinePx);
  assert.ok(after.composed.glyphs.length > before.composed.glyphs.length);

  // Fixed point: measuring the fitted frame returns the same size. A future
  // reversible command can restore exactly this height on undo.
  const again = measureAutoFit(noto, story, layerOf(fit.w, fit.h, tf));
  assert.ok(Math.abs(again.h - fit.h) < 1e-9);
});

test("autoSize height measurement includes the insets", () => {
  const tf = makeTextFrame({
    inset: { top: 10, right: 12, bottom: 14, left: 12 },
    autoSize: "height",
  });
  const W = 420;
  const H = 100;
  const before = renderFrame(story, noto, W, H, tf);
  assert.ok(before.composed.overflow, "precondition: story overflows");
  const fit = measureAutoFit(noto, story, layerOf(W, H, tf));
  // Bottom inset lands past the last descender; top inset already sits inside
  // heightPx (the baseline block starts at it).
  const taller = measureAutoFit(noto, story, layerOf(W, 1000, tf));
  assert.ok(Math.abs(taller.h - fit.h) < 1e-9);
  const after = renderFrame(story, noto, fit.w, fit.h, tf);
  assert.equal(after.composed.overflow, false);
  assert.ok(after.composed.lineCount > before.composed.lineCount);
  assert.equal(after.composed.firstBaselinePx, before.composed.firstBaselinePx);
  // Same story without the bottom inset measures exactly 14 px less.
  const noBottom = measureAutoFit(
    noto,
    story,
    layerOf(W, H, makeTextFrame({ inset: { top: 10, right: 12, bottom: 0, left: 12 }, autoSize: "height" })),
  );
  assert.ok(Math.abs(noBottom.h + 14 - fit.h) < 1e-9);
});

test("empty story still measures one line box", () => {
  const empty = { ...story, text: "" };
  const tf = makeTextFrame({ inset: { top: 6, right: 0, bottom: 8, left: 0 }, autoSize: "height" });
  const fit = measureAutoFit(noto, empty, layerOf(300, 120, tf));
  const base = renderFrame(empty, noto, 300, 120, tf);
  assert.equal(
    fit.h,
    base.composed.firstBaselinePx + base.composed.lastDescentPx + 8,
  );
  assert.ok(fit.h > 14, "empty frame still gets one line box plus insets");
});

test("measurement is consistent under verticalAlign center at the fit size", () => {
  const tf = makeTextFrame({ autoSize: "height", verticalAlign: "center" });
  const fit = measureAutoFit(noto, story, layerOf(420, 100, tf));
  const after = renderFrame(story, noto, fit.w, fit.h, tf);
  assert.equal(after.composed.overflow, false);
  // The block now fills the content box, so centering has no free space.
  const top = renderFrame(story, noto, fit.w, fit.h, makeTextFrame({ autoSize: "height" }));
  assert.ok(Math.abs(after.composed.firstBaselinePx - top.composed.firstBaselinePx) < 1e-6);
});
