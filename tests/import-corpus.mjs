/**
 * Versioned fuzz/negative test corpus for the import parsers (VIRO-0013).
 *
 * The corpus is generated, not committed as binaries: every case is built by a
 * pure, seeded generator so the exact byte/text inputs are reproducible on any
 * machine, and `corpusDigest` (SHA-256 over the sorted per-case input hashes,
 * recorded in tests/fixtures/import-corpus/manifest.json) fails the test run
 * if generation ever stops being deterministic.
 *
 * Categories (frozen acceptance for VIRO-0013):
 *   zero-length, truncated, wrong-magic-bytes, oversized-dimensions,
 *   oversized-counts, deep-nesting, hostile-keys (prototype-pollution
 *   patterns), malformed-json, valid-baseline.
 *
 * Boundaries under proof:
 *   documentFromPsd          — src/import/psd.ts
 *   documentFromVdj          — src/import/vdj.ts
 *   openJsonDocument         — src/import/pressjson.ts (Press JSON + VDJ text gate)
 */
import { createHash } from "node:crypto";
import { writePsd } from "ag-psd";
import { createDocument } from "../src/document/factory.ts";

export const CORPUS_VERSION = 1;
export const CORPUS_SEED = 20260827;
export const FUZZ_ITERATIONS = { psd: 400, json: 400 };

/** Deterministic PRNG (mulberry32). Same seed → same mutation stream. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function solidPixels(w, h, [r, g, b]) {
  const channel = [r, g, b, 255];
  return {
    width: w,
    height: h,
    data: new Uint8ClampedArray(Array.from({ length: w * h * 4 }, (_, i) => channel[i % 4])),
  };
}

/** Real flattened PSD (composite image data only), written by ag-psd itself. */
export function validCompositePsd() {
  return writePsd({ width: 4, height: 2, imageData: solidPixels(4, 2, [220, 40, 40]) }, { generateThumbnail: false });
}

/** Real layered PSD: one group holding one layer, plus one sibling layer. */
export function validLayeredPsd() {
  return writePsd(
    {
      width: 6,
      height: 2,
      imageData: solidPixels(6, 2, [255, 0, 0]),
      children: [
        {
          name: "Grp",
          opened: true,
          children: [{ name: "L1", imageData: solidPixels(2, 2, [0, 255, 0]), left: 0, top: 0, right: 2, bottom: 2 }],
        },
        { name: "L2", imageData: solidPixels(2, 2, [0, 0, 255]), left: 4, top: 0, right: 6, bottom: 2 },
      ],
    },
    { generateThumbnail: false },
  );
}

/** Real PSD with a `depth`-deep chain of nested groups (iterable-walk proof). */
export function validDeepGroupPsd(depth) {
  let node = { name: "Leaf", imageData: solidPixels(2, 2, [9, 9, 9]), left: 0, top: 0, right: 2, bottom: 2 };
  for (let i = 0; i < depth; i++) node = { name: `G${i}`, opened: true, children: [node] };
  return writePsd({ width: 2, height: 2, imageData: solidPixels(2, 2, [1, 2, 3]), children: [node] }, { generateThumbnail: false });
}

/**
 * Hand-built PSD header (26-byte header + zero-length colour-mode section).
 * Nothing after the declared dimensions, so oversized claims hit the reader's
 * bounds check before any allocation can follow them.
 */
export function hostilePsdHeader(width, height, channels = 3) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x38, 0x42, 0x50, 0x53]); // "8BPS"
  view.setUint16(4, 1); // version: PSD
  view.setUint16(12, channels);
  view.setUint32(14, height);
  view.setUint32(18, width);
  view.setUint16(22, 8); // depth
  view.setUint16(24, 3); // mode: RGB
  view.setUint32(26, 0); // colour-mode section length
  return bytes;
}

/**
 * PSD whose layer section declares 0x7FFF layer records and then stops —
 * the oversized-count shape for the binary reader.
 */
export function hostilePsdLayerCount() {
  const bytes = new Uint8Array(42);
  const view = new DataView(bytes.buffer);
  bytes.set([0x38, 0x42, 0x50, 0x53]);
  view.setUint16(4, 1);
  view.setUint16(12, 3);
  view.setUint32(14, 2);
  view.setUint32(18, 2);
  view.setUint16(22, 8);
  view.setUint16(24, 3);
  view.setUint32(26, 0); // colour-mode length
  view.setUint32(30, 0); // image-resources length
  view.setUint32(34, 4); // layer-and-mask length
  view.setInt16(38, 0x7fff); // layer count: 32767 declared…
  view.setUint16(40, 0); // …and nothing follows
  return bytes;
}

