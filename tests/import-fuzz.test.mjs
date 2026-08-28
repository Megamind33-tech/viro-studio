/**
 * Import parser fuzz/negative corpus runner (VIRO-0013).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/import-fuzz.test.mjs
 *
 * Proves the import-boundary guarantee: every malformed input — truncated
 * PSDs, wrong magic bytes, zero-length files, oversized dimensions/counts,
 * deep nesting, hostile JSON keys / prototype-pollution patterns — is either
 * imported as a document or rejected as a typed `ImportParseError`. Nothing
 * else may escape the boundary. Seeded fuzz sections complete in-place inside
 * the normal unit-test time budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { initializeCanvas } from "ag-psd";
import { ImportParseError } from "../src/import/errors.ts";
import { documentFromPsd } from "../src/import/psd.ts";
import { documentFromVdj } from "../src/import/vdj.ts";
import { openJsonDocument } from "../src/import/pressjson.ts";
import {
  CORPUS_SEED,
  CORPUS_VERSION,
  FUZZ_ITERATIONS,
  buildCorpus,
  mulberry32,
  validCompositePsd,
  validLayeredPsd,
  validPressJsonText,
  validVdjText,
} from "./import-corpus.mjs";

/* ------------------------------------------------------------------ *
 * Minimal but REAL canvas shim so ag-psd can decode image data under
 * Node. toDataURL encodes the actual stored pixels as a genuine PNG
 * (zlib-deflated, CRC-32'd) — no fake data, so round-trip assertions
 * check true pixel content.
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (1 + width * 4) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), "dataURL decodes to a real PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit channels");
      assert.equal(data[9], 6, "RGBA colour type");
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (1 + width * 4)], 0, "scanline filter is none");
    raw.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)).forEach((v, i) => {
      rgba[y * width * 4 + i] = v;
    });
  }
  return { width, height, data: rgba };
}

let canvasInstances = 0;
initializeCanvas((width, height) => {
  canvasInstances++;
  let pixels = null;
  const ctx = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => {
      pixels = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
    },
    getImageData: (x, y, w, h) => {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        out.set(pixels.data.subarray(((y + row) * pixels.width + x) * 4, ((y + row) * pixels.width + x + w) * 4), row * w * 4);
      }
      return { width: w, height: h, data: out };
    },
  };
  return {
    width,
    height,
    getContext: () => ctx,
    toDataURL: () => `data:image/png;base64,${encodePng(pixels.width, pixels.height, pixels.data).toString("base64")}`,
  };
});

/* ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "fixtures/import-corpus/manifest.json"), "utf8"));

function dataUrlBytes(dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  return Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
}

/** Drive one corpus case through its boundary and classify the outcome. */
function runCase(kase) {
  const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();
  try {
    let result;
    if (kase.boundary === "documentFromPsd") {
      const buffer = kase.input instanceof Uint8Array ? kase.input.slice().buffer : kase.input;
      result = { doc: documentFromPsd(buffer, `${kase.id.replace(/\W+/g, "-")}.psd`) };
    } else if (kase.boundary === "documentFromVdj") {
      result = { doc: documentFromVdj(JSON.parse(kase.input), `${kase.id.replace(/\W+/g, "-")}.vdj`) };
    } else {
      result = openJsonDocument(kase.input, `${kase.id.replace(/\W+/g, "-")}.json`);
    }
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), prototypeKeys, `${kase.id}: Object.prototype polluted`);
    return { status: "doc", result };
  } catch (err) {
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), prototypeKeys, `${kase.id}: Object.prototype polluted`);
    if (err instanceof ImportParseError) return { status: "typed", error: err };
    // Anything else escaping the boundary is the failure this suite exists to catch.
    throw new assert.AssertionError({
      message: `${kase.id}: untyped ${err.constructor.name} escaped the import boundary: ${err.message}`,
    });
  }
}

function assertCaseOutcome(kase, outcome) {
  if (kase.outcome === "safe-doc") {
    assert.equal(outcome.status, "doc", `${kase.id}: expected a safe document`);
    assert.ok(outcome.result.doc && typeof outcome.result.doc === "object", `${kase.id}: result is a document object`);
  } else {
    assert.equal(outcome.status, "typed", `${kase.id}: expected a typed ImportParseError`);
    assert.equal(outcome.error.format, kase.format, `${kase.id}: rejection format matches`);
    if (kase.code) assert.equal(outcome.error.code, kase.code, `${kase.id}: rejection code matches`);
  }
}

