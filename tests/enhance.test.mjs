/**
 * Pixel algorithms for Filter > Enhance Details / Improve Lighting.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/enhance.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { enhanceRgba } from "../src/engine/enhance.ts";

function solid(w, h, r, g, b, a = 255) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

test("sharpen changes pixels on an edge (not a no-op)", () => {
  const w = 8;
  const h = 8;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x < 4 ? 40 : 220;
      src[i] = v;
      src[i + 1] = v;
      src[i + 2] = v;
      src[i + 3] = 255;
    }
  }
  const out = enhanceRgba(src, w, h, "sharpen");
  assert.equal(out.length, src.length);
  let changed = 0;
  for (let i = 0; i < src.length; i += 4) {
    if (out[i] !== src[i] || out[i + 1] !== src[i + 1] || out[i + 2] !== src[i + 2]) changed++;
  }
  assert.ok(changed > 0, "unsharp mask must alter edge pixels");
  // Alpha is preserved.
  for (let i = 3; i < src.length; i += 4) assert.equal(out[i], 255);
});

test("lighting stretches a dark buffer toward full range", () => {
  const w = 16;
  const h = 16;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = 20 + (i % 40); // 20..59
    src[i * 4] = v;
    src[i * 4 + 1] = v;
    src[i * 4 + 2] = v;
    src[i * 4 + 3] = 255;
  }
  const out = enhanceRgba(src, w, h, "lighting");
  let max = 0;
  for (let i = 0; i < out.length; i += 4) max = Math.max(max, out[i] ?? 0);
  assert.ok(max > 200, `auto-levels should lift 20–59 toward white, got max ${max}`);
});

test("lighting leaves a fully-transparent buffer untouched", () => {
  const src = solid(8, 8, 10, 20, 30, 0);
  const out = enhanceRgba(src, 8, 8, "lighting");
  assert.deepEqual(out, src);
});

test("rejects a buffer shorter than width×height", () => {
  assert.throws(() => enhanceRgba(new Uint8ClampedArray(4), 8, 8, "sharpen"), /shorter/);
});
