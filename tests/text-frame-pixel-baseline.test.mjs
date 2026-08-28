/**
 * Acceptance 4 (VIRO-0143): zero-inset single-column area frames render
 * PIXEL-IDENTICALLY to the pre-change engine.
 *
 * tests/text-frame-pixel-baseline.json holds raw-RGBA SHA-256 hashes captured
 * from the UNMODIFIED engine at base 72b05f0 (VIRO-0143 before-state). Each
 * case here reconstructs the exact story the hash was captured from and
 * re-renders it through the changed engine. A hash mismatch means the textFrame
 * consumption moved existing pixels — a regression.
 *
 * The baseline also pins the back-compat surface: a layer with NO textFrame
 * object and a layer with the DEFAULT textFrame (zero inset, top, 1 column)
 * must both match the pre-contract render.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/text-frame-pixel-baseline.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_CASES,
  baselineStory,
  makeTextFrame,
  renderFrame,
} from "./text-frame-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = JSON.parse(
  readFileSync(join(ROOT, "tests", "text-frame-pixel-baseline.json"), "utf8"),
);

const faces = await (await import("./text-frame-harness.mjs")).loadFaces();
const noto = faces["noto-sans"];

for (const c of BASELINE_CASES) {
  test(`pixel-identical to pre-change engine: ${c.name}`, () => {
    const golden = GOLDEN.cases[c.name];
    assert.ok(golden, `golden case ${c.name} missing from baseline fixture`);
    const story = baselineStory(c);
    const { raw } = renderFrame(story, noto, golden.w, golden.h);
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      golden.sha,
    );
  });
}

test("default textFrame object equals the pre-contract render", () => {
  const c = BASELINE_CASES[0];
  const golden = GOLDEN.cases[c.name];
  const story = baselineStory(c);
  const { raw } = renderFrame(story, noto, golden.w, golden.h, makeTextFrame());
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    golden.shaDefaultTextFrame,
  );
  assert.equal(golden.shaDefaultTextFrame, golden.sha);
});
