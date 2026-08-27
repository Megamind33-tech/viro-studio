/**
 * Unit tests for the feature-flag resolver (ADR 0004, GOVERNOR.md §12B).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/flags.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { flag, flags, setFlag, resetFlags } from "../src/platform/flags.ts";

test("defaults: local platform on, cloud + billing off until provisioned", () => {
  resetFlags();
  assert.equal(flag("platform.enabled"), true);
  assert.equal(flag("platform.cloud"), false);
  assert.equal(flag("platform.billing"), false);
});

test("in-memory override wins and can be cleared", () => {
  resetFlags();
  setFlag("platform.cloud", true);
  assert.equal(flag("platform.cloud"), true);
  setFlag("platform.cloud", undefined);
  assert.equal(flag("platform.cloud"), false);
  setFlag("platform.enabled", false);
  assert.equal(flag("platform.enabled"), false);
  resetFlags();
  assert.equal(flag("platform.enabled"), true);
});

test("flags() reports the full resolved map", () => {
  resetFlags();
  assert.deepEqual(flags(), {
    "platform.enabled": true,
    "platform.cloud": false,
    "platform.billing": false,
  });
});
