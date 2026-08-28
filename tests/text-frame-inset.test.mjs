/**
 * Acceptance 1 (VIRO-0143): a frame with inset 24 composes against the reduced
 * measure — the first baseline shifts down by the top inset, lines wrap at
 * (frame width − left − right), no ink lands inside the insets, and the
 * screenshots are committed as evidence.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/text-frame-inset.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  baselineStory,
  inkBox,
  makeTextFrame,
  renderFrame,
  saveShot,
} from "./text-frame-harness.mjs";

const faces = await (await import("./text-frame-harness.mjs")).loadFaces();
const noto = faces["noto-sans"];

const W = 420;
const H = 300;
const INSET = 24;
// Long enough that the 372 px inset measure rewraps (5 → 6 lines at 28/34).
const TEXT =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus luctus urna sed urna ultricies, " +
  "eget tristique felis gravida. Aliquam erat volutpat.";

test("inset shifts the first baseline down by exactly the top inset", () => {
  const story = baselineStory({ text: TEXT, paragraph: {} });
  const plain = renderFrame(story, noto, W, H);
  const inset = renderFrame(
    story,
    noto,
    W,
    H,
    makeTextFrame({ inset: { top: INSET, right: INSET, bottom: INSET, left: INSET } }),
  );
  assert.equal(
    inset.composed.firstBaselinePx,
    plain.composed.firstBaselinePx + INSET,
  );
});

test("inset shrinks the measure: the same story wraps into more lines", () => {
  const story = baselineStory({ text: TEXT, paragraph: {} });
  const plain = renderFrame(story, noto, W, H);
  const inset = renderFrame(
    story,
    noto,
    W,
    H,
    makeTextFrame({ inset: { top: INSET, right: INSET, bottom: INSET, left: INSET } }),
  );
  assert.ok(
    inset.composed.lineCount > plain.composed.lineCount,
    `expected more lines at measure ${W - 2 * INSET} than at ${W}`,
  );
  // The caret layout follows the reduced measure: every stop stays inside it.
  for (const stop of inset.composed.caretStops) {
    assert.ok(stop.x >= INSET - 0.5, `caret x ${stop.x} left of the inset`);
    assert.ok(stop.x <= W - INSET + 0.5, `caret x ${stop.x} past the right inset`);
  }
});

test("no ink lands inside the insets; committed screenshots prove the geometry", () => {
  const story = baselineStory({ text: TEXT, paragraph: {} });
  const plain = renderFrame(story, noto, W, H);
  const inset = renderFrame(
    story,
    noto,
    W,
    H,
    makeTextFrame({ inset: { top: INSET, right: INSET, bottom: INSET, left: INSET } }),
  );
  const plainBox = inkBox(plain.raw, W, H);
  const insetBox = inkBox(inset.raw, W, H);
  assert.ok(insetBox, "inset render has ink");
  assert.ok(insetBox.minX >= INSET, `ink minX ${insetBox.minX} crosses the left inset`);
  assert.ok(insetBox.minY >= INSET, `ink minY ${insetBox.minY} crosses the top inset`);
  assert.ok(insetBox.maxX <= W - INSET, `ink maxX ${insetBox.maxX} crosses the right inset`);
  // The left-aligned story starts flush at the frame edge without insets.
  assert.ok(plainBox.minX < INSET, "plain render should start left of the inset");
  assert.equal(
    saveShot("inset-0.png", plain.png),
    "inset-0.png",
  );
  saveShot("inset-24.png", inset.png);
});
