/**
 * VIRO-0015 — corpus documents for the PNG/PDF export regression suite.
 *
 * Builders are pure document-model calls (src/document/factory + ops +
 * boolean-ops) and run in Node. Each corpus case records the expected
 * PdfExportReport (every field, see export-corpus-verify.mjs) and the expected
 * PDF content-stream operator topology, and — via the playwright harness in
 * export-corpus.test.mjs — the expected PNG pixel fingerprint of the same
 * document rendered by the real compositor.
 *
 * REBASE NOTE (activated at build 2026-08-28): the two compound cases were
 * authored as DEFERRED-UNTIL-REBASE (VIRO-0005 @ 4d2576c). VIRO-0005 is now
 * merged into this packet's base (72b05f0), so `emitVector` consumes the
 * authoritative `contours[]` and the post-rebase expectations ARE the
 * expectations. `status` is therefore "READY" on every row; the runner fails
 * the whole suite if any row is ever re-deferred.
 *
 * DETERMINISM NOTE: every builder zeroes the page background alpha so the
 * content-stream census carries ONLY the layer's own operators (same practice
 * as tests/pdf-compound.spec.ts) and the compositor PNG is reproducible
 * pixel-for-pixel under the pinned SwiftShader launch args.
 */
import { createDocument, addImageFrame, addTypeFrame, addVectorRect } from "../src/document/factory.ts";
import { setStoryText, setCharacter } from "../src/document/ops.ts";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PAGE = { ppi: 72, widthPx: 400, heightPx: 300, bleedPx: 0, pageCount: 1, facingPages: false };

function newDoc(name) {
  const doc = createDocument({ name, ...PAGE });
  // Zero the paper so operator censuses and PNG pixels come only from the
  // corpus layer(s) under test. Data mutation on the doc — no product code.
  doc.pages[0].background.a = 0;
  return doc;
}

/** A real 2×2 RGBA PNG as a data URL — genuine bytes, no mocks. */
export function tinyPngDataUrl() {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

export async function singleContourVectorDoc() {
  let doc = newDoc("Corpus Vector");
  doc = addVectorRect(doc, 40, 40, 200, 120, { r: 0.8, g: 0.2, b: 0.1, a: 1 });
  return doc;
}

export async function textLayerDoc() {
  let doc = newDoc("Corpus Text");
  // Explicit 320×120 frame: "VIRO corpus" at 36px must compose as ONE line so
  // the topology pins one Tm / one TJ run deterministically.
  doc = addTypeFrame(doc, "noto-sans", 32, 32, { w: 320, h: 120 });
  const id = doc.activeLayerIds[0];
  doc = setStoryText(doc, id, "VIRO corpus");
  doc = setCharacter(doc, id, { size: 36, leading: 43.2, tracking: 0, fill: { r: 0.1, g: 0.1, b: 0.1, a: 1 } });
  return doc;
}

export async function rasterLayerDoc() {
  let doc = newDoc("Corpus Raster");
  doc = addImageFrame(doc, { name: "Tile", mime: "image/png", dataUrl: tinyPngDataUrl(), width: 2, height: 2 }, 24, 24);
  doc.pages[0].layers[doc.pages[0].layers.length - 1].transform.w = 160;
  doc.pages[0].layers[doc.pages[0].layers.length - 1].transform.h = 120;
  return doc;
}

/**
 * A drop-shadowed vector, plus `false` for its control.
 *
 * FIDELITY DECISION (VIRO-0146, updating the VIRO-0015 pin): the exporter
 * RENDERS drop shadows — each shadow is rasterised with the same Skia
 * MakeDropShadowOnly filter the compositor uses (sigma = blur/2, colour alpha
 * = colour.a × opacity) and embedded beneath its layer as a transparent-PNG
 * XObject underlay. Only the shadow is raster; the vector body stays vector,
 * so this case's path operators still equal the control's and the delta is
 * exactly one `q … cm … Do … Q` group plus one report image and note.
 */
export async function effectsLayerDoc(withShadow = true) {
  let doc = await singleContourVectorDoc();
  doc.name = withShadow ? "Corpus Effects" : "Corpus Effects Control";
  const layer = doc.pages[0].layers[0];
  layer.effects = withShadow
    ? [{ type: "drop-shadow", enabled: true, offsetX: 8, offsetY: 8, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 }, opacity: 1 }]
    : [];
  return doc;
}

