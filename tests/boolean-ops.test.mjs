/**
 * Unit tests for the ADR 0005 Phase-0 proof boolean (`subtract`) and the v6
 * multi-contour validation. Loads the real CanvasKit (Skia) engine in Node —
 * the same build the compositor uses — so `Path.makeCombined(Difference)` is
 * exercised for real, then asserts the extracted `contours[]` model.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/boolean-ops.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subtractVectors, booleanCombineVectors } from "../src/document/boolean-ops.ts";
import { validateContours } from "../src/document/factory.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert.ok(existsSync(ckWasm), "canvaskit.wasm missing");
const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });

const rectNodes = (w, h) => {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
};

function vectorRect(id, x, y, w, h) {
  return {
    id,
    kind: "vector",
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: rectNodes(w, h),
    fill: { r: 0, g: 0, b: 0, a: 1 },
    stroke: null,
  };
}

test("subtract punches a hole: outer rect minus a fully-contained inner rect yields 2 contours", () => {
  const outer = vectorRect("outer", 100, 100, 200, 200); // page 100..300
  const inner = vectorRect("inner", 150, 150, 100, 100); // page 150..250, inside outer
  const page = { id: "p", layers: [outer, inner] };

  // top (outer) minus beneath (inner).
  const result = subtractVectors(ck, page, outer, inner);
  assert.ok(result, "subtract must produce a result layer");
  assert.equal(result.kind, "vector");
  assert.ok(Array.isArray(result.contours), "result carries the v6 contours[] model");
  assert.equal(result.contours.length, 2, "an outer ring plus one hole contour");
  for (const c of result.contours) assert.ok(c.nodes.length >= 2, "each contour has >= 2 nodes");

  // The result box is the outer rect's page-space bounds.
  const t = result.transform;
  assert.ok(Math.abs(t.x - 100) < 1e-6 && Math.abs(t.y - 100) < 1e-6, `origin ${t.x},${t.y}`);
  assert.ok(Math.abs(t.w - 200) < 1e-6 && Math.abs(t.h - 200) < 1e-6, `size ${t.w}x${t.h}`);
});

test("subtract result validates as a well-formed compound path", () => {
  const outer = vectorRect("outer", 0, 0, 200, 200);
  const inner = vectorRect("inner", 50, 50, 100, 100);
  const page = { id: "p", layers: [outer, inner] };
  const result = subtractVectors(ck, page, outer, inner);
  assert.ok(result);
  assert.deepEqual(validateContours(result.contours, "result"), [], "no validation problems");
});

test("subtract result round-trips through JSON save/open unchanged", () => {
  const outer = vectorRect("outer", 0, 0, 200, 200);
  const inner = vectorRect("inner", 50, 50, 100, 100);
  const page = { id: "p", layers: [outer, inner] };
  const result = subtractVectors(ck, page, outer, inner);
  assert.ok(result);
  const round = JSON.parse(JSON.stringify(result));
  assert.deepEqual(round.contours, result.contours, "contours survive serialization byte-for-byte");
});

test("subtract that removes everything returns null instead of an empty layer", () => {
  const small = vectorRect("small", 100, 100, 50, 50); // top
  const big = vectorRect("big", 0, 0, 400, 400); // beneath, covers small entirely
  const page = { id: "p", layers: [small, big] };
  assert.equal(subtractVectors(ck, page, small, big), null);
});

test("union of two disjoint rectangles yields one layer with two contours", () => {
  const left = vectorRect("left", 0, 0, 100, 100);
  const right = vectorRect("right", 200, 0, 100, 100);
  const page = { id: "p", layers: [left, right] };
  const result = booleanCombineVectors(ck, page, [left, right], "union");
  assert.ok(result, "union must produce a result layer");
  assert.equal(result.contours.length, 2, "disjoint union yields two visible pieces");
});

test("intersect of non-overlapping rects returns null", () => {
  const a = vectorRect("a", 0, 0, 100, 100);
  const b = vectorRect("b", 200, 0, 100, 100);
  const page = { id: "p", layers: [a, b] };
  assert.equal(booleanCombineVectors(ck, page, [a, b], "intersect"), null);
});

test("exclude (XOR) of overlapping rects validates as a compound path", () => {
  const outer = vectorRect("outer", 0, 0, 200, 200);
  const inner = vectorRect("inner", 50, 50, 100, 100);
  const page = { id: "p", layers: [outer, inner] };
  const result = booleanCombineVectors(ck, page, [outer, inner], "exclude");
  assert.ok(result);
  assert.deepEqual(validateContours(result.contours, "result"), []);
});

test("validateContours rejects non-finite coordinates and short contours", () => {
  const bad = [
    { closed: true, nodes: [{ x: Number.NaN, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 1, y: 1, inX: 1, inY: 1, outX: 1, outY: 1 }] },
    { closed: true, nodes: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] },
  ];
  const errs = validateContours(bad, "x");
  assert.ok(errs.some((e) => /finite/.test(e)), "flags non-finite coords");
  assert.ok(errs.some((e) => /at least 2 nodes/.test(e)), "flags a 1-node contour");
});
