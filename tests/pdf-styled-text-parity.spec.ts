import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { createDocument, addTypeFrame } from "../src/document/factory";
import { setStoryText, setCharacter } from "../src/document/ops";
import { applyCharacterRange } from "../src/document/text-model";
import type { PressDocument, TypeFrameLayer } from "../src/document/types";

/**
 * VIRO-0147 — the styled text the PDF paints must be the styled text the
 * canvas paints. Artifact-level proof through the independent pdf.js oracle
 * (same vendored Apache-2.0 legacy build the VIRO-0146 parity suite uses):
 *
 *   1. the critic-repro document — one line, two character ranges ("VIRO"
 *      64px copper, "corpus" 34px blue over a 12px black story style) — is
 *      opened in the live editor with the app's own `openBytes`;
 *   2. the REAL compositor snapshots the page (the canvas truth);
 *   3. the real exporter — the exact module and argument shape src/app.ts
 *      exportPdf() uses, fonts registry included so a range face could
 *      resolve — saves the PDF;
 *   4. pdf.js extracts the text layer (getTextContent: the composed string,
 *      and per-item font sizes + origins — artifact-level proof that both
 *      spans exist at their own sizes and positions) and rasterises page 1;
 *   5. rendered pixels are classified by hue on both arms: the copper-span
 *      population and the blue-span population must each exist, in the right
 *      place (copper left of blue), and agree between canvas and PDF within
 *      generous rasteriser tolerance.
 *
 * Before this packet the same document exported every glyph at the story's
 * 12px black scattered across the mixed advances — a pdf.js arm could not
 * have produced either the size pin or the two-population colour pin.
 */

const COPPER = { r: 0.878, g: 0.478, b: 0.184, a: 1 };
const BLUE = { r: 0.1, g: 0.3, b: 0.9, a: 1 };