/**
 * Subtract ring with a hole (VIRO-0005 compound kernel, now on this base).
 * `ck` is a CanvasKit instance initialised engines.mjs-style.
 */
export async function compoundRingDoc(ck) {
  const { subtractVectors } = await import("../src/document/boolean-ops.ts");
  let doc = newDoc("Corpus Ring");
  doc = addVectorRect(doc, 40, 40, 200, 120, { r: 0.8, g: 0.2, b: 0.1, a: 1 });
  doc = addVectorRect(doc, 80, 70, 80, 60, { r: 0.2, g: 0.4, b: 0.8, a: 1 });
  const page = doc.pages[0];
  const [bottom, top] = page.layers.slice(-2);
  // subtract = TOP operand minus the one beneath it (small rect out of the
  // large): the kernel signature is (ck, page, bottom, top), so the large
  // bottom operand goes first.
  const ring = subtractVectors(ck, page, bottom, top);
  page.layers.splice(page.layers.length - 2, 2, ring);
  return doc;
}

/** Union of two separated rects — a two-contour compound (VIRO-0005 kernel). */
export async function compoundDisjointUnionDoc(ck) {
  const { booleanCombineVectors } = await import("../src/document/boolean-ops.ts");
  let doc = newDoc("Corpus Disjoint");
  doc = addVectorRect(doc, 20, 20, 100, 80, { r: 0.1, g: 0.6, b: 0.3, a: 1 });
  doc = addVectorRect(doc, 200, 160, 120, 90, { r: 0.6, g: 0.1, b: 0.6, a: 1 });
  const page = doc.pages[0];
  const layers = page.layers.slice(-2);
  const union = booleanCombineVectors(ck, page, layers, "union");
  page.layers.splice(page.layers.length - 2, 2, union);
  return doc;
}

/** Stroke-only compound: the subtract ring with fill removed and a stroke set. */
export async function compoundStrokeOnlyDoc(ck) {
  const doc = await compoundRingDoc(ck);
  doc.name = "Corpus Stroke Only";
  const layer = doc.pages[0].layers[doc.pages[0].layers.length - 1];
  layer.fill = null;
  layer.stroke = { color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, width: 4 };
  return doc;
}

/** Fill+stroke compound: the subtract ring with a stroke added. */
export async function compoundFillStrokeDoc(ck) {
  const doc = await compoundRingDoc(ck);
  doc.name = "Corpus Fill Stroke";
  const layer = doc.pages[0].layers[doc.pages[0].layers.length - 1];
  layer.stroke = { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 };
  return doc;
}

export function bundledFaceBytes() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "public", "fonts", "NotoSans-Regular.ttf"));
}

/**
 * The corpus manifest. Every row is "READY": the corpus fails if any row is
 * deferred. Expectations:
 *   - expectReport  — PdfExportReport; ALL seven fields must be named (the
 *     runner enforces coverage: pagePt, vectorPaths, textRuns, glyphs,
 *     images, rasterFallbacks, notes). Numbers exact, ">=N" floors allowed
 *     (on arrays ">=N" means length).
 *   - expectTopology — content-stream operator census; partial on purpose
 *     (only the operators the case means to pin). `sameContentAs` asserts the
 *     whole census is identical to another case's.
 */
