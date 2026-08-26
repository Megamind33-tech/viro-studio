/**
 * Unit tests for the typed command bus (foundation slice 3).
 *
 * Covers every command and its inverse, atomicity, coalescing, transactions,
 * dirty regions, serializability, and correct ordering when command entries and
 * legacy snapshot entries are interleaved in one undo stack.
 *
 *   node --experimental-strip-types --test tests/command-bus.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CommandBus } from "../src/document/command-bus.ts";
import { CommandError, COMMAND_TYPES, getCommandDef } from "../src/document/commands.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";

const RECT = "ly_rect";
const IMG = "ly_img";
const LOCKED = "ly_locked";
const GROUP = "ly_group";
const CHILD = "ly_child";

function base(o = {}) {
  return {
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    parentId: null,
    ...o,
  };
}

/** A real document from the real preset path, with layers of each relevant kind. */
function makeDoc() {
  const doc = documentFromPreset(PRESETS[0]);
  const page = doc.pages[0];
  page.layers.length = 0;
  doc.assets["as_1"] = { id: "as_1", name: "probe.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 100, height: 200 };
  page.layers.push(
    { ...base(), id: RECT, name: "Rect", kind: "vector", transform: { x: 100, y: 100, w: 200, h: 100, rotation: 0 }, closed: true, nodes: [], fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
    { ...base(), id: IMG, name: "Pic", kind: "image-frame", transform: { x: 400, y: 400, w: 300, h: 150, rotation: 0 }, assetId: "as_1", fit: "cover", focal: { x: 0.5, y: 0.5 }, crop: null },
    { ...base({ locked: true }), id: LOCKED, name: "Locked", kind: "image-frame", transform: { x: 0, y: 0, w: 50, h: 50, rotation: 0 }, assetId: "as_1", fit: "cover", focal: { x: 0.5, y: 0.5 }, crop: null },
    { ...base(), id: GROUP, name: "Group", kind: "group", transform: { x: 800, y: 800, w: 400, h: 400, rotation: 0 } },
    { ...base({ parentId: GROUP }), id: CHILD, name: "Child", kind: "vector", transform: { x: 10, y: 10, w: 100, h: 100, rotation: 0 }, closed: true, nodes: [], fill: { r: 0, g: 0, b: 1, a: 1 }, stroke: null },
  );
  doc.activePageId = page.id;
  return doc;
}

const snap = (doc) => JSON.stringify(doc);

/** Every command, with a valid params object and an invalid one. */
const CASES = {
  "layer.transform": {
    valid: { layerId: RECT, patch: { x: 555, y: 666, rotation: 30 } },
    invalid: { layerId: RECT, patch: { w: 0 } },
    invalidMatch: /must be greater than 0/,
  },
  "image.fit": {
    valid: { layerId: IMG, fit: "contain" },
    invalid: { layerId: IMG, fit: "crop" },
    invalidMatch: /must be one of cover \| contain \| stretch/,
  },
  "image.focal": {
    valid: { layerId: IMG, x: 0.2, y: 0.8 },
    invalid: { layerId: IMG, x: 1.5, y: 0.5 },
    invalidMatch: /must be <= 1/,
  },
  "image.crop": {
    valid: { layerId: IMG, crop: { x: 5, y: 5, w: 40, h: 60 } },
    invalid: { layerId: IMG, crop: { x: 5, y: 5, w: -40, h: 60 } },
    invalidMatch: /must be greater than 0/,
  },
};

/**
 * Commands that are not user-facing actions and so are not in the matrix above.
 * doc.restore is the generic inverse primitive; it is covered by the patch
 * round-trip tests in tests/anchor-command.test.mjs.
 */
const INTERNAL = ["doc.restore"];

test("the registry and the test matrix cover the same commands", () => {
  assert.deepEqual(COMMAND_TYPES.slice().sort(), [...Object.keys(CASES), ...INTERNAL].sort());
});

for (const [type, c] of Object.entries(CASES)) {
  test(`${type}: a valid command mutates the document`, () => {
    const bus = new CommandBus();
    const doc = makeDoc();
    const before = snap(doc);
    const res = bus.execute(doc, { type, params: c.valid });
    assert.notEqual(snap(res.doc), before, "the command must actually change something");
    assert.equal(snap(doc), before, "the input document must not be mutated in place");
  });

  test(`${type}: an invalid command is rejected with a precise message`, () => {
    const bus = new CommandBus();
    const doc = makeDoc();
    assert.throws(() => bus.execute(doc, { type, params: c.invalid }), (e) => {
      assert.ok(e instanceof CommandError, `expected CommandError, got ${e?.name}`);
      assert.match(e.message, c.invalidMatch);
      return true;
    });
    assert.equal(bus.stats().entries, 0, "a rejected command must not land in history");
  });

  test(`${type}: INVERSE round-trip — execute then undo restores the document exactly`, () => {
    const bus = new CommandBus();
    const doc = makeDoc();
    const before = snap(doc);
    const res = bus.execute(doc, { type, params: c.valid });
    const undone = bus.undo(res.doc);
    assert.ok(undone, "undo must produce a result");
    assert.equal(snap(undone.doc), before, `${type} inverse did not restore the document`);
  });

  test(`${type}: redo re-applies exactly what undo removed`, () => {
    const bus = new CommandBus();
    const doc = makeDoc();
    const res = bus.execute(doc, { type, params: c.valid });
    const after = snap(res.doc);
    const undone = bus.undo(res.doc);
    const redone = bus.redo(undone.doc);
    assert.ok(redone);
    assert.equal(snap(redone.doc), after);
  });

  test(`${type}: params survive a JSON round-trip (serializable)`, () => {
    const bus = new CommandBus();
    const doc = makeDoc();
    const wire = JSON.parse(JSON.stringify({ type, params: c.valid }));
    const res = bus.execute(doc, wire);
    assert.ok(res.affected.length > 0);
  });
}

// ── the silent-no-op holes ops.ts leaves open ────────────────────────────────

test("a missing layer is refused, not silently ignored", () => {
  const bus = new CommandBus();
  assert.throws(
    () => bus.execute(makeDoc(), { type: "layer.transform", params: { layerId: "ly_nope", patch: { x: 1 } } }),
    /no layer "ly_nope"/,
  );
});

test("a locked layer is refused, not silently ignored", () => {
  const bus = new CommandBus();
  assert.throws(
    () => bus.execute(makeDoc(), { type: "image.fit", params: { layerId: LOCKED, fit: "contain" } }),
    /is locked/,
  );
});

test("the wrong layer kind is refused, not silently ignored", () => {
  const bus = new CommandBus();
  assert.throws(
    () => bus.execute(makeDoc(), { type: "image.fit", params: { layerId: RECT, fit: "contain" } }),
    /is a vector layer; this command needs image-frame/,
  );
});

test("an unknown command names the ones that exist", () => {
  const bus = new CommandBus();
  assert.throws(() => bus.execute(makeDoc(), { type: "layer.explode", params: {} }), /unknown command "layer.explode"/);
});

test("an unknown patch field is refused rather than quietly dropped", () => {
  const bus = new CommandBus();
  assert.throws(
    () => bus.execute(makeDoc(), { type: "layer.transform", params: { layerId: RECT, patch: { z: 5 } } }),
    /unknown patch field\(s\) "z"/,
  );
});

// ── atomicity ────────────────────────────────────────────────────────────────

test("a batch is atomic — one bad command discards the whole batch", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const before = snap(doc);
  assert.throws(() =>
    bus.execute(doc, [
      { type: "layer.transform", params: { layerId: RECT, patch: { x: 900 } } },
      { type: "image.fit", params: { layerId: IMG, fit: "contain" } },
      { type: "image.focal", params: { layerId: IMG, x: 99, y: 0 } }, // bad
    ]),
  );
  assert.equal(snap(doc), before, "the caller's document must be untouched");
  assert.equal(bus.stats().entries, 0, "nothing may land in history");
});

test("a valid batch undoes as ONE entry, in reverse order", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const before = snap(doc);
  const res = bus.execute(doc, [
    { type: "layer.transform", params: { layerId: RECT, patch: { x: 900 } } },
    { type: "image.fit", params: { layerId: IMG, fit: "contain" } },
  ]);
  assert.equal(bus.stats().entries, 1);
  const undone = bus.undo(res.doc);
  assert.equal(snap(undone.doc), before);
});

