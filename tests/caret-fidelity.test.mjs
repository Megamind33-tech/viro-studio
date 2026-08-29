/**
 * Caret/selection fidelity from HarfBuzz clusters (VIRO-0144).
 *
 * The shaped glyph list is the single source of truth for carets: every stop
 * must sit on the x where shaping actually put a cluster boundary, kerning
 * pairs and ligatures included, and the prefix re-shaping pass is gone. The
 * story's script/direction/language must reach the HarfBuzz buffer instead of
 * everything being guessed.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/caret-fidelity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFaces, makeCharacter, makeParagraph } from "./rich-text-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { composeFrame, nearestCaretOffset, loadFace } = await import("../src/engine/type.ts");

const faces = await loadFaces();
const noto = faces["noto-sans"];
const notoBold = faces["noto-sans-bold"];

const arabicBytes = readFileSync(
  join(ROOT, "tests", "caret-fidelity-arabic", "NotoNaskhArabic-Regular.ttf"),
);
const arabicFace = await loadFace(
  "caret-naskh",
  "NotoNaskhArabic-Regular.ttf",
  arabicBytes.buffer.slice(arabicBytes.byteOffset, arabicBytes.byteOffset + arabicBytes.byteLength),
);

/** The fixture line: kerning pairs (AV, TA) and both an ffi and an fi ligature. */
const LIGATURE_TEXT = "AVATAR office fi";
const LIGATURE_FEATURES = ["kern", "liga"];

function story(text, { character = {}, paragraph = {}, runs = [], id = "st_caret" } = {}) {
  return {
    id,
    text,
    character: makeCharacter(character),
    paragraph: makeParagraph(paragraph),
    runs,
    paragraphRuns: [],
  };
}

function compose(s, face = noto, w = 420, h = 200) {
  return composeFrame(face, s, w, h);
}

const KERN_STORY = () =>
  story(LIGATURE_TEXT, { character: { otFeatures: LIGATURE_FEATURES }, id: "st_caret_kern" });

/* ------------------------------------------------------------------ *
 * Acceptance 2 — caret x at cluster boundaries == shaped glyph origin
 * ------------------------------------------------------------------ */

test("kerning + ligature line: every visible cluster stop sits on its glyph origin", () => {
  const c = compose(KERN_STORY());
  // A stop whose offset starts a drawn glyph must be at that glyph's origin
  // (<= 0.5px): stops come off the same pen walk that placed the glyphs, so
  // kerning between "A" and "V" or across "TA" cannot drift them apart. The
  // deleted prefix re-shaping put the caret after "A" at 17.89px (the kern-off
  // advance) while "V" inked at 16.77px.
  for (const stop of c.caretStops) {
    const glyph = c.glyphs.find((g) => g.cluster === stop.offset);
    if (!glyph) continue;
    assert.ok(
      Math.abs(glyph.x - stop.x) <= 0.5,
      `stop ${stop.offset} at ${stop.x.toFixed(2)} vs glyph origin ${glyph.x.toFixed(2)}`,
    );
  }
  // The specific kerning pair from the audit: caret between A and V.
  const afterA = c.caretStops.find((s) => s.offset === 1);
  const v = c.glyphs.find((g) => g.cluster === 1);
  assert.ok(afterA && v, "caret after A and the V glyph exist");
  assert.ok(Math.abs(afterA.x - v.x) <= 0.5, `caret after A lands on V origin (kerned)`);
});

test("ligature interiors have no caret stop; the ligature brackets exactly", () => {
  const c = compose(KERN_STORY());
  const offsets = c.caretStops.map((s) => s.offset);
  // "office" shapes o + ffi-ligature + c + e: the ffi glyph's cluster covers
  // offsets 8..10, so 9 and 10 are mid-glyph and must not carry a stop.
  // The "fi" in "fi" covers 14..15, so 15 is mid-glyph too.
  for (const inside of [9, 10, 15]) {
    assert.ok(!offsets.includes(inside), `no caret stop inside a ligature at ${inside}`);
  }
  for (const boundary of [8, 11, 14, 16]) {
    assert.ok(offsets.includes(boundary), `cluster boundary ${boundary} has a stop`);
  }
  // The stop right after the ffi ligature is exactly where the next glyph
  // starts — the highlight over the ligature ends at its ink edge, not inside.
  const stopAfterLig = c.caretStops.find((s) => s.offset === 11);
  const afterLig = c.glyphs.find((g) => g.cluster === 11);
  assert.ok(Math.abs(stopAfterLig.x - afterLig.x) <= 0.5);
});

