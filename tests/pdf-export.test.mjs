/**
 * Vector PDF export — every Press page is a PDF page, not only the active one.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/pdf-export.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { addVectorLayer, rectNodes } from "../src/document/factory.ts";
import { addPage } from "../src/document/ops.ts";
import { documentFromPreset, PRESETS } from "../src/document/presets.ts";
import { exportPagePdf } from "../src/export/pdf.ts";

const COPPER = { r: 224 / 255, g: 122 / 255, b: 47 / 255, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 1 };

test("a one-page document still exports a one-page PDF", async () => {
  let doc = documentFromPreset(PRESETS[0]);
  doc = addVectorLayer(doc, "Box", 40, 40, 200, 100, rectNodes(200, 100), {
    closed: true,
    fill: COPPER,
    stroke: null,
  });
  const { bytes, report } = await exportPagePdf({ doc, face: null });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(report.pageCount, 1);
  assert.ok(report.vectorPaths >= 1);
});

test("every Press page becomes a PDF page, including artwork on page 2", async () => {
  let doc = documentFromPreset(PRESETS[0]);
  doc = addVectorLayer(doc, "One", 40, 40, 200, 100, rectNodes(200, 100), {
    closed: true,
    fill: COPPER,
    stroke: null,
  });
  doc = addPage(doc);
  doc = addVectorLayer(doc, "Two", 80, 80, 120, 80, rectNodes(120, 80), {
    closed: true,
    fill: RED,
    stroke: null,
  });
  assert.equal(doc.pages.length, 2);
  const { bytes, report } = await exportPagePdf({ doc, face: null });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2, "exporting while page 2 is active must still include page 1");
  assert.equal(report.pageCount, 2);
  assert.ok(report.vectorPaths >= 2, `expected a path on each page, got ${report.vectorPaths}`);
  const subject = pdf.getSubject() ?? "";
  assert.match(subject, /2 page/);
});
