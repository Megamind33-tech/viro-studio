/**
 * Real vector PDF export.
 *
 * Not a screenshot in a wrapper. Every layer in the document graph is walked and
 * emitted as PDF content-stream operators:
 *
 *   vector   → path operators (`m`/`c`/`h`) with `f` / `S` / `B`
 *   type     → `Tf` + `TJ` against an embedded, subset TrueType face
 *   image    → an `/XObject Do` (raster is correct here; pixels are pixels)
 *   group    → nested `q … Q` with the group's alpha folded into its children
 *
 * ## Type: why `TJ` and not `drawText`
 *
 * The canvas positions glyphs with HarfBuzz, shaped in font units, with the
 * app's own line breaker, tracking and justification on top (see
 * `src/engine/type.ts`). `pdf-lib`'s `drawText` throws all of that away and
 * re-lays the string with fontkit's shaper, so the PDF would silently disagree
 * with the screen.
 *
 * So this exporter never hands pdf-lib a string. It calls the *same*
 * `composeFrame()` the compositor calls, takes the resulting glyph ids and
 * their absolute frame-space positions, and writes each glyph by id with a `TJ`
 * displacement chosen so the PDF pen lands on exactly the x HarfBuzz computed.
 * The glyph id, not the character, is what goes on the page — ligatures,
 * kerning, tracking and justified word gaps therefore survive verbatim.
 *
 * ## Coordinate frame
 *
 * One `cm` at the top of the page maps document pixels to points and flips y:
 *
 *     k 0 0 -k 0 ptH cm       where k = 72 / doc.ppi
 *
 * Everything below is written in document pixels, y-down, which is the exact
 * space the compositor draws in — so layer transforms, path nodes and glyph
 * positions transfer without a second coordinate system to get wrong. Text
 * objects counter-flip with `Tm = [1 0 0 -1 x y]` so glyphs come out upright.
 */
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Op,
  type PDFImage,
  appendBezierCurve,
  beginText,
  clip,
  closePath as closePathOp,
  concatTransformationMatrix,
  drawObject,
  endPath,
  endText,
  fill as fillOp,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  stroke as strokeOp,
} from "pdf-lib";
import type {
  BlendMode,
  Layer,
  Page,
  PressDocument,
  Story,
  Transform,
  TypeFrameLayer,
  VectorLayer,
} from "../document/types";
import { localMatrix } from "../document/transform";
import { destWindow, sourceWindow } from "../document/image-fit";
import { composeFrame, type FacePack, type ShapedGlyph } from "../engine/type";
import type { FontRegistry } from "../engine/font-registry";

/* ------------------------------------------------------------------ *
 * Report — what the file actually turned out to be
 * ------------------------------------------------------------------ */

export interface PdfExportReport {
  /** Page size in PDF points. */
  pagePt: { w: number; h: number };
  vectorPaths: number;
  /** One per set line — a `BT … TJ … ET` run. */
  textRuns: number;
  glyphs: number;
  images: number;
  /** Layers that could not be expressed as vector and were rasterised. */
  rasterFallbacks: string[];
  /** Honest caveats, carried into the PDF's Subject so the file describes itself. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * fontkit internals we reach into, deliberately and narrowly
 * ------------------------------------------------------------------ */

interface FkGlyph {
  id: number;
  advanceWidth: number;
  codePoints: number[];
}

interface FkSubset {
  includeGlyph(glyph: FkGlyph | number): number;
}

interface FkFont {
  unitsPerEm: number;
  characterSet: number[];
  glyphForCodePoint(codePoint: number): FkGlyph;
  getGlyph(glyphId: number, codePoints?: number[]): FkGlyph;
}

/**
 * The shape of pdf-lib's `CustomFontSubsetEmbedder`. pdf-lib's public API only
 * offers `encodeText(string)`, which re-shapes with fontkit — the one thing this
 * exporter must not do. Adding a glyph *by id* means replaying exactly what
 * `encodeText` does internally, minus the shaping.
 */
interface SubsetEmbedder {
  font: FkFont;
  /** font units → 1/1000 em, i.e. 1000 / unitsPerEm. */
  scale: number;
  subset?: FkSubset;
  glyphs?: FkGlyph[];
  glyphIdMap?: Map<number, number>;
  glyphCache?: { invalidate(): void };
}

/** A face embedded once per document, addressable by HarfBuzz glyph id. */
class EmbeddedFace {
  private readonly reverseCmap = new Map<number, number>();