export function corpusManifest() {
  return [
    {
      id: "export/single-contour-vector",
      status: "READY",
      build: singleContourVectorDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 1, textRuns: 0, glyphs: 0, images: 0, rasterFallbacks: [], notes: [] },
      expectTopology: { m: 1, c: 4, h: 1, fill: 1, evenOddFill: 0, stroke: 0, re: 1, endPath: 1, do: 0, BT: 0, TJ: 0 },
    },
    {
      id: "export/compound-ring",
      status: "READY",
      build: compoundRingDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 1, textRuns: 0, glyphs: 0, images: 0, rasterFallbacks: [], notes: [] },
      expectTopology: { m: 2, h: 2, evenOddFill: 1, fill: 0, stroke: 0, fillStroke: 0, fillStrokeEvenOdd: 0, do: 0, BT: 0 },
    },
    {
      id: "export/compound-disjoint-union",
      status: "READY",
      build: compoundDisjointUnionDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 1, textRuns: 0, glyphs: 0, images: 0, rasterFallbacks: [], notes: [] },
      expectTopology: { m: 2, h: 2, evenOddFill: 1, fill: 0, stroke: 0 },
    },
    {
      id: "export/compound-stroke-only",
      status: "READY",
      build: compoundStrokeOnlyDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 1, textRuns: 0, glyphs: 0, images: 0, rasterFallbacks: [], notes: [] },
      expectTopology: { m: 2, h: 2, stroke: 1, fill: 0, evenOddFill: 0, fillStroke: 0, fillStrokeEvenOdd: 0, lineWidth: 1 },
    },
    {
      id: "export/compound-fill-stroke",
      status: "READY",
      build: compoundFillStrokeDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 1, textRuns: 0, glyphs: 0, images: 0, rasterFallbacks: [], notes: [] },
      expectTopology: { m: 2, h: 2, fillStrokeEvenOdd: 1, fill: 0, evenOddFill: 0, fillStroke: 0, stroke: 0, lineWidth: 1 },
    },
    {
      id: "export/text-layer",
      status: "READY",
      build: textLayerDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 0, textRuns: 1, glyphs: ">=10", images: 0, rasterFallbacks: [], notes: ">=1" },
      expectTopology: { m: 0, BT: 1, ET: 1, Tf: 1, Tm: 1, TJ: 1, do: 0, fill: 0, evenOddFill: 0 },
    },
    {
      id: "export/raster-layer",
      status: "READY",
      build: rasterLayerDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 0, textRuns: 0, glyphs: 0, images: 1, rasterFallbacks: [], notes: [] },
      expectTopology: { m: 0, do: 1, clip: 2, endPath: 2, BT: 0, fill: 0 },
    },
    {
      id: "export/effects-layer",
      status: "READY",
      build: effectsLayerDoc,
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 1, textRuns: 0, glyphs: 0, images: 1, rasterFallbacks: [], notes: ">=1" },
      expectTopology: { m: 1, c: 4, h: 1, fill: 1, do: 1, BT: 0, cm: 3, stroke: 0 },
      fidelityNote:
        "VIRO-0146 FIX (updates the VIRO-0015 silent-drop pin): the exporter renders the drop " +
        "shadow as a Skia-rasterised transparent-PNG underlay beneath the vector body — the same " +
        "MakeDropShadowOnly semantics as the compositor (sigma = blur/2, colour alpha = colour.a " +
        "× opacity). The delta from the unshadowed control is exactly one embedded raster " +
        "(report.images 1 vs 0, a report note) plus one `q cm Do Q` group in the stream; the path " +
        "operators (m/c/h/fill) stay identical. The canvas/PDF pixel parity of this shadow is " +
        "proven by tests/pdf-effects-parity.spec.ts; other enabled effects (glow/stroke/gradient " +
        "overlay) are recorded as rasterFallbacks entries, never dropped silently.",
    },
    {
      id: "export/effects-control",
      status: "READY",
      build: () => effectsLayerDoc(false),
      expectReport: { pagePt: { w: 400, h: 300 }, vectorPaths: 1, textRuns: 0, glyphs: 0, images: 0, rasterFallbacks: [], notes: [] },
      expectTopology: { m: 1, c: 4, h: 1, fill: 1, evenOddFill: 0, stroke: 0 },
    },
  ];
}