// ── transactions ─────────────────────────────────────────────────────────────

test("a transaction collapses many commands into one history entry", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const before = snap(doc);
  const res = bus.transaction(doc, "Reframe", (run) => {
    run({ type: "layer.transform", params: { layerId: IMG, patch: { x: 10, y: 20 } } });
    run({ type: "image.fit", params: { layerId: IMG, fit: "stretch" } });
    run({ type: "image.focal", params: { layerId: IMG, x: 0.1, y: 0.9 } });
  });
  assert.equal(res.label, "Reframe");
  assert.equal(bus.stats().entries, 1);
  assert.equal(snap(bus.undo(res.doc).doc), before, "one undo must revert the whole transaction");
});

test("an empty transaction is an error, not a silent no-op entry", () => {
  const bus = new CommandBus();
  assert.throws(() => bus.transaction(makeDoc(), "Nothing", () => {}), /no commands were run/);
});

// ── coalescing ───────────────────────────────────────────────────────────────

test("COALESCING: a drag of many commands is ONE history entry that undoes to the start", () => {
  const bus = new CommandBus();
  let doc = makeDoc();
  const before = snap(doc);
  for (let i = 1; i <= 50; i++) {
    doc = bus.execute(doc, {
      type: "layer.transform",
      params: { layerId: RECT, patch: { x: 100 + i * 4, y: 100 + i * 2 }, session: "drag-1" },
    }).doc;
  }
  assert.equal(bus.stats().entries, 1, "50 pointer events must not be 50 undo entries");
  const layer = doc.pages[0].layers.find((l) => l.id === RECT);
  assert.equal(layer.transform.x, 300, "the last position must win");
  assert.equal(snap(bus.undo(doc).doc), before, "undo must return to where the drag STARTED");
});