test("caret stops stay monotone and cover the line ends", () => {
  const c = compose(KERN_STORY());
  const stops = c.caretStops;
  for (let i = 1; i < stops.length; i++) {
    assert.ok(stops[i].offset > stops[i - 1].offset, "stop offsets strictly increase");
    assert.ok(stops[i].x >= stops[i - 1].x - 0.5, "stop x never moves left along a line");
  }
  assert.equal(stops[0].offset, 0, "line starts with a stop at offset 0");
  assert.equal(stops[stops.length - 1].offset, LIGATURE_TEXT.length, "line ends with a stop");
  // Space-boundary stops (spaces draw no glyph) sit at the pen position
  // between their neighbours.
  const spaceStop = stops.find((s) => s.offset === 6);
  const before = c.glyphs.filter((g) => g.cluster < 6).at(-1);
  const after = c.glyphs.find((g) => g.cluster === 7);
  assert.ok(spaceStop.x >= before.x && spaceStop.x <= after.x);
});

/* ------------------------------------------------------------------ *
 * Acceptance 3 — selection covers exactly the selected glyphs
 * ------------------------------------------------------------------ */

/**
 * The rects compositor.paintTextEdit derives from stops: one rect per stop in
 * [a, b), spanning to the next stop on the same baseline.
 */
function selectionRects(c, a, b) {
  const stops = c.caretStops;
  const rects = [];
  for (const s of stops.filter((s) => s.offset >= a && s.offset < b)) {
    const next = stops.find((n) => n.offset > s.offset && n.y === s.y) ?? { ...s, x: s.x + 6 };
    rects.push({ x0: Math.min(s.x, next.x), x1: Math.max(s.x, next.x, s.x + 4), y: s.y });
  }
  return rects;
}

test("selection across a style boundary covers exactly the selected glyphs", () => {
  // 0142-style runs: the first word set larger, the rest bold — a style
  // boundary lands mid-line at offset 7, and the selection [4, 12) crosses it.
  const s = KERN_STORY();
  s.runs = [
    { start: 0, end: 7, overrides: { size: 34 } },
    { start: 7, end: LIGATURE_TEXT.length, overrides: { fontId: "noto-sans-bold" } },
  ];
  const c = compose(s);
  const a = 4;
  const b = 12;

  // The style boundary offset carries exactly one stop, shared by both runs.
  const boundaryStops = c.caretStops.filter((st) => st.offset === 7);
  assert.equal(boundaryStops.length, 1, "the style boundary dedupes to one caret stop");

  const rects = selectionRects(c, a, b);
  assert.ok(rects.length >= 2, "selection spans both sides of the boundary");
  const x0 = rects[0].x0;
  const x1 = rects[rects.length - 1].x1;
  const startStop = c.caretStops.find((st) => st.offset === a);
  const endStop = c.caretStops.find((st) => st.offset === b);
  assert.ok(Math.abs(rects[0].x0 - startStop.x) <= 0.01, "selection starts at the caret stop");
  assert.ok(Math.abs(x1 - endStop.x) <= 0.01, "selection ends at the caret stop");

  // Exact coverage: every glyph whose cluster starts inside [a, b) lies in the
  // selection; every glyph outside it lies fully outside the selection.
  const inBand = (g) => g.x >= x0 - 0.5 && g.x < x1;
  for (const g of c.glyphs) {
    if (g.cluster >= a && g.cluster < b) {
      assert.ok(inBand(g), `selected glyph (cluster ${g.cluster}) inside the highlight`);
    } else if (g.cluster < a) {
      assert.ok(g.x < x0, `unselected glyph (cluster ${g.cluster}) left of the highlight`);
    } else {
      assert.ok(g.x >= x1 - 0.5, `unselected glyph (cluster ${g.cluster}) right of the highlight`);
    }
  }
  // Both styles contributed: some selected glyph is 34px, some is 22px face.
  const selected = c.glyphs.filter((g) => g.cluster >= a && g.cluster < b);
  assert.ok(selected.some((g) => g.scale > 34 / noto.upem - 0.001));
  assert.ok(selected.some((g) => g.face === notoBold));
});

