/**
 * VIRO-0014 negative-input corpus for the font and image upload paths.
 * All generators are pure and seeded so every byte sequence is reproducible.
 *
 * BEFORE-STATE (probed on origin/main 9f0ed70, Node 24, harfbuzzjs WASM):
 *   - loadFace("x", name, anyBytes) SUCCEEDS on literal text, empty buffers,
 *     and even a 50%-truncated real TTF — HarfBuzz recovers leniently, so a
 *     corrupted font registers, shapes (possibly garbage), and its raw bytes
 *     are persisted to IndexedDB by FontRegistry.importBytes with no error.
 *   - FontRegistry.importBytes performs no magic-byte check, no size cap, and
 *     derives identity purely from the file name; family names retained path
 *     separators from hostile filenames.
 *   - sniffBytes classified fonts/images by extension fallback, so a text
 *     file named .ttf reached the font importer and a text file named .png
 *     reached the image decoder.
 *
 * VIRO-0014 HARDENING (this corpus now pins the hardened behaviour):
 *   - src/engine/font-registry.ts: validateFontBytes enforces size caps,
 *     container magic, minimum sane size and sfnt directory bounds before
 *     loadFace; rejections are FontImportError with the per-case `expectCode`.
 *     Filenames are sanitized (path separators, NULs, length) before
 *     prettyFamily. Persistence stays strictly after successful decode.
 *   - src/engine/sniff.ts: image/font kinds are only produced by a real
 *     magic match; extension lies classify "unknown" (recorded in `sniff`).
 *     validateImageBytes enforces caps + container integrity as
 *     ImageImportError with the per-case `imageCode`.
 *
 * VERSION HISTORY
 *   1 — prep draft: recorded before-state classifications (extension lies
 *       classified as font/image).
 *   2 — hardened classification: six extension-lie / zero-byte entries now
 *       record "unknown" (sniff refuses the lie); per-case error-code fields
 *       added (`expectCode`, `imageCode`); the hostile BMP generator now
 *       writes spec-conformant little-endian header fields (v1's big-endian
 *       DataView defaults produced a header no spec reader could parse, so
 *       the dims-bomb path was never actually exercised). Digest changes for
 *       these recorded reasons.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export const SANITIZE_CORPUS_VERSION = 2;

/** Read-only positive control: a real, shipping TTF. */
export function validRealTtf() {
  const here = dirname(fileURLToPath(import.meta.url));
  const buf = readFileSync(join(here, "..", "public", "fonts", "NotoSans-Regular.ttf"));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Minimal sfnt header: magic + numTables, with `tables` bogus directory entries. */
export function sfnt(magic, numTables, dirEntries = 0) {
  const size = 12 + dirEntries * 16 + 64;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(magic, 0);
  view.setUint16(4, numTables);
  for (let i = 0; i < dirEntries; i++) {
    const at = 12 + i * 16;
    view.setUint32(at, 0x676c7966); // "glyf"
    view.setUint32(at + 8, 0xfffffff0); // offset far beyond the blob
    view.setUint32(at + 12, 0x0000ffff); // length
  }
  return bytes;
}

export const FONT_TTF_MAGIC = [0x00, 0x01, 0x00, 0x00];
export const FONT_OTF_MAGIC = [0x4f, 0x54, 0x54, 0x4f]; // "OTTO"
export const FONT_TRUE_MAGIC = [0x74, 0x72, 0x75, 0x65]; // "true"
export const FONT_TTC_MAGIC = [0x74, 0x74, 0x63, 0x66]; // "ttcf"
export const FONT_WOFF_MAGIC = [0x77, 0x4f, 0x46, 0x46]; // "wOFF"
export const FONT_WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32]; // "wOF2"

