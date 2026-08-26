import assert from "node:assert/strict";
import test from "node:test";

import { addTypeFrame, createDocument, validateDocument } from "../src/document/factory.ts";
import { DOC_VERSION, migrateDocument } from "../src/document/migrate.ts";
import {
  applyCharacterRange,
  applyParagraphRange,
  assertTextRange,
  graphemeBoundaries,
  paragraphRange,
  replaceStoryRange,
  validateStoryTextModel,
} from "../src/document/text-model.ts";

const black = { r: 0, g: 0, b: 0, a: 1 };

function story(text, runs = [], paragraphRuns = []) {
  return {
    id: "st_test",
    text,
    character: {
      fontId: "noto-sans",
      size: 48,
      leading: 58,
      tracking: 0,
      fill: black,
      otFeatures: ["kern", "liga"],
    },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
    runs,
    paragraphRuns,
  };
}

test("grapheme boundaries preserve combining marks and emoji ZWJ sequences", () => {
  const text = `A${"e\u0301"}${"👨‍👩‍👧‍👦"}B`;
  const boundaries = graphemeBoundaries(text);
  assert.deepEqual(boundaries, [0, 1, 3, text.length - 1, text.length]);
  assert.throws(() => assertTextRange(text, 2, 3), /splits a grapheme cluster/);
  assert.doesNotThrow(() => assertTextRange(text, 1, 3));
});

test("character formatting creates sparse, non-overlapping mixed-style runs", () => {
  let next = applyCharacterRange(story("Commercial poster"), 0, 10, { size: 72 }, "display");
  next = applyCharacterRange(next, 11, 17, { fill: { r: 0.9, g: 0.2, b: 0.1, a: 1 } }, null);
  assert.deepEqual(
    next.runs.map(({ start, end, styleId }) => ({ start, end, styleId })),
    [
      { start: 0, end: 10, styleId: "display" },
      { start: 11, end: 17, styleId: null },
    ],
  );
  assert.deepEqual(validateStoryTextModel(next), []);
});

test("applying a style over an existing range splits the prior run deterministically", () => {
  const base = story("abcdef", [{ start: 0, end: 6, styleId: "base", overrides: { tracking: 20 } }]);
  const next = applyCharacterRange(base, 2, 4, { size: 80 }, "accent");
  assert.deepEqual(
    next.runs.map(({ start, end, styleId }) => ({ start, end, styleId })),
    [
      { start: 0, end: 2, styleId: "base" },
      { start: 2, end: 4, styleId: "accent" },
      { start: 4, end: 6, styleId: "base" },
    ],
  );
});

test("insert and delete keep style ranges normalized and inherit by affinity", () => {
  const base = story("Hello world", [{ start: 0, end: 5, styleId: "strong", overrides: { size: 64 } }]);
  const inserted = replaceStoryRange(base, 5, 5, "!", "backward");
  assert.equal(inserted.text, "Hello! world");
  assert.deepEqual(inserted.runs, [{ start: 0, end: 6, styleId: "strong", overrides: { size: 64 } }]);

  const deleted = replaceStoryRange(inserted, 1, 4, "");
  assert.equal(deleted.text, "Ho! world");
  assert.deepEqual(deleted.runs, [{ start: 0, end: 3, styleId: "strong", overrides: { size: 64 } }]);
});

test("paragraph formatting expands a selection to complete paragraph boundaries", () => {
  const text = "One\nTwo\nThree";
  assert.deepEqual(paragraphRange(text, 5, 6), { start: 4, end: 8 });
  const next = applyParagraphRange(story(text), 5, 6, { align: "center" }, "middle");
  assert.deepEqual(next.paragraphRuns, [
    { start: 4, end: 8, styleId: "middle", overrides: { align: "center" } },
  ]);
});

test("validation reports overlapping and grapheme-splitting ranges", () => {
  const broken = story("e\u0301x", [
    { start: 0, end: 1, styleId: null, overrides: { size: 20 } },
    { start: 0, end: 2, styleId: null, overrides: { size: 30 } },
  ]);
  const errors = validateStoryTextModel(broken).join(" ");
  assert.match(errors, /overlap/);
  assert.match(errors, /splits a grapheme cluster/);
});

test("v3 migration initializes the v4 rich-text contract without changing visible text", () => {
  let doc = createDocument({
    name: "Migration fixture",
    ppi: 300,
    widthPx: 1000,
    heightPx: 1000,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  doc = addTypeFrame(doc, "noto-sans", 100, 100);
  const expectedText = doc.stories[0].text;
  doc.version = 3;
  delete doc.textStyles;
  delete doc.fontSubstitutions;
  delete doc.stories[0].runs;
  delete doc.stories[0].paragraphRuns;
  delete doc.pages[0].layers[0].textFrame;

  const report = migrateDocument(doc);
  assert.equal(doc.version, DOC_VERSION);
  assert.equal(doc.stories[0].text, expectedText);
  assert.deepEqual(doc.stories[0].runs, []);
  assert.deepEqual(doc.stories[0].paragraphRuns, []);
  assert.equal(doc.pages[0].layers[0].textFrame.kind, "area");
  assert.equal(report.textStoriesInitialised, 1);
  assert.equal(report.textFramesInitialised, 1);
  assert.equal(report.textRegistriesInitialised, 2);
  assert.deepEqual(validateDocument(doc), []);
});

test("new documents are stamped with the complete current text schema", () => {
  let doc = createDocument({
    name: "Current",
    ppi: 72,
    widthPx: 800,
    heightPx: 600,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  doc = addTypeFrame(doc, "noto-sans", 20, 30);
  assert.equal(doc.version, DOC_VERSION);
  assert.deepEqual(doc.textStyles, { character: {}, paragraph: {} });
  assert.deepEqual(doc.fontSubstitutions, {});
  assert.deepEqual(doc.stories[0].runs, []);
  assert.deepEqual(doc.stories[0].paragraphRuns, []);
  assert.equal(doc.pages[0].layers[0].textFrame.kind, "area");
  assert.deepEqual(validateDocument(doc), []);
});
