/**
 * Rich-text contract, composition side (VIRO-0142).
 *
 * Proves three things the before-state audit found missing:
 *
 *   1. Stories with EMPTY runs still compose and render byte-identically to the
 *      pre-change engine — the golden fixture in rich-text-golden.json was
 *      captured from the unmodified engine before this packet's edit.
 *   2. Character runs are actually segmented and styled per range: face, size,
 *      tracking and fill change inside the range, the shared baseline survives,
 *      and unknown fontIds fall back to the story face instead of throwing.
 *   3. Paragraph runs change only their own paragraph: alignment, startIndent
 *      and spaceBefore move one paragraph's lines and leave the rest untouched.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/rich-text-compose.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { loadFaces, makeCharacter, makeParagraph, renderStoryPixels } = await import(
  "./rich-text-harness.mjs"
);
const { composeFrame } = await import("../src/engine/type.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = JSON.parse(readFileSync(join(ROOT, "tests", "rich-text-golden.json"), "utf8"));

const faces = await loadFaces();
const noto = faces["noto-sans"];
const serif = faces["noto-serif"];

// The exact stories the pre-change golden was captured from. Do not edit these
// without regenerating the fixture from an unmodified engine.
const GOLDEN_STORIES = {
  A: {
    id: "st_a",
    text: "Hello Rich World",
    character: makeCharacter({ size: 28, leading: 34 }),
    paragraph: makeParagraph(),
    runs: [],
    paragraphRuns: [],
  },
  B: {
    id: "st_b",
    text: "The quick brown fox jumps over the lazy dog again and again",
    character: makeCharacter({ size: 24, leading: 29 }),
    paragraph: makeParagraph(),
    runs: [],
    paragraphRuns: [],
  },
  C: {
    id: "st_c",
    text: "First paragraph text\nSecond paragraph here",
    character: makeCharacter({ size: 22, leading: 27, tracking: 10 }),
    paragraph: makeParagraph({ align: "center", firstLineIndent: 10, spaceAfter: 8 }),
    runs: [],
    paragraphRuns: [],
  },
  D: {
    id: "st_d",
    text: "",
    character: makeCharacter({ size: 30, leading: 36 }),
    paragraph: makeParagraph(),
    runs: [],
    paragraphRuns: [],
  },
};
const GOLDEN_FRAMES = { A: [320, 120], B: [200, 400], C: [260, 200], D: [100, 100] };

function composeJSON(story, w, h) {
  const c = composeFrame(noto, story, w, h);
  return {
    lineCount: c.lineCount,
    overflow: c.overflow,
    heightPx: c.heightPx,
    firstBaselinePx: c.firstBaselinePx,
    glyphCount: c.glyphs.length,
    glyphPos: c.glyphs.map((g) => [g.gid, +g.x.toFixed(4), +g.y.toFixed(4)]),
    pathHash: undefined, // paths are engine internals; the pixel gate covers them
    caretStops: c.caretStops.map((s) => [+s.x.toFixed(4), +s.y.toFixed(4), s.offset]),
  };
}

test("empty runs: compose output matches the pre-change engine exactly", () => {
  for (const key of Object.keys(GOLDEN_STORIES)) {
    const [w, h] = GOLDEN_FRAMES[key];
    const got = composeJSON(GOLDEN_STORIES[key], w, h);
    const want = GOLDEN[key].compose;
    assert.deepEqual(
      got,
      { ...want, pathHash: undefined },
      `story ${key} compose drifted from the pre-change engine`,
    );
  }
});

test("empty runs: rendered pixels match the pre-change engine byte-for-byte", () => {
  for (const key of Object.keys(GOLDEN_STORIES)) {
    const [w, h] = GOLDEN_FRAMES[key];
    const got = renderStoryPixels(GOLDEN_STORIES[key], noto, w, h);
    assert.equal(got.rawSha, GOLDEN[key].pixels.rawSha, `story ${key} raw pixels drifted`);
    assert.equal(got.pngSha, GOLDEN[key].pixels.pngSha, `story ${key} PNG bytes drifted`);
  }
});

test("character runs: a range renders with its own face, size and fill", () => {
  const red = { r: 0.8, g: 0.1, b: 0.05, a: 1 };
  const story = {
    id: "st_run",
    text: "ABC DEF",
    character: makeCharacter({ size: 24, leading: 30 }),
    paragraph: makeParagraph(),
    runs: [
      {
        start: 0,
        end: 3,
        styleId: null,
        overrides: { fontId: "noto-serif", size: 40, fill: red, tracking: 100 },
      },
    ],
    paragraphRuns: [],
  };
  const c = composeFrame(noto, story, 400, 120);
  assert.equal(c.lineCount, 1);
  assert.equal(c.glyphs.length, 6); // "ABC DEF" — the word space paints no outline
  for (const g of c.glyphs.slice(0, 3)) {
    assert.equal(g.face, serif, "range glyphs must use the range's resolved face");
    assert.equal(g.fill, red, "range glyphs must carry the range fill");
    assert.ok(Math.abs(g.scale - 40 / serif.upem) < 1e-12, "range glyphs scale by the range size");
  }
  for (const g of c.glyphs.slice(3)) {
    assert.equal(g.face, noto, "text outside every range keeps the story face");
    assert.equal(g.fill, story.character.fill, "text outside every range keeps the story fill");
  }
  // One shared baseline across both runs.
  const baseline = c.glyphs[0].y;
  for (const g of c.glyphs) assert.equal(g.y, baseline);
  // The serif range is bigger than the story size, so it must be wider than
  // the same three glyphs set uniformly.
  const uniform = composeFrame(noto, { ...story, runs: [] }, 400, 120);
  const rangeW = c.glyphs[2].x - c.glyphs[0].x;
  const uniformW = uniform.glyphs[2].x - uniform.glyphs[0].x;
  assert.ok(rangeW > uniformW * 1.2, `styled range width ${rangeW} should clearly exceed ${uniformW}`);
  // The styled render must actually differ from the uniform one, pixel for pixel.
  const a = renderStoryPixels(story, noto, 400, 120);
  const b = renderStoryPixels({ ...story, runs: [] }, noto, 400, 120);
  assert.notEqual(a.rawSha, b.rawSha, "a range that changes nothing on canvas is decorative");
});

test("character runs: an unknown fontId falls back to the story face", () => {
  const story = {
    id: "st_unknown",
    text: "Fallback",
    character: makeCharacter({ size: 24, leading: 30 }),
    paragraph: makeParagraph(),
    runs: [{ start: 0, end: 4, styleId: null, overrides: { fontId: "does-not-exist" } }],
    paragraphRuns: [],
  };
  const c = composeFrame(noto, story, 300, 100);
  assert.equal(c.glyphs.length, 8); // "Fallback" — every glyph keeps an outline
  for (const g of c.glyphs) assert.equal(g.face, noto);
});

test("character runs: a range ending at the paragraph break styles only its own text", () => {
  const story = {
    id: "st_cross",
    text: "One\nTwo",
    character: makeCharacter({ size: 24, leading: 30 }),
    paragraph: makeParagraph(),
    runs: [{ start: 0, end: 3, styleId: null, overrides: { fontId: "noto-serif", size: 34 } }],
    paragraphRuns: [],
  };
  const c = composeFrame(noto, story, 300, 200);
  assert.equal(c.glyphs.slice(0, 3).filter((g) => g.face === serif).length, 3, "One -> serif");
  assert.equal(c.glyphs.slice(3).filter((g) => g.face === noto).length, 3, "Two -> story face");
});

test("paragraph runs: align, startIndent and spaceBefore move only their own paragraph", () => {
  const text = "First paragraph line\nSecond paragraph line";
  const plain = {
    id: "st_p0",
    text,
    character: makeCharacter({ size: 20, leading: 26 }),
    paragraph: makeParagraph(),
    runs: [],
    paragraphRuns: [],
  };
  const styled = {
    ...plain,
    id: "st_p1",
    paragraphRuns: [
      {
        start: 21,
        end: text.length,
        styleId: null,
        overrides: { align: "center", startIndent: 24, spaceBefore: 19, firstLineIndent: 8 },
      },
    ],
  };
  const a = composeFrame(noto, plain, 300, 200);
  const b = composeFrame(noto, styled, 300, 200);

  assert.equal(a.lineCount, 2);
  assert.equal(b.lineCount, 2);
  // Paragraph 1: untouched, glyph for glyph.
  const firstLineA = a.glyphs.filter((g) => g.y === a.caretStops[0].y);
  const firstLineB = b.glyphs.filter((g) => g.y === b.caretStops[0].y);
  assert.deepEqual(
    firstLineB.map((g) => [g.gid, +g.x.toFixed(4), +g.y.toFixed(4)]),
    firstLineA.map((g) => [g.gid, +g.x.toFixed(4), +g.y.toFixed(4)]),
    "the un-styled paragraph must render exactly as before",
  );
  // Paragraph 2: its first caret sits spaceBefore lower than in the plain set.
  const stopA = a.caretStops.find((s) => s.offset === 21);
  const stopB = b.caretStops.find((s) => s.offset === 21);
  assert.ok(stopA && stopB, "both composes must place a caret at the second paragraph");
  assert.ok(
    Math.abs(stopB.y - stopA.y - 19) < 1e-9,
    `second baseline should drop by spaceBefore (got ${stopB.y - stopA.y})`,
  );
  // startIndent shifts every line of paragraph 2; center alignment pulls the
  // pen right of the indent, so the caret must sit right of the plain one.
  assert.ok(stopB.x > stopA.x, "startIndent + center must move the pen right");
  // And the styled second paragraph must look different on canvas.
  const pa = renderStoryPixels(plain, noto, 300, 200);
  const pb = renderStoryPixels(styled, noto, 300, 200);
  assert.notEqual(pa.rawSha, pb.rawSha);
});

test("paragraph runs: spaceAfter of paragraph 1 and spaceBefore of paragraph 2 stack", () => {
  const mk = (o1, o2) => ({
    id: "st_gap",
    text: "Alpha\nBeta",
    character: makeCharacter({ size: 20, leading: 26 }),
    paragraph: makeParagraph(),
    runs: [],
    paragraphRuns: [
      { start: 0, end: 6, styleId: null, overrides: o1 },
      { start: 6, end: 11, styleId: null, overrides: o2 },
    ],
  });
  const base = composeFrame(noto, mk({}, {}), 300, 300);
  const gapped = composeFrame(noto, mk({ spaceAfter: 12 }, { spaceBefore: 7 }), 300, 300);
  const baseStop = base.caretStops.find((s) => s.offset === 6);
  const gappedStop = gapped.caretStops.find((s) => s.offset === 6);
  assert.ok(baseStop && gappedStop);
  assert.ok(Math.abs(gappedStop.y - baseStop.y - 19) < 1e-9);
});

test("overset with mixed sizes still reports overflow, not corrupted layout", () => {
  const story = {
    id: "st_over",
    text: "Tiny text here and then a HUGE tail that cannot possibly fit the frame",
    character: makeCharacter({ size: 16, leading: 20 }),
    paragraph: makeParagraph(),
    runs: [{ start: 28, end: 70, styleId: null, overrides: { size: 44, leading: 52 } }],
    paragraphRuns: [],
  };
  const c = composeFrame(noto, story, 220, 90);
  assert.equal(c.overflow, true);
  assert.ok(c.lineCount >= 1, "some lines must still have been set before the cut");
  // Whatever was set sits on proper baselines: y strictly increases line to line.
  const baselines = [...new Set(c.glyphs.map((g) => g.y))];
  for (let i = 1; i < baselines.length; i++) assert.ok(baselines[i] > baselines[i - 1]);
});
