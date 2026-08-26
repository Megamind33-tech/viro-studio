/**
 * Unit tests for the multi-selection transform geometry (RFC-6).
 *
 * Pure functions, no browser/Skia/command-bus: the group move, the group scale
 * about the opposite anchor, the group rotate about the selection centre, and
 * the smart-guide snap resolver.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/multi-transform.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  movedLayerBox,
  resolveMoveSnap,
  rotatedLayerBox,
  scaleFromHandle,
  scaledLayerBox,
} from "../src/document/multi-transform.ts";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const box = (id, x, y, w, h, rotation = 0) => ({ id, x, y, w, h, rotation });

// ── move ─────────────────────────────────────────────────────────────────────

test("movedLayerBox translates from the pointer-down box", () => {
  assert.deepEqual(movedLayerBox(box("a", 10, 20, 5, 5), 3, -4), { x: 13, y: 16 });
});

test("move measured from origin is reversible (back over the start returns it)", () => {
  const b = box("a", 10, 20, 5, 5);
  assert.deepEqual(movedLayerBox(b, 0, 0), { x: 10, y: 20 });
  assert.deepEqual(movedLayerBox(b, 40, 40), { x: 50, y: 60 });
});

// ── scale (corner/edge handles, anchored on the opposite side) ────────────────

test("dragging SE doubles the group and holds the NW anchor", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  const s = scaleFromHandle(frame, "se", 200, 200, { shift: false, minSize: 4 });
  assert.ok(near(s.kx, 2) && near(s.ky, 2), `kx/ky = ${s.kx}/${s.ky}`);
  // The NW-quadrant member sits at the anchored corner and must not move.
  assert.deepEqual(scaledLayerBox(box("nw", 0, 0, 50, 50), frame, s, 4), { x: 0, y: 0, w: 100, h: 100 });
  // The SE-quadrant member scales its offset AND its size about that anchor.
  assert.deepEqual(scaledLayerBox(box("se", 50, 50, 50, 50), frame, s, 4), { x: 100, y: 100, w: 100, h: 100 });
});

test("dragging NW holds the SE anchor", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  const s = scaleFromHandle(frame, "nw", -100, -100, { shift: false, minSize: 4 });
  assert.ok(near(s.kx, 2) && near(s.ky, 2));
  // The member whose bottom-right is the SE corner (100,100) must keep it there.
  const se = scaledLayerBox(box("se", 50, 50, 50, 50), frame, s, 4);
  assert.ok(near(se.x + se.w, 100) && near(se.y + se.h, 100), `SE corner at ${se.x + se.w},${se.y + se.h}`);
});

test("edge handle scales one axis only", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  const s = scaleFromHandle(frame, "e", 300, 0, { shift: false, minSize: 4 });
  assert.ok(near(s.kx, 3) && near(s.ky, 1), `kx/ky = ${s.kx}/${s.ky}`);
});

test("Shift on a corner preserves the frame's aspect ratio", () => {
  const frame = { x: 0, y: 0, w: 100, h: 50, rotation: 0 };
  const s = scaleFromHandle(frame, "se", 300, 100, { shift: true, minSize: 4 });
  assert.ok(near(s.kx, s.ky), `kx=${s.kx} ky=${s.ky} must be equal`);
  assert.ok(near(s.kx, 3), `expected 3x, got ${s.kx}`);
});

test("minSize clamps a member so it never collapses / inverts", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  // Collapse the frame to near-zero by dragging SE back onto NW.
  const s = scaleFromHandle(frame, "se", 0, 0, { shift: false, minSize: 4 });
  const out = scaledLayerBox(box("m", 0, 0, 50, 50), frame, s, 4);
  assert.ok(out.w >= 4 && out.h >= 4, `w/h = ${out.w}/${out.h}`);
});

// ── rotate (about the selection centre) ───────────────────────────────────────

test("group rotate swings a member about the frame centre and turns its own angle", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  // Member centred at (10,10); a 90° CW turn about (50,50) sends it to (90,10).
  const r = rotatedLayerBox(box("m", 0, 0, 20, 20), frame, 90);
  assert.ok(near(r.x, 80) && near(r.y, 0), `landed at ${r.x},${r.y}`);
  assert.equal(r.rotation, 90);
});

test("a member at the pivot only spins in place", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  const r = rotatedLayerBox(box("c", 40, 40, 20, 20), frame, 37);
  assert.ok(near(r.x, 40) && near(r.y, 40), `centre member moved to ${r.x},${r.y}`);
  assert.equal(r.rotation, 37);
});

test("rotating by 0° is the identity", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  const r = rotatedLayerBox(box("m", 12, 34, 20, 20), frame, 0);
  assert.ok(near(r.x, 12) && near(r.y, 34));
  assert.equal(r.rotation, 0);
});

// ── smart-guide snapping ──────────────────────────────────────────────────────

test("snaps the moving right edge onto a candidate within tolerance", () => {
  const frame = { x: 100, y: 100, w: 50, h: 50, rotation: 0 };
  // dx=8 -> right edge at 158; candidate line at 160 is 2px away, within tol 10.
  const snap = resolveMoveSnap(frame, 8, 0, [160], [], 10);
  assert.ok(near(snap.ox, 2), `ox=${snap.ox}`);
  assert.equal(snap.guideX, 160);
  assert.equal(snap.guideY, null);
});

test("snaps the moving centre when it is the closest edge", () => {
  const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  // Centre at 50; candidate 52 is closer than either edge (0/100).
  const snap = resolveMoveSnap(frame, 0, 0, [52], [], 5);
  assert.ok(near(snap.ox, 2), `ox=${snap.ox}`);
  assert.equal(snap.guideX, 52);
});

test("no snap when every candidate is beyond tolerance", () => {
  const frame = { x: 100, y: 100, w: 50, h: 50, rotation: 0 };
  // Edges land at 100/125/150; the only candidate is 300, far past tol 10.
  const snap = resolveMoveSnap(frame, 0, 0, [300], [], 10);
  assert.equal(snap.ox, 0);
  assert.equal(snap.guideX, null);
});

test("X and Y snap independently", () => {
  const frame = { x: 0, y: 0, w: 40, h: 40, rotation: 0 };
  // Left edge -> 100 (dx 3), top edge -> 200 (dy 4).
  const snap = resolveMoveSnap(frame, 97, 196, [100], [200], 6);
  assert.ok(near(snap.ox, 3) && near(snap.oy, 4), `ox=${snap.ox} oy=${snap.oy}`);
  assert.equal(snap.guideX, 100);
  assert.equal(snap.guideY, 200);
});

test("a rotated frame never snaps (its edges are not axis-aligned)", () => {
  const frame = { x: 100, y: 100, w: 50, h: 50, rotation: 30 };
  const snap = resolveMoveSnap(frame, 8, 8, [160], [160], 10);
  assert.equal(snap.ox, 0);
  assert.equal(snap.oy, 0);
  assert.equal(snap.guideX, null);
  assert.equal(snap.guideY, null);
});

test("the nearest candidate wins when several are in range", () => {
  const frame = { x: 0, y: 0, w: 10, h: 10, rotation: 0 };
  // Left edge at 0; candidates 3 and 1 both within tol 5 -> 1 is nearer.
  const snap = resolveMoveSnap(frame, 0, 0, [3, 1], [], 5);
  assert.equal(snap.guideX, 1);
  assert.ok(near(snap.ox, 1));
});
