/**
 * VIRO-0015 — THE EXPORT CORPUS VERIFICATION COMMAND.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs \
 *        --test tests/export-corpus.test.mjs
 *
 * Per corpus document (tests/export-corpus-docs.mjs manifest) this runner
 * checks, against the real exporter and the real compositor only:
 *
 *   PDF arm (Node-pure) — the saved PDF's page content stream is decoded via
 *   pdf-lib and censused operator-by-operator (`topologyOf`) against the
 *   manifest topology pins, and the PdfExportReport is asserted field by
 *   field. Coverage is enforced: EVERY report field (pagePt, vectorPaths,
 *   textRuns, glyphs, images, rasterFallbacks, notes) must be pinned by every
 *   row, so a report change cannot land silently.
 *
 *   PNG arm (playwright harness, tests/export-corpus-png.mjs) — the same
 *   documents are opened in the live editor and snapshot by the real Skia
 *   compositor; decoded-IDAT SHA-256 pixel fingerprints are compared to the
 *   pins in tests/export-corpus-png.json.
 *
 *   VACUITY PROOF — deliberate mutations of a content hash, a topology
 *   expectation and a PNG pixel buffer must each be REJECTED, proving the
 *   corpus still bites.
 *
 * The compound rows were authored DEFERRED-UNTIL-REBASE (VIRO-0005 @
 * 4d2576c); that rebase is in this packet's base, the compound expectations
 * hold against the merged exporter, and the manifest guard below fails the
 * suite if any row is ever re-deferred.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusManifest, tinyPngDataUrl } from "./export-corpus-docs.mjs";
import {
  pageContentText,
  topologyOf,
  contentHash,
  pngFingerprint,
  assertTopology,
  assertReport,
  assertReportCoverage,
  mutationSelfChecks,
} from "./export-corpus-verify.mjs";
import { pagePngFingerprints, loadPngPins } from "./export-corpus-png.mjs";
import { exportPagePdf } from "../src/export/pdf.ts";
import { loadFace } from "../src/engine/type.ts";

/* ------------------------------------------------------------------ *
 * Node bootstrap — CanvasKit for the boolean kernel, the real face
 * ------------------------------------------------------------------ */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert.ok(existsSync(ckWasm), "canvaskit.wasm missing");
const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });

const FONT_BYTES = join(ROOT, "public", "fonts", "NotoSans-Regular.ttf");
const notoBytes = (await import("node:fs")).readFileSync(FONT_BYTES);
const face = await loadFace(
  "noto-sans",
  "Noto Sans Regular",
  notoBytes.buffer.slice(notoBytes.byteOffset, notoBytes.byteOffset + notoBytes.byteLength),
);

const manifest = corpusManifest();
/** Actual per-case artefacts, for the cross-case parity pins. */
const actuals = new Map();

/* ------------------------------------------------------------------ *
 * Manifest guard
 * ------------------------------------------------------------------ */

test("corpus manifest: every row is READY — the VIRO-0005 rebase landed, nothing may be deferred", () => {
  const deferred = manifest.filter((c) => c.status !== "READY");
  assert.deepEqual(
    deferred.map((c) => c.id),
    [],
    "DEFERRED-UNTIL-REBASE rows must be activated once their dependency merges",
  );
  assert.ok(manifest.length >= 9, "corpus shrank below its activation set");
});

/* ------------------------------------------------------------------ *
 * PDF arm — report + topology per document
 * ------------------------------------------------------------------ */

for (const c of manifest) {
  test(`pdf arm: ${c.id}`, async () => {
    const doc = await c.build(ck);
    // The text case exports with the real face it was set in (the exact
    // argument shape src/app.ts exportPdf() resolves to for bundled faces).
    // `ck` is passed so drop-shadow underlays rasterise in Node exactly as
    // they do in the browser (pixel parity is proven separately by
    // tests/pdf-effects-parity.spec.ts).
    const isText = c.id === "export/text-layer";
    const { bytes, report } = await exportPagePdf({ doc, face: isText ? face : null, ck });
    const contentText = await pageContentText(bytes);
    const census = topologyOf(contentText);

    // Report: full field coverage, then the pinned values.
    if (c.expectReport.sameReportAs) {
      const target = manifest.find((x) => x.id === c.expectReport.sameReportAs);
      assert.ok(target, `${c.id}: sameReportAs target ${c.expectReport.sameReportAs} missing`);
      assertReportCoverage(target.expectReport, target.id);
      assertReport(report, target.expectReport, c.id);
    } else {
      assertReportCoverage(c.expectReport, c.id);
      assertReport(report, c.expectReport, c.id);
    }

    // Topology: partial pins, token-exact census.
    if (!c.expectTopology.sameContentAs) {
      assertTopology(census, c.expectTopology, c.id);
    }

    actuals.set(c.id, { report, contentText, census, hash: contentHash(contentText) });
  });
}

