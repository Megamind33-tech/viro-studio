import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { addVectorRect, createDocument } from "../src/document/factory";
import type { LayerEffect } from "../src/document/types";

/**
 * VIRO-0146 — the drop shadow the PDF now renders must be the shadow the
 * canvas paints. Artifact-level proof, not serialization success:
 *
 *   1. the corpus-shaped shadow document (one vector rect, one enabled drop
 *      shadow) is opened in the live editor with the app's own `openBytes`;
 *   2. the REAL compositor snapshots the page (the canvas truth);
 *   3. the real exporter — the exact module and argument shape src/app.ts
 *      exportPdf() uses, WITHOUT an injected CanvasKit, so the browser's
 *      lazy shadow-rasteriser boot is exercised end to end — saves the PDF;
 *   4. pdf.js (the vendored Apache-2.0 legacy build under
 *      tests/pdf-effects-oracle/) rasterises page 1;
 *   5. both arms are composited over white and compared pixel-wise with
 *      stated tolerances (per-channel delta bounds + shadow-band ink
 *      presence), and the UNSHADOWED control must show NO ink in the
 *      shadow band on either arm — the falsifiable contrast that makes the
 *      tolerance assertions mean something.
 *
 * Why pdf.js: it is the independent oracle the acceptance names. Rendering
 * the saved bytes back through a third-party engine catches exporter bugs a
 * content-stream census cannot see (bad XObject placement, broken SMask,
 * inverted transforms).
 */

/* ------------------------------------------------------------------ *
 * The corpus-shaped document, built through the real document factory
 * ------------------------------------------------------------------ */

const SHADOW: LayerEffect[] = [
  { type: "drop-shadow", enabled: true, offsetX: 8, offsetY: 8, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 }, opacity: 1 },
];