test("selecting a ligature highlights the whole ligature glyph", () => {
  const c = compose(KERN_STORY());
  // [8, 11) is exactly the ffi ligature — one glyph, three characters.
  const rects = selectionRects(c, 8, 11);
  assert.equal(rects.length, 1, "the ligature highlights as one span");
  const lig = c.glyphs.find((g) => g.cluster === 8);
  const next = c.glyphs.find((g) => g.cluster === 11);
  assert.ok(rects[0].x0 <= lig.x + 0.5, "highlight starts at the ligature ink");
  assert.ok(rects[0].x1 >= next.x - 0.5, "highlight ends at the ligature's right edge");
});

test("nearestCaretOffset snaps clicks to cluster boundaries, not mid-glyph", () => {
  const c = compose(KERN_STORY());
  const y = c.caretStops[0].y;
  // A click in the middle of the ffi ligature lands on one of its two
  // boundary stops — never on a phantom mid-glyph offset.
  const lig = c.glyphs.find((g) => g.cluster === 8);
  const next = c.glyphs.find((g) => g.cluster === 11);
  const midX = (lig.x + next.x) / 2;
  const offset = nearestCaretOffset(c.caretStops, midX, y);
  assert.ok(offset === 8 || offset === 11, `mid-ligature click gave boundary ${offset}`);
});

/* ------------------------------------------------------------------ *
 * Acceptance 4 — story script/direction/language reach HarfBuzz
 * ------------------------------------------------------------------ */

const ARABIC = "\u0644\u0628\u064a\u062a"; // lam beh yeh teh — joins and runs RTL

function arabicStory(extra) {
  return story(ARABIC, { character: { fontId: "caret-naskh", ...extra }, id: "st_caret_rtl" });
}

test("RTL: story direction feeds the shaper and carets mirror", () => {
  const c = compose(arabicStory({ direction: "rtl" }), arabicFace, 400, 120);
  assert.ok(c.glyphs.length > 0, "Arabic shaped into glyphs");
  // HarfBuzz lays RTL runs out visually left-to-right with DESCENDING
  // clusters. Joined forms give several glyphs per cluster.
  const clusters = c.glyphs.map((g) => g.cluster);
  assert.deepEqual(clusters, [...clusters].sort((a, b) => b - a), "clusters descend in visual order");

  // Carets mirror: offset 0 sits at the right edge of the line, the final
  // offset at the left edge, strictly decreasing in between.
  const stops = c.caretStops;
  assert.equal(stops[0].offset, 0);
  assert.equal(stops[stops.length - 1].offset, ARABIC.length);
  for (let i = 1; i < stops.length; i++) {
    assert.ok(stops[i].x < stops[i - 1].x, "RTL caret x decreases as the offset grows");
  }
  // A click at the far right of an RTL line puts the caret before the text.
  const right = nearestCaretOffset(stops, stops[0].x + 50, stops[0].y);
  assert.equal(right, 0);
});

test("forced LTR direction overrides the Arabic guess — proof the setter is applied", () => {
  // guessSegmentProperties on Arabic yields RTL; only an explicit
  // setDirection from story.character.direction can turn this into ascending
  // clusters, so this assertion fails if the story field stops reaching hb.
  const forced = compose(arabicStory({ direction: "ltr" }), arabicFace, 400, 120);
  const clusters = forced.glyphs.map((g) => g.cluster);
  assert.deepEqual(clusters, [...clusters].sort((a, b) => a - b), "clusters ascend under LTR");
  for (let i = 1; i < forced.caretStops.length; i++) {
    assert.ok(forced.caretStops[i].x > forced.caretStops[i - 1].x, "LTR carets run left to right");
  }
  // The same text without a direction still shapes RTL (the guess path).
  const auto = compose(arabicStory({}), arabicFace, 400, 120);
  assert.ok(auto.glyphs[0].cluster > auto.glyphs.at(-1).cluster, "unset direction still guesses RTL");
});

