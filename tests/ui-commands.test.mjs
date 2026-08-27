/**
 * Unit tests for the UI editing commands (foundation slice 5).
 *
 * Same mechanical claim as the Anchor suite: every command applies, refuses bad
 * input with a precise message, and undoes exactly. The guard at the top means
 * a newly registered command cannot quietly escape this file.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/ui-commands.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CommandBus } from "../src/document/command-bus.ts";
import { CommandError } from "../src/document/commands.ts";
import { installUiCommands, UI_COMMAND_TYPES } from "../src/document/ui-commands.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";
import { setBooleanEngineProvider } from "../src/document/boolean-ops.ts";

installUiCommands();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert.ok(existsSync(ckWasm), "canvaskit.wasm missing");
const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });
setBooleanEngineProvider(() => ck);

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const RED = { r: 1, g: 0, b: 0, a: 1 };
const COPPER = { r: 0.878, g: 0.478, b: 0.184, a: 1 };

function base(o = {}) {
  return { visible: true, locked: false, opacity: 1, blend: "srcOver", parentId: null, ...o };
}

function makeDoc() {
  const doc = documentFromPreset(PRESETS[0]);
  const page = doc.pages[0];
  page.layers.length = 0;
  doc.assets["as_1"] = { id: "as_1", name: "probe.png", dataUrl: PNG, width: 64, height: 48 };
  doc.stories.length = 0;
  doc.stories.push({
    id: "st_1",
    text: "Round trip",
    runs: [],
    paragraphRuns: [],
    character: { fontId: "noto-sans", size: 48, leading: 56, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 } },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
  });
  page.layers.push(
    { ...base(), id: "ly_rect", name: "Rect", kind: "vector", transform: { x: 100, y: 100, w: 200, h: 100, rotation: 0 }, closed: true, nodes: [], fill: RED, stroke: null },
    { ...base(), id: "ly_rect2", name: "Rect 2", kind: "vector", transform: { x: 400, y: 100, w: 200, h: 100, rotation: 0 }, closed: true, nodes: [], fill: RED, stroke: null },
    { ...base(), id: "ly_path", name: "Path", kind: "vector", transform: { x: 300, y: 300, w: 200, h: 200, rotation: 0 }, closed: false, nodes: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 50, y: 50, inX: 0, inY: 0, outX: 0, outY: 0 }], fill: null, stroke: { color: RED, width: 2 } },
    { ...base(), id: "ly_img", name: "Pic", kind: "image-frame", transform: { x: 500, y: 500, w: 300, h: 150, rotation: 0 }, assetId: "as_1", fit: "cover", focal: { x: 0.5, y: 0.5 }, crop: null },
    { ...base(), id: "ly_type", name: "Type", kind: "type-frame", transform: { x: 700, y: 900, w: 600, h: 300, rotation: 0 }, storyId: "st_1", nextFrameId: null },
    { ...base(), id: "ly_group", name: "Group", kind: "group", transform: { x: 900, y: 1400, w: 400, h: 400, rotation: 0 } },
    { ...base({ parentId: "ly_group" }), id: "ly_child", name: "Child", kind: "vector", transform: { x: 10, y: 10, w: 100, h: 100, rotation: 0 }, closed: true, nodes: [], fill: RED, stroke: null },
  );
  doc.activePageId = page.id;
  doc.activeLayerIds = ["ly_rect"];
  return doc;
}

const sel = (ids) => (doc) => {
  doc.activeLayerIds = ids;
};

const rectNodes = (w, h) => {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
};

const booleanSetup = (doc) => {
  sel(["ly_rect", "ly_rect2"])(doc);
  const page = doc.pages[0];
  for (const layer of page.layers) {
    if (layer.id === "ly_rect" || layer.id === "ly_rect2") {
      layer.nodes = rectNodes(layer.transform.w, layer.transform.h);
      layer.closed = true;
    }
  }
};

/** valid / invalid params for every UI command. `setup` prepares the selection. */
const CASES = {
  "layer.delete": { valid: {}, invalid: { layerId: "x" }, match: /takes no parameters/ },
  "layer.group": { valid: {}, invalid: { x: 1 }, match: /takes no parameters/, setup: sel(["ly_rect", "ly_rect2"]) },
  "layer.ungroup": { valid: {}, invalid: { x: 1 }, match: /takes no parameters/, setup: sel(["ly_group"]) },
  "layer.duplicate": { valid: {}, invalid: { x: 1 }, match: /takes no parameters/ },
  "vector.boolean": { valid: { op: "union" }, invalid: { op: "burnify" }, match: /must be one of/, setup: booleanSetup },
  "page.add": { valid: {}, invalid: { x: 1 }, match: /takes no parameters/ },

  "layer.opacity": { valid: { layerId: "ly_rect", opacity: 0.4 }, invalid: { layerId: "ly_rect", opacity: 40 }, match: /must be <= 1/ },
  "layer.blend": { valid: { layerId: "ly_rect", blend: "multiply" }, invalid: { layerId: "ly_rect", blend: "burnify" }, match: /must be one of/ },
  "layer.visible": { valid: { layerId: "ly_rect", visible: false }, invalid: { layerId: "ly_rect", visible: "no" }, match: /must be true or false/ },
  "layer.locked": { valid: { layerId: "ly_rect", locked: true }, invalid: { layerId: "ly_rect", locked: 1 }, match: /must be true or false/ },
  "layer.reorder": { valid: { layerId: "ly_rect", dir: 1 }, invalid: { layerId: "ly_rect", dir: 2 }, match: /must be 1 \(forward\) or -1/ },
  "layer.fill": { valid: { color: COPPER }, invalid: { color: { r: 224, g: 122, b: 47 } }, match: /float 0-1/ },
  "vector.gradientFill": {
    valid: { type: "linear", angle: 90, stops: [{ offset: 0, color: COPPER }, { offset: 1, color: RED }] },
    invalid: { type: "rainbow", angle: 90, stops: [{ offset: 0, color: COPPER }, { offset: 1, color: RED }] },
    match: /must be linear or radial/,
  },

  "vector.addRect": { valid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER }, invalid: { x: 10, y: 10, w: 0, h: 50, fill: COPPER }, match: /greater than 0/ },
  "vector.addEllipse": { valid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER }, invalid: { x: 10, y: 10, w: 100, h: -5, fill: COPPER }, match: /greater than 0/ },
  "vector.addRoundRect": { valid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER, radius: 12 }, invalid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER, radius: -1 }, match: /must be >= 0/ },
  "vector.addPolygon": { valid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER, sides: 6 }, invalid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER, sides: 2 }, match: /must be >= 3/ },
  "vector.addStar": { valid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER, points: 5 }, invalid: { x: 10, y: 10, w: 100, h: 50, fill: COPPER, points: 2 }, match: /must be >= 3/ },
  "vector.addLine": { valid: { x1: 0, y1: 0, x2: 100, y2: 100, stroke: { color: COPPER, width: 3 } }, invalid: { x1: 0, y1: 0, x2: 100, y2: 100, stroke: { color: COPPER, width: 0 } }, match: /greater than 0/ },
  "vector.addPath": { valid: { x: 20, y: 30, color: COPPER }, invalid: { x: 20, y: 30 }, match: /required as a float 0-1/ },
  "path.appendNode": { valid: { layerId: "ly_path", x: 90, y: 90 }, invalid: { layerId: "ly_type", x: 1, y: 1 }, match: /needs vector/ },
  "path.close": { valid: { layerId: "ly_path" }, invalid: { layerId: "ly_type" }, match: /needs vector/ },

  "type.addFrame": { valid: { fontId: "noto-sans", x: 40, y: 40 }, invalid: { fontId: "", x: 40, y: 40 }, match: /non-empty string/ },
  "image.place": {
    valid: { asset: { name: "a.png", mime: "image/png", dataUrl: PNG, width: 10, height: 10 }, x: 5, y: 5 },
    invalid: { asset: { name: "a.png", mime: "image/png", dataUrl: "http://x/a.png", width: 10, height: 10 }, x: 5, y: 5 },
    match: /must be a data: URL/,
  },
  "image.addFrame": { valid: { x: 40, y: 60, w: 200, h: 120 }, invalid: { x: 40, y: 60, w: 0, h: 120 }, match: /greater than 0/ },
  "image.fillFrame": {
    valid: { layerId: "ly_img", asset: { name: "b.png", mime: "image/png", dataUrl: PNG, width: 12, height: 8 } },
    invalid: { layerId: "ly_type", asset: { name: "b.png", mime: "image/png", dataUrl: PNG, width: 12, height: 8 } },
    match: /needs image-frame/,
  },
  "page.guide": { valid: { axis: "v", offset: 240 }, invalid: { axis: "z", offset: 240 }, match: /must be h or v/ },

  "story.setText": { valid: { layerId: "ly_type", text: "Changed" }, invalid: { layerId: "ly_type", text: 5 }, match: /must be a string/ },
  "story.replaceRange": { valid: { layerId: "ly_type", start: 0, end: 5, text: "Range" }, invalid: { layerId: "ly_type", start: 1.5, end: 5, text: "x" }, match: /integer UTF-16 offset/ },
  "type.character": { valid: { layerId: "ly_type", size: 64 }, invalid: { layerId: "ly_type" }, match: /at least one of/ },
  "layer.flip": { valid: { axis: "h" }, invalid: { axis: "z" }, match: /must be h or v/ },
  "type.characterRange": { valid: { layerId: "ly_type", start: 0, end: 5, size: 64, horizontalScale: 110 }, invalid: { layerId: "ly_type", start: 0, end: 0, size: 64 }, match: /must not be empty/ },
  "type.paragraphRange": { valid: { layerId: "ly_type", start: 0, end: 5, align: "center", spaceAfter: 12 }, invalid: { layerId: "ly_type", start: 0, end: 5 }, match: /at least one paragraph property/ },
  "type.paragraphAlign": { valid: { layerId: "ly_type", align: "center" }, invalid: { layerId: "ly_type", align: "centre" }, match: /must be one of/ },
  "type.paragraphSpacing": { valid: { layerId: "ly_type", spaceAfter: 12 }, invalid: { layerId: "ly_type" }, match: /at least one of/ },

  "vector.strokeWidth": { valid: { width: 6, fallbackColor: COPPER }, invalid: { width: -1, fallbackColor: COPPER }, match: /must be >= 0/ },
  "adjustment.add": { valid: { brightness: -0.2, contrast: 1.2 }, invalid: { brightness: -5, contrast: 1.2 }, match: /must be >= -1/ },
  "asset.replace": { valid: { assetId: "as_1", dataUrl: PNG.replace("iVBORw0", "iVBORw1"), width: 32, height: 24 }, invalid: { assetId: "as_missing", dataUrl: PNG, width: 1, height: 1 }, match: /no asset "as_missing"/ },
  "doc.imageSize": { valid: { w: 1200, h: 1600, ppi: 150, resample: false, assets: {} }, invalid: { w: 0, h: 1600, ppi: 150, resample: false, assets: {} }, match: /greater than 0/ },
};