export function validVdjText() {
  const doc = {
    version: "1",
    meta: { template: "Poster" },
    canvas: { w: 800, h: 600, dpi: 72, bleed: 0, background: "#ffffff" },
    layers: [
      { type: "rect", name: "BG", x: 0, y: 0, w: 800, h: 600, style: { fill: "#204080" }, opacity: 1, visible: true },
      {
        type: "text",
        name: "Head",
        x: 40,
        y: 60,
        w: 400,
        h: 80,
        blend: "normal",
        text: { value: "Hello VIRO", size: 42, leading: 1.2, tracking: 0, color: "#111111", align: "left" },
      },
      {
        type: "image",
        name: "Pic",
        x: 40,
        y: 200,
        w: 300,
        h: 200,
        image: { src: "data:image/png;base64,iVBORw0KGgo=", fit: "cover", focal: { x: 0.5, y: 0.5 } },
      },
    ],
  };
  return JSON.stringify(doc);
}

/**
 * Rewrite factory-generated uid strings (`pg_0_1`, `ly_0_2`, …) to position
 * independent tokens in encounter order. `uid()` counts calls in a module-level
 * counter, so two generations of the same document would otherwise differ in
 * every id and the corpus digest would drift within a single process.
 */
function canonicaliseIds(value, map = new Map()) {
  if (typeof value === "string") {
    if (/^[a-z]{1,6}_[0-9a-z]+_[0-9a-z]+$/.test(value)) {
      if (!map.has(value)) map.set(value, `id_${map.size + 1}`);
      return map.get(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => canonicaliseIds(v, map));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = canonicaliseIds(v, map);
    return out;
  }
  return value;
}

/** A real v6 Press document (current factory output), serialised for open. */
export function validPressJsonText() {
  // `uid()` stamps wall-clock time and a call counter into ids, so freeze the
  // clock and canonicalise the ids: the corpus digest must be identical on
  // every run, in and across processes.
  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const doc = createDocument({
      name: "Corpus Press",
      ppi: 96,
      widthPx: 640,
      heightPx: 480,
      bleedPx: 12,
      pageCount: 1,
      facingPages: false,
    });
    return JSON.stringify(canonicaliseIds(JSON.parse(JSON.stringify(doc))));
  } finally {
    Date.now = realNow;
  }
}

export function deepNestedArrays(depth) {
  return `${"[".repeat(depth)}${"]".repeat(depth)}`;
}

export function deepNestedObjects(depth) {
  // Built with repeat, not iterative concatenation, so generation stays linear.
  return `{"a":`.repeat(depth) + `{"leaf":1}` + `}`.repeat(depth);
}

export function oversizedLayerListText(count) {
  return JSON.stringify({ layers: Array.from({ length: count }, () => ({ type: "rect" })) });
}

/**
 * Build the full corpus. Returns `{ cases, corpusDigest }`. Every case:
 *   { id, format, category, boundary, input, outcome, code? }
 * where `input` is a Uint8Array (psd) or string (json), and `outcome` is the
 * guaranteed boundary behaviour: "safe-doc" or "typed-error".
 */
