/**
 * VIRO-0141 — contour-addressed node editing: ops + bus contract.
 *
 * Pins the contract for contour-addressed node editing (banked as a draft
 * before implementation; the only build-stage adaptation was the CommandBus
 * import, which lives in command-bus.ts, not commands.ts).
 *
 * Design under test:
 * - Contour addressing is {layerId, contourIndex, nodeIndex} into the
 *   AUTHORITATIVE contour list: v6 contours[] when present, otherwise the
 *   legacy single contour {nodes, closed} — the exact precedence of
 *   boolean-ops.ts layerContours and compositor drawVector.
 * - All coordinates are LAYER-LOCAL (the space nodes are stored in). Page-space
 *   conversion belongs to the (phase-2) overlay, not the command.
 * - Inverses are DERIVED: every command uses the house invertAfter →
 *   deriveInverse wrapper; patch.ts carries the prior layer record wholesale,
 *   so undo is byte-exact no matter how many nodes changed.
 * - CORRUPTION GUARD: path.appendNode on a contours-authoritative layer is
 *   rejected with a CommandError that names the routing alternative — it must
 *   never rewrite the transform from legacy nodes (nodes[] is empty on boolean
 *   results, so the current code computes Infinity bounds and teleports the
 *   layer while the renderer keeps drawing untouched contours).
 * - factory.ts is NOT in the 0141 lease: no validator changes; the guard lives
 *   entirely in the command layer.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/vector-node-commands.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CommandError } from "../src/document/commands.ts";
import { CommandBus } from "../src/document/command-bus.ts";
import { installUiCommands } from "../src/document/ui-commands.ts";
import { createDocument, validateDocument } from "../src/document/factory.ts";
import {
  moveContourNode,
  insertContourNode,
  deleteContourNode,
  setContourClosed,
  appendPathNode,
} from "../src/document/ops.ts";
import { booleanCombineVectors } from "../src/document/boolean-ops.ts";

installUiCommands();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert.ok(existsSync(ckWasm), "canvaskit.wasm missing");
const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });

const RED = { r: 1, g: 0, b: 0, a: 1 };

const rectNodes = (w, h) => {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
};

function vectorRect(id, x, y, w, h) {
  return {
    id,
    name: id,
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: rectNodes(w, h),
    fill: RED,
    stroke: null,
  };
}

/** A real engine-produced boolean ring on a valid v6 document. */
function docWithRing() {
  const doc = createDocument({
    name: "node-edit",
    ppi: 72,
    widthPx: 800,
    heightPx: 600,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  const page = doc.pages[0];
  const outer = vectorRect("outer", 100, 100, 200, 200);
  const inner = vectorRect("inner", 150, 150, 100, 100);
  page.layers.push(outer, inner);
  // Draw order (last = TOPMOST): subtract keeps the topmost shape minus what is
  // beneath it, so `outer` must be the LAST operand — [outer, inner] would ask
  // for inner − outer and get an empty set.
  const ring = booleanCombineVectors(ck, page, [inner, outer], "subtract");
  assert.ok(ring, "subtract must produce a ring");
  assert.equal(ring.contours.length, 2, "ring = outer contour + hole contour");
  assert.equal(ring.nodes.length, 0, "boolean results are born contours-authoritative");
  page.layers.length = 0;
  page.layers.push(ring, vectorRect("solo", 500, 100, 60, 60));
  doc.activeLayerIds = [];
  return doc;
}

const byId = (doc, id) => doc.pages[0].layers.find((l) => l.id === id);

// ── moveNode: exactly the addressed node moves, locally ─────────────────────

test("path.moveNode moves exactly one node of the addressed contour, handles riding along", () => {
  const doc = docWithRing();
  const ring = byId(doc, doc.pages[0].layers[0].id);
  const before = structuredClone(ring);
  const node = ring.contours[0].nodes[1];
  const dx = 12, dy = -7;

  const next = moveContourNode(doc, ring.id, 0, 1, node.x + dx, node.y + dy);
  const after = byId(next, ring.id);

  // The addressed anchor moved by the delta; its handles translated by the
  // same delta so the segment tangents (and therefore the shape language)
  // survive the drag.
  assert.equal(after.contours[0].nodes[1].x, node.x + dx);
  assert.equal(after.contours[0].nodes[1].y, node.y + dy);
  assert.equal(after.contours[0].nodes[1].inX, node.inX + dx);
  assert.equal(after.contours[0].nodes[1].inY, node.inY + dy);
  assert.equal(after.contours[0].nodes[1].outX, node.outX + dx);
  assert.equal(after.contours[0].nodes[1].outY, node.outY + dy);

  // Byte-identical everywhere else: other nodes, the hole contour, transform.
  after.contours[0].nodes.splice(1, 1);
  before.contours[0].nodes.splice(1, 1);
  assert.deepEqual(after.contours[0].nodes, before.contours[0].nodes, "sibling nodes untouched");
  assert.deepEqual(after.contours[1], before.contours[1], "the OTHER contour is byte-identical");
  assert.deepEqual(after.transform, before.transform, "moveNode never rewrites the transform");
  assert.deepEqual(validateDocument(next), []);
});

test("path.moveNode addresses the LEGACY single contour of a plain vector (index 0)", () => {
  const doc = createDocument({ name: "legacy", ppi: 72, widthPx: 400, heightPx: 400, bleedPx: 0, pageCount: 1, facingPages: false });
  doc.pages[0].layers.push(vectorRect("plain", 20, 20, 100, 80));
  const next = moveContourNode(doc, "plain", 0, 2, 130, 110);
  const layer = byId(next, "plain");
  assert.equal(layer.nodes[2].x, 130);
  assert.equal(layer.nodes[2].y, 110);
  assert.equal("contours" in layer, false, "legacy layers must not silently gain a contours list");
  assert.deepEqual(validateDocument(next), []);
});

test("out-of-range contourIndex/nodeIndex is a precise CommandError, not a silent no-op", () => {
  const bus = new CommandBus();
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  assert.throws(
    () => bus.execute(doc, { type: "path.moveNode", params: { layerId: ringId, contourIndex: 5, nodeIndex: 0, x: 1, y: 1 } }),
    (e) => e instanceof CommandError && /contourIndex/.test(e.message),
  );
  assert.throws(
    () => bus.execute(doc, { type: "path.moveNode", params: { layerId: ringId, contourIndex: 0, nodeIndex: 99, x: 1, y: 1 } }),
    (e) => e instanceof CommandError && /nodeIndex/.test(e.message),
  );
  assert.equal(bus.stats().entries, 0, "a rejected command must not land in history");
});

// ── insertNode / deleteNode: remaining geometry byte-identical ──────────────

test("path.insertNode splices one node into the addressed contour only", () => {
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  const ring = byId(doc, ringId);
  const before = structuredClone(ring);
  const fresh = { x: 55, y: 5, inX: 55, inY: 5, outX: 55, outY: 5 };

  const next = insertContourNode(doc, ringId, 1, 1, fresh);
  const after = byId(next, ringId);

  assert.equal(after.contours[1].nodes.length, before.contours[1].nodes.length + 1);
  assert.deepEqual(after.contours[1].nodes[2], fresh, "the new node sits at index afterNodeIndex+1");
  after.contours[1].nodes.splice(2, 1);
  assert.deepEqual(after.contours[1].nodes, before.contours[1].nodes, "remaining hole nodes byte-identical");
  assert.deepEqual(after.contours[0], before.contours[0], "the untouched contour is byte-identical");
  assert.deepEqual(after.transform, before.transform);
  assert.deepEqual(validateDocument(next), []);
});

test("path.insertNode may append at the end of a CLOSED contour (the closing segment)", () => {
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  const ring = byId(doc, ringId);
  const n = ring.contours[0].nodes.length;
  const fresh = { x: 10, y: 10, inX: 10, inY: 10, outX: 10, outY: 10 };
  const next = insertContourNode(doc, ringId, 0, n, fresh); // afterNodeIndex === length
  assert.equal(byId(next, ringId).contours[0].nodes.length, n + 1);
  assert.deepEqual(validateDocument(next), []);
});

test("path.deleteNode removes exactly the addressed node and refuses to degenerate a contour", () => {
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  const ring = byId(doc, ringId);
  const before = structuredClone(ring);

  const next = deleteContourNode(doc, ringId, 1, 0);
  const after = byId(next, ringId);
  assert.equal(after.contours[1].nodes.length, before.contours[1].nodes.length - 1);
  assert.deepEqual(after.contours[1].nodes, before.contours[1].nodes.slice(1), "remaining order preserved");
  assert.deepEqual(after.contours[0], before.contours[0], "untouched contour byte-identical");
  assert.deepEqual(validateDocument(next), []);

  // A contour is only drawable with >= 2 nodes (mirror validateDocument's
  // legacy rule); deleting below that must be refused, not silently corrupt.
  const bus = new CommandBus();
  const twoNode = structuredClone(doc);
  const two = byId(twoNode, ringId);
  two.contours[1].nodes.length = 2;
  assert.throws(
    () => bus.execute(twoNode, { type: "path.deleteNode", params: { layerId: ringId, contourIndex: 1, nodeIndex: 0 } }),
    (e) => e instanceof CommandError && /2 nodes|at least 2/.test(e.message),
  );
});

// ── closeContour: closes the addressed contour; fill gating follows ─────────

test("path.closeContour flips only the addressed contour's closed flag", () => {
  const doc = createDocument({ name: "open", ppi: 72, widthPx: 400, heightPx: 400, bleedPx: 0, pageCount: 1, facingPages: false });
  // Stroke-only: an OPEN filled legacy path would rightly fail validation
  // ("open path carries a fill"), so the toggle fixture must not carry fill.
  doc.pages[0].layers.push({ ...vectorRect("plain", 20, 20, 100, 80), closed: true, fill: null, stroke: { color: RED, width: 2 } });
  const next = setContourClosed(doc, "plain", 0, false);
  assert.equal(byId(next, "plain").closed, false, "legacy single contour closes/opens via index 0");
  assert.deepEqual(validateDocument(next), []);
  const back = setContourClosed(next, "plain", 0, true);
  assert.equal(byId(back, "plain").closed, true);
  assert.deepEqual(validateDocument(back), []);
});

test("path.closeContour on a boolean hole edits contours[i].closed, not the inert legacy field", () => {
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  const next = setContourClosed(doc, ringId, 1, false);
  const after = byId(next, ringId);
  assert.equal(after.contours[1].closed, false, "the addressed contour opened");
  assert.equal(after.contours[0].closed, true, "the sibling contour untouched");
  assert.deepEqual(validateDocument(next), [], "multi-contour branch validates contours, not legacy closed");
});

// ── CORRUPTION GUARD: appendNode must never rewrite transform from legacy nodes

test("path.appendNode on a contours-authoritative layer is rejected with routing guidance", () => {
  const bus = new CommandBus();
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  const before = JSON.stringify(doc);

  assert.throws(
    () => bus.execute(doc, { type: "path.appendNode", params: { layerId: ringId, x: 300, y: 300 } }),
    (e) => {
      assert.ok(e instanceof CommandError, `expected CommandError, got ${e?.name}`);
      assert.match(e.message, /contours-authoritative|contour/);
      assert.match(e.message, /path\.insertNode/);
      return true;
    },
  );
  assert.equal(JSON.stringify(doc), before, "the rejected command must not touch the document");
  assert.equal(bus.stats().entries, 0);
});

test("appendPathNode (ops level) is a no-op on a contours-authoritative layer — no Infinity transform", () => {
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  const before = JSON.stringify(byId(doc, ringId));
  const next = appendPathNode(doc, ringId, 300, 300);
  assert.equal(JSON.stringify(byId(next, ringId)), before, "ops must never rewrite transform from empty legacy nodes");
});

test("path.appendNode on a LEGACY vector is unchanged (regression)", () => {
  const bus = new CommandBus();
  const doc = createDocument({ name: "legacy", ppi: 72, widthPx: 400, heightPx: 400, bleedPx: 0, pageCount: 1, facingPages: false });
  doc.pages[0].layers.push({ ...vectorRect("open_path", 20, 20, 100, 80), closed: false, fill: null, stroke: { color: RED, width: 2 } });
  const res = bus.execute(doc, { type: "path.appendNode", params: { layerId: "open_path", x: 150, y: 150 } });
  const layer = res.doc.pages[0].layers[0];
  assert.equal(layer.nodes.length, 5);
  assert.deepEqual(validateDocument(res.doc), []);
});

// ── derived inverses through the bus: undo/redo exact for every new command ──

for (const [type, params] of [
  ["path.moveNode", { layerId: "__RING__", contourIndex: 0, nodeIndex: 1, x: 120, y: 90 }],
  ["path.insertNode", { layerId: "__RING__", contourIndex: 1, afterNodeIndex: 1, node: { x: 5, y: 5, inX: 5, inY: 5, outX: 5, outY: 5 } }],
  ["path.deleteNode", { layerId: "__RING__", contourIndex: 1, nodeIndex: 0 }],
  ["path.closeContour", { layerId: "__RING__", contourIndex: 1, closed: false }],
]) {
  test(`${type}: undo restores the document exactly; redo re-applies it`, () => {
    const bus = new CommandBus();
    const doc = docWithRing();
    doc.pages[0].layers[0].contours[1].nodes.length = 4; // room to delete
    const wired = JSON.parse(JSON.stringify(params)).layerId === "__RING__"
      ? { ...params, layerId: doc.pages[0].layers[0].id }
      : params;
    const before = JSON.stringify(doc);

    const res = bus.execute(doc, { type, params: wired });
    const after = JSON.stringify(res.doc);
    assert.notEqual(after, before, "the command must change the document");

    const undone = bus.undo(res.doc);
    assert.ok(undone, "undo must produce a result");
    assert.equal(JSON.stringify(undone.doc), before, `${type} inverse did not restore the document`);

    const redone = bus.redo(undone.doc);
    assert.ok(redone);
    assert.equal(JSON.stringify(redone.doc), after);
  });
}

// ── save/reopen round-trip ───────────────────────────────────────────────────

test("edited contours survive a JSON save/reopen byte-identically", () => {
  const doc = docWithRing();
  const ringId = doc.pages[0].layers[0].id;
  const node = byId(doc, ringId).contours[0].nodes[0];
  const edited = moveContourNode(doc, ringId, 0, 0, node.x + 3, node.y + 4);
  const saved = JSON.parse(JSON.stringify(edited));
  assert.deepEqual(saved.pages[0].layers[0].contours, edited.pages[0].layers[0].contours);
  assert.deepEqual(validateDocument(saved), []);
});
