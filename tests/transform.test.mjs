/**
 * Unit tests for the v2 hierarchical transform algebra and the v1 -> v2
 * migration invariant. Pure functions only: no browser, no Skia.
 *
 *   node --experimental-strip-types --test tests/transform.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPt,
  decompose,
  invert,
  localMatrix,
  mul,
  parentWorldMatrix,
  worldBounds,
  worldMatrix,
} from "../src/document/transform.ts";
import { DOC_VERSION, migrateDocument, needsMigration } from "../src/document/migrate.ts";

const T = (o = {}) => ({ x: 0, y: 0, w: 100, h: 50, rotation: 0, ...o });
const L = (id, t, parentId = null, kind = "vector") => ({
  id,
  name: id,
  kind,
  visible: true,
  locked: false,
  opacity: 1,
  blend: "srcOver",
  transform: T(t),
  parentId,
});
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, "expected " + a + " close to " + b);
const nearPt = (p, x, y, eps = 1e-9) => {
  near(p.x, x, eps);
  near(p.y, y, eps);
};

test("localMatrix: translation places the box origin", () => {
  nearPt(applyPt(localMatrix(T({ x: 30, y: 40 })), 0, 0), 30, 40);
});

test("localMatrix: rotation pivots about the box centre, not the origin", () => {
  const m = localMatrix(T({ rotation: 90 }));
  nearPt(applyPt(m, 50, 25), 50, 25);
  nearPt(applyPt(m, 0, 0), 75, -25);
});

test("localMatrix: scale is about the centre and defaults to 1", () => {
  assert.deepEqual(
    localMatrix(T()),
    localMatrix(T({ scaleX: 1, scaleY: 1 })),
    "absent scale must read as 1 so v1 documents are unchanged",
  );
  const m = localMatrix(T({ scaleX: 2, scaleY: 2 }));
  nearPt(applyPt(m, 50, 25), 50, 25);
  nearPt(applyPt(m, 0, 0), -50, -25);
});

test("mul/invert round-trip returns the original point", () => {
  const m = mul(
    localMatrix(T({ x: 12, y: -8, rotation: 33, scaleX: 1.7, scaleY: 0.4 })),
    localMatrix(T({ x: -5, y: 9, rotation: -12 })),
  );
  const inv = invert(m);
  assert.ok(inv, "matrix must be invertible");
  const fwd = applyPt(m, 17, 23);
  nearPt(applyPt(inv, fwd.x, fwd.y), 17, 23, 1e-8);
});

test("invert returns null for a degenerate transform instead of throwing", () => {
  assert.equal(invert(localMatrix(T({ scaleX: 0 }))), null);
});

test("worldMatrix composes the whole ancestor chain", () => {
  const page = {
    id: "p",
    layers: [L("g", { x: 100, y: 100, w: 200, h: 200 }, null, "group"), L("c", { x: 10, y: 10 }, "g")],
  };
  nearPt(applyPt(worldMatrix(page, page.layers[1]), 0, 0), 110, 110);
});

test("worldMatrix composes NESTED groups", () => {
  const page = {
    id: "p",
    layers: [
      L("g1", { x: 100, y: 100, w: 400, h: 400 }, null, "group"),
      L("g2", { x: 50, y: 25, w: 200, h: 200 }, "g1", "group"),
      L("leaf", { x: 5, y: 5 }, "g2"),
    ],
  };
  nearPt(applyPt(worldMatrix(page, page.layers[2]), 0, 0), 155, 130);
});

test("a group's scale scales its children's world position", () => {
  const page = {
    id: "p",
    layers: [
      L("g", { x: 0, y: 0, w: 100, h: 100, scaleX: 2, scaleY: 2 }, null, "group"),
      L("c", { x: 10, y: 10, w: 10, h: 10 }, "g"),
    ],
  };
  // Scale x2 about the group centre (50,50): 50 + (10-50)*2 = -30
  nearPt(applyPt(worldMatrix(page, page.layers[1]), 0, 0), -30, -30);
});

test("parentWorldMatrix excludes the layer's own transform", () => {
  const page = {
    id: "p",
    layers: [L("g", { x: 100, y: 100, w: 200, h: 200 }, null, "group"), L("c", { x: 10, y: 10 }, "g")],
  };
  nearPt(applyPt(parentWorldMatrix(page, page.layers[1]), 0, 0), 100, 100);
});

test("worldBounds is the axis-aligned box of a rotated nested layer", () => {
  const page = {
    id: "p",
    layers: [
      L("g", { x: 100, y: 100, w: 200, h: 200 }, null, "group"),
      L("c", { x: 0, y: 0, w: 100, h: 50, rotation: 90 }, "g"),
    ],
  };
  const b = worldBounds(page, page.layers[1]);
  near(b.w, 50);
  near(b.h, 100);
  near(b.x, 125);
  near(b.y, 75);
});

test("a parentId cycle terminates instead of hanging the renderer", () => {
  const page = {
    id: "p",
    layers: [L("a", { x: 1, y: 1 }, "b", "group"), L("b", { x: 2, y: 2 }, "a", "group")],
  };
  const m = worldMatrix(page, page.layers[0]);
  assert.ok(Number.isFinite(m.e) && Number.isFinite(m.f));
});

test("decompose inverts localMatrix exactly when there is no shear", () => {
  const t = T({ x: 17, y: -9, w: 120, h: 64, rotation: 37, scaleX: 1.5, scaleY: 1.5 });
  const { transform: back, sheared } = decompose(localMatrix(t), t.w, t.h);
  assert.equal(sheared, false);
  near(back.x, t.x, 1e-8);
  near(back.y, t.y, 1e-8);
  near(back.rotation, t.rotation, 1e-8);
  near(back.scaleX, t.scaleX, 1e-8);
  near(back.scaleY, t.scaleY, 1e-8);
});

test("rotate-then-scale is representable and must NOT be flagged as shear", () => {
  // Order matters. A rotated group containing a scaled child keeps its matrix
  // columns orthogonal, so it decomposes exactly.
  const m = mul(localMatrix(T({ rotation: 45 })), localMatrix(T({ scaleX: 3, scaleY: 1 })));
  assert.equal(decompose(m, 100, 50).sheared, false);
});

test("decompose reports shear rather than inventing a rectangle", () => {
  // The reverse order is what ungroupSelected composes: a NON-UNIFORMLY SCALED
  // GROUP wrapping a ROTATED CHILD. That genuinely shears, and a
  // {x,y,w,h,rotation,scale} record cannot represent it.
  const m = mul(localMatrix(T({ scaleX: 3, scaleY: 1 })), localMatrix(T({ rotation: 45 })));
  assert.equal(decompose(m, 100, 50).sheared, true);
});

// -- the migration invariant -------------------------------------------------

test("MIGRATION INVARIANT: v1 absolute positions survive as current world positions", () => {
  const doc = {
    version: 1,
    pages: [
      {
        id: "p",
        layers: [
          L("g", { x: 100, y: 200, w: 300, h: 300 }, null, "group"),
          L("c1", { x: 120, y: 220 }, "g"),
          L("c2", { x: 300, y: 400 }, "g"),
          L("root", { x: 10, y: 10 }),
        ],
      },
    ],
  };
  const v1Absolute = doc.pages[0].layers.map((l) => ({ x: l.transform.x, y: l.transform.y }));

  assert.equal(needsMigration(doc), true);
  const report = migrateDocument(doc);
  assert.equal(report.from, 1);
  assert.equal(report.to, DOC_VERSION);
  assert.equal(report.layersRebased, 2);
  assert.equal(doc.version, DOC_VERSION);

  const page = doc.pages[0];
  page.layers.forEach((l, i) => {
    nearPt(applyPt(worldMatrix(page, l), 0, 0), v1Absolute[i].x, v1Absolute[i].y);
  });
});

test("migration is idempotent - running it twice must not move anything", () => {
  const doc = {
    version: 1,
    pages: [
      {
        id: "p",
        layers: [L("g", { x: 100, y: 100, w: 200, h: 200 }, null, "group"), L("c", { x: 150, y: 150 }, "g")],
      },
    ],
  };
  migrateDocument(doc);
  const after = JSON.stringify(doc);
  const second = migrateDocument(doc);
  assert.match(second.notes.join(" "), new RegExp("already version " + DOC_VERSION));
  assert.equal(JSON.stringify(doc), after, "second migration must be a no-op");
});

test("migration discards inert v1 group rotation and reports it", () => {
  const doc = {
    version: 1,
    pages: [
      {
        id: "p",
        layers: [
          L("g", { x: 0, y: 0, w: 100, h: 100, rotation: 45 }, null, "group"),
          L("c", { x: 10, y: 10 }, "g"),
        ],
      },
    ],
  };
  const r = migrateDocument(doc);
  assert.equal(r.groupRotationsDiscarded, 1);
  assert.equal(doc.pages[0].layers[0].transform.rotation, 0);
  nearPt(applyPt(worldMatrix(doc.pages[0], doc.pages[0].layers[1]), 0, 0), 10, 10);
});

test("migration keeps a layer with a dangling parentId visible and reports it", () => {
  const doc = {
    version: 1,
    pages: [{ id: "p", layers: [L("orphan", { x: 42, y: 42 }, "ghost")] }],
  };
  const r = migrateDocument(doc);
  assert.equal(r.layersRebased, 0);
  assert.match(r.notes.join(" "), /missing parent/);
  assert.equal(doc.pages[0].layers[0].transform.x, 42);
});

function vectorWithStroke(stroke) {
  return {
    id: "r",
    kind: "vector",
    name: "r",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: [],
    fill: null,
    stroke,
  };
}

test("MIGRATION INVARIANT v4 -> v6: stroke-styling stamp leaves existing strokes byte-identical", () => {
  const doc = {
    version: 4,
    pages: [{ id: "p", layers: [vectorWithStroke({ color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 })] }],
  };
  const before = JSON.parse(JSON.stringify(doc.pages[0].layers[0].stroke));
  assert.equal(needsMigration(doc), true);
  const r = migrateDocument(doc);
  assert.equal(r.from, 4);
  assert.equal(r.to, DOC_VERSION);
  assert.equal(r.strokeStylesStamped, 1);
  assert.equal(doc.version, DOC_VERSION);
  // A v4 stroke is already a valid v6 stroke and renders solid/butt/miter.
  assert.deepEqual(doc.pages[0].layers[0].stroke, before);
});

test("a v5 dashed/styled stroke round-trips through JSON save/open unchanged", () => {
  const stroke = {
    color: { r: 0.9, g: 0.1, b: 0.1, a: 1 },
    width: 4,
    dash: [12, 6],
    dashPhase: 2,
    cap: "round",
    join: "bevel",
  };
  // DOC_VERSION is now 6, so a v5 file needs the widening stamp on open.
  const doc = { version: 5, pages: [{ id: "p", layers: [vectorWithStroke(stroke)] }] };
  assert.equal(needsMigration(doc), true);
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round.pages[0].layers[0].stroke, stroke);
});

// -- v5 -> v6 multi-contour widening (ADR 0005 Phase-0) ----------------------

function rectContour(w, h) {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
}

test("MIGRATION INVARIANT v5 -> v6: a v5 vector reopens byte-identically as a v6 one-contour vector", () => {
  const layer = {
    id: "v",
    kind: "vector",
    name: "v",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: rectContour(10, 10),
    fill: { r: 0, g: 0, b: 0, a: 1 },
    stroke: null,
  };
  const doc = { version: 5, pages: [{ id: "p", layers: [layer] }] };
  const before = JSON.parse(JSON.stringify(doc));

  assert.equal(needsMigration(doc), true);
  const r = migrateDocument(doc);
  assert.equal(r.from, 5);
  assert.equal(r.to, 6);
  assert.equal(r.to, DOC_VERSION);
  // Every existing vector is counted, but NOTHING is rewritten.
  assert.equal(r.contoursStamped, 1);
  assert.equal(doc.version, 6);

  const migratedVector = doc.pages[0].layers[0];
  // The stamp adds no `contours` field and moves no node — pixel-identical.
  assert.equal("contours" in migratedVector, false, "widening stamp must not add contours[]");
  assert.deepEqual(migratedVector.nodes, before.pages[0].layers[0].nodes);
  assert.equal(migratedVector.closed, true);

  // Only the version differs between the v5 input and the v6 output.
  before.version = 6;
  assert.deepEqual(doc, before, "migrating v5 -> v6 must change only the version field");
});

test("a v6 multi-contour vector (rect with a rect hole) round-trips through JSON save/open unchanged", () => {
  const inner = rectContour(4, 4).map((n) => ({
    x: n.x + 3,
    y: n.y + 3,
    inX: n.inX + 3,
    inY: n.inY + 3,
    outX: n.outX + 3,
    outY: n.outY + 3,
  }));
  const layer = {
    id: "v",
    kind: "vector",
    name: "hole",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: [],
    fill: { r: 0, g: 0, b: 0, a: 1 },
    stroke: null,
    contours: [
      { closed: true, nodes: rectContour(10, 10) },
      { closed: true, nodes: inner },
    ],
  };
  const doc = { version: 6, pages: [{ id: "p", layers: [layer] }] };
  assert.equal(needsMigration(doc), false, "a v6 document is current — no migration");
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round.pages[0].layers[0].contours, layer.contours);
  assert.equal(round.pages[0].layers[0].contours.length, 2);
});