function effectsDoc(withShadow: boolean, name: string): ReturnType<typeof createDocument> {
  let doc = createDocument({
    name,
    ppi: 72,
    widthPx: 400,
    heightPx: 300,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  // Same practice as tests/export-corpus-docs.mjs: zero the paper so the
  // pixels come only from the layer under test.
  doc.pages[0].background.a = 0;
  doc = addVectorRect(doc, 40, 40, 200, 120, { r: 0.8, g: 0.2, b: 0.1, a: 1 });
  doc.pages[0].layers[0].effects = withShadow ? SHADOW : [];
  return doc;
}

/* ------------------------------------------------------------------ *
 * Geometry of the probe regions (400×300 page, rect 40,40 200×120,
 * shadow +8/+8, σ = 6 → visible fade to ≈ rect + offset ± 3σ = 18px)
 * ------------------------------------------------------------------ */

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const BODY: Rect = { x0: 46, y0: 46, x1: 234, y1: 154 }; // interior of the fill, AA edges excluded
const RIGHT_BAND: Rect = { x0: 244, y0: 56, x1: 262, y1: 150 }; // shadow-only, right of the body
const BOTTOM_BAND: Rect = { x0: 56, y0: 166, x1: 234, y1: 184 }; // shadow-only, below the body
const PAGE: Rect = { x0: 0, y0: 0, x1: 400, y1: 300 };

/* ------------------------------------------------------------------ *
 * In-page capture: canvas snapshot RGBA + exported PDF bytes + report
 * ------------------------------------------------------------------ */

interface Capture {
  canvasRgbaB64: string;
  pdfRgbaB64: string;
  width: number;
  height: number;
  pdfNonWhite: number;
  canvasNonWhite: number;
  report: {
    vectorPaths: number;
    images: number;
    rasterFallbacks: string[];
    notes: string[];
  };
}

async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean((window as unknown as { __press?: { compositor?: unknown } }).__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

async function captureVariant(page: Page, json: string, name: string): Promise<Capture> {
  await page.evaluate(
    async ({ json, name }: { json: string; name: string }) => {
      const P = (window as unknown as {
        __press?: {
          doc: { name: string; pages: Array<{ ppi: number }> };
          openBytes(name: string, buffer: ArrayBuffer): Promise<void>;
          compositor: { snapshotPagePng(doc: unknown): Uint8Array };
        };
      }).__press;
      if (!P || !P.compositor) throw new Error("app not booted / compositor missing");
      const bytes = new TextEncoder().encode(json);
      await P.openBytes(`${name}.press.json`, bytes.buffer);
      if (P.doc.name !== name) throw new Error(`open failed: doc is "${P.doc.name}", expected "${name}"`);
      // pdf.js renders points; the canvas arm is in page pixels. Corpus pages
      // are ppi 72, so the render scale is ppi/72 (1 here) — derived, not assumed.
      (window as unknown as { __viroEffectsScale?: number }).__viroEffectsScale = P.doc.pages[0].ppi / 72;
    },
    { json, name },
  );

  // Window captured state across the evaluates (no reload in between).
  await page.evaluate(
    async () => {
      const P = (window as unknown as {
        __press?: {
          doc: unknown;
          compositor: { snapshotPagePng(doc: unknown): Uint8Array };
          fonts: { resolve(id?: string | undefined): unknown };
          face: unknown;
        };
        __viroEffectsProbe?: Record<string, unknown>;
      }).__press;
      if (!P) throw new Error("app not booted");
      const w = window as unknown as { __viroEffectsProbe?: Record<string, unknown> };
      w.__viroEffectsProbe = {};

      // Canvas truth: the real compositor's page snapshot.
      const png = P.compositor.snapshotPagePng(P.doc);
      const bmp = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }));
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      w.__viroEffectsProbe.canvas = img.data.buffer;

      // The PDF: the exact module and argument shape src/app.ts exportPdf()
      // uses. Deliberately WITHOUT a `ck` option: the browser's lazy
      // shadow-rasteriser boot is part of what this spec proves. (The module
      // URL goes through a variable so tsc, which cannot resolve runtime
      // /src/ paths, leaves the dynamic import alone.)
      const moduleUrl = "/src/export/pdf.ts";
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as unknown as {
        exportPagePdf(o: {
          doc: unknown;
          face: unknown;
          fonts?: unknown;
          rasterise?: (doc: unknown) => Uint8Array;
        }): Promise<{ bytes: Uint8Array; report: { vectorPaths: number; images: number; rasterFallbacks: string[]; notes: string[] } }>;
      };
      const { bytes, report } = await mod.exportPagePdf({
        doc: P.doc,
        face: P.fonts.resolve(undefined) ?? P.face,
        fonts: P.fonts,
        rasterise: (doc: unknown) => P.compositor.snapshotPagePng(doc),
      });
      w.__viroEffectsProbe.pdfBytes = new Uint8Array(bytes).buffer;
      w.__viroEffectsProbe.report = report;
    },
  );

  // pdf.js oracle: vendored Apache-2.0 legacy build, served same-origin by
  // the dev server. The worker runs from a same-origin blob URL.
  const oracle = join(process.cwd(), "tests", "pdf-effects-oracle");
  await page.addScriptTag({ path: join(oracle, "pdf.min.js") });
  await page.evaluate(async () => {
    const lib = (window as unknown as { pdfjsLib?: { GlobalWorkerOptions: { workerSrc: string } } }).pdfjsLib;
    if (!lib) throw new Error("pdf.js failed to load");
    const src = await fetch("tests/pdf-effects-oracle/pdf.worker.min.js").then((r) => {
      if (!r.ok) throw new Error(`worker fetch ${r.status}`);
      return r.text();
    });
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  });

  const out = await page.evaluate(
    async (): Promise<{
      canvasRgbaB64: string;
      pdfRgbaB64: string;
      width: number;
      height: number;
      pdfNonWhite: number;
      canvasNonWhite: number;
      report: Capture["report"];
    }> => {
      const w = window as unknown as {
        __viroEffectsProbe?: {
          canvas?: ArrayBuffer;
          pdfBytes?: ArrayBuffer;
          report?: Capture["report"];
        };
        pdfjsLib?: {
          GlobalWorkerOptions: { workerSrc: string };
          getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDoc> };
        };
      };
      const probe = w.__viroEffectsProbe!;
      if (!probe?.canvas || !probe?.pdfBytes || !probe?.report) throw new Error("probe state missing");

      interface PdfDoc {
        getPage(n: number): Promise<PdfPage>;
      }
      interface PdfPage {
        getViewport(o: { scale: number }): { width: number; height: number };
        render(o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void> };
      }
      const lib = w.pdfjsLib;
      if (!lib) throw new Error("pdf.js failed to load");
      const pdf = await lib.getDocument({ data: new Uint8Array(probe.pdfBytes) }).promise;
      const p = await pdf.getPage(1);

      // The canvas arm is in page pixels (snapshotPagePng is 1:1); render
      // the PDF at the scale that maps points back to those pixels.
      const rawScale = (window as unknown as { __viroEffectsScale?: number }).__viroEffectsScale;
      const scale = typeof rawScale === "number" && Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const vp = p.getViewport({ scale });
      if (!(vp.width > 0) || !(vp.height > 0)) {
        throw new Error(`bad viewport w=${vp.width} h=${vp.height} rawScale=${rawScale} bytes=${probe.pdfBytes.byteLength}`);
      }
      const cv = document.createElement("canvas");
      cv.width = Math.round(vp.width);
      cv.height = Math.round(vp.height);
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const img = ctx.getImageData(0, 0, cv.width, cv.height);

      const b64 = (buf: ArrayBuffer): string => {
        const u = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...Array.from(u.subarray(i, i + 0x8000)));
        return btoa(bin);
      };
      // Oracle-liveness evidence: a pdf.js arm that rendered nothing (or is
      // secretly the canvas buffer again) must be visible in these numbers.
      let pdfNonWhite = 0;
      let canvasNonWhite = 0;
      const pc = new Uint8Array(probe.canvas);
      const pd = img.data;
      for (let i = 0; i < pd.length; i += 4) {
        if (pd[i]! < 255 || pd[i + 1]! < 255 || pd[i + 2]! < 255) pdfNonWhite += 1;
        const a = pc[i + 3]! / 255;
        const r = pc[i]! * a + 255 * (1 - a);
        const g = pc[i + 1]! * a + 255 * (1 - a);
        const b2 = pc[i + 2]! * a + 255 * (1 - a);
        if (r < 255 || g < 255 || b2 < 255) canvasNonWhite += 1;
      }
      return {
        canvasRgbaB64: b64(probe.canvas),
        pdfRgbaB64: b64(img.data.buffer),
        width: cv.width,
        height: cv.height,
        pdfNonWhite,
        canvasNonWhite,
        report: probe.report,
      };
    },
  );
  return out;
}

