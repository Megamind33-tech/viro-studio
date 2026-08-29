/**
 * Acceptance 5 (VIRO-0144): stories without kerning-dependent boundaries
 * render PIXEL-IDENTICALLY to the pre-change engine.
 *
 * tests/caret-fidelity-pixel-baseline.json holds raw-RGBA SHA-256 hashes
 * captured from the UNMODIFIED engine at base 668d682 (before caret stops
 * moved to HarfBuzz clusters) by tests/caret-fidelity-baseline-capture.mjs.
 * Every case here reconstructs the exact story the hash was captured from and
 * re-renders it through the changed engine. A hash mismatch means the caret
 * work moved existing pixels — a regression. The caret stops themselves are
 * not part of the render; the risk under test is that segment-property or
 * span-merge changes disturbed shaping for ordinary (kern/liga-off) stories.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/caret-fidelity-pixel-baseline.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFaces,
  makeCharacter,
  makeParagraph,
} from "./rich-text-harness.mjs";
import { renderFrame, makeStory, makeTextFrame, LOREM } from "./text-frame-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = JSON.parse(
  readFileSync(join(ROOT, "tests", "caret-fidelity-pixel-baseline.json"), "utf8"),
);

const faces = await loadFaces();
const noto = faces["noto-sans"];
const notoBold = faces["noto-sans-bold"];

// These builders must stay identical to tests/caret-fidelity-baseline-capture.mjs —
// the hashes only mean anything if the story is reconstructed exactly.
const styledStory = () => {
  const story = makeStory("Office avatar fixed rust", { id: "st_caret_runs" });
  story.runs = [
    { start: 0, end: 6, overrides: { fill: { r: 0.7, g: 0.1, b: 0.1, a: 1 }, size: 30 } },
    { start: 7, end: 13, overrides: { fontId: "noto-sans-bold", tracking: 20 } },
  ];
  return story;
};

const insetStory = () =>
  makeStory("Inset text flows inside the frame box with a comfortable measure.", {
    id: "st_caret_inset",
    paragraph: { align: "justify" },
  });

const CASES = {
  "plain-left-multiline": () => ({ story: makeStory(LOREM, { id: "st_c1" }), w: 420, h: 300 }),
  "plain-justify-wrap": () => ({
    story: makeStory(LOREM, { id: "st_c2", paragraph: { align: "justify" } }),
    w: 500,
    h: 360,
  }),
  "plain-center-wrap": () => ({
    story: makeStory("Caret lines center under alignment slack", {
      id: "st_c3",
      paragraph: { align: "center" },
    }),
    w: 260,
    h: 220,
  }),
  "styled-runs": () => ({ story: styledStory(), w: 420, h: 200 }),
  "inset-frame": () => ({
    story: insetStory(),
    w: 380,
    h: 260,
    textFrame: makeTextFrame({ inset: { top: 14, right: 22, bottom: 18, left: 26 } }),
  }),
  "empty-frame": () => ({ story: makeStory("", { id: "st_c6" }), w: 300, h: 120 }),
};

test("baseline was captured from the pre-change engine", () => {
  assert.equal(GOLDEN.meta.packet, "VIRO-0144");
  assert.equal(GOLDEN.meta.capturedAt, "668d682");
});

for (const [name, make] of Object.entries(CASES)) {
  test(`pixel-identical to the pre-caret-cluster engine: ${name}`, () => {
    const golden = GOLDEN.cases[name];
    assert.ok(golden, `golden case ${name} missing from baseline fixture`);
    const { story, w, h, textFrame } = make();
    const { raw } = renderFrame(story, noto, w, h, textFrame);
    assert.equal(createHash("sha256").update(raw).digest("hex"), golden.sha);
  });
}

test("the extra faces stay loaded for parity with the capture run", () => {
  assert.ok(notoBold && notoBold.upem > 0);
});
