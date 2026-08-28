/**
 * Layer-integrity regression tests for the group edit ops (VIRO-0140).
 *
 * duplicating a group used to clone only the selected row (a childless shell
 * whose children stayed behind), and deleting a group removed only ONE level of
 * descendants, so PSD-imported trees of depth >= 2 left grandchildren with
 * dangling parentIds. These tests pin the structural contract: subtree-complete
 * duplicate, subtree-complete delete, exact undo/redo, and validateDocument
 * staying clean through every flow.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/layer-integrity-ops.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CommandBus } from "../src/document/command-bus.ts";
import { installUiCommands } from "../src/document/ui-commands.ts";
import { createDocument, makeStory, validateDocument } from "../src/document/factory.ts";
import { deleteSelected, duplicateSelected } from "../src/document/ops.ts";
import { worldBounds } from "../src/document/transform.ts";

installUiCommands();

const RED = { r: 1, g: 0, b: 0, a: 1 };

const rectNodes = (w, h) => {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
};

const base = (o = {}) => ({ visible: true, locked: false, opacity: 1, blend: "srcOver", parentId: null, ...o });

const vector = (id, parentId, x, y, w, h) => ({
  ...base({ parentId }),
  id,
  name: id,
  kind: "vector",
  transform: { x, y, w, h, rotation: 0 },
  closed: true,
  nodes: rectNodes(w, h),
  fill: RED,
  stroke: null,
});

const group = (id, parentId, x, y, w, h) => ({
  ...base({ parentId }),
  id,
  name: id,
  kind: "group",
  transform: { x, y, w, h, rotation: 0 },
});

const typeFrame = (id, parentId, storyId, x, y, w, h) => ({
  ...base({ parentId }),
  id,
  name: id,
  kind: "type-frame",
  transform: { x, y, w, h, rotation: 0 },
  storyId,
  nextFrameId: null,
  textFrame: {
    kind: "area",
    inset: { top: 0, right: 0, bottom: 0, left: 0 },
    columns: 1,
    columnGutter: 0,
    verticalAlign: "top",
    autoSize: "none",
  },
});

/**
 * A PSD-import-shaped tree: outer > inner > leaves, one leaf directly under
 * outer, plus a page-level layer outside the group. Depth 3.
 */