/* ------------------------------------------------------------------ *
 * Node-side pixel metrics
 * ------------------------------------------------------------------ */

/** Composite RGBA over white → RGB triplets (the PDF arm has opaque white already). */
function overWhite(rgba: Buffer): Buffer {
  const out = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3]! / 255;
    out[j] = Math.round(rgba[i]! * a + 255 * (1 - a));
    out[j + 1] = Math.round(rgba[i + 1]! * a + 255 * (1 - a));
    out[j + 2] = Math.round(rgba[i + 2]! * a + 255 * (1 - a));
  }
  return out;
}

function inRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
}

/** Share of region pixels that carry ink (any channel visibly off white). */
function inkFraction(rgb: Buffer, width: number, rect: Rect): number {
  let ink = 0;
  let total = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const o = (y * width + x) * 3;
      total += 1;
      if (rgb[o]! < 235 || rgb[o + 1]! < 235 || rgb[o + 2]! < 235) ink += 1;
    }
  }
  return total === 0 ? 0 : ink / total;
}

interface DiffStats {
  /** Mean |Δ| over all three channels of all pixels. */
  mean: number;
  /** 99th percentile per-channel |Δ|. */
  p99: number;
  /** Share of channel samples whose |Δ| exceeds 64 (real structural breaks). */
  shareGt64: number;
}

function diffStats(a: Buffer, b: Buffer): DiffStats {
  if (a.length !== b.length) throw new Error(`pixel buffer mismatch ${a.length} vs ${b.length}`);
  const deltas: number[] = [];
  let sum = 0;
  let gt64 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    deltas.push(d);
    sum += d;
    if (d > 64) gt64 += 1;
  }
  deltas.sort((x, y) => x - y);
  return {
    mean: sum / a.length,
    p99: deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.99))]!,
    shareGt64: gt64 / a.length,
  };
}

function meanAbsDelta(a: Buffer, b: Buffer, width: number, rect: Rect): number {
  let sum = 0;
  let n = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(a[o + c]! - b[o + c]!);
        n += 1;
      }
    }
  }
  return n === 0 ? 0 : sum / n;
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