/* ------------------------------------------------------------------ *
 * Cross-case parity pins
 * ------------------------------------------------------------------ */

test("effects layer vs control: the PDF now carries the shadow as an underlay — vector body unchanged", async () => {
  const withFx = actuals.get("export/effects-layer");
  const control = actuals.get("export/effects-control");
  assert.ok(withFx && control, "effects cases must export before the parity pin");
  // VIRO-0146: the shadow is no longer dropped silently. The content stream
  // gains exactly one underlay draw (`q cm Do Q`), so it is no longer
  // byte-identical to the unshadowed control.
  assert.notEqual(withFx.hash, control.hash, "the shadow underlay must appear in the content stream");
  assert.equal(withFx.census.do, 1, "exactly one shadow underlay XObject draw");
  assert.equal(control.census.do, 0, "the unshadowed control must not grow an underlay");
  // …but the vector body is untouched: the same path operators as the control.
  for (const op of ["m", "c", "h", "fill"]) {
    assert.equal(withFx.census[op], control.census[op], `vector operator '${op}' must be unchanged by the shadow`);
  }
  // The report states what happened: one embedded shadow raster plus a note,
  // and a rendered shadow is not a raster fallback.
  assert.equal(withFx.report.images, control.report.images + 1, "the shadow underlay is one embedded raster");
  assert.ok(withFx.report.notes.length > control.report.notes.length, "the rendered shadow is documented in the report");
  assert.deepEqual(withFx.report.rasterFallbacks, control.report.rasterFallbacks, "a rendered shadow must not be a rasterFallback");
});

/* ------------------------------------------------------------------ *
 * PNG arm — real compositor fingerprints through the playwright harness
 * ------------------------------------------------------------------ */

test("png arm: compositor pixel fingerprints match the pins", async () => {
  const docs = [];
  for (const c of manifest) {
    const doc = await c.build(ck);
    docs.push({ id: c.id, name: doc.name, doc });
  }
  const fingerprints = await pagePngFingerprints(docs);

  // Structural sanity: page-sized PNGs, and the canvas REALLY draws the
  // shadow the PDF drops (effects fingerprint differs from its control).
  const fx = fingerprints.get("export/effects-layer");
  const control = fingerprints.get("export/effects-control");
  for (const [id, fp] of fingerprints) {
    assert.equal(fp.width, 400, `${id}: PNG width`);
    assert.equal(fp.height, 300, `${id}: PNG height`);
  }
  assert.notEqual(fx.sha256, control.sha256, "the canvas must paint the drop shadow the PDF arm proves is dropped");

  if (process.env.CORPUS_PIN === "1") {
    // Pin-capture mode: pins were just written; nothing to compare yet.
    assert.ok(loadPngPins(), "CORPUS_PIN=1 must write tests/export-corpus-png.json");
    return;
  }

  const pins = loadPngPins();
  assert.ok(pins, "tests/export-corpus-png.json missing — generate with CORPUS_PIN=1 and review the diff");
  for (const c of manifest) {
    const pin = pins[c.id];
    assert.ok(pin, `${c.id}: no PNG pin`);
    const fp = fingerprints.get(c.id);
    assert.equal(
      fp.sha256,
      pin.sha256,
      `${c.id}: PNG pixels changed (decoded-IDAT sha256 ${fp.sha256}, pin ${pin.sha256}). ` +
        `If this pixel delta is intended, re-pin with CORPUS_PIN=1 and name the reason in the commit.`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Vacuity proof — the corpus must still bite
 * ------------------------------------------------------------------ */

test("vacuity: content-hash, topology-expectation and png-pixel mutations are each rejected", async () => {
  // Real artefacts, not fixtures: the content of an actual export and a real
  // (if tiny) PNG the corpus itself places.
  const single = actuals.get("export/single-contour-vector");
  assert.ok(single, "the single-contour case must export before the vacuity proof");
  const samplePng = Buffer.from(tinyPngDataUrl().split(",")[1], "base64");
  const caught = mutationSelfChecks(single.contentText, samplePng);
  assert.deepEqual(
    caught.sort(),
    ["content-hash", "png-pixel-hash", "topology-expectation"],
    "a comparator stopped biting — the corpus can no longer prove its own assertions",
  );
});