test("script override feeds the shaper: latn on Arabic suppresses joining", () => {
  const arab = compose(arabicStory({ script: "Arab" }), arabicFace, 400, 120);
  const latn = compose(arabicStory({ script: "latn" }), arabicFace, 400, 120);
  // With an explicit Arab script the run joins: contextual (initial/medial/
  // final) glyph forms, laid out RTL with descending clusters. Forcing latn
  // selects no Arabic shaping lookups, so every character keeps its isolated
  // form and the direction guess follows the latn script (LTR, ascending).
  const arabClusters = arab.glyphs.map((g) => g.cluster);
  assert.deepEqual(arabClusters, [...arabClusters].sort((a, b) => b - a), "Arab script joins RTL");
  const latnClusters = latn.glyphs.map((g) => g.cluster);
  assert.deepEqual(latnClusters, [...latnClusters].sort((a, b) => a - b), "latn script runs LTR");
  assert.notDeepEqual(
    arab.glyphs.map((g) => g.gid),
    latn.glyphs.map((g) => g.gid),
    "script selection changed the shaped glyph ids (contextual vs isolated forms)",
  );
});

test("language feeds the shaper: distinct languages never collide in the run cache", async () => {
  const probe = await loadFace(
    "caret-lang-probe",
    "NotoNaskhArabic-Regular.ttf",
    arabicBytes.buffer.slice(arabicBytes.byteOffset, arabicBytes.byteOffset + arabicBytes.byteLength),
  );
  const before = probe.runs.size;
  compose(arabicStory({ language: "ar" }), probe, 400, 120);
  compose(arabicStory({ language: "fa" }), probe, 400, 120);
  compose(arabicStory({ language: "ar" }), probe, 400, 120); // cache hit
  const added = probe.runs.size - before;
  assert.equal(added, 2, `ar and fa shape separately (${added} cache entries)`);
});

/* ------------------------------------------------------------------ *
 * Acceptance 1/5 — prefix re-shaping eliminated
 * ------------------------------------------------------------------ */

test("one compose shapes words and lines, never every prefix", async () => {
  // The deleted emitStops shaped line.slice(0, i) for every grapheme boundary:
  // a 16-character line added 17+ prefix runs to the cache. Deriving stops
  // from the glyph walk adds only tokens plus the line pieces.
  const bytes = readFileSync(join(ROOT, "public", "fonts", "NotoSans-Regular.ttf"));
  const probe = await loadFace(
    "caret-perf-probe",
    "NotoSans-Regular.ttf",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const before = probe.runs.size;
  compose(KERN_STORY(), probe);
  const added = probe.runs.size - before;
  assert.ok(added <= 12, `one compose added ${added} shaped runs (prefix pass would add 17+)`);
  const afterFirst = probe.runs.size;
  compose(KERN_STORY(), probe);
  assert.equal(probe.runs.size, afterFirst, "a second compose adds nothing new to the cache");
});

test("overflow lines keep their caret stops but stay out of the line count", () => {
  const s = story("one two three four five six seven eight", { id: "st_caret_overflow" });
  const c = compose(s, noto, 90, 60); // measure fits ~one word per line, frame fits ~2
  assert.ok(c.overflow, "the frame overflows");
  const visible = c.lineCount;
  assert.ok(visible >= 1 && visible < 8, `visible lines: ${visible}`);
  // Stops exist past the last drawn line: the caret can still sit in text the
  // frame had to drop (emitStops-before-setLine behaviour, preserved).
  const drawnStops = c.caretStops.filter((st) => st.y <= c.heightPx).length;
  assert.ok(c.caretStops.length > drawnStops, "overflow line contributes caret stops");
});

test("empty story keeps its single origin caret stop", () => {
  const c = compose(story("", { id: "st_caret_empty", paragraph: { firstLineIndent: 12 } }), noto, 300, 120);
  assert.equal(c.caretStops.length, 1);
  assert.equal(c.caretStops[0].offset, 0);
  assert.ok(Math.abs(c.caretStops[0].x - 12) < 0.01, "empty caret honours the first-line indent");
});

test("multi-paragraph stories put stops at the paragraph boundaries", () => {
  const c = compose(story("ab\ncd", { id: "st_caret_paras" }), noto, 300, 160);
  const offsets = c.caretStops.map((s) => s.offset);
  for (const at of [0, 1, 2, 3, 4, 5]) {
    assert.ok(offsets.includes(at), `offset ${at} has a caret stop`);
  }
  // The "\n" itself (offset 2) is a line-end stop of paragraph one; offset 3
  // starts paragraph two.
  assert.ok(Math.abs(c.caretStops.find((s) => s.offset === 3).y - c.caretStops.find((s) => s.offset === 2).y) > 1,
    "paragraph two's stop sits on its own baseline");
});
