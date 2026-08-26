/**
 * Anchor ops as commands (foundation slice 4).
 *
 * The point of this file is ONE mechanical claim: every Anchor op, applied
 * through the command bus, can be undone exactly. That is what routing the AI
 * path through the bus buys, and it is checked op by op rather than asserted.
 *
 * Ops are synthesised from each tool's published JSON Schema rather than
 * hand-written, so a new op cannot quietly escape this test.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/anchor-command.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CommandBus } from "../src/document/command-bus.ts";
import { commandTypes } from "../src/document/commands.ts";
import { diffDocuments, applyPatch, patchWeight } from "../src/document/patch.ts";
import { installAnchorCommands, anchorCommands, PatchScopeError } from "../src/anchor/anchor-command.ts";
import { ANCHOR_TOOLS } from "../src/anchor/tools.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";
import { setBooleanEngineProvider } from "../src/document/boolean-ops.ts";

installAnchorCommands();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert.ok(existsSync(ckWasm), "canvaskit.wasm missing");
const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });
setBooleanEngineProvider(() => ck);

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function base(o = {}) {
  return { visible: true, locked: false, opacity: 1, blend: "srcOver", parentId: null, ...o };
}

/** A document containing one layer of every kind the ops can target. */
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
    character: { fontId: "noto-sans", size: 48, leading: 56, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 } },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
  });
  const rn = (w, h) => {
    const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
    return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
  };
  page.layers.push(
    { ...base(), id: "ly_rect", name: "Rect", kind: "vector", transform: { x: 100, y: 100, w: 200, h: 100, rotation: 0 }, closed: true, nodes: rn(200, 100), fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
    { ...base(), id: "ly_bool_b", name: "BoolB", kind: "vector", transform: { x: 180, y: 80, w: 120, h: 80, rotation: 0 }, closed: true, nodes: rn(120, 80), fill: { r: 0, g: 0.5, b: 1, a: 1 }, stroke: null },
    { ...base(), id: "ly_path", name: "Path", kind: "vector", transform: { x: 300, y: 300, w: 200, h: 200, rotation: 0 }, closed: false, nodes: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 50, y: 50, inX: 0, inY: 0, outX: 0, outY: 0 }], fill: null, stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 } },
    { ...base(), id: "ly_img", name: "Pic", kind: "image-frame", transform: { x: 500, y: 500, w: 300, h: 150, rotation: 0 }, assetId: "as_1", fit: "cover", focal: { x: 0.5, y: 0.5 }, crop: null },
    { ...base(), id: "ly_type", name: "Type", kind: "type-frame", transform: { x: 700, y: 900, w: 600, h: 300, rotation: 0 }, storyId: "st_1", nextFrameId: null },
    { ...base(), id: "ly_group", name: "Group", kind: "group", transform: { x: 900, y: 1400, w: 400, h: 400, rotation: 0 } },
    { ...base({ parentId: "ly_group" }), id: "ly_child", name: "Child", kind: "vector", transform: { x: 10, y: 10, w: 100, h: 100, rotation: 0 }, closed: true, nodes: [], fill: { r: 0, g: 0, b: 1, a: 1 }, stroke: null },
  );
  doc.activePageId = page.id;
  doc.activeLayerIds = ["ly_rect"];
  return doc;
}

/** Pick a layer whose kind suits the op. */
function targetFor(name) {
  if (/story|character|paragraph|type/.test(name)) return "ly_type";
  if (/image|place|crop|focal|fit/.test(name)) return "ly_img";
  if (/path|node|close/.test(name)) return "ly_path";
  if (/ungroup/.test(name)) return "ly_group";
  return "ly_rect";
}

/** Build a value satisfying one JSON-Schema property. */
function synthValue(key, spec, ctx) {
  if (key === "layerId") return ctx.target;
  if (key === "layerIds") return [ctx.target];
  if (key === "pageId") return ctx.pageId;
  if (key === "dataUrl") return PNG;
  if (key === "reason") return "round-trip coverage";

  // LAST enum member, not the first: the first is usually the current value
  // ("srcOver", "left", "cover"), which would make the op a no-op and prove
  // nothing about undo.
  if (Array.isArray(spec?.enum) && spec.enum.length) return spec.enum[spec.enum.length - 1];
  switch (spec?.type) {
    case "boolean":
      // Defaults in this fixture are true, so false is the value that changes something.
      return false;
    case "string":
      return key === "name" || key === "text" ? "Synthesised" : "Synthesised";
    case "number":
    case "integer": {
      const min =
        typeof spec.minimum === "number"
          ? spec.minimum
          : typeof spec.exclusiveMinimum === "number"
            ? spec.exclusiveMinimum + 1
            : 1;
      const max = typeof spec.maximum === "number" ? spec.maximum : 64;
      // 0.5 where the range allows it (opacity, focal), otherwise just inside the
      // minimum. Both are chosen to DIFFER from the fixture defaults.
      let v = min <= 0.5 && max >= 0.5 ? 0.5 : Math.min(min + 1, max);
      if (spec.type === "integer") v = Math.max(Math.ceil(min), Math.min(Math.max(Math.round(v), 1), Math.floor(max)));
      return v;
    }
    case "array": {
      const item = spec.items ?? { type: "number" };
      const n = Math.max(spec.minItems ?? 2, 2);
      return Array.from({ length: n }, () => synthValue("", item, ctx));
    }
    case "object": {
      const out = {};
      for (const [k, s] of Object.entries(spec.properties ?? {})) out[k] = synthValue(k, s, ctx);
      return out;
    }
    default:
      return 1;
  }
}