const WORKING = process.env.VIRO_FX_TUNE === "1";

for (const variant of ["shadow", "control"] as const) {
  test(`pdf-effects ${variant}: pdf.js render vs canvas within tolerance`, async ({ page }) => {
    const name = variant === "shadow" ? "VIRO-0146 Shadow" : "VIRO-0146 Control";
    const json = JSON.stringify(effectsDoc(variant === "shadow", name));
    await page.goto("/");
    await bootReady(page);
    const cap = await captureVariant(page, json, name);

    expect(cap.width).toBe(400);
    expect(cap.height).toBe(300);

    const canvas = overWhite(Buffer.from(cap.canvasRgbaB64, "base64"));
    const pdf = overWhite(Buffer.from(cap.pdfRgbaB64, "base64"));

    const stats = diffStats(canvas, pdf);
    const bodyDelta = meanAbsDelta(canvas, pdf, 400, BODY);
    const rightCanvas = inkFraction(canvas, 400, RIGHT_BAND);
    const rightPdf = inkFraction(pdf, 400, RIGHT_BAND);
    const bottomCanvas = inkFraction(canvas, 400, BOTTOM_BAND);
    const bottomPdf = inkFraction(pdf, 400, BOTTOM_BAND);
    const bodyInkCanvas = inkFraction(canvas, 400, BODY);
    const bodyInkPdf = inkFraction(pdf, 400, BODY);

    if (WORKING) {
      let firstDiff = -1;
      for (let i = 0; i < canvas.length; i++) {
        if (canvas[i] !== pdf[i]) {
          firstDiff = i;
          break;
        }
      }
      console.log(
        `[${variant}] stats=${JSON.stringify(stats)} firstDiff=${firstDiff} ` +
          `nonWhite canvas=${cap.canvasNonWhite} pdf=${cap.pdfNonWhite} ` +
          `bodyDelta=${bodyDelta.toFixed(4)} right c=${rightCanvas.toFixed(4)} p=${rightPdf.toFixed(4)} ` +
          `bottom c=${bottomCanvas.toFixed(4)} p=${bottomPdf.toFixed(4)} ` +
          `bodyInk c=${bodyInkCanvas.toFixed(4)} p=${bodyInkPdf.toFixed(4)} ` +
          `report=${JSON.stringify(cap.report)}`,
      );
    }

    if (variant === "shadow") {
      // The shadowed document: both arms show the shadow, and they agree.
      expect(rightCanvas).toBeGreaterThanOrEqual(0.05);
      expect(rightPdf).toBeGreaterThanOrEqual(0.05);
      expect(Math.abs(rightCanvas - rightPdf)).toBeLessThanOrEqual(0.08);
      expect(bottomCanvas).toBeGreaterThanOrEqual(0.05);
      expect(bottomPdf).toBeGreaterThanOrEqual(0.05);
      expect(Math.abs(bottomCanvas - bottomPdf)).toBeLessThanOrEqual(0.08);
      // The report states the underlay (never silent, never a fallback).
      expect(cap.report.images).toBe(1);
      expect(cap.report.notes.length).toBeGreaterThanOrEqual(1);
      expect(cap.report.rasterFallbacks).toEqual([]);
    } else {
      // The control: nothing outside the rect on either arm — the contrast
      // that proves the shadow-band assertion above can actually bite.
      expect(rightCanvas).toBe(0);
      expect(rightPdf).toBe(0);
      expect(bottomCanvas).toBe(0);
      expect(bottomPdf).toBe(0);
      expect(cap.report.images).toBe(0);
    }

    // Both variants: the body is the same solid copper fill in both arms,
    // and the arms agree within the stated tolerance.
    expect(bodyInkCanvas).toBeGreaterThanOrEqual(0.98);
    expect(bodyInkPdf).toBeGreaterThanOrEqual(0.98);
    expect(bodyDelta).toBeLessThanOrEqual(WORKING ? 1e9 : 6);
    expect(stats.mean).toBeLessThanOrEqual(WORKING ? 1e9 : 6);
    expect(stats.p99).toBeLessThanOrEqual(WORKING ? 1e9 : 96);
    expect(stats.shareGt64).toBeLessThanOrEqual(WORKING ? 1 : 0.01);
  });
}
