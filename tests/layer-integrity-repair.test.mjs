/**
 * Open-time repair of documents carrying dangling parentId links (VIRO-0140).
 *
 * The pre-fix deep delete could save documents whose grandchildren referenced
 * parents that no longer exist: validateDocument then reported
 * "parentId points outside the page" forever, and parentChain rendered the
 * layer's LOCAL coordinates as page coordinates. The repair pass detaches such
 * layers to the page WITHOUT moving the transform — the record is made to
 * agree with the pixels — and is idempotent, so reopening the repaired file
 * changes nothing.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/layer-integrity-repair.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, repairDanglingParents, validateDocument } from "../src/document/factory.ts";
import { worldBounds } from "../src/document/transform.ts";

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

function newDoc(pages = 1) {
  return createDocument({
    name: "repair",
    ppi: 72,
    widthPx: 800,
    heightPx: 600,
    bleedPx: 0,
    pageCount: pages,
    facingPages: false,
  });
}

/** A hand-crafted CURRENT-VERSION (v6) document with dangling parent links. */
function corruptedDoc() {
  const doc = newDoc();
  // What an old deep-delete left on disk: the group rows are gone, the
  // grandchildren survive with parentIds naming layers that no longer exist.
  doc.pages[0].layers.push(
    vector("orphan_a", "g_ghost", 42, 42, 100, 80),
    vector("orphan_b", "g_gone_too", 300, 120, 60, 60),
    vector("healthy", null, 500, 100, 80, 80),
  );
  return doc;
}

const danglingCount = (doc) => {
  let n = 0;
  for (const page of doc.pages) {
    const ids = new Set(page.layers.map((l) => l.id));
    n += page.layers.filter((l) => l.parentId && !ids.has(l.parentId)).length;
  }
  return n;
};

test("a hand-crafted v6 document with dangling parentIds is repaired on open", () => {
  const doc = corruptedDoc();
  assert.equal(doc.version, 6, "the corruption is a current-version problem, not a migration one");
  assert.equal(danglingCount(doc), 2);
  assert.ok(
    validateDocument(doc).some((e) => e.includes("parentId points outside the page")),
    "the pre-repair document must fail validation",
  );

  const report = repairDanglingParents(doc);
  assert.equal(report.repaired, 2);
  assert.equal(report.notes.length, 2);
  assert.match(report.notes.join(" "), /g_ghost/);

  const a = doc.pages[0].layers.find((l) => l.id === "orphan_a");
  const b = doc.pages[0].layers.find((l) => l.id === "orphan_b");
  assert.equal(a.parentId, null, "the dangling link is detached to the page");
  assert.equal(b.parentId, null);

  // Page-space positions: the transform is NOT touched — those local numbers
  // were already what the user saw, because the broken chain composed nothing.
  assert.deepEqual(a.transform, { x: 42, y: 42, w: 100, h: 80, rotation: 0 });
  assert.deepEqual(b.transform, { x: 300, y: 120, w: 60, h: 60, rotation: 0 });

  assert.equal(danglingCount(doc), 0);
  assert.deepEqual(validateDocument(doc), [], "the repaired document validates clean");
});

test("repair is visually stable: rendered page-space bounds are unchanged", () => {
  const doc = corruptedDoc();
  const page = doc.pages[0];
  const before = new Map(page.layers.map((l) => [l.id, { ...worldBounds(page, l) }]));

  repairDanglingParents(doc);

  for (const l of page.layers) {
    const after = worldBounds(page, l);
    const was = before.get(l.id);
    assert.ok(
      Math.abs(after.x - was.x) < 1e-9 &&
        Math.abs(after.y - was.y) < 1e-9 &&
        Math.abs(after.w - was.w) < 1e-9 &&
        Math.abs(after.h - was.h) < 1e-9,
      `${l.id} must not move by one pixel when repaired`,
    );
  }
});

test("reopening the repaired file is a no-op (idempotent)", () => {
  const doc = corruptedDoc();
  repairDanglingParents(doc);
  const repaired = JSON.stringify(doc);

  // Simulate save + reopen: the repaired bytes come back from disk.
  const reopened = JSON.parse(repaired);
  const second = repairDanglingParents(reopened);
  assert.equal(second.repaired, 0, "the second open must repair nothing");
  assert.equal(second.notes.length, 0);
  assert.equal(JSON.stringify(reopened), repaired, "the second repair must not change the file");
});

test("repair leaves healthy documents byte-identical", () => {
  const doc = newDoc();
  doc.pages[0].layers.push(
    group("g1", null, 10, 10, 200, 200),
    vector("c1", "g1", 5, 5, 100, 80),
    group("g2", "g1", 20, 20, 100, 100),
    vector("c2", "g2", 1, 1, 40, 40),
  );
  const before = JSON.stringify(doc);
  const report = repairDanglingParents(doc);
  assert.equal(report.repaired, 0);
  assert.equal(JSON.stringify(doc), before, "a valid document must not be rewritten");
});

test("repair is per-page: a parent on another page is outside this page and is detached", () => {
  const doc = newDoc(2);
  const [p1, p2] = doc.pages;
  p1.layers.push(group("p1_group", null, 0, 0, 100, 100));
  p2.layers.push(vector("cross", "p1_group", 10, 10, 50, 50));
  assert.ok(
    validateDocument(doc).some((e) => e.includes("parentId points outside the page")),
    "validateDocument scopes parenting to the page, so the fixture is invalid",
  );

  const report = repairDanglingParents(doc);
  assert.equal(report.repaired, 1);
  assert.equal(p2.layers.find((l) => l.id === "cross").parentId, null);
  assert.equal(p1.layers.find((l) => l.id === "p1_group").parentId, null, "the healthy page is untouched");
  assert.deepEqual(validateDocument(doc), []);
});