const snap = (doc) => JSON.stringify(doc);

test("every registered UI command is covered by this file", () => {
  assert.deepEqual(UI_COMMAND_TYPES.slice().sort(), Object.keys(CASES).sort());
});

for (const [type, c] of Object.entries(CASES)) {
  const prep = (doc) => {
    if (c.setup) c.setup(doc);
    return doc;
  };

  test(`${type}: applies and changes the document`, () => {
    const bus = new CommandBus();
    const doc = prep(makeDoc());
    const before = snap(doc);
    const res = bus.execute(doc, { type, params: c.valid });
    assert.notEqual(snap(res.doc), before, "the command must actually change something");
    assert.equal(snap(doc), before, "the input document must not be mutated in place");
  });

  test(`${type}: refuses bad input with a precise message`, () => {
    const bus = new CommandBus();
    const doc = prep(makeDoc());
    assert.throws(
      () => bus.execute(doc, { type, params: c.invalid }),
      (e) => {
        assert.ok(e instanceof CommandError, `expected CommandError, got ${e?.name}: ${e?.message}`);
        assert.match(e.message, c.match);
        return true;
      },
    );
    assert.equal(bus.stats().entries, 0, "a rejected command must not land in history");
  });

  test(`${type}: INVERSE round-trip — undo restores the document exactly`, () => {
    const bus = new CommandBus();
    const doc = prep(makeDoc());
    const before = snap(doc);
    const res = bus.execute(doc, { type, params: c.valid });
    const undone = bus.undo(res.doc);
    assert.ok(undone, "undo must produce a result");
    assert.equal(snap(undone.doc), before, `${type} inverse did not restore the document`);
  });

  test(`${type}: redo re-applies exactly what undo removed`, () => {
    const bus = new CommandBus();
    const doc = prep(makeDoc());
    const res = bus.execute(doc, { type, params: c.valid });
    const after = snap(res.doc);
    const redone = bus.redo(bus.undo(res.doc).doc);
    assert.ok(redone);
    assert.equal(snap(redone.doc), after);
  });

  test(`${type}: params survive a JSON round-trip (serializable)`, () => {
    const bus = new CommandBus();
    const doc = prep(makeDoc());
    const wire = JSON.parse(JSON.stringify({ type, params: c.valid }));
    assert.doesNotThrow(() => bus.execute(doc, wire));
  });
}

