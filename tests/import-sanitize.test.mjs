/**
 * VIRO-0014 regression suite: font/image import sanitization hardening.
 * See import-sanitize-corpus.mjs for the corpus, the probed before-state, and
 * the version history. The suite now runs in hardened mode: hostile fonts are
 * typed-rejected at the registry boundary before decode/persistence, and the
 * sniff classifier refuses extension lies. Set MODE = "before-state" only to
 * re-derive the pre-fix behaviour on an unhardened base.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/import-sanitize.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sniffBytes, validateImageBytes } from "../src/engine/sniff.ts";
import { loadFace } from "../src/engine/type.ts";
import { FontRegistry } from "../src/engine/font-registry.ts";
import {
  buildFontCorpus,
  buildImageCorpus,
  corpusDigest,
  validRealTtf,
} from "./import-sanitize-corpus.mjs";

const MODE = "hardened"; // VIRO-0014 boundary is live; flip to "before-state" only for pre-fix archaeology

const fonts = buildFontCorpus();
const images = buildImageCorpus();

function arrayBufferOf(input) {
  return input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    : input;
}

test("sanitizer corpus is deterministic (digest stable across two builds)", () => {
  assert.equal(corpusDigest(fonts), corpusDigest(buildFontCorpus()));
  assert.equal(corpusDigest(images), corpusDigest(buildImageCorpus()));
  assert.ok(fonts.length >= 15, `font corpus substantial (${fonts.length})`);
  assert.ok(images.length >= 9, `image corpus substantial (${images.length})`);
});

test("sniffBytes hardened classification: magic-true kinds carry magic, extension lies are refused", () => {
  for (const kase of [...fonts, ...images]) {
    const sniffed = sniffBytes(kase.name, arrayBufferOf(kase.input));
    assert.equal(sniffed.kind, kase.sniff, `${kase.id}: sniff classification`);
    if (sniffed.kind === "image" || sniffed.kind === "font") {
      assert.ok(sniffed.magic, `${kase.id}: image/font kind must come from a real magic match`);
    } else {
      assert.equal(sniffed.magic, null, `${kase.id}: non-magic classification carries no magic`);
    }
  }
  // The extension-fallback lies the pre-fix classifier honoured (VIRO-0014
  // before-state) must stay refused:
  assert.equal(sniffBytes("readme.ttf", arrayBufferOf(new TextEncoder().encode("text"))).kind, "unknown", "text named .ttf must not reach the font path");
  assert.equal(sniffBytes("notes.png", arrayBufferOf(new TextEncoder().encode("<script>"))).kind, "unknown", "text named .png must not reach the image path");
});

test("loadFace never crashes the process on hostile fonts (degenerate acceptance documented)", async () => {
  for (const kase of fonts) {
    if (kase.id === "font/oversized-zeros") continue; // exercised below, once
    const pack = await loadFace(kase.id.replace(/\W+/g, "-"), kase.name, arrayBufferOf(kase.input));
    assert.ok(pack && pack.upem > 0, `${kase.id}: degenerate pack returned, process alive`);
  }
  // Positive control: the real face has real metrics and a space glyph.
  const real = await loadFace("positive-control", "NotoSans-Regular.ttf", arrayBufferOf(validRealTtf()));
  assert.equal(real.upem, 1000);
  assert.ok(real.ascender > 0 && real.descender < 0, "real face has sane extents");
  assert.ok(real.spaceGid >= 0, "real face shapes a space glyph");
});

test("FontRegistry.importBytes hardened: typed rejection before decode, valid files unchanged", { skip: MODE !== "hardened" }, async () => {
  const registry = new FontRegistry();
  for (const kase of fonts) {
    if (kase.id === "font/valid-real-ttf") continue;
    await assert.rejects(
      registry.importBytes(kase.name, arrayBufferOf(kase.input), false),
      (err) => {
        assert.equal(err.name, "FontImportError", `${kase.id}: typed rejection`);
        assert.equal(err.code, kase.expectCode, `${kase.id}: rejection code`);
        return true;
      },
      `${kase.id}: hostile font must be rejected`,
    );
  }
  // Positive control: valid bytes keep importing with a real face.
  const rec = await registry.importBytes("NotoSans-Regular.ttf", arrayBufferOf(validRealTtf()), false);
  assert.ok(rec?.face, "font/valid-real-ttf: valid font still imports");
  assert.equal(rec.family, "NotoSans", "valid filename yields the same family as before the hardening");
  // Filename sanitization is observable on VALID bytes under a hostile name:
  // traversal separators and NULs never reach id/family.
  const hostileNamed = await registry.importBytes("..\\..\\windows\\evil\u0000.ttf", arrayBufferOf(validRealTtf()), false);
  assert.ok(hostileNamed?.face, "hostile-named valid font still imports");
  assert.ok(!/[\\/]/.test(hostileNamed.family) && !hostileNamed.family.includes("\u0000"), "family is separator-free");
  assert.ok(!/[\\/]/.test(hostileNamed.id), "id is separator-free");
});

test("image boundary: validateImageBytes types every hostile container; valid containers pass", () => {
  let rejected = 0;
  for (const kase of images) {
    if (kase.imageCode) {
      assert.throws(
        () => validateImageBytes(kase.name, arrayBufferOf(kase.input)),
        (err) => {
          assert.equal(err.name, "ImageImportError", `${kase.id}: typed image rejection`);
          assert.equal(err.code, kase.imageCode, `${kase.id}: image rejection code`);
          return true;
        },
        `${kase.id}: hostile image must be rejected pre-decode`,
      );
      rejected++;
    } else {
      assert.doesNotThrow(
        () => validateImageBytes(kase.name, arrayBufferOf(kase.input)),
        `${kase.id}: genuine container passes the boundary`,
      );
    }
  }
  assert.ok(rejected >= 7, `hostile image coverage (${rejected} typed rejections)`);
  // A real-world-sized image passes; the DOM decode stays browser-side.
  const realPng = images.find((k) => k.id === "image/png-script-tail");
  assert.doesNotThrow(() => validateImageBytes(realPng.name, arrayBufferOf(realPng.input)));
});