test("corpus is versioned, matches its manifest, and is byte-deterministic", () => {
  const first = buildCorpus();
  const second = buildCorpus();
  assert.equal(first.corpusDigest, second.corpusDigest, "two in-process generations agree");
  assert.equal(manifest.corpusVersion, CORPUS_VERSION);
  assert.equal(manifest.seed, CORPUS_SEED);
  assert.equal(manifest.corpusDigest, first.corpusDigest, "corpus digest matches the frozen manifest");

  const rows = first.cases.map((c) => ({
    id: c.id,
    format: c.format,
    category: c.category,
    boundary: c.boundary,
    outcome: c.outcome,
    code: c.code ?? null,
  }));
  assert.deepEqual(rows, manifest.cases, "manifest enumerates exactly the built corpus");
  assert.ok(first.cases.length >= 30, `corpus is substantial (${first.cases.length} cases)`);

  const categories = new Set(first.cases.map((c) => c.category));
  for (const required of [
    "zero-length",
    "truncated",
    "wrong-magic-bytes",
    "oversized-dimensions",
    "oversized-counts",
    "deep-nesting",
    "hostile-keys",
    "malformed-json",
    "valid-baseline",
  ]) {
    assert.ok(categories.has(required), `category ${required} present`);
  }
});

test("every corpus case ends in a document or a typed rejection — never an escape", () => {
  const { cases } = buildCorpus();
  const tally = { doc: 0, typed: 0 };
  for (const kase of cases) {
    const outcome = runCase(kase);
    assertCaseOutcome(kase, outcome);
    tally[outcome.status] += 1;
  }
  assert.ok(tally.typed > 0 && tally.doc > 0, `both behaviours exercised: ${JSON.stringify(tally)}`);
});

test("seeded PSD fuzz: mutations of a valid PSD never escape the typed boundary", () => {
  const base = validLayeredPsd();
  const run = () => {
    const rng = mulberry32(CORPUS_SEED ^ 0x5d5d);
    const lines = [];
    for (let i = 0; i < FUZZ_ITERATIONS.psd; i++) {
      let bytes = new Uint8Array(base.slice());
      const kind = (() => {
        const roll = rng();
        if (roll < 0.7) return "flip";
        if (roll < 0.85) return "truncate";
        return "insert";
      })();
      if (kind === "flip") {
        const flips = 1 + Math.floor(rng() * 6);
        for (let f = 0; f < flips; f++) {
          bytes[Math.floor(rng() * bytes.byteLength)] ^= 1 + Math.floor(rng() * 255);
        }
      } else if (kind === "truncate") {
        bytes = bytes.slice(0, Math.floor(rng() * bytes.byteLength));
      } else {
        const at = Math.floor(rng() * bytes.byteLength);
        const out = new Uint8Array(bytes.byteLength + 4);
        out.set(bytes.subarray(0, at), 0);
        out.set([0x38, 0x42, 0x50, 0x53], at); // splice in a PSD signature
        out.set(bytes.subarray(at), at + 4);
        bytes = out;
      }
      const kase = { id: `fuzz-psd#${i}:${kind}`, format: "psd", boundary: "documentFromPsd", input: bytes, outcome: "?" };
      const outcome = runCase(kase);
      lines.push(outcome.status === "typed" ? `${i} ${kind} typed ${outcome.error.code}` : `${i} ${kind} doc`);
    }
    return lines;
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second, "two seeded runs classify identically");
  assert.equal(first.length, FUZZ_ITERATIONS.psd, "every iteration classified");
  const digest = createHash("sha256").update(first.join("\n")).digest("hex");
  console.log(`[import-fuzz] psd outcome digest ${digest}`);
});