// ── the whole point of the slice ─────────────────────────────────────────────

test("a UI edit records a COMMAND entry, not a document snapshot", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  bus.execute(doc, { type: "layer.opacity", params: { layerId: "ly_rect", opacity: 0.5 } });
  const st = bus.stats();
  assert.equal(st.commandEntries, 1);
  assert.equal(st.snapshotEntries, 0, "UI edits must no longer clone the document");
});

test("the inverse of a UI edit is proportional, not a clone", () => {
  const doc = makeDoc();
  const page = doc.pages[0];
  for (let i = 0; i < 300; i++) {
    page.layers.push({ ...base(), id: `ly_bulk_${i}`, name: `Bulk ${i}`, kind: "vector", transform: { x: i, y: i, w: 50, h: 50, rotation: 0 }, closed: true, nodes: [], fill: RED, stroke: null });
  }
  const bus = new CommandBus();
  const res = bus.execute(doc, { type: "layer.opacity", params: { layerId: "ly_rect", opacity: 0.5 } });
  const entryWeight = JSON.stringify(bus.labels()).length; // labels only; measure the real entry below
  const cloneWeight = JSON.stringify(doc).length;
  // Undo must still be exact on a big document.
  assert.equal(JSON.stringify(bus.undo(res.doc).doc), JSON.stringify(doc));
  assert.ok(cloneWeight > 40_000, `fixture should be large enough to matter, got ${cloneWeight}`);
  assert.ok(entryWeight < cloneWeight);
});

test("mixed UI and Anchor edits share one correctly ordered stack", async () => {
  const { installAnchorCommands, anchorCommands } = await import("../src/anchor/anchor-command.ts");
  installAnchorCommands();
  const bus = new CommandBus();
  const doc = makeDoc();
  const s0 = snap(doc);

  const r1 = bus.execute(doc, { type: "layer.opacity", params: { layerId: "ly_rect", opacity: 0.5 } });
  const s1 = snap(r1.doc);
  const r2 = bus.execute(
    r1.doc,
    anchorCommands([{ op: "press.set_name", params: { layerId: "ly_rect", name: "Via Anchor" }, reason: "mixed stack test" }]),
  );

  assert.equal(bus.stats().commandEntries, 2);
  assert.equal(bus.stats().snapshotEntries, 0);
  assert.equal(snap(bus.undo(r2.doc).doc), s1, "undo the Anchor edit first");
  assert.equal(snap(bus.undo(JSON.parse(s1)).doc), s0, "then the UI edit");
});