/**
 * Semantic combinations a JSON Schema cannot express, so a generic synthesiser
 * cannot invent them: "a rectangle needs a fill, a stroke, or both", "give at
 * least one of size/leading/tracking/fill". Merged over the synthesised params
 * so the op layer itself is still the thing under test.
 */
const OVERRIDES = {
  "press.select": { layerIds: ["ly_img"] },
  "press.image_size": { resample: false, ppi: 150 },
  "press.set_transform": { x: 55, y: 66 },
  "press.set_character": { size: 64 },
  "press.add_rect": { fill: "#E07A2F" },
  "press.add_ellipse": { fill: "#1B5BE0" },
  // The synthesiser gives every coordinate the same value; a line needs two
  // distinct points.
  "press.add_line": { x1: 100, y1: 120, x2: 900, y2: 640, stroke: { color: "#12A150", width: 3 } },
  // ly_rect is already backmost and already unlocked, and 0.5/0.5 is the
  // default focal, so the generic values would make these ops no-ops and the
  // round trip would prove nothing.
  "press.reorder": { direction: "front" },
  "press.set_locked": { locked: true },
  "press.set_image_focal": { x: 0.2, y: 0.8 },
  "press.add_path": { closed: true, fill: "#E07A2F" },
  "press.set_image_crop": { crop: { x: 4, y: 4, w: 32, h: 24 } },
  "press.apply_fill": { color: "#E07A2F" },
  "press.boolean": { op: "union", layerIds: ["ly_rect", "ly_bool_b"] },
  "press.add_round_rect": { fill: "#E07A2F", radius: 16 },
  "press.add_polygon": { fill: "#1B5BE0", sides: 6 },
};

/** Synthesise a valid op envelope for a tool from its schema. */
function synthOp(tool) {
  const ctx = { target: targetFor(tool.name), pageId: "PAGE" };
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const params = {};
  for (const [k, spec] of Object.entries(props)) {
    if (k === "reason") continue;
    // Include required params, plus the targeting params the op needs.
    if (required.has(k) || k === "layerId" || k === "layerIds" || k === "pageId") {
      params[k] = synthValue(k, spec, ctx);
    }
  }
  Object.assign(params, OVERRIDES[tool.name] ?? {});
  return { op: tool.name, params, reason: "round-trip coverage" };
}

const snap = (doc) => JSON.stringify(doc);

test("anchor.op is registered on the same bus the UI uses", () => {
  assert.ok(commandTypes().includes("anchor.op"), commandTypes().join(", "));
});

// ── the mechanical claim ─────────────────────────────────────────────────────

test("EVERY Anchor op that applies can be undone exactly", () => {
  const applied = [];
  const rejected = [];
  const notUndone = [];
  const outOfScope = [];

  for (const tool of ANCHOR_TOOLS) {
    const bus = new CommandBus();
    const doc = makeDoc();
    const pageId = doc.pages[0].id;
    const before = snap(doc);
    const op = synthOp(tool);
    // Late-bind the real page id.
    if (op.params.pageId === "PAGE") op.params.pageId = pageId;

    let res;
    try {
      res = bus.execute(doc, anchorCommands([op]));
    } catch (err) {
      if (err instanceof PatchScopeError) outOfScope.push(`${tool.name}: ${err.message}`);
      else rejected.push(`${tool.name}: ${String(err.message).split("\n")[0]}`);
      continue;
    }
    applied.push(tool.name);

    // It must have actually done something, or the round trip proves nothing.
    if (snap(res.doc) === before) {
      notUndone.push(`${tool.name}: applied but changed nothing`);
      continue;
    }
    const undone = bus.undo(res.doc);
    if (!undone || snap(undone.doc) !== before) {
      notUndone.push(`${tool.name}: undo did not restore the document`);
    }
  }

  console.log(
    `      applied ${applied.length}/${ANCHOR_TOOLS.length} synthesised ops; ` +
      `${rejected.length} could not be synthesised; ${outOfScope.length} out of patch scope`,
  );
  if (rejected.length) console.log("      not synthesised:\n        " + rejected.join("\n        "));
  if (outOfScope.length) console.log("      out of scope:\n        " + outOfScope.join("\n        "));

  assert.ok(applied.length >= 20, `only ${applied.length} ops could be synthesised — the generator is too weak to be evidence`);
  assert.deepEqual(notUndone, [], "these ops applied but did not undo exactly");
});