function styledDoc(): PressDocument {
  let doc = createDocument({
    name: "VIRO-0147 Styled Parity",
    ppi: 72,
    widthPx: 400,
    heightPx: 300,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  // Same practice as tests/export-corpus-docs.mjs: zero the paper.
  doc.pages[0].background.a = 0;
  doc = addTypeFrame(doc, "noto-sans", 40, 60, { w: 320, h: 120 });
  const id = doc.activeLayerIds[0];
  doc = setStoryText(doc, id, "VIRO corpus");
  doc = setCharacter(doc, id, { size: 12, leading: 14.4, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 } });
  const layer = doc.pages[0].layers.find((l): l is TypeFrameLayer => l.kind === "type-frame")!;
  const story = doc.stories.find((s) => s.id === layer.storyId)!;
  let styled = applyCharacterRange(story, 0, 4, { size: 64, leading: 76.8, fill: COPPER });
  styled = applyCharacterRange(styled, 5, 11, { size: 34, leading: 40.8, fill: BLUE });
  doc.stories[doc.stories.findIndex((s) => s.id === story.id)] = styled;
  return doc;
}

interface TextItem {
  str: string;
  height: number; // font size the oracle saw (viewport scale applied)
  x: number; // baseline origin, page px (y-down)
  y: number;
}

interface Capture {
  canvasRgbaB64: string;
  pdfRgbaB64: string;
  width: number;
  height: number;
  text: string;
  items: TextItem[];
  report: {
    glyphs: number;
    textRuns: number;
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

async function capture(page: Page, json: string, name: string): Promise<Capture> {
  await page.evaluate(
    async ({ json, name }: { json: string; name: string }) => {
      const P = (
        window as unknown as {
          __press?: {
            doc: { name: string; ppi: number };
            openBytes(name: string, buffer: ArrayBuffer): Promise<void>;
            compositor: { snapshotPagePng(doc: unknown): Uint8Array };
          };
        }
      ).__press;
      if (!P || !P.compositor) throw new Error("app not booted / compositor missing");
      const bytes = new TextEncoder().encode(json);
      await P.openBytes(`${name}.press.json`, bytes.buffer);
      if (P.doc.name !== name) throw new Error(`open failed: doc is "${P.doc.name}", expected "${name}"`);
      // pdf.js renders points; the canvas arm is in page pixels. ppi is a
      // document-level field; corpus pages are ppi 72, so the render scale is
      // ppi/72 (1 here) — derived, not assumed.
      const w0 = window as unknown as { __viroStyledScale?: number };
      w0.__viroStyledScale = P.doc.ppi / 72;
    },
    { json, name },
  );

  // Canvas truth + the PDF through the exact src/app.ts exportPdf() shape.
  await page.evaluate(
    async () => {
      const P = (
        window as unknown as {
          __press?: {
            doc: unknown;
            compositor: { snapshotPagePng(doc: unknown): Uint8Array };
            fonts: { resolve(id?: string | undefined): unknown };
            face: unknown;
          };
          __viroStyledProbe?: Record<string, unknown>;
        }
      ).__press;
      if (!P) throw new Error("app not booted");
      const w = window as unknown as { __viroStyledProbe?: Record<string, unknown> };
      w.__viroStyledProbe = {};

      const png = P.compositor.snapshotPagePng(P.doc);
      const bmp = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }));
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      w.__viroStyledProbe.canvas = ctx.getImageData(0, 0, cv.width, cv.height).data.buffer;

      const moduleUrl = "/src/export/pdf.ts";
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as unknown as {
        exportPagePdf(o: {
          doc: unknown;
          face: unknown;
          fonts?: unknown;
          rasterise?: (doc: unknown) => Uint8Array;
        }): Promise<{
          bytes: Uint8Array;
          report: { glyphs: number; textRuns: number; rasterFallbacks: string[]; notes: string[] };
        }>;
      };
      const { bytes, report } = await mod.exportPagePdf({
        doc: P.doc,
        face: P.fonts.resolve(undefined) ?? P.face,
        fonts: P.fonts,
        rasterise: (doc: unknown) => P.compositor.snapshotPagePng(doc),
      });
      if (!(bytes.byteLength > 0)) throw new Error("exportPagePdf returned empty bytes");
      w.__viroStyledProbe.pdfBytes = new Uint8Array(bytes).buffer;
      w.__viroStyledProbe.report = report;
    },
  );

  // pdf.js oracle: the same vendored build the VIRO-0146 suite pins.
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

  return page.evaluate(
    async (): Promise<Capture> => {
      const w = window as unknown as {
        __viroStyledProbe?: { canvas?: ArrayBuffer; pdfBytes?: ArrayBuffer; report?: Capture["report"] };
        __viroStyledScale?: number;
        pdfjsLib?: {
          getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDoc> };
        };
      };
      const probe = w.__viroStyledProbe!;
      if (!probe?.canvas || !probe?.pdfBytes || !probe?.report) throw new Error("probe state missing");
      const lib = w.pdfjsLib;
      if (!lib) throw new Error("pdf.js failed to load");

      interface PdfDoc {
        numPages: number;
        getPage(n: number): Promise<PdfPage>;
      }
      interface PdfPage {
        getViewport(o: { scale: number }): { width: number; height: number };
        render(o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void> };
        getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }>;
      }

      const pdf = await lib.getDocument({ data: new Uint8Array(probe.pdfBytes) }).promise;
      if (!(pdf.numPages >= 1)) throw new Error("pdf.js parsed zero pages");
      const p = await pdf.getPage(1);
      // The canvas arm is in page pixels (snapshotPagePng is 1:1); render the
      // PDF at the scale that maps points back to those pixels.
      const rawScale = w.__viroStyledScale;
      const scale = typeof rawScale === "number" && Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

      // Text layer: the composed string plus per-item geometry, flipped to
      // page px y-down so it can be compared with the canvas arm directly.
      const tc = await p.getTextContent();
      const items: TextItem[] = [];
      let text = "";
      const vpH = p.getViewport({ scale }).height;
      for (const it of tc.items) {
        if (!it.str || !it.transform) continue;
        text += it.str;
        items.push({
          str: it.str,
          height: it.transform[3] ?? 0,
          x: it.transform[4] ?? 0,
          y: vpH - (it.transform[5] ?? 0),
        });
      }

      // Raster.
      const vp = p.getViewport({ scale });
      if (!(vp.width > 0) || !(vp.height > 0)) {
        throw new Error(`bad viewport w=${vp.width} h=${vp.height} scale=${scale} bytes=${probe.pdfBytes.byteLength}`);
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
      return {
        canvasRgbaB64: b64(probe.canvas),
        pdfRgbaB64: b64(img.data.buffer),
        width: cv.width,
        height: cv.height,
        text,
        items,
        report: probe.report,
      };
    },
  );
}