test("two different drag sessions stay two history entries", () => {
  const bus = new CommandBus();
  let doc = makeDoc();
  doc = bus.execute(doc, { type: "layer.transform", params: { layerId: RECT, patch: { x: 150 }, session: "a" } }).doc;
  doc = bus.execute(doc, { type: "layer.transform", params: { layerId: RECT, patch: { x: 250 }, session: "b" } }).doc;
  assert.equal(bus.stats().entries, 2);
});

test("without a session, nothing coalesces", () => {
  const bus = new CommandBus();
  let doc = makeDoc();
  doc = bus.execute(doc, { type: "layer.transform", params: { layerId: RECT, patch: { x: 150 } } }).doc;
  doc = bus.execute(doc, { type: "layer.transform", params: { layerId: RECT, patch: { x: 250 } } }).doc;
  assert.equal(bus.stats().entries, 2);
});

test("a drag on a DIFFERENT layer in the same session does not merge", () => {
  const bus = new CommandBus();
  let doc = makeDoc();
  doc = bus.execute(doc, { type: "layer.transform", params: { layerId: RECT, patch: { x: 150 }, session: "s" } }).doc;
  doc = bus.execute(doc, { type: "layer.transform", params: { layerId: IMG, patch: { x: 150 }, session: "s" } }).doc;
  assert.equal(bus.stats().entries, 2);
});

// ── dirty regions ────────────────────────────────────────────────────────────

test("DIRTY REGION covers both where the layer was and where it went", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  // Rect starts at (100,100) 200x100; move it to (1000,1000).
  const res = bus.execute(doc, { type: "layer.transform", params: { layerId: RECT, patch: { x: 1000, y: 1000 } } });
  const d = res.dirty;
  assert.ok(d, "a move must report a dirty region");
  assert.ok(d.x <= 100 && d.y <= 100, `dirty must include the old position, got ${JSON.stringify(d)}`);
  assert.ok(d.x + d.w >= 1200 && d.y + d.h >= 1100, `dirty must include the new position, got ${JSON.stringify(d)}`);
});

test("DIRTY REGION for a group includes its children", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const res = bus.execute(doc, { type: "layer.transform", params: { layerId: GROUP, patch: { x: 1600 } } });
  assert.ok(res.affected.includes(GROUP));
  // The child sits at group-local (10,10) 100x100; moving the group must dirty
  // the child's old world box around x=810 and its new one around x=1610.
  const d = res.dirty;
  assert.ok(d.x <= 810 && d.x + d.w >= 1710, `group dirty must span child old+new, got ${JSON.stringify(d)}`);
});