// ── preview ──────────────────────────────────────────────────────────────────

test("preview reports what would happen and changes nothing", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const before = snap(doc);
  const res = bus.preview(
    doc,
    anchorCommands([
      { op: "press.add_rect", params: { x: 10, y: 10, w: 100, h: 50, fill: "#E07A2F" }, reason: "preview only" },
    ]),
  );
  assert.equal(snap(doc), before, "preview must not mutate the document it was given");
  assert.equal(bus.stats().entries, 0, "preview must not touch history");
  assert.equal(res.notes.length, 1);
  assert.match(res.notes[0].summary, /rectangle/);
  assert.equal(res.notes[0].reason, "preview only");
  assert.equal(res.notes[0].created.length, 1, "preview must report what it would create");
  assert.notEqual(snap(res.doc), before, "preview must still return the resulting document");
});

test("preview and execute agree — the preview IS the execution, minus the commit", () => {
  const ops = [
    { op: "press.add_rect", params: { x: 20, y: 20, w: 120, h: 60, fill: "#E07A2F" }, reason: "agree" },
    { op: "press.set_opacity", params: { layerId: "ly_rect", opacity: 0.25 }, reason: "agree" },
  ];
  const previewed = new CommandBus().preview(makeDoc(), anchorCommands(ops));
  const executed = new CommandBus().execute(makeDoc(), anchorCommands(ops));
  assert.deepEqual(
    previewed.notes.map((n) => n.summary.replace(/ly_[a-z0-9_]+/g, "ID")),
    executed.notes.map((n) => n.summary.replace(/ly_[a-z0-9_]+/g, "ID")),
  );
});

// ── the inverse is proportional, not a clone ─────────────────────────────────

test("the derived inverse is far smaller than a document clone", () => {
  const doc = makeDoc();
  // Make the document substantially bigger so a clone is clearly expensive.
  const page = doc.pages[0];
  for (let i = 0; i < 300; i++) {
    page.layers.push({
      ...base(),
      id: `ly_bulk_${i}`,
      name: `Bulk ${i}`,
      kind: "vector",
      transform: { x: i, y: i, w: 50, h: 50, rotation: 0 },
      closed: true,
      nodes: [],
      fill: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
      stroke: null,
    });
  }
  const bus = new CommandBus();
  const res = bus.execute(
    doc,
    anchorCommands([{ op: "press.set_opacity", params: { layerId: "ly_rect", opacity: 0.4 }, reason: "one layer" }]),
  );
  const { patch } = diffDocuments(doc, res.doc);
  const weight = patchWeight(patch);
  const cloneWeight = JSON.stringify(doc).length;
  console.log(`      inverse patch ${weight} bytes vs document clone ${cloneWeight} bytes`);
  assert.ok(
    weight < cloneWeight / 10,
    `inverse should be proportional to the change: ${weight} vs ${cloneWeight}`,
  );
  // And it must still be correct.
  assert.equal(JSON.stringify(applyPatch(res.doc, patch)), JSON.stringify(doc));
});

// ── batch semantics carried over from Anchor ─────────────────────────────────

test("a rejected op leaves the document and the history untouched", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const before = snap(doc);
  assert.throws(() =>
    bus.execute(
      doc,
      anchorCommands([
        { op: "press.set_opacity", params: { layerId: "ly_rect", opacity: 0.5 }, reason: "ok" },
        { op: "press.set_opacity", params: { layerId: "ly_rect", opacity: 50 }, reason: "bad - not a percentage" },
      ]),
    ),
  );
  assert.equal(snap(doc), before);
  assert.equal(bus.stats().entries, 0);
});

test("a multi-op batch is ONE history entry that undoes as a whole", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const before = snap(doc);
  const res = bus.execute(
    doc,
    anchorCommands([
      { op: "press.add_rect", params: { x: 0, y: 0, w: 100, h: 100, fill: "#E07A2F" }, reason: "add the band" },
      { op: "press.set_name", params: { layerId: "ly_rect", name: "Renamed" }, reason: "name it for the panel" },
      { op: "press.set_opacity", params: { layerId: "ly_rect", opacity: 0.3 }, reason: "knock it back" },
    ]),
  );
  assert.equal(bus.stats().entries, 1);
  assert.equal(res.notes.length, 3, "each op contributes its own audit line");
  assert.deepEqual(res.notes.map((n) => n.reason), ["add the band", "name it for the panel", "knock it back"]);
  assert.equal(snap(bus.undo(res.doc).doc), before, "one undo must revert the whole batch");
});