/* ------------------------------------------------------------------ *
 * Node-side pixel + geometry metrics
 * ------------------------------------------------------------------ */

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

interface InkStats {
  ink: number;
  copper: number;
  blue: number;
  copperMeanX: number;
  blueMeanX: number;
}

/** Hue-classified ink populations: copper has r>b by a wide margin, blue the reverse. */
function inkStats(rgb: Buffer, width: number, height: number): InkStats {
  let ink = 0;
  let copper = 0;
  let blue = 0;
  let cx = 0;
  let bx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const r = rgb[o]!;
      const g = rgb[o + 1]!;
      const b = rgb[o + 2]!;
      if (r >= 235 && g >= 235 && b >= 235) continue;
      ink += 1;
      if (r > b + 40 && r > g) {
        copper += 1;
        cx += x;
      } else if (b > r + 40 && b > g) {
        blue += 1;
        bx += x;
      }
    }
  }
  return {
    ink,
    copper,
    blue,
    copperMeanX: copper ? cx / copper : -1,
    blueMeanX: blue ? bx / blue : -1,
  };
}

test("pdf-styled-text parity: pdf.js text layer shows both ranges at their own size, colour and place", async ({ page }) => {
  const name = "VIRO-0147 Styled Parity";
  await page.goto("/");
  await bootReady(page);
  const cap = await capture(page, JSON.stringify(styledDoc()), name);

  expect(cap.width).toBe(400);
  expect(cap.height).toBe(300);

  // Text-content proof: the full composed string extracts, styled boundary
  // word break included.
  expect(cap.text).toBe("VIRO corpus");

  // Size + place proof: one item cluster at 64px starting at the frame's left
  // edge, one at 34px where the canvas starts "corpus" (≈40 + 154 = 194),
  // both on the single composed baseline (frame y 60 + first baseline 12.83).
  const big = cap.items.filter((i) => Math.abs(i.height - 64) < 1);
  const small = cap.items.filter((i) => Math.abs(i.height - 34) < 1);
  expect(big.length).toBeGreaterThan(0);
  expect(small.length).toBeGreaterThan(0);
  expect(cap.items.every((i) => i.height > 12 || i.str.trim() === "")).toBe(true);
  const bigX = Math.min(...big.map((i) => i.x));
  const smallX = Math.min(...small.map((i) => i.x));
  expect(bigX).toBeGreaterThanOrEqual(39);
  expect(bigX).toBeLessThanOrEqual(42);
  expect(smallX).toBeGreaterThan(bigX + 100);
  expect(smallX).toBeLessThanOrEqual(198);
  for (const i of cap.items) {
    expect(i.y).toBeGreaterThan(71);
    expect(i.y).toBeLessThan(76);
  }

  // Rendered-pixel proof, both arms: two hue populations in the right order.
  const canvas = inkStats(overWhite(Buffer.from(cap.canvasRgbaB64, "base64")), cap.width, cap.height);
  const pdf = inkStats(overWhite(Buffer.from(cap.pdfRgbaB64, "base64")), cap.width, cap.height);

  for (const arm of [canvas, pdf]) {
    expect(arm.copper).toBeGreaterThan(50);
    expect(arm.blue).toBeGreaterThan(30);
    expect(arm.copperMeanX).toBeLessThan(arm.blueMeanX - 20);
  }
  // Cross-arm agreement within generous rasteriser tolerance (Skia canvas AA
  // vs pdf.js glyph rasterisation): neither population may more than halve or
  // double against the other arm.
  expect(pdf.copper).toBeGreaterThan(canvas.copper * 0.5);
  expect(pdf.copper).toBeLessThan(canvas.copper * 2);
  expect(pdf.blue).toBeGreaterThan(canvas.blue * 0.5);
  expect(pdf.blue).toBeLessThan(canvas.blue * 2);

  // The report tells the truth about what was emitted.
  expect(cap.report.textRuns).toBe(2);
  expect(cap.report.glyphs).toBeGreaterThanOrEqual(10);
  expect(cap.report.rasterFallbacks).toEqual([]);
  expect(cap.report.notes.length).toBeGreaterThanOrEqual(1);
});