export function buildCorpus() {
  const cases = [];
  const add = (c) => cases.push(c);

  const composite = validCompositePsd();
  const layered = validLayeredPsd();

  // ---- valid baselines (also the fuzz mutation bases) ----
  add({ id: "psd/valid-composite", format: "psd", category: "valid-baseline", boundary: "documentFromPsd", input: composite, outcome: "safe-doc" });
  add({ id: "psd/valid-layered", format: "psd", category: "valid-baseline", boundary: "documentFromPsd", input: layered, outcome: "safe-doc" });
  add({ id: "psd/deep-groups-400", format: "psd", category: "deep-nesting", boundary: "documentFromPsd", input: validDeepGroupPsd(400), outcome: "safe-doc" });
  add({ id: "vdj/valid-baseline", format: "vdj", category: "valid-baseline", boundary: "openJsonDocument", input: validVdjText(), outcome: "safe-doc" });
  add({ id: "press/valid-baseline", format: "press-json", category: "valid-baseline", boundary: "openJsonDocument", input: validPressJsonText(), outcome: "safe-doc" });
  add({ id: "press/vdj-fallback-valid", format: "press-json", category: "valid-baseline", boundary: "openJsonDocument", input: validVdjText(), outcome: "safe-doc" });

  // ---- zero-length ----
  add({ id: "psd/zero-length", format: "psd", category: "zero-length", boundary: "documentFromPsd", input: new Uint8Array(0), outcome: "typed-error", code: "unreadable" });
  add({ id: "psd/four-byte-magic-only", format: "psd", category: "zero-length", boundary: "documentFromPsd", input: new Uint8Array([0x38, 0x42, 0x50, 0x53]), outcome: "typed-error", code: "unreadable" });
  add({ id: "press/empty-text", format: "press-json", category: "zero-length", boundary: "openJsonDocument", input: "", outcome: "typed-error", code: "malformed-json" });

  // ---- wrong magic bytes ----
  for (const [magic, label] of [
    [[0x52, 0x49, 0x46, 0x46], "riff"],
    [[0x41, 0x41, 0x41, 0x41], "aaaa"],
    [[0xff, 0xd8, 0xff, 0xe0], "jpeg"],
    [[0x00, 0x00, 0x00, 0x00], "zeros"],
  ]) {
    const bytes = new Uint8Array(layered.slice());
    bytes.set(magic, 0);
    add({ id: `psd/wrong-magic-${label}`, format: "psd", category: "wrong-magic-bytes", boundary: "documentFromPsd", input: bytes, outcome: "typed-error", code: "unreadable" });
  }

  // ---- truncated ----
  // The final byte of the layered fixture is terminal padding: dropping it
  // still decodes, which the corpus records as a safe import rather than a
  // rejection.
  for (const at of [4, 12, 26, 30, 34, 60, 130, 300, 500, layered.byteLength - 1]) {
    add({
      id: `psd/truncated-at-${at}`,
      format: "psd",
      category: "truncated",
      boundary: "documentFromPsd",
      input: layered.slice(0, at),
      outcome: at === layered.byteLength - 1 ? "safe-doc" : "typed-error",
      ...(at === layered.byteLength - 1 ? {} : { code: "unreadable" }),
    });
  }
  const press = validPressJsonText();
  for (const frac of [0.1, 0.35, 0.6, 0.85, 0.999]) {
    add({
      id: `press/truncated-at-${String(frac).replace(".", "_")}`,
      format: "press-json",
      category: "truncated",
      boundary: "openJsonDocument",
      input: press.slice(0, Math.floor(press.length * frac)),
      outcome: "typed-error",
      code: "malformed-json",
    });
  }

  // ---- oversized dimensions ----
  add({ id: "psd/oversized-dims-max-int32", format: "psd", category: "oversized-dimensions", boundary: "documentFromPsd", input: hostilePsdHeader(0x7fffffff, 0x7fffffff), outcome: "typed-error", code: "unreadable" });
  add({ id: "psd/oversized-dims-50000", format: "psd", category: "oversized-dimensions", boundary: "documentFromPsd", input: hostilePsdHeader(50000, 50000), outcome: "typed-error", code: "unreadable" });
  add({ id: "psd/oversized-dims-40000x1", format: "psd", category: "oversized-dimensions", boundary: "documentFromPsd", input: hostilePsdHeader(40000, 1), outcome: "typed-error", code: "unreadable" });
  add({ id: "psd/zero-dims", format: "psd", category: "oversized-dimensions", boundary: "documentFromPsd", input: hostilePsdHeader(0, 0), outcome: "typed-error", code: "unreadable" });
  add({ id: "vdj/oversized-canvas-w", format: "vdj", category: "oversized-dimensions", boundary: "documentFromVdj", input: '{"canvas":{"w":1e9,"h":100},"layers":[]}', outcome: "typed-error", code: "canvas-dimension-out-of-range" });
  add({ id: "vdj/oversized-canvas-h", format: "vdj", category: "oversized-dimensions", boundary: "documentFromVdj", input: '{"canvas":{"w":100,"h":1e9},"layers":[]}', outcome: "typed-error", code: "canvas-dimension-out-of-range" });
  add({ id: "vdj/infinite-canvas", format: "vdj", category: "oversized-dimensions", boundary: "documentFromVdj", input: '{"canvas":{"w":1e999,"h":100},"layers":[]}', outcome: "safe-doc" });
  add({ id: "vdj/negative-canvas", format: "vdj", category: "oversized-dimensions", boundary: "documentFromVdj", input: '{"canvas":{"w":-5,"h":0},"layers":[]}', outcome: "safe-doc" });

  // ---- oversized counts ----
  add({ id: "psd/oversized-layer-count", format: "psd", category: "oversized-counts", boundary: "documentFromPsd", input: hostilePsdLayerCount(), outcome: "typed-error", code: "unreadable" });
  add({ id: "vdj/oversized-layer-count", format: "vdj", category: "oversized-counts", boundary: "documentFromVdj", input: oversizedLayerListText(100_001), outcome: "typed-error", code: "child-count-out-of-range" });
  // No pages/stories on the root, so openJsonDocument routes to the VDJ
  // importer, whose typed rejection carries format "vdj".
  add({ id: "press/oversized-count-via-vdj-fallback", format: "vdj", category: "oversized-counts", boundary: "openJsonDocument", input: oversizedLayerListText(100_002), outcome: "typed-error", code: "child-count-out-of-range" });

  // ---- deep nesting ----
  // Node's JSON parser is non-recursive, so pathological depth parses cleanly
  // and is routed to the VDJ fallback, which ignores the deep structure. The
  // guarantee under proof: depth alone can never escape the boundary.
  add({ id: "press/deep-arrays-50k", format: "press-json", category: "deep-nesting", boundary: "openJsonDocument", input: deepNestedArrays(50_000), outcome: "safe-doc" });
  add({ id: "press/deep-objects-50k", format: "press-json", category: "deep-nesting", boundary: "openJsonDocument", input: deepNestedObjects(50_000), outcome: "safe-doc" });
  add({ id: "press/truncated-deep-arrays-50k", format: "press-json", category: "deep-nesting", boundary: "openJsonDocument", input: "[".repeat(50_000), outcome: "typed-error", code: "malformed-json" });

  // ---- hostile keys / prototype-pollution patterns ----
  add({ id: "vdj/proto-root", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"__proto__":{"polluted":true},"layers":[]}', outcome: "safe-doc" });
  add({ id: "vdj/proto-layer", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"layers":[{"type":"rect","__proto__":{"x":1}}]}', outcome: "safe-doc" });
  add({ id: "vdj/ctor-root", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"constructor":{"prototype":{"polluted":true}},"layers":[]}', outcome: "safe-doc" });
  add({ id: "vdj/proto-canvas", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"canvas":{"__proto__":{"w":1e9}}}', outcome: "safe-doc" });
  add({ id: "press/proto-stories", format: "press-json", category: "hostile-keys", boundary: "openJsonDocument", input: '{"version":6,"pages":[],"stories":{"__proto__":{"polluted":true}}}', outcome: "safe-doc" });
  // A v6 document short-circuits migration before touching pages, so the
  // non-iterable pages object is never walked: the hostile keys ride in as
  // inert own properties and the import is a safe no-op document.
  add({ id: "press/proto-page", format: "press-json", category: "hostile-keys", boundary: "openJsonDocument", input: '{"version":6,"pages":{"__proto__":{"polluted":true}},"stories":[]}', outcome: "safe-doc" });

  // ---- hostile / degenerate roots and layers (VDJ robustness) ----
  add({ id: "vdj/root-null", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: "null", outcome: "safe-doc" });
  add({ id: "vdj/root-number", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: "42", outcome: "safe-doc" });
  add({ id: "vdj/root-string", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '"hello"', outcome: "safe-doc" });
  add({ id: "vdj/root-array", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: "[1,2,3]", outcome: "safe-doc" });
  add({ id: "vdj/layers-pseudo-object", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"layers":{"length":3}}', outcome: "safe-doc" });
  add({ id: "vdj/pages-pseudo-object", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"pages":{"length":1,"0":{"layers":5}}}', outcome: "safe-doc" });
  add({ id: "vdj/layer-null-entry", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"layers":[null]}', outcome: "safe-doc" });
  add({ id: "vdj/layer-number-entry", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"layers":[42]}', outcome: "safe-doc" });
  add({ id: "vdj/text-color-number", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"layers":[{"type":"text","text":{"color":5,"size":"big","leading":"x"}}]}', outcome: "safe-doc" });
  add({ id: "vdj/fill-number", format: "vdj", category: "hostile-keys", boundary: "documentFromVdj", input: '{"layers":[{"type":"rect","style":{"fill":9}}]}', outcome: "safe-doc" });

  // ---- malformed JSON ----
  for (const [i, frag] of ['{"a":', "[", "{", '"unterminated', '{"version":6,}', "\u0000{}"].entries()) {
    add({ id: `press/malformed-${i}`, format: "press-json", category: "malformed-json", boundary: "openJsonDocument", input: frag, outcome: "typed-error", code: "malformed-json" });
  }

  // ---- Press migration hostility (gate-passing docs with hostile bodies) ----
  add({
    id: "press/v1-null-layer-entry",
    format: "press-json",
    category: "hostile-keys",
    boundary: "openJsonDocument",
    input: '{"version":1,"pages":[{"layers":[null]}],"stories":[]}',
    outcome: "typed-error",
    code: "migration-failed",
  });
  add({
    id: "press/v1-dangling-parent",
    format: "press-json",
    category: "hostile-keys",
    boundary: "openJsonDocument",
    input: '{"version":1,"pages":[{"layers":[{"id":"a","kind":"rect","transform":{"x":10,"y":10},"parentId":"missing"}]}],"stories":[]}',
    outcome: "safe-doc",
  });

  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const digest = createHash("sha256");
  for (const c of cases) {
    digest.update(`${c.id}\n${c.format}\n${c.category}\n${c.boundary}\n${c.outcome}\n${c.code ?? "-"}\n`);
    digest.update(c.input instanceof Uint8Array ? sha256(c.input) : sha256(Buffer.from(c.input, "utf8")));
    digest.update("\n");
  }
  return { cases, corpusDigest: digest.digest("hex") };
}