export function buildFontCorpus() {
  const real = validRealTtf();
  const textBytes = new TextEncoder().encode("this is definitely not a font file");
  return [
    { id: "font/valid-real-ttf", name: "NotoSans-Regular.ttf", input: real, sniff: "font", family: "magic+structure" },
    { id: "font/zero-length", name: "empty.ttf", input: new Uint8Array(0), sniff: "unknown", family: "zero-length", expectCode: "too-small" },
    { id: "font/text-as-ttf", name: "readme.ttf", input: textBytes, sniff: "unknown", family: "wrong-magic", expectCode: "bad-magic" },
    { id: "font/truncated-50pct", name: "cut.ttf", input: real.slice(0, Math.floor(real.byteLength / 2)), sniff: "font", family: "truncated", expectCode: "undecodable" },
    { id: "font/truncated-header-12b", name: "stub.ttf", input: real.slice(0, 12), sniff: "font", family: "truncated", expectCode: "too-small" },
    {
      id: "font/psd-magic-as-ttf",
      name: "polyglot.ttf",
      input: new Uint8Array([0x38, 0x42, 0x50, 0x53, 0, 1, 0, 0, ...textBytes]),
      sniff: "unknown",
      family: "wrong-magic",
      expectCode: "bad-magic",
    },
    { id: "font/sfnt-hostile-table-dir", name: "hostile.ttf", input: sfnt(FONT_TTF_MAGIC, 0xffff, 4), sniff: "font", family: "hostile-structure", expectCode: "undecodable" },
    { id: "font/sfnt-claims-zero-tables", name: "void.ttf", input: sfnt(FONT_TTF_MAGIC, 0), sniff: "font", family: "hostile-structure", expectCode: "undecodable" },
    { id: "font/ttc-garbage", name: "collection.ttc", input: new Uint8Array([...FONT_TTC_MAGIC, 0, 0, 1, 0, 0xde, 0xad]), sniff: "font", family: "wrong-magic", expectCode: "too-small" },
    { id: "font/woff-broken", name: "broken.woff", input: new Uint8Array([...FONT_WOFF_MAGIC, 0, 0, 0, 3, 0xde, 0xad]), sniff: "font", family: "wrong-magic", expectCode: "too-small" },
    { id: "font/woff2-broken", name: "broken.woff2", input: new Uint8Array([...FONT_WOFF2_MAGIC, 0, 0, 0, 3, 0xde, 0xad]), sniff: "font", family: "wrong-magic", expectCode: "too-small" },
    { id: "font/otf-broken", name: "broken.otf", input: new Uint8Array([...FONT_OTF_MAGIC, 0, 0, 0, 1, 0xde, 0xad]), sniff: "font", family: "wrong-magic", expectCode: "too-small" },
    { id: "font/true-garbage", name: "classic.ttf", input: new Uint8Array([...FONT_TRUE_MAGIC, 0xff, 0xff, 0xff, 0xff]), sniff: "font", family: "wrong-magic", expectCode: "too-small" },
    {
      id: "font/oversized-zeros",
      name: "bloat.ttf",
      input: (() => {
        const big = new Uint8Array(25 * 1024 * 1024); // above any sane font cap
        big.set(FONT_TTF_MAGIC, 0);
        return big;
      })(),
      sniff: "font",
      family: "oversized",
      expectCode: "too-large",
    },
    { id: "font/name-path-traversal", name: "..\\..\\windows\\evil.ttf", input: textBytes, sniff: "unknown", family: "hostile-name", expectCode: "bad-magic" },
    { id: "font/name-nul-byte", name: "evil\u0000.ttf", input: textBytes, sniff: "unknown", family: "hostile-name", expectCode: "bad-magic" },
    { id: "font/name-300-chars", name: `${"a".repeat(300)}.ttf`, input: textBytes, sniff: "unknown", family: "hostile-name", expectCode: "bad-magic" },
  ];
}

export function buildImageCorpus() {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = (width, height) => [
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, // IHDR length+type
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0, // depth, RGBA, deflate, filter, interlace
  ];
  const textBytes = new TextEncoder().encode("<script>alert(1)</script>");
  return [
    { id: "image/zero-byte-png", name: "empty.png", input: new Uint8Array(0), sniff: "unknown", family: "zero-length", imageCode: "empty" },
    { id: "image/png-signature-only", name: "stub.png", input: new Uint8Array(pngSignature), sniff: "image", family: "truncated", imageCode: "truncated" },
    {
      id: "image/png-hostile-ihdr-dims",
      name: "huge.png",
      input: new Uint8Array([...pngSignature, ...ihdr(0x7fffffff, 0x7fffffff)]),
      sniff: "image",
      family: "oversized-dimensions",
      imageCode: "bad-dimensions",
    },
    {
      id: "image/png-script-tail",
      name: "polyglot.png",
      input: new Uint8Array([...pngSignature, ...ihdr(2, 2), ...textBytes]),
      sniff: "image",
      family: "hostile-payload",
      // No imageCode: a genuine 2x2 PNG with an inert script tail must pass
      // the boundary and fail (contained) only if the decode itself chokes.
      imageCode: null,
    },
    { id: "image/jpeg-magic-garbage", name: "fake.jpg", input: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xde, 0xad, 0xbe, 0xef]), sniff: "image", family: "truncated", imageCode: "truncated" },
    { id: "image/gif-header-only", name: "stub.gif", input: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), sniff: "image", family: "truncated", imageCode: "truncated" },
    {
      id: "image/bmp-huge-dims",
      name: "huge.bmp",
      input: (() => {
        const b = new Uint8Array(26);
        const v = new DataView(b.buffer);
        b.set([0x42, 0x4d]); // "BM"
        v.setUint32(2, 26, true); // BMP header fields are little-endian per spec
        v.setUint32(14, 12, true); // DIB header size (BITMAPCOREHEADER → int16 dims)
        v.setUint16(18, 0xffff, true); // width
        v.setUint16(20, 0xffff, true); // height
        return b;
      })(),
      sniff: "image",
      family: "oversized-dimensions",
      imageCode: "bad-dimensions",
    },
    { id: "image/webp-riff-truncated", name: "stub.webp", input: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), sniff: "image", family: "truncated", imageCode: "truncated" },
    { id: "image/text-as-png", name: "notes.png", input: textBytes, sniff: "unknown", family: "wrong-magic", imageCode: "wrong-magic" },
  ];
}

/** SHA-256 over the sorted corpus inputs; asserted by the runner so any generator drift fails loudly. */
export function corpusDigest(cases) {
  const hash = createHash("sha256");
  for (const c of [...cases].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    hash.update(`${c.id}\n${c.name}\n${c.sniff}\n${c.family}\n`);
    hash.update(createHash("sha256").update(c.input).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}
