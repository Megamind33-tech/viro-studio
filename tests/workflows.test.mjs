/**
 * Automated workflows — named Anchor batches, not flattened pictures.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/workflows.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ANCHOR_OP_NAMES } from "../src/anchor/tools.ts";
import { WORKFLOWS } from "../src/library/workflows.ts";

test("every workflow is a non-empty batch of real Anchor ops with an audit reason", () => {
  assert.ok(WORKFLOWS.length >= 3);
  const known = new Set(ANCHOR_OP_NAMES);
  for (const wf of WORKFLOWS) {
    const ops = wf.build({ width: 1080, height: 1350, fg: { r: 0.88, g: 0.48, b: 0.18, a: 1 } });
    assert.ok(ops.length >= 1, `${wf.id} produced no ops`);
    for (const op of ops) {
      assert.ok(known.has(op.op), `${wf.id} uses unknown op ${op.op}`);
      assert.ok(typeof op.reason === "string" && op.reason.trim().length >= 3, `${wf.id} missing reason`);
    }
  }
});

test("headline lockup creates a line and two type frames", () => {
  const wf = WORKFLOWS.find((w) => w.id === "headline-lockup");
  assert.ok(wf);
  const ops = wf.build({ width: 2480, height: 3508, fg: { r: 1, g: 0, b: 0, a: 1 } });
  assert.equal(ops.filter((o) => o.op === "press.add_line").length, 1);
  assert.equal(ops.filter((o) => o.op === "press.add_type_frame").length, 2);
});

test("quote card is a plate plus two type frames", () => {
  const wf = WORKFLOWS.find((w) => w.id === "quote-card");
  assert.ok(wf);
  const ops = wf.build({ width: 1080, height: 1350, fg: { r: 0.88, g: 0.48, b: 0.18, a: 1 } });
  assert.ok(ops.some((o) => o.op === "press.add_round_rect"));
  assert.equal(ops.filter((o) => o.op === "press.add_type_frame").length, 2);
});

test("star badge uses press.add_star, not a baked icon", () => {
  const wf = WORKFLOWS.find((w) => w.id === "star-badge");
  assert.ok(wf);
  const ops = wf.build({ width: 1080, height: 1080, fg: { r: 0.88, g: 0.48, b: 0.18, a: 1 } });
  const star = ops.find((o) => o.op === "press.add_star");
  assert.ok(star);
  assert.equal(star.params.points, 5);
});

test("column grid drops two real vertical guides and a type frame between them", () => {
  const wf = WORKFLOWS.find((w) => w.id === "column-grid");
  assert.ok(wf);
  const ops = wf.build({ width: 1080, height: 1350, fg: { r: 0.88, g: 0.48, b: 0.18, a: 1 } });
  const guides = ops.filter((o) => o.op === "press.add_guide");
  assert.equal(guides.length, 2);
  assert.equal(guides[0].params.axis, "v");
  assert.equal(guides[0].params.offset, 360);
  assert.equal(guides[1].params.offset, 720);
  const type = ops.find((o) => o.op === "press.add_type_frame");
  assert.ok(type);
  assert.ok(type.params.x > 360 && type.params.x + type.params.w < 720);
});
