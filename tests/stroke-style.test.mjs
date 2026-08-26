/**
 * Unit tests for vector stroke styling (document v5): dash / cap / join.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/stroke-style.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeStroke, setVectorStroke } from "../src/document/ops.ts";
import { validateStroke, validateDocument, cloneStroke } from "../src/document/factory.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

function docWithStrokedRect(stroke) {
  const doc = documentFromPreset(PRESETS[0]);
  doc.pages[0].layers.push({
    id: "L1",
    name: "rect",
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 100, y: 0, inX: 100, inY: 0, outX: 100, outY: 0 },
      { x: 100, y: 100, inX: 100, inY: 100, outX: 100, outY: 100 },
      { x: 0, y: 100, inX: 0, inY: 100, outX: 0, outY: 100 },
    ],
    fill: null,
    stroke: stroke ?? { color: RED, width: 2 },
  });
  doc.activeLayerIds = ["L1"];
  return doc;
}

// ── mergeStroke ────────────────────────────────────────────────────────────

test("mergeStroke keeps colour when only the width changes", () => {
  const prev = { color: RED, width: 2 };
  const next = mergeStroke(prev, { width: 8 }, BLUE);
  assert.deepEqual(next.color, RED);
  assert.equal(next.width, 8);
});

test("mergeStroke sets cap and join without disturbing width or colour", () => {
  const next = mergeStroke({ color: RED, width: 4 }, { cap: "round", join: "bevel" }, BLUE);
  assert.equal(next.cap, "round");
  assert.equal(next.join, "bevel");
  assert.equal(next.width, 4);
  assert.deepEqual(next.color, RED);
});

test("mergeStroke born from fallback colour when there is no prior stroke", () => {
  const next = mergeStroke(null, { width: 3 }, BLUE);
  assert.deepEqual(next.color, BLUE);
  assert.equal(next.width, 3);
});

test("mergeStroke applies a dash and an empty array clears it back to solid", () => {
  let s = mergeStroke({ color: RED, width: 2 }, { dash: [12, 6] }, BLUE);
  assert.deepEqual(s.dash, [12, 6]);
  s = mergeStroke(s, { dash: [] }, BLUE);
  assert.equal(s.dash, undefined);
});

test("mergeStroke does not mutate its inputs", () => {
  const prev = { color: RED, width: 2, dash: [4, 4] };
  const copy = JSON.parse(JSON.stringify(prev));
  mergeStroke(prev, { width: 9, dash: [8, 2] }, BLUE);
  assert.deepEqual(prev, copy);
});

// ── setVectorStroke ─────────────────────────────────────────────────────────

test("setVectorStroke patches the named layer and is immutable", () => {
  const doc = docWithStrokedRect();
  const next = setVectorStroke(doc, "L1", { width: 10, dash: [20, 5], cap: "square" }, BLUE);
  assert.equal(next.pages[0].layers[0].stroke.width, 10);
  assert.deepEqual(next.pages[0].layers[0].stroke.dash, [20, 5]);
  assert.equal(next.pages[0].layers[0].stroke.cap, "square");
  // original untouched
  assert.equal(doc.pages[0].layers[0].stroke.width, 2);
  assert.equal(doc.pages[0].layers[0].stroke.dash, undefined);
});

test("setVectorStroke skips locked layers", () => {
  const doc = docWithStrokedRect();
  doc.pages[0].layers[0].locked = true;
  const next = setVectorStroke(doc, "L1", { width: 40 }, BLUE);
  assert.equal(next.pages[0].layers[0].stroke.width, 2);
});

test("a styled stroke survives a JSON round-trip", () => {
  const styled = { color: RED, width: 5, dash: [10, 4], dashPhase: 3, cap: "round", join: "miter" };
  const round = JSON.parse(JSON.stringify(docWithStrokedRect(styled)));
  assert.deepEqual(round.pages[0].layers[0].stroke, styled);
});

test("cloneStroke deep-copies dash and preserves optional styling", () => {
  const s = { color: RED, width: 3, dash: [6, 2], cap: "square", join: "bevel", dashPhase: 1 };
  const c = cloneStroke(s);
  assert.deepEqual(c, s);
  c.dash[0] = 999;
  assert.equal(s.dash[0], 6, "clone must not alias the dash array");
});

// ── validateStroke ──────────────────────────────────────────────────────────

test("validateStroke accepts a well-formed styled stroke", () => {
  assert.deepEqual(validateStroke({ color: RED, width: 2, dash: [8, 4], cap: "round", join: "bevel" }, "x"), []);
});

test("validateStroke rejects an odd dash interval count", () => {
  const errs = validateStroke({ color: RED, width: 2, dash: [8, 4, 2] }, "x");
  assert.ok(errs.some((e) => /even number/.test(e)), errs.join(" | "));
});

test("validateStroke rejects a negative dash value", () => {
  const errs = validateStroke({ color: RED, width: 2, dash: [8, -4] }, "x");
  assert.ok(errs.some((e) => /finite and >= 0/.test(e)), errs.join(" | "));
});

test("validateStroke rejects an all-zero dash (draws nothing)", () => {
  const errs = validateStroke({ color: RED, width: 2, dash: [0, 0] }, "x");
  assert.ok(errs.some((e) => /all zeros/.test(e)), errs.join(" | "));
});

test("validateStroke rejects an unknown cap or join", () => {
  assert.ok(validateStroke({ color: RED, width: 2, cap: "flat" }, "x").some((e) => /cap must be/.test(e)));
  assert.ok(validateStroke({ color: RED, width: 2, join: "sharp" }, "x").some((e) => /join must be/.test(e)));
});

test("validateDocument passes for a current-version document carrying a dashed stroke", () => {
  const doc = docWithStrokedRect({ color: RED, width: 3, dash: [12, 6], cap: "round" });
  // Factory documents are stamped at the current DOC_VERSION (now 6 after ADR 0005).
  assert.equal(doc.version, 6);
  assert.deepEqual(validateDocument(doc), []);
});

test("validateDocument flags a malformed stroke on an otherwise valid document", () => {
  const doc = docWithStrokedRect({ color: RED, width: 3, dash: [12, 6, 3] });
  const errs = validateDocument(doc);
  assert.ok(errs.some((e) => /even number/.test(e)), errs.join(" | "));
});