test("seeded JSON fuzz: mutations of valid VDJ/Press JSON never escape the typed boundary", () => {
  const bases = [validVdjText(), validPressJsonText()];
  const run = () => {
    const rng = mulberry32(CORPUS_SEED ^ 0x6a6a);
    const lines = [];
    for (let i = 0; i < FUZZ_ITERATIONS.json; i++) {
      let text = bases[i % bases.length];
      const ops = 1 + Math.floor(rng() * 8);
      for (let op = 0; op < ops; op++) {
        const roll = rng();
        const at = Math.floor(rng() * text.length);
        if (roll < 0.4) {
          const pool = '{}[]":,.0123456789 nulltruefalse';
          text = text.slice(0, at) + pool[Math.floor(rng() * pool.length)] + text.slice(at + 1);
        } else if (roll < 0.7) {
          text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rng() * 6));
        } else if (roll < 0.9) {
          text = text.slice(0, at) + '"__proto__":{},' + text.slice(at);
        } else {
          const pool = "0123456789abcdef";
          text = text.slice(0, at) + pool[Math.floor(rng() * pool.length)] + text.slice(at);
        }
      }
      const kase = { id: `fuzz-json#${i}`, format: "press-json", boundary: "openJsonDocument", input: text, outcome: "?" };
      const outcome = runCase(kase);
      lines.push(
        outcome.status === "typed"
          ? `${i} typed ${outcome.error.format}/${outcome.error.code}`
          : `${i} doc ${outcome.result.kind}`,
      );
    }
    return lines;
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second, "two seeded runs classify identically");
  assert.equal(first.length, FUZZ_ITERATIONS.json, "every iteration classified");
  const digest = createHash("sha256").update(first.join("\n")).digest("hex");
  console.log(`[import-fuzz] json outcome digest ${digest}`);
});

test("valid PSD composite: real bytes round-trip into the document model", () => {
  const bytes = validCompositePsd();
  const doc = documentFromPsd(bytes, "composite-round-trip.psd");
  assert.equal(doc.name, "composite-round-trip");
  const page = doc.pages[0];
  assert.equal(page.widthPx, 4);
  assert.equal(page.heightPx, 2);
  // ag-psd synthesises a single child record for a flattened file but gives
  // the composite pixels to `psd.canvas`, not to that child, so the walk —
  // matching the pre-hardening behaviour exactly — imports the page geometry
  // with no pixel layer. The pixel round-trip proof is the layered PSD below.
  assert.equal(page.layers.length, 0);
});

test("valid PSD layered: group structure and child layers survive the walk", () => {
  const doc = documentFromPsd(validLayeredPsd(), "layered-round-trip.psd");
  const layers = doc.pages[0].layers;
  assert.equal(layers.length, 3, "group + child + sibling");
  assert.equal(layers[0].kind, "group");
  assert.equal(layers[0].name, "Grp");
  assert.equal(layers[1].kind, "image-frame");
  assert.equal(layers[1].parentId, layers[0].id, "child parented to the group");
  assert.equal(layers[1].transform.w, 2);
  assert.equal(layers[1].transform.h, 2);
  const green = decodePng(dataUrlBytes(doc.assets[layers[1].assetId].dataUrl));
  assert.deepEqual([green.data[0], green.data[1], green.data[2], green.data[3]], [0, 255, 0, 255]);
  assert.equal(layers[2].parentId, null, "sibling sits at root");
  const blue = decodePng(dataUrlBytes(doc.assets[layers[2].assetId].dataUrl));
  assert.deepEqual([blue.data[0], blue.data[1], blue.data[2], blue.data[3]], [0, 0, 255, 255]);
});

test("valid VDJ import is unchanged by hardening", () => {
  const result = openJsonDocument(validVdjText(), "poster.vdj");
  assert.equal(result.kind, "vdj");
  const doc = result.doc;
  assert.equal(doc.name, "Poster");
  assert.equal(doc.pages[0].widthPx, 800);
  assert.equal(doc.pages[0].heightPx, 600);
  assert.equal(doc.pages[0].layers.length, 3);
  assert.equal(doc.pages[0].layers[0].kind, "vector");
  assert.equal(doc.pages[0].layers[1].kind, "type-frame");
  assert.equal(doc.pages[0].layers[2].kind, "image-frame");
  const direct = documentFromVdj(JSON.parse(validVdjText()), "poster.vdj");
  assert.equal(direct.pages[0].layers.length, 3);
});

test("valid Press JSON import is unchanged by hardening", () => {
  const text = validPressJsonText();
  const result = openJsonDocument(text, "corpus-press.press.json");
  assert.equal(result.kind, "press");
  assert.deepEqual(
    result.doc,
    JSON.parse(text),
    "a current-version document passes through migration untouched",
  );
  assert.match(result.report.notes.join("; "), /already version 6/);
});