  constructor(
    private readonly emb: SubsetEmbedder,
    readonly resource: PDFName,
    readonly upem: number,
  ) {
    // Priming the reverse cmap also primes fontkit's own glyph cache *with*
    // code points, which is what gives the /ToUnicode CMap something to say —
    // and /ToUnicode is what makes the text searchable rather than merely
    // present.
    for (const cp of emb.font.characterSet) {
      const g = emb.font.glyphForCodePoint(cp);
      if (g && !this.reverseCmap.has(g.id)) this.reverseCmap.set(g.id, cp);
    }
  }

  /** Include one HarfBuzz glyph id in the subset. Returns its PDF code and advance in font units. */
  glyph(gid: number): { code: number; advance: number } {
    const cp = this.reverseCmap.get(gid);
    const g = this.emb.font.getGlyph(gid, cp === undefined ? undefined : [cp]);
    const advance = g ? g.advanceWidth : 0;

    const { subset, glyphs, glyphIdMap, glyphCache } = this.emb;
    if (!subset || !glyphs || !glyphIdMap || !glyphCache || !g) {
      // Non-subset embedding: the 2-byte code *is* the glyph id (Identity-H).
      return { code: gid, advance };
    }
    const known = glyphIdMap.get(gid);
    if (known !== undefined) return { code: known, advance };
    const code = subset.includeGlyph(g);
    glyphs[code - 1] = g;
    glyphIdMap.set(gid, code);
    glyphCache.invalidate();
    return { code, advance };
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const PDF_BLEND: Record<BlendMode, string> = {
  srcOver: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  colorDodge: "ColorDodge",
  colorBurn: "ColorBurn",
  hardLight: "HardLight",
  softLight: "SoftLight",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round(v: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function hex4(code: number): string {
  return (code & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const head = dataUrl.slice(0, comma);
  if (!/;base64/i.test(head)) return null;
  const mime = /^data:([^;,]+)/i.exec(head)?.[1]?.toLowerCase() ?? "";
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

/** pdf-lib embeds PNG and JPEG only. Anything else is re-encoded to PNG, losslessly. */
async function toPngBytes(dataUrl: string): Promise<Uint8Array | null> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!out) return null;
  return new Uint8Array(await out.arrayBuffer());
}

/* ------------------------------------------------------------------ *
 * Exporter
 * ------------------------------------------------------------------ */

export interface PdfExportOptions {
  doc: PressDocument;
  /** The very face HarfBuzz shaped with. Without it, type frames cannot be emitted. */
  face: FacePack | null;
  /** Optional registry so stories can embed the face they were actually set in. */
  fonts?: FontRegistry;
  /**
   * Flatten a document to a page-sized PNG. Only ever called for the sub-stack
   * beneath an adjustment layer, which is a pixel operation on the accumulated
   * composite and has no vector equivalent.
   */
  rasterise?: (doc: PressDocument) => Uint8Array;
}


/**
 * Emit a layer's LOCAL transform as a single PDF matrix. Shares
 * document/transform.ts with the canvas so the two renderers cannot drift:
 * that shared definition is the rendering contract.
 */
function emitLocalMatrix(ops: unknown[], t: Transform): void {
  const m = localMatrix(t);
  ops.push(
    concatTransformationMatrix(round(m.a, 6), round(m.b, 6), round(m.c, 6), round(m.d, 6), round(m.e), round(m.f)),
  );
}

export async function exportPagePdf(
  opts: PdfExportOptions,
): Promise<{ bytes: Uint8Array; report: PdfExportReport }> {
  const { doc, fonts } = opts;
  let face = opts.face;
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0];
  if (!page) throw new Error("document has no page");

  const ptW = (page.widthPx / doc.ppi) * 72;
  const ptH = (page.heightPx / doc.ppi) * 72;
  const k = 72 / doc.ppi;

  const report: PdfExportReport = {
    pagePt: { w: round(ptW, 3), h: round(ptH, 3) },
    vectorPaths: 0,
    textRuns: 0,
    glyphs: 0,
    images: 0,
    rasterFallbacks: [],
    notes: [],
  };

  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([ptW, ptH]);
  const ops: PDFOperator[] = [];

  // ── resources ───────────────────────────────────────────────────────────

  const gsCache = new Map<string, PDFName>();
  const gsName = (fillA: number, strokeA: number, blend: BlendMode): PDFName => {
    const ca = round(clamp01(fillA), 4);
    const CA = round(clamp01(strokeA), 4);
    const bm = PDF_BLEND[blend] ?? "Normal";
    const key = `${ca}|${CA}|${bm}`;
    const hit = gsCache.get(key);
    if (hit) return hit;
    const dict = PDFDict.withContext(pdf.context);
    dict.set(PDFName.of("Type"), PDFName.of("ExtGState"));
    dict.set(PDFName.of("ca"), PDFNumber.of(ca));
    dict.set(PDFName.of("CA"), PDFNumber.of(CA));
    dict.set(PDFName.of("BM"), PDFName.of(bm));
    const name = pdfPage.node.newExtGState("GS", dict);
    gsCache.set(key, name);
    return name;
  };

  let embedded: EmbeddedFace | null = null;
  const embeddedById = new Map<string, EmbeddedFace>();
  const faceFor = async (pack: FacePack | null): Promise<EmbeddedFace | null> => {
    if (!pack) return null;
    const cached = embeddedById.get(pack.id);
    if (cached) return cached;
    if (embedded && pack.id === face?.id) return embedded;
    // The package ships a UMD bundle; depending on the bundler's CJS interop the
    // module object is either the fontkit instance itself or hangs off `default`.
    const mod = (await import("@pdf-lib/fontkit")) as unknown as {
      create?: unknown;
      default?: unknown;
    };
    const kit = typeof mod.create === "function" ? mod : mod.default;
    pdf.registerFontkit(kit as Parameters<PDFDocument["registerFontkit"]>[0]);
    const pdfFont = await pdf.embedFont(new Uint8Array(pack.bytes.slice(0)), {
      subset: true,
      customName: pack.name.replace(/\s+/g, ""),
    });
    const emb = (pdfFont as unknown as { embedder: SubsetEmbedder }).embedder;
    const resource = pdfPage.node.newFontDictionary("F", pdfFont.ref);
    const next = new EmbeddedFace(emb, resource, pack.upem);
    embeddedById.set(pack.id, next);
    if (!embedded) embedded = next;
    return next;
  };

  const imageCache = new Map<string, PDFName | null>();
  const imageFor = async (assetId: string): Promise<PDFName | null> => {
    const hit = imageCache.get(assetId);
    if (hit !== undefined) return hit;
    let name: PDFName | null = null;
    const asset = doc.assets[assetId];
    if (asset) {
      const raw = dataUrlBytes(asset.dataUrl);
      let img: PDFImage | null = null;
      try {
        if (raw && (raw.mime === "image/png" || /^\x89PNG/.test(String.fromCharCode(...raw.bytes.slice(0, 4))))) {
          img = await pdf.embedPng(raw.bytes);
        } else if (raw && (raw.mime === "image/jpeg" || raw.mime === "image/jpg")) {
          img = await pdf.embedJpg(raw.bytes);
        } else {
          const png = await toPngBytes(asset.dataUrl);
          if (png) img = await pdf.embedPng(png);
        }
      } catch {
        const png = await toPngBytes(asset.dataUrl).catch(() => null);
        if (png) img = await pdf.embedPng(png);
      }
      if (img) name = pdfPage.node.newXObject("Img", img.ref);
    }
    imageCache.set(assetId, name);
    return name;
  };

  // ── page frame ──────────────────────────────────────────────────────────

  ops.push(pushGraphicsState());
  ops.push(concatTransformationMatrix(k, 0, 0, -k, 0, ptH));
  // The compositor clips content to the trim; so does this.
  ops.push(rectangle(0, 0, page.widthPx, page.heightPx), clip(), endPath());

  if (page.background.a > 0) {
    ops.push(pushGraphicsState());
    ops.push(setGraphicsState(gsName(page.background.a, page.background.a, "srcOver")));
    ops.push(setFillingRgbColor(clamp01(page.background.r), clamp01(page.background.g), clamp01(page.background.b)));
    ops.push(rectangle(0, 0, page.widthPx, page.heightPx), fillOp());
    ops.push(popGraphicsState());
  }

  // ── adjustment layers: the one thing with no vector form ────────────────

  const cut = flattenCut(page);
  let vectorLayers = page.layers;
  if (cut >= 0) {
    const flattened = page.layers.slice(0, cut + 1);
    if (opts.rasterise) {
      const stub: PressDocument = {
        ...doc,
        pages: doc.pages.map((p) => (p.id === page.id ? { ...p, layers: flattened } : p)),
      };
      const png = opts.rasterise(stub);
      const img = await pdf.embedPng(png);
      const name = pdfPage.node.newXObject("Flat", img.ref);
      ops.push(pushGraphicsState());
      ops.push(concatTransformationMatrix(page.widthPx, 0, 0, -page.heightPx, 0, page.heightPx));
      ops.push(drawObject(name));
      ops.push(popGraphicsState());
      report.images += 1;
    }
    for (const l of flattened) {
      if (l.kind === "adjustment") report.rasterFallbacks.push(`${l.name} (adjustment)`);
    }
    report.rasterFallbacks.push(
      `${flattened.length} layer(s) beneath the last adjustment, flattened to one raster`,
    );
    report.notes.push(
      "An adjustment layer resamples the accumulated composite; PDF has no vector equivalent, " +
        "so the stack up to and including the last adjustment is embedded as a raster and only " +
        "the layers above it are vector.",
    );
    vectorLayers = page.layers.slice(cut + 1);
  }

  // ── layer walk ──────────────────────────────────────────────────────────

  const byId = new Map(vectorLayers.map((l) => [l.id, l] as const));
  let groupNoted = false;
  const emit = async (layer: Layer, inheritedAlpha: number): Promise<void> => {
    if (!layer.visible) return;

    if (layer.kind === "group") {
      const alpha = inheritedAlpha * layer.opacity;
      if ((layer.opacity < 1 || layer.blend !== "srcOver") && !groupNoted) {
        groupNoted = true;
        report.notes.push(
          "The canvas composites a group into its own layer before applying the group's " +
            "opacity and blend; this export folds group opacity into each child instead and " +
            "drops the group-level blend, so overlapping children inside a semi-transparent " +
            "group show through one another where the canvas would not.",
        );
      }
      ops.push(pushGraphicsState());
      // A group establishes a coordinate space for its children, exactly as on
      // canvas. Omitting this is what made grouped artwork export in the wrong
      // place while the canvas showed it correctly.
      emitLocalMatrix(ops, layer.transform);
      for (const child of vectorLayers) {
        if (child.parentId === layer.id) await emit(child, alpha);
      }
      ops.push(popGraphicsState());
      return;
    }
    if (layer.kind === "adjustment") return;

    const t = layer.transform;
    ops.push(pushGraphicsState());
    emitLocalMatrix(ops, t);

    if (layer.kind === "vector") {
      emitVector(ops, layer, inheritedAlpha, gsName, report);
    } else if (layer.kind === "type-frame") {
      const story = doc.stories.find((s) => s.id === layer.storyId);
      const pack = story ? (fonts?.resolve(story.character.fontId) ?? face) : null;
      const ef = pack ? await faceFor(pack) : null;
      if (story && ef && pack) {
        emitType(ops, layer, story, pack, ef, inheritedAlpha, gsName, report);
      } else if (story && !pack) {
        report.notes.push(`Type frame "${layer.name}" was skipped: no face was loaded.`);
      }
    } else if (layer.kind === "image-frame" || layer.kind === "raster") {
      const id = layer.assetId;
      const asset = id ? doc.assets[id] : null;
      if (id && asset) {
        const name = await imageFor(id);
        if (name) {
          emitImage(ops, layer, asset.width, asset.height, name, inheritedAlpha, gsName);
          report.images += 1;
        } else {
          report.notes.push(`Image "${layer.name}" could not be embedded and was skipped.`);
        }
      }
    }

    ops.push(popGraphicsState());
  };

  for (const layer of vectorLayers) {
    if (layer.parentId && byId.has(layer.parentId)) continue;
    await emit(layer, 1);
  }

  ops.push(popGraphicsState());
  // Spread-applied in slices: a busy page runs to tens of thousands of operators
  // and a single spread of that size is an argument-count gamble.
  for (let i = 0; i < ops.length; i += 2048) pdfPage.pushOperators(...ops.slice(i, i + 2048));

  // ── metadata that describes the file it is actually on ──────────────────

  const parts = [
    `${report.vectorPaths} vector path(s)`,
    `${report.textRuns} text run(s) / ${report.glyphs} glyph(s)`,
    `${report.images} embedded raster(s)`,
  ];
  if (face && report.glyphs > 0) parts.push(`${face.name} embedded as a TrueType subset`);
  const caveats = report.notes.join(" ");

  pdf.setTitle(doc.name);
  pdf.setCreator("VIRO Press");
  pdf.setProducer("VIRO Press — vector PDF, untagged DeviceRGB, not colour-separated, not PDF/X");
  pdf.setSubject(
    `${parts.join("; ")}. Glyphs are placed at the positions HarfBuzz shaped for the canvas. ` +
      `Colour is untagged DeviceRGB — no output intent, no ICC profile, no CMYK separation. ` +
      (caveats ? `${caveats} ` : "") +
      `This file is not PDF/X-certified.`,
  );
  pdf.setKeywords(["VIRO Press", "vector", "DeviceRGB", "not PDF/X"]);

  const bytes = await pdf.save();
  return { bytes, report };
}

/* ------------------------------------------------------------------ *
 * Vector
 * ------------------------------------------------------------------ */

type GsFn = (fillA: number, strokeA: number, blend: BlendMode) => PDFName;

/** Kappa: the circle-from-four-cubics constant, for the lone-node pen affordance. */
const KAPPA = 0.5522847498307936;

function emitVector(
  ops: PDFOperator[],
  layer: VectorLayer,
  inheritedAlpha: number,
  gsName: GsFn,
  report: PdfExportReport,
): void {
  const alpha = inheritedAlpha * layer.opacity;

  if (layer.nodes.length < 2) {
    // Mirrors the compositor: a single pen node shows as a small copper dot.
    const n = layer.nodes[0];
    if (!n) return;
    const r = 3;
    ops.push(setGraphicsState(gsName(alpha, alpha, layer.blend)));
    ops.push(setFillingRgbColor(0.878, 0.478, 0.184));
    ops.push(moveTo(round(n.x + r), round(n.y)));
    ops.push(appendBezierCurve(round(n.x + r), round(n.y + r * KAPPA), round(n.x + r * KAPPA), round(n.y + r), round(n.x), round(n.y + r)));
    ops.push(appendBezierCurve(round(n.x - r * KAPPA), round(n.y + r), round(n.x - r), round(n.y + r * KAPPA), round(n.x - r), round(n.y)));
    ops.push(appendBezierCurve(round(n.x - r), round(n.y - r * KAPPA), round(n.x - r * KAPPA), round(n.y - r), round(n.x), round(n.y - r)));
    ops.push(appendBezierCurve(round(n.x + r * KAPPA), round(n.y - r), round(n.x + r), round(n.y - r * KAPPA), round(n.x + r), round(n.y)));
    ops.push(closePathOp(), fillOp());
    report.vectorPaths += 1;
    return;
  }

  const doFill = !!layer.fill && layer.closed;
  const doStroke = !!layer.stroke;
  if (!doFill && !doStroke) return;

  const fillA = layer.fill ? layer.fill.a * alpha : 0;
  const strokeA = layer.stroke ? layer.stroke.color.a * alpha : 0;
  ops.push(setGraphicsState(gsName(fillA, strokeA, layer.blend)));
  if (layer.fill) {
    ops.push(setFillingRgbColor(clamp01(layer.fill.r), clamp01(layer.fill.g), clamp01(layer.fill.b)));
  }
  if (layer.stroke) {
    const c = layer.stroke.color;
    ops.push(setStrokingRgbColor(clamp01(c.r), clamp01(c.g), clamp01(c.b)));
    ops.push(setLineWidth(round(layer.stroke.width)));
  }

  // Node topology is exactly the compositor's PathBuilder walk.
  const n0 = layer.nodes[0]!;
  ops.push(moveTo(round(n0.x), round(n0.y)));
  for (let i = 1; i < layer.nodes.length; i++) {
    const a = layer.nodes[i - 1]!;
    const b = layer.nodes[i]!;
    ops.push(appendBezierCurve(round(a.outX), round(a.outY), round(b.inX), round(b.inY), round(b.x), round(b.y)));
  }
  if (layer.closed) {
    const last = layer.nodes[layer.nodes.length - 1]!;
    ops.push(appendBezierCurve(round(last.outX), round(last.outY), round(n0.inX), round(n0.inY), round(n0.x), round(n0.y)));
    ops.push(closePathOp());
  }
  ops.push(doFill && doStroke ? fillAndStroke() : doFill ? fillOp() : strokeOp());
  report.vectorPaths += 1;
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

function emitImage(
  ops: PDFOperator[],
  layer: Layer,
  imgW: number,
  imgH: number,
  resource: PDFName,
  inheritedAlpha: number,
  gsName: GsFn,
): void {
  if (layer.kind !== "image-frame" && layer.kind !== "raster") return;
  const t = layer.transform;
  const alpha = inheritedAlpha * layer.opacity;

  // Geometry comes from document/image-fit.ts, the same module the compositor
  // uses. This file used to re-derive it, which is exactly how two renderers
  // drift apart.
  const src = sourceWindow(layer, imgW, imgH);
  const dest = destWindow(layer, src, t.w, t.h);
  if (src.w <= 0 || src.h <= 0 || dest.w <= 0 || dest.h <= 0) return;

  // The visible region is the frame INTERSECTED with the destination rect.
  // Clipping to dest alone was the bug: for `cover` dest is larger than the
  // frame, so that clip never bit and the picture spilled. Clipping to the
  // frame alone would lose the crop bound, because PDF cannot crop an XObject
  // and relies on this rect to window it.
  const cx0 = Math.max(dest.x, 0);
  const cy0 = Math.max(dest.y, 0);
  const cx1 = Math.min(dest.x + dest.w, t.w);
  const cy1 = Math.min(dest.y + dest.h, t.h);
  if (cx1 <= cx0 || cy1 <= cy0) return;

  // PDF cannot crop an XObject, so the whole image is scaled such that the crop
  // window lands on the destination rect, and the destination rect clips it.
  const sx = dest.w / src.w;
  const sy = dest.h / src.h;
  const fullW = imgW * sx;
  const fullH = imgH * sy;
  const fullX = dest.x - src.x * sx;
  const fullY = dest.y - src.y * sy;

  ops.push(pushGraphicsState());
  ops.push(setGraphicsState(gsName(alpha, alpha, layer.blend)));
  ops.push(rectangle(round(cx0), round(cy0), round(cx1 - cx0), round(cy1 - cy0)), clip(), endPath());
  // Unit square is y-up; the extra flip puts image row 0 at the top of the rect.
  ops.push(concatTransformationMatrix(round(fullW), 0, 0, round(-fullH), round(fullX), round(fullY + fullH)));
  ops.push(drawObject(resource));
  ops.push(popGraphicsState());
}

/* ------------------------------------------------------------------ *
 * Type
 * ------------------------------------------------------------------ */

/**
 * Position error tolerated before a `TJ` displacement is written, expressed in
 * document pixels. Below this the glyph rides on the font's own advance, which
 * keeps consecutive glyphs in one hex string — better for text extraction.
 */
const POSITION_EPSILON_PX = 0.002;

function emitType(
  ops: PDFOperator[],
  layer: TypeFrameLayer,
  story: Story,
  face: FacePack,
  ef: EmbeddedFace,
  inheritedAlpha: number,
  gsName: GsFn,
  report: PdfExportReport,
): void {
  // The exact call the compositor makes — same breaker, same tracking, same
  // justification, same HarfBuzz positions.
  const composed = composeFrame(face, story, layer.transform.w, layer.transform.h);
  const alpha = inheritedAlpha * layer.opacity;

  if (composed.glyphs.length) {
    const size = story.character.size > 0 ? story.character.size : 1;
    const unitsToPx = size / ef.upem;
    const fill = story.character.fill;
    const spaceAdvPx =
      face.spaceGid >= 0 ? ef.glyph(face.spaceGid).advance * unitsToPx : 0;
    const spaceCode = face.spaceGid >= 0 ? ef.glyph(face.spaceGid).code : -1;

    ops.push(setGraphicsState(gsName(fill.a * alpha, fill.a * alpha, layer.blend)));
    ops.push(beginText());
    ops.push(setFontAndSize(ef.resource, round(size, 4)));
    ops.push(setFillingRgbColor(clamp01(fill.r), clamp01(fill.g), clamp01(fill.b)));

    for (const line of groupLines(composed.glyphs)) {
      const originX = line[0]!.x;
      const originY = line[0]!.y;
      // Counter-flip: the page CTM is y-down, glyph outlines are y-up.
      ops.push(setTextMatrix(1, 0, 0, -1, round(originX, 4), round(originY, 4)));

      const items: Array<string | number> = [];
      let pen = 0; // text-space x, relative to originX
      let hexRun = "";

      const put = (gid: number, target: number | null): void => {
        const { code, advance } = ef.glyph(gid);
        const advPx = advance * unitsToPx;
        if (target !== null) {
          const errPx = pen - target;
          const adj = round((errPx * 1000) / size, 4);
          if (Math.abs(errPx) > POSITION_EPSILON_PX && adj !== 0) {
            if (hexRun) {
              items.push(hexRun);
              hexRun = "";
            }
            items.push(adj);
            // Track the pen from the *emitted* number, not the ideal one, so the
            // 4-decimal rounding cannot accumulate down the line.
            pen -= (adj / 1000) * size;
          }
        }
        hexRun += hex4(code);
        pen += advPx;
        report.glyphs += 1;
      };

      for (let i = 0; i < line.length; i++) {
        const g = line[i]!;
        const target = g.x - originX;
        // composeFrame drops glyphs with empty outlines — the word space among
        // them. The gap it leaves is real, so put the space glyph back: it paints
        // nothing, and without it the extracted text has no word breaks.
        if (i > 0 && spaceCode >= 0 && spaceAdvPx > 0 && target - pen > spaceAdvPx * 0.5) {
          put(face.spaceGid, null);
        }
        put(g.gid, target);
      }
      if (hexRun) items.push(hexRun);

      ops.push(showTextAdjusted(items));
      report.textRuns += 1;
    }

    ops.push(endText());
  }

  const underline = !!story.character.underline;
  const strike = !!story.character.strikethrough;
  if ((underline || strike) && composed.lines.length) {
    const size = story.character.size > 0 ? story.character.size : 1;
    const fill = story.character.fill;
    ops.push(setGraphicsState(gsName(fill.a * alpha, fill.a * alpha, layer.blend)));
    ops.push(setStrokingRgbColor(clamp01(fill.r), clamp01(fill.g), clamp01(fill.b)));
    ops.push(setLineWidth(Math.max(1, size * 0.055)));
    for (const line of composed.lines) {
      if (underline) {
        const y = line.baseline + size * 0.12;
        ops.push(moveTo(round(line.x), round(y)), lineTo(round(line.x + line.width), round(y)), strokeOp());
        report.vectorPaths += 1;
      }
      if (strike) {
        const y = line.baseline - size * 0.28;
        ops.push(moveTo(round(line.x), round(y)), lineTo(round(line.x + line.width), round(y)), strokeOp());
        report.vectorPaths += 1;
      }
    }
  }

  if (composed.overflow) {
    // Parity with the canvas, which paints a red overset marker into the page
    // composite itself (not into overlay chrome).
    ops.push(setGraphicsState(gsName(1, 1, "srcOver")));
    ops.push(setStrokingRgbColor(0.84, 0.18, 0.18));
    ops.push(setLineWidth(2));
    ops.push(moveTo(round(layer.transform.w - 10), 4), lineTo(round(layer.transform.w - 10), 14), strokeOp());
    ops.push(moveTo(round(layer.transform.w - 15), 9), lineTo(round(layer.transform.w - 5), 9), strokeOp());
    report.vectorPaths += 2;
  }
}

/** Consecutive glyphs sharing a baseline are one set line, therefore one `TJ` run. */
function groupLines(glyphs: ShapedGlyph[]): ShapedGlyph[][] {
  const lines: ShapedGlyph[][] = [];
  let cur: ShapedGlyph[] = [];
  for (const g of glyphs) {
    if (cur.length && cur[cur.length - 1]!.y !== g.y) {
      lines.push(cur);
      cur = [];
    }
    cur.push(g);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * `[ <hex> adj <hex> … ] TJ`. Built by hand because pdf-lib's `showText` only
 * emits `Tj`, which cannot carry per-glyph displacements.
 */
function showTextAdjusted(items: Array<string | number>): PDFOperator {
  const parts = items.map((it) => (typeof it === "number" ? String(round(it, 4)) : `<${it}>`));
  return PDFOperator.of(Op.ShowTextAdjusted, [`[${parts.join(" ")}]`]);
}

/* ------------------------------------------------------------------ *
 * Adjustment cut
 * ------------------------------------------------------------------ */

/**
 * Index of the last layer that must be flattened, or -1 when the page is fully
 * vector. Extends past the last visible adjustment layer to swallow any group
 * whose children would otherwise straddle the cut.
 */
function flattenCut(page: Page): number {
  let cut = -1;
  for (let i = 0; i < page.layers.length; i++) {
    if (page.layers[i]!.kind === "adjustment" && page.layers[i]!.visible) cut = i;
  }
  if (cut < 0) return -1;
  const inside = new Set<string>();
  for (let i = 0; i <= cut; i++) inside.add(page.layers[i]!.id);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < page.layers.length; i++) {
      const l = page.layers[i]!;
      const parent = l.parentId;
      if (parent && inside.has(parent) && !inside.has(l.id)) {
        inside.add(l.id);
        if (i > cut) cut = i;
        grew = true;
      }
    }
  }
  return cut;
}