function makeDoc() {
  const doc = createDocument({
    name: "integrity",
    ppi: 72,
    widthPx: 800,
    heightPx: 600,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  doc.pages[0].layers.push(
    group("g_outer", null, 100, 80, 300, 260),
    group("g_inner", "g_outer", 20, 15, 240, 200),
    vector("v_a", "g_inner", 5, 5, 100, 80),
    vector("v_b", "g_inner", 120, 90, 110, 100),
    vector("v_c", "g_outer", 0, 210, 300, 50),
    vector("v_solo", null, 500, 100, 80, 80),
  );
  doc.activeLayerIds = [];
  return doc;
}

const byId = (doc, id) => doc.pages[0].layers.find((l) => l.id === id);
const childrenOf = (doc, parentId) => doc.pages[0].layers.filter((l) => l.parentId === parentId);
const noDanglingParents = (doc) => {
  const ids = new Set(doc.pages[0].layers.map((l) => l.id));
  return doc.pages[0].layers.every((l) => !l.parentId || ids.has(l.parentId));
};

// ── acceptance 1: duplicating a group copies the whole subtree ───────────────

test("duplicating a selected group copies the whole subtree with remapped parentIds", () => {
  const doc = makeDoc();
  doc.activeLayerIds = ["g_outer"];
  const next = duplicateSelected(doc);

  assert.deepEqual(validateDocument(next), [], "the duplicated document must validate clean");
  assert.equal(next.activeLayerIds.length, 1, "selection becomes exactly the group copy");

  const src = byId(doc, "g_outer");
  const copy = byId(next, next.activeLayerIds[0]);
  assert.notEqual(copy.id, src.id);
  assert.equal(copy.name, "g_outer copy");
  assert.equal(copy.parentId, null, "the copy is a page-level layer like the original");
  assert.equal(copy.transform.x, src.transform.x + 16, "the duplicate delta applies to the root");
  assert.equal(copy.transform.y, src.transform.y + 16);

  // Subtree shape: inner group + leaf under the copy, two leaves under inner.
  const copyInner = childrenOf(next, copy.id).find((l) => l.kind === "group");
  assert.ok(copyInner, "the copy contains the nested group");
  assert.notEqual(copyInner.id, "g_inner");
  assert.equal(childrenOf(next, copyInner.id).length, 2, "grandchildren travel with the copy");
  assert.equal(childrenOf(next, copy.id).length, 2, "inner group and v_c travel with the copy");
  assert.equal(
    childrenOf(next, copy.id).filter((l) => l.id === copyInner.id).length,
    1,
    "the copy is independent: it does not keep children of the ORIGINAL group",
  );

  // Descendants keep their LOCAL coordinates — offsetting them too would move
  // them twice once the root delta composes.
  const srcInner = byId(doc, "g_inner");
  assert.equal(copyInner.transform.x, srcInner.transform.x);
  assert.equal(copyInner.transform.y, srcInner.transform.y);
  const copyLeaf = childrenOf(next, copyInner.id).find((l) => l.name === "v_a");
  assert.deepEqual(copyLeaf.transform, byId(doc, "v_a").transform);

  // The original tree is untouched and still complete.
  assert.equal(childrenOf(doc, "g_outer").length, 2, "the original group keeps its children");
  assert.equal(childrenOf(doc, "g_inner").length, 2);
});

test("the duplicated group renders identically, offset by the duplicate delta", () => {
  const doc = makeDoc();
  doc.activeLayerIds = ["g_outer"];
  const next = duplicateSelected(doc);
  const page = next.pages[0];

  const copy = byId(next, next.activeLayerIds[0]);
  const copyInner = childrenOf(next, copy.id).find((l) => l.kind === "group");
  const copyA = childrenOf(next, copyInner.id).find((l) => l.name === "v_a");
  const copyC = childrenOf(next, copy.id).find((l) => l.name === "v_c");

  // World-space bounds of every copied subtree member are the original's bounds
  // shifted by exactly (+16, +16) — what the renderer must paint.
  for (const [orig, copyL] of [
    [byId(doc, "g_outer"), copy],
    [byId(doc, "g_inner"), copyInner],
    [byId(doc, "v_a"), copyA],
    [byId(doc, "v_c"), copyC],
  ]) {
    const b0 = worldBounds(doc.pages[0], orig);
    const b1 = worldBounds(page, copyL);
    assert.ok(
      Math.abs(b1.x - (b0.x + 16)) < 1e-9 &&
        Math.abs(b1.y - (b0.y + 16)) < 1e-9 &&
        Math.abs(b1.w - b0.w) < 1e-9 &&
        Math.abs(b1.h - b0.h) < 1e-9,
      `world bounds of ${orig.name} must shift by the duplicate delta`,
    );
  }
});

test("duplicating a group containing a type frame clones the story, not the reference", () => {
  const doc = makeDoc();
  doc.stories.push(makeStory("Grouped text", "noto-sans"));
  const storyId = doc.stories[0].id;
  doc.pages[0].layers.push(typeFrame("t_in", "g_outer", storyId, 10, 10, 200, 80));
  doc.activeLayerIds = ["g_outer"];

  const next = duplicateSelected(doc);
  assert.deepEqual(validateDocument(next), [], "document with the cloned story must validate clean");

  const copy = byId(next, next.activeLayerIds[0]);
  const copyType = childrenOf(next, copy.id).find((l) => l.kind === "type-frame");
  assert.ok(copyType, "the type frame travels with the copy");
  assert.notEqual(copyType.storyId, storyId, "the copy must not share the original story");
  const cloned = next.stories.find((s) => s.id === copyType.storyId);
  assert.equal(cloned.text, "Grouped text");
  assert.equal(next.stories.length, 2);
  assert.equal(next.stories.find((s) => s.id === storyId).text, "Grouped text", "original story untouched");
});

test("group duplicate through the command bus undoes and redoes exactly", () => {
  const bus = new CommandBus();
  const doc = makeDoc();
  doc.activeLayerIds = ["g_outer"];
  const before = JSON.stringify(doc);

  const res = bus.execute(doc, { type: "layer.duplicate", params: {} });
  const after = JSON.stringify(res.doc);
  assert.notEqual(after, before, "the duplicate must change the document");

  const undone = bus.undo(res.doc);
  assert.ok(undone, "undo must produce a result");
  assert.equal(JSON.stringify(undone.doc), before, "undo must restore the document exactly");

  const redone = bus.redo(undone.doc);
  assert.ok(redone, "redo must produce a result");
  assert.equal(JSON.stringify(redone.doc), after, "redo must re-create the duplicated state exactly");
});

test("duplicating one nested leaf is unchanged: offset copy under the same parent", () => {
  const doc = makeDoc();
  doc.activeLayerIds = ["v_a"];
  const next = duplicateSelected(doc);

  const copy = byId(next, next.activeLayerIds[0]);
  assert.equal(copy.parentId, "g_inner", "a nested leaf duplicate rejoins the same parent");
  assert.equal(copy.transform.x, byId(doc, "v_a").transform.x + 16);
  assert.equal(childrenOf(next, "g_inner").length, 3);
  assert.deepEqual(validateDocument(next), []);
});

// ── acceptance 2 + 4: deep delete leaves zero dangling parents ───────────────

test("deleting a group of depth >= 2 leaves zero dangling parentIds", () => {
  const doc = makeDoc();
  doc.activeLayerIds = ["g_outer"];
  const before = doc.pages[0].layers.length;

  const next = deleteSelected(doc);
  const ids = new Set(next.pages[0].layers.map((l) => l.id));
  assert.equal(next.pages[0].layers.length, before - 5, "outer, inner and three leaves are gone");
  assert.ok(noDanglingParents(next), "no layer may reference a deleted parent");
  assert.ok(ids.has("v_solo"), "layers outside the deleted tree survive");
  assert.deepEqual(next.activeLayerIds, []);
  assert.deepEqual(validateDocument(next), [], "validateDocument must be clean after a deep delete");
});

test("deleting a group selected together with its own child removes the subtree once", () => {
  const doc = makeDoc();
  doc.activeLayerIds = ["g_outer", "v_a"];
  const next = deleteSelected(doc);
  assert.equal(next.pages[0].layers.length, 1, "only v_solo survives");
  assert.ok(noDanglingParents(next));
  assert.deepEqual(validateDocument(next), []);
});

test("deleting an INNER group keeps outer siblings valid (no over-delete)", () => {
  const doc = makeDoc();
  doc.activeLayerIds = ["g_inner"];
  const next = deleteSelected(doc);
  const ids = new Set(next.pages[0].layers.map((l) => l.id));
  assert.ok(ids.has("g_outer"), "the outer group survives");
  assert.ok(ids.has("v_c"), "the outer group's other child survives");
  assert.ok(!ids.has("v_a") && !ids.has("v_b"), "the inner subtree is gone");
  assert.ok(noDanglingParents(next));
  assert.deepEqual(validateDocument(next), []);
});

test("single-layer delete is unchanged", () => {
  const doc = makeDoc();
  doc.activeLayerIds = ["v_solo"];
  const next = deleteSelected(doc);
  assert.equal(next.pages[0].layers.length, 5);
  assert.deepEqual(validateDocument(next), []);
});

// ── acceptance 4: PSD-like deep tree through duplicate AND delete ────────────

test("a PSD-like 4-level tree survives duplicate then delete of outer groups", () => {
  const doc = createDocument({
    name: "psdlike",
    ppi: 72,
    widthPx: 1000,
    heightPx: 800,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  doc.pages[0].layers.push(
    group("L1", null, 0, 0, 500, 500),
    group("L2", "L1", 10, 10, 400, 400),
    group("L3", "L2", 10, 10, 300, 300),
    vector("leaf1", "L3", 1, 1, 50, 50),
    vector("leaf2", "L3", 60, 1, 50, 50),
    group("L3b", "L2", 10, 200, 100, 100),
    vector("leaf3", "L3b", 5, 5, 40, 40),
    vector("loose", null, 700, 100, 60, 60),
  );
  assert.deepEqual(validateDocument(doc), [], "the fixture itself must validate clean");

  // Duplicate the outermost group — the whole 4-level tree must come along.
  doc.activeLayerIds = ["L1"];
  const dup = duplicateSelected(doc);
  assert.deepEqual(validateDocument(dup), [], "duplicate of the deep tree validates clean");
  const copy = byId(dup, dup.activeLayerIds[0]);
  const copyL2 = childrenOf(dup, copy.id);
  assert.equal(copyL2.length, 1, "the copy's root holds exactly the L2 copy");
  const copyL3 = dup.pages[0].layers.filter((l) => l.name === "L3" && l.parentId === copyL2[0].id);
  assert.equal(copyL3.length, 1, "an L3 copy exists under the copied L2, beside the original");
  const deepLeaves = dup.pages[0].layers.filter((l) => l.name === "leaf1");
  assert.equal(deepLeaves.length, 2, "depth-3 leaves were duplicated too");
  const copyL3b = dup.pages[0].layers.filter((l) => l.name === "L3b" && l.parentId === copyL2[0].id);
  assert.equal(copyL3b.length, 1, "the sibling nested group was duplicated as well");

  // Delete the ORIGINAL outer group — nothing dangles, the copy keeps rendering.
  doc.activeLayerIds = ["L1"];
  const del = deleteSelected(doc);
  const ids = new Set(del.pages[0].layers.map((l) => l.id));
  assert.ok(!ids.has("L1") && !ids.has("L2") && !ids.has("L3"));
  assert.ok(ids.has("loose"), "unrelated page layer survives");
  assert.ok(noDanglingParents(del), "zero dangling parentIds after deleting the deep original");
  assert.deepEqual(validateDocument(del), [], "validateDocument clean after the deep delete");

  // And delete the copy as well — still zero dangling parentIds.
  del.activeLayerIds = del.pages[0].layers.filter((l) => l.name === "L1").map((l) => l.id);
  const del2 = deleteSelected(del);
  assert.equal(del2.pages[0].layers.length, 1);
  assert.ok(noDanglingParents(del2));
  assert.deepEqual(validateDocument(del2), []);
});
