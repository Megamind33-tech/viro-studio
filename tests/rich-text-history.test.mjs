/**
 * Rich-text contract, document side (VIRO-0142).
 *
 * Drives the REAL command-bus commands (`type.characterRange`,
 * `type.paragraphRange`) the Character/Paragraph panels use, then proves:
 *
 *   - applying a range mutates the story and changes the rendered page;
 *   - UNDO restores the document AND the pixels exactly;
 *   - REDO re-applies it and the pixels match the first application exactly;
 *   - save/reopen (JSON round-trip through the migrator) is pixel-stable.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/rich-text-history.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { loadFaces, makeCharacter, makeParagraph, renderStoryPixels } = await import(
  "./rich-text-harness.mjs"
);
const { CommandBus } = await import("../src/document/command-bus.ts");
const { installUiCommands } = await import("../src/document/ui-commands.ts");
const { documentFromPreset, PRESETS } = await import("../src/document/presets.ts");
const { findLayer } = await import("../src/document/factory.ts");
const { DOC_VERSION, migrateDocument } = await import("../src/document/migrate.ts");

installUiCommands();
const faces = await loadFaces();
const noto = faces["noto-sans"];

const W = 420;
const H = 160;
const TEXT = "Styled story here";

function docWithStory() {
  const doc = documentFromPreset(PRESETS[0]);
  const page = doc.pages[0];
  page.layers.length = 0;
  doc.stories.length = 0;
  doc.stories.push({
    id: "st_rich",
    text: TEXT,
    runs: [],
    paragraphRuns: [],
    character: makeCharacter({ size: 36, leading: 44 }),
    paragraph: makeParagraph(),
  });
  page.layers.push({
    id: "ly_rich",
    name: "Rich",
    kind: "type-frame",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    parentId: null,
    storyId: "st_rich",
    nextFrameId: null,
    transform: { x: 20, y: 20, w: W, h: H, rotation: 0 },
  });
  doc.activeLayerIds = ["ly_rich"];
  return doc;
}

const RED = { r: 0.75, g: 0.1, b: 0.1, a: 1 };
const snap = (doc) => JSON.stringify(doc);

test("type.characterRange: apply, undo, redo — pixels and document both round-trip", () => {
  const bus = new CommandBus();
  let doc = docWithStory();
  const baseline = renderStoryPixels(doc.stories[0], noto, W, H);
  const before = snap(doc);

  const out = bus.execute(doc, {
    type: "type.characterRange",
    params: { layerId: "ly_rich", start: 0, end: 6, size: 48, fill: RED, fontId: "noto-serif", tracking: 60 },
  });
  doc = out.doc;
  const styled = doc.stories[0];
  assert.equal(styled.runs.length, 1);
  assert.deepEqual(styled.runs[0], {
    start: 0,
    end: 6,
    styleId: null,
    overrides: { size: 48, fill: RED, fontId: "noto-serif", tracking: 60 },
  });
  const styledPixels = renderStoryPixels(styled, noto, W, H);
  assert.notEqual(styledPixels.rawSha, baseline.rawSha, "the range must change the page");

  // UNDO — document and pixels both restored.
  const undone = bus.undo(doc);
  assert.ok(undone, "undo must have an entry");
  doc = undone.doc;
  assert.deepEqual(doc.stories[0].runs, []);
  assert.equal(snap(doc), before, "undo must restore the document exactly");
  const undonePixels = renderStoryPixels(doc.stories[0], noto, W, H);
  assert.equal(undonePixels.rawSha, baseline.rawSha, "undo must restore the pixels exactly");

  // REDO — pixels match the first application exactly.
  const redone = bus.redo(doc);
  assert.ok(redone, "redo must have an entry");
  doc = redone.doc;
  assert.equal(doc.stories[0].runs.length, 1);
  const redonePixels = renderStoryPixels(doc.stories[0], noto, W, H);
  assert.equal(redonePixels.rawSha, styledPixels.rawSha, "redo must reproduce the styled pixels");
});

test("type.paragraphRange: apply/undo changes only the target paragraph's rendering", () => {
  const bus = new CommandBus();
  let doc = docWithStory();
  doc.stories[0] = { ...doc.stories[0], text: "First line here\nSecond line here" };
  const baseline = renderStoryPixels(doc.stories[0], noto, W, 260);

  const out = bus.execute(doc, {
    type: "type.paragraphRange",
    params: { layerId: "ly_rich", start: 17, end: 20, align: "center", startIndent: 30, spaceBefore: 14 },
  });
  doc = out.doc;
  assert.equal(doc.stories[0].paragraphRuns.length, 1);
  const shifted = renderStoryPixels(doc.stories[0], noto, W, 260);
  assert.notEqual(shifted.rawSha, baseline.rawSha);

  const undone = bus.undo(doc);
  doc = undone.doc;
  assert.deepEqual(doc.stories[0].paragraphRuns, []);
  assert.equal(renderStoryPixels(doc.stories[0], noto, W, 260).rawSha, baseline.rawSha);
});

test("save/reopen: JSON round-trip through the migrator is pixel-stable", () => {
  const bus = new CommandBus();
  let doc = docWithStory();
  doc = bus.execute(doc, {
    type: "type.characterRange",
    params: { layerId: "ly_rich", start: 7, end: 12, size: 52, fill: { r: 0.05, g: 0.3, b: 0.8, a: 1 }, fontId: "noto-sans-bold" },
  }).doc;
  doc = bus.execute(doc, {
    type: "type.paragraphRange",
    params: { layerId: "ly_rich", start: 0, end: 4, align: "right", spaceAfter: 6 },
  }).doc;
  const saved = renderStoryPixels(doc.stories[0], noto, W, H);

  // The exact path a .press.json save takes: stringify → parse → migrate.
  const reopened = JSON.parse(JSON.stringify(doc));
  migrateDocument(reopened);
  assert.equal(reopened.version, DOC_VERSION);
  assert.equal(reopened.stories[0].runs.length, 1);
  assert.equal(reopened.stories[0].paragraphRuns.length, 1);
  const reopenedPixels = renderStoryPixels(reopened.stories[0], noto, W, H);
  assert.equal(reopenedPixels.rawSha, saved.rawSha, "reopen must repaint identically");
  assert.equal(reopenedPixels.pngSha, saved.pngSha);
});

test("empty runs stay empty through migration; the type frame still validates", () => {
  const doc = docWithStory();
  const reopened = JSON.parse(JSON.stringify(doc));
  migrateDocument(reopened);
  const layer = findLayer(reopened.pages[0], "ly_rich");
  assert.ok(layer && layer.kind === "type-frame");
  assert.deepEqual(reopened.stories[0].runs, []);
  assert.equal(
    renderStoryPixels(reopened.stories[0], noto, W, H).rawSha,
    renderStoryPixels(doc.stories[0], noto, W, H).rawSha,
  );
});