test("a command that changes nothing visible still reports its affected layer", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const res = bus.execute(doc, { type: "image.focal", params: { layerId: IMG, x: 0.5, y: 0.5 } });
  assert.deepEqual(res.affected, [IMG]);
});

// ── mixed stack: the migration guarantee ─────────────────────────────────────

test("MIXED STACK: snapshot and command entries undo in the correct order", () => {
  const bus = new CommandBus();
  const doc0 = makeDoc();
  const s0 = snap(doc0);

  // 1. a legacy commit()-style mutation
  bus.pushSnapshot("Legacy edit", doc0);
  const doc1 = JSON.parse(s0);
  doc1.pages[0].layers.find((l) => l.id === RECT).name = "Renamed by legacy path";
  const s1 = snap(doc1);

  // 2. a typed command
  const res = bus.execute(doc1, { type: "image.fit", params: { layerId: IMG, fit: "stretch" } });

  assert.equal(bus.stats().entries, 2);
  assert.equal(bus.stats().snapshotEntries, 1);
  assert.equal(bus.stats().commandEntries, 1);

  // Undo the command first: back to state 1, legacy rename still present.
  const u1 = bus.undo(res.doc);
  assert.equal(snap(u1.doc), s1, "undoing the command must land on the legacy state");
  assert.equal(u1.doc.pages[0].layers.find((l) => l.id === RECT).name, "Renamed by legacy path");

  // Then undo the snapshot: back to the original.
  const u2 = bus.undo(u1.doc);
  assert.equal(snap(u2.doc), s0, "undoing the snapshot must land on the original");
  assert.equal(bus.canUndo, false);
});

test("undo on an empty stack returns null rather than throwing", () => {
  const bus = new CommandBus();
  assert.equal(bus.undo(makeDoc()), null);
  assert.equal(bus.redo(makeDoc()), null);
});

test("a new command clears the redo stack", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  const r1 = bus.execute(doc, { type: "image.fit", params: { layerId: IMG, fit: "contain" } });
  const u = bus.undo(r1.doc);
  assert.equal(bus.canRedo, true);
  bus.execute(u.doc, { type: "image.fit", params: { layerId: IMG, fit: "stretch" } });
  assert.equal(bus.canRedo, false);
});

test("labels() is most-recent-first for the History panel", () => {
  const bus = new CommandBus();
  let doc = makeDoc();
  doc = bus.execute(doc, { type: "image.fit", params: { layerId: IMG, fit: "contain" } }).doc;
  doc = bus.execute(doc, { type: "image.focal", params: { layerId: IMG, x: 0, y: 0 } }).doc;
  assert.deepEqual(bus.labels(), ["Focal point", "Fit contain"]);
});

// ── inverse correctness under partial patches ────────────────────────────────

test("the inverse restores ONLY the fields the command wrote", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  // Write x only, then change rotation by another route, then undo.
  const res = bus.execute(doc, { type: "layer.transform", params: { layerId: RECT, patch: { x: 777 } } });
  const mid = JSON.parse(snap(res.doc));
  mid.pages[0].layers.find((l) => l.id === RECT).transform.rotation = 42;
  const undone = bus.undo(mid);
  const t = undone.doc.pages[0].layers.find((l) => l.id === RECT).transform;
  assert.equal(t.x, 100, "x must be restored");
  assert.equal(t.rotation, 42, "rotation must NOT be resurrected — this command never wrote it");
});

test("every registered command exposes the full CommandDef contract", () => {
  for (const type of COMMAND_TYPES) {
    const def = getCommandDef(type);
    for (const fn of ["label", "validate", "affects", "apply"]) {
      assert.equal(typeof def[fn], "function", `${type} is missing ${fn}()`);
    }
    // Exactly one inverse strategy: known up front, or derived after the fact.
    const hasInvert = typeof def.invert === "function";
    const hasInvertAfter = typeof def.invertAfter === "function";
    assert.ok(
      hasInvert !== hasInvertAfter,
      `${type} must define exactly one of invert()/invertAfter(), has ${hasInvert && hasInvertAfter ? "both" : "neither"}`,
    );
  }
});
