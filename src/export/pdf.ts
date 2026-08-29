/**
 * Real vector PDF export.
 *
 * Not a screenshot in a wrapper. Every layer in the document graph is walked and
 * emitted as PDF content-stream operators:
 *
 *   vector   → path operators (`m`/`c`/`h`) with `f` / `S` / `B`
 *   type     → `Tf` + `TJ` against an embedded full TrueType face
 *              (not a subset — see the note at `faceFor`)
 *   image    → an `/XObject Do` (raster is correct here; pixels are pixels)
 *   group    → nested `q … Q` with the group's alpha folded into its children
 *
 * ## Drop shadows
 *
 * A layer's enabled drop shadow is rendered by the SAME Skia filter the
 * compositor uses (`ImageFilter.MakeDropShadowOnly`, sigma = blur/2, colour
 * alpha = colour.a × opacity, kernel truncated at 3σ — see
 * `src/engine/compositor.ts withDropShadow`), rasterised into a transparent
 * PNG and embedded beneath the layer as an `/XObject Do` underlay. Only the
 * shadow pixels are raster; the layer content above them stays vector. When
 * the shadow cannot be rendered (no Skia in this environment), the report
 * records a rasterFallbacks entry and a note — never a silent drop. Outer
 * glow / stroke / gradient-overlay effects are not represented and are
 * reported the same way.
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
  DropShadowEffect,
  Layer,
  LayerEffect,
  Page,
  PressDocument,
  Story,
  Transform,
  TypeFrameLayer,
  VectorLayer,
} from "../document/types";
import { localMatrix, type Mat } from "../document/transform";
import { destWindow, sourceWindow } from "../document/image-fit";
import { composeFrame, type FacePack, type ShapedGlyph } from "../engine/type";
import { loadCanvasKit } from "../engine/canvaskit";
import type { FontRegistry } from "../engine/font-registry";
import type {
  CanvasKit,
  ImageFilter,
  Paint as SkPaint,
  Path as SkPath,
  Surface as SkSurface,
} from "canvaskit-wasm";

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

/**
 * A face embedded once per document, addressable by HarfBuzz glyph id.
 *
 * Written without TypeScript parameter properties on purpose: parameter
 * properties are non-erasable syntax, and `node --experimental-strip-types`
 * (which the unit-test gate runs under) refuses to load any module that uses
 * them. The same constraint applies to every class in this file.
 */
class EmbeddedFace {
  private readonly reverseCmap = new Map<number, number>();
  private readonly emb: SubsetEmbedder;
  readonly resource: PDFName;
  readonly upem: number;

  // Plain field assignments, not constructor parameter properties: the latter
  // is TS-only syntax that node --experimental-strip-types (used to run
  // tests/** without a build step) cannot strip, which made this file
  // unimportable from any unit test.
  constructor(emb: SubsetEmbedder, resource: PDFName, upem: number) {
    this.emb = emb;
    this.resource = resource;
    this.upem = upem;
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
 * Drop shadows — the same Skia semantics as the compositor
 * ------------------------------------------------------------------ */

/**
 * The layer's enabled drop shadow, if any. Identical precedence to
 * `compositor.ts dropShadowOf`: the first enabled `drop-shadow` wins.
 */
function dropShadowOf(layer: Layer): DropShadowEffect | null {
  const fx = layer.effects;
  if (!fx) return null;
  for (const e of fx) if (e.type === "drop-shadow" && e.enabled) return e;
  return null;
}

/** Enabled effects this exporter does not represent (everything but the shadow). */
function unrepresentedEffectsOf(layer: Layer): LayerEffect[] {
  const fx = layer.effects;
  if (!fx) return [];
  return fx.filter((e) => e.enabled && e.type !== "drop-shadow");
}

/**
 * Lazy CanvasKit for shadow rasterisation. The compositor's blur lives in
 * Skia; reusing the same engine here is what makes canvas/PDF shadow parity a
 * construction property instead of a tuning exercise. Fails soft: a null kit
 * degrades to honest rasterFallback reporting, never a wrong or missing file.
 */
let shadowKitPromise: Promise<CanvasKit | null> | null = null;
function shadowKit(): Promise<CanvasKit | null> {
  shadowKitPromise ??= loadCanvasKit()
    .then((r) => r.ck)
    .catch(() => null);
  return shadowKitPromise;
}

/** Skia's Gaussian kernel is truncated at 3σ, and the compositor's sigma is blur/2. */
const SIGMA_PER_BLUR = 0.5;
/** Anti-aliased silhouettes bleed a little; the compositor pads its saveLayer by 2px too. */
const SHADOW_AA_PAD = 2;
/** Hard cap on a shadow underlay's raster side — a runaway blur must fail loudly, not OOM. */
const SHADOW_RASTER_MAX_PX = 4096;

/**
 * One drawable piece of a layer's silhouette, with the effective content
 * alpha the canvas would paint it with — because Skia's drop-shadow filter
 * blurs the *drawn alpha*, the shadow strength must reproduce it.
 *
 * `path` stays in the space the geometry was built in (layer-local / frame /
 * font units); `matrix` carries it into the space the layer's content is
 * emitted in (its parent's space) and is applied as a canvas concat, exactly
 * like the compositor's `concatLocal` — so stroke widths, dashes and the
 * blur itself all scale the way they do on canvas.
 */
interface ShadowDraw {
  path: SkPath;
  matrix: Mat;
  alpha: number;
  /** Null = filled silhouette; otherwise the stroked band (width in local px). */
  stroke: {
    width: number;
    cap?: NonNullable<VectorLayer["stroke"]>["cap"];
    join?: NonNullable<VectorLayer["stroke"]>["join"];
    dash?: number[];
    dashPhase?: number;
  } | null;
  evenOdd: boolean;
}

/** Affine compose: `matCompose(m, n)` applies `n` first, then `m`. */
function matCompose(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** Skia row-major 3×3 from a localMatrix — same mapping as the compositor's concatLocal. */
function skiaMatrix(m: Mat): number[] {
  return [m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1];
}

/**
 * The layer's own silhouette in its LOCAL space. Mirrors
 * `compositor.ts drawVector`: same contour precedence, same fill gating
 * (`fill && anyClosed`), same even-odd rule, same stroke attributes — and the
 * single-node copper dot, whose shadow the canvas also paints. `chain` maps
 * this layer's local space into the space its content is emitted in.
 * Returns nothing when the canvas would paint no pixels.
 */
function vectorShadowDraws(ck: CanvasKit, layer: VectorLayer, chain: Mat, alpha: number, out: ShadowDraw[]): void {
  // PRECEDENCE (v6) — identical expression to emitVector and drawVector.
  const multi = Array.isArray(layer.contours) && layer.contours.length > 0;
  const contours = multi ? layer.contours! : [{ nodes: layer.nodes, closed: layer.closed }];

  if (!multi && layer.nodes.length < 2) {
    // The compositor paints a lone pen node as a small copper dot; the PDF
    // emitter does too, so its shadow belongs here as well.
    const n = layer.nodes[0];
    if (!n) return;
    const dot = dotPath(ck, n.x, n.y, 3);
    if (dot) out.push({ path: dot, matrix: chain, alpha: 1, stroke: null, evenOdd: false });
    return;
  }

  const drawable = contours.filter((c) => c.nodes.length >= 2);
  if (drawable.length === 0) return;
  const anyClosed = drawable.some((c) => c.closed);
  const doFill = !!layer.fill && anyClosed;
  const doStroke = !!layer.stroke;
  if (!doFill && !doStroke) return;

  const builder = new ck.PathBuilder();
  for (const c of drawable) {
    const n0 = c.nodes[0]!;
    builder.moveTo(n0.x, n0.y);
    for (let i = 1; i < c.nodes.length; i++) {
      const a = c.nodes[i - 1]!;
      const b = c.nodes[i]!;
      builder.cubicTo(a.outX, a.outY, b.inX, b.inY, b.x, b.y);
    }
    if (c.closed) {
      const last = c.nodes[c.nodes.length - 1]!;
      builder.cubicTo(last.outX, last.outY, n0.inX, n0.inY, n0.x, n0.y);
      builder.close();
    }
  }
  const path = builder.detach();
  const evenOdd = multi && drawable.length > 1;
  if (evenOdd) path.setFillType(ck.FillType.EvenOdd);

  if (doFill && layer.fill) {
    out.push({ path, matrix: chain, alpha: alpha * layer.fill.a, stroke: null, evenOdd });
  }
  if (doStroke && layer.stroke) {
    // The fill silhouette and the stroked band share the contour geometry; the
    // path is owned once and handed to the first draw (the renderer deletes it).
    out.push({
      path: doFill ? path.copy() : path,
      matrix: chain,
      alpha: alpha * layer.stroke.color.a,
      stroke: {
        width: layer.stroke.width,
        cap: layer.stroke.cap,
        join: layer.stroke.join,
        dash: layer.stroke.dash,
        dashPhase: layer.stroke.dashPhase,
      },
      evenOdd: false,
    });
  }
}

/** A circle of radius r about (cx, cy) as four cubics — the compositor's dot, as a path. */
function dotPath(ck: CanvasKit, cx: number, cy: number, r: number): SkPath | null {
  const builder = new ck.PathBuilder();
  builder.moveTo(cx + r, cy);
  builder.cubicTo(cx + r, cy + r * KAPPA, cx + r * KAPPA, cy + r, cx, cy + r);
  builder.cubicTo(cx - r * KAPPA, cy + r, cx - r, cy + r * KAPPA, cx - r, cy);
  builder.cubicTo(cx - r, cy - r * KAPPA, cx - r * KAPPA, cy - r, cx, cy - r);
  builder.cubicTo(cx + r * KAPPA, cy - r, cx + r, cy - r * KAPPA, cx + r, cy);
  builder.close();
  return builder.detach();
}

/**
 * The image silhouette: the frame-intersected destination rect the compositor
 * actually blits into (same sourceWindow/destWindow contract as emitImage),
 * so `contain`'s letterbox bands carry no shadow, exactly as on canvas.
 * An asset the canvas could not draw casts no shadow either.
 */
function imageShadowDraws(ck: CanvasKit, layer: Layer, asset: { width: number; height: number } | null, chain: Mat, alpha: number, out: ShadowDraw[]): void {
  if (layer.kind !== "image-frame" && layer.kind !== "raster") return;
  if (!asset) return;
  const vis = visibleImageRect(layer, asset.width, asset.height);
  if (!vis) return;
  const rect = ck.Path.MakeFromSVGString(
    `M ${vis.x} ${vis.y} L ${vis.x + vis.w} ${vis.y} L ${vis.x + vis.w} ${vis.y + vis.h} L ${vis.x} ${vis.y + vis.h} Z`,
  );
  if (!rect) return;
  out.push({ path: rect, matrix: chain, alpha, stroke: null, evenOdd: false });
}

/**
 * The type silhouette: every shaped glyph's SVG outline (the exact outlines
 * `drawTypeFrame` paints). Each glyph carries its own place-and-scale (font
 * units are y-up, the frame is y-down), composed onto the layer chain.
 */
function typeShadowDraws(ck: CanvasKit, layer: TypeFrameLayer, story: Story, face: FacePack, chain: Mat, alpha: number, out: ShadowDraw[]): void {
  const composed = composeFrame(face, story, layer.transform.w, layer.transform.h);
  for (const g of composed.glyphs) {
    if (!g.path) continue;
    const p = ck.Path.MakeFromSVGString(g.path);
    if (!p) continue;
    // drawTypeFrame: translate(g.x, g.y) then scale(g.scale, -g.scale).
    const glyphMat: Mat = { a: g.scale, b: 0, c: 0, d: -g.scale, e: g.x, f: g.y };
    out.push({ path: p, matrix: matCompose(chain, glyphMat), alpha: alpha * g.fill.a, stroke: null, evenOdd: false });
  }
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
  /**
   * An already-initialised CanvasKit, for drop-shadow rasterisation. Optional:
   * when absent the exporter lazily boots its own through
   * `engine/canvaskit.loadCanvasKit()` (the browser path); in bare Node no
   * wasm URL resolves, so hosts that export shadows under Node should pass
   * the instance they already initialised. When no kit can be obtained,
   * shadows are recorded in `report.rasterFallbacks` — never dropped silently.
   */
  ck?: CanvasKit;
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
    // subset:false is deliberate. pdf-lib's subsetter (the fontkit fork it
    // bundles) emits a TrueType subset whose glyf/loca drift — e.g. for Noto
    // Sans Regular the saved FontFile2 is 1313 bytes against a last loca
    // offset of 1312 with individual glyph outlines reading out of bounds.
    // pdf.js then paints only fragmentary glyphs and fontkit throws
    // "Offset is outside the bounds of the DataView" on glyph 4. A full-font
    // embed keeps the face byte-identical, so Identity-H CIDs stay equal to
    // the HarfBuzz glyph ids this file writes, and every viewer sees the
    // whole face. The cost is file size, carried honestly in report.notes.
    const pdfFont = await pdf.embedFont(new Uint8Array(pack.bytes.slice(0)), {
      subset: false,
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

  /* ── drop shadows: collect the silhouette, rasterise, embed beneath ── */

  let shadowKitResolved = false;
  let kit: CanvasKit | null = null;
  let shadowMethodNoted = false;
  let shadowKitNoted = false;
  let shadowRegionNoted = false;
  let unrepresentedNoted = false;

  const noteNoRasteriser = (layerName: string): void => {
    report.rasterFallbacks.push(`${layerName} (drop shadow)`);
    if (!shadowKitNoted) {
      shadowKitNoted = true;
      report.notes.push(
        "At least one drop shadow is absent from this file: no Skia rasteriser was available where " +
          "the export ran, so the canvas shows a shadow the PDF does not. Every affected layer is " +
          "listed in rasterFallbacks.",
      );
    }
  };

  const noteRegionTooLarge = (layerName: string, w: number, h: number): void => {
    report.rasterFallbacks.push(`${layerName} (drop shadow — ${w}×${h}px region)`);
    if (!shadowRegionNoted) {
      shadowRegionNoted = true;
      report.notes.push(
        "At least one drop shadow has a blur/offset whose raster underlay would exceed the " +
          `${SHADOW_RASTER_MAX_PX}px per-side budget, so it is absent from this file. Every ` +
          "affected layer is listed in rasterFallbacks.",
      );
    }
  };

  /**
   * The layer's shadow silhouette as drawable pieces, in the layer's LOCAL
   * space with a matrix chain into `chain`'s target space. Walks children
   * exactly like `emit` does (same vectorLayers filter, same visibility rule,
   * same inherited-alpha folding), so a group's shadow takes the composited
   * group silhouette the canvas blurs.
   */
  const collectShadowDraws = (ck: CanvasKit, layer: Layer, chain: Mat, inheritedAlpha: number, out: ShadowDraw[]): void => {
    const alpha = inheritedAlpha * layer.opacity;
    if (layer.kind === "group") {
      for (const child of vectorLayers) {
        if (child.parentId !== layer.id || !child.visible) continue;
        collectShadowDraws(ck, child, matCompose(chain, localMatrix(child.transform)), alpha, out);
      }
      return;
    }
    if (layer.kind === "adjustment") return;
    if (layer.kind === "vector") {
      vectorShadowDraws(ck, layer, chain, alpha, out);
    } else if (layer.kind === "image-frame" || layer.kind === "raster") {
      const id = layer.assetId;
      const asset = id ? doc.assets[id] : null;
      imageShadowDraws(ck, layer, asset, chain, alpha, out);
    } else if (layer.kind === "type-frame") {
      const story = doc.stories.find((s) => s.id === layer.storyId);
      const pack = story ? (fonts?.resolve(story.character.fontId) ?? face) : null;
      if (story && pack) typeShadowDraws(ck, layer, story, pack, chain, alpha, out);
    }
  };

  /**
   * Emit the layer's drop shadow as a transparent-PNG XObject underlay, in the
   * coordinate space the layer's own content is about to be emitted in. The
   * mirror of `compositor.ts withDropShadow`: MakeDropShadowOnly, sigma =
   * blur/2, colour alpha = colour.a × opacity, content drawn with its real
   * alpha inside the filtered layer so the blur sees what the canvas sees.
   */
  const emitShadowUnderlay = async (layer: Layer, inheritedAlpha: number): Promise<void> => {
    const shadow = dropShadowOf(layer);
    if (!shadow || !shadow.enabled || shadow.blur < 0) return;

    if (!shadowKitResolved) {
      shadowKitResolved = true;
      kit = opts.ck ?? (await shadowKit());
    }
    if (!kit) {
      noteNoRasteriser(layer.name);
      return;
    }

    const local: ShadowDraw[] = [];
    // chain: the layer's local space → the space its content is emitted in.
    const chain = localMatrix(layer.transform);
    collectShadowDraws(kit, layer, chain, inheritedAlpha, local);
    if (local.length === 0) return; // the canvas paints no pixels, so it casts no shadow either

    // Region: transformed silhouette bounds + 3σ blur + |offset| + stroke
    // spread + AA pad. Corner-mapping each tight box is conservative for
    // rotated ancestors, which is exactly what a region budget should be.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let strokeMax = 0;
    for (const d of local) {
      const b = d.path.computeTightBounds();
      if (!b || b.length < 4) continue;
      const corners: Array<[number, number]> = [
        [b[0]!, b[1]!],
        [b[2]!, b[1]!],
        [b[2]!, b[3]!],
        [b[0]!, b[3]!],
      ];
      for (const [cx, cy] of corners) {
        const px = d.matrix.a * cx + d.matrix.c * cy + d.matrix.e;
        const py = d.matrix.b * cx + d.matrix.d * cy + d.matrix.f;
        x0 = Math.min(x0, px);
        y0 = Math.min(y0, py);
        x1 = Math.max(x1, px);
        y1 = Math.max(y1, py);
      }
      if (d.stroke) strokeMax = Math.max(strokeMax, d.stroke.width * Math.max(d.matrix.a, d.matrix.d));
    }
    if (x1 <= x0 || y1 <= y0) return;

    const sigma = Math.max(0, shadow.blur) * SIGMA_PER_BLUR;
    const padX = 3 * sigma + Math.abs(shadow.offsetX) + strokeMax + SHADOW_AA_PAD;
    const padY = 3 * sigma + Math.abs(shadow.offsetY) + strokeMax + SHADOW_AA_PAD;
    const L = Math.floor(x0 - padX);
    const T = Math.floor(y0 - padY);
    const W = Math.ceil(x1 + padX) - L;
    const H = Math.ceil(y1 + padY) - T;
    if (W <= 0 || H <= 0 || W > SHADOW_RASTER_MAX_PX || H > SHADOW_RASTER_MAX_PX) {
      noteRegionTooLarge(layer.name, W, H);
      for (const d of local) d.path.delete();
      return;
    }

    const surf: SkSurface | null = kit.MakeSurface(W, H);
    if (!surf) {
      noteNoRasteriser(layer.name);
      for (const d of local) d.path.delete();
      return;
    }
    const sk = surf.getCanvas();
    sk.translate(-L, -T);

    const a = clamp01(shadow.color.a * shadow.opacity);
    const filter: ImageFilter | null = kit.ImageFilter.MakeDropShadowOnly(
      shadow.offsetX,
      shadow.offsetY,
      sigma,
      sigma,
      kit.Color4f(shadow.color.r, shadow.color.g, shadow.color.b, a),
      null,
    );
    if (!filter) {
      surf.delete();
      noteNoRasteriser(layer.name);
      for (const d of local) d.path.delete();
      return;
    }
    const layerPaint = new kit.Paint();
    layerPaint.setImageFilter(filter);
    sk.saveLayer(layerPaint, null);
    for (const d of local) {
      const p: SkPaint = new kit.Paint();
      p.setAntiAlias(true);
      p.setAlphaf(clamp01(d.alpha));
      if (d.stroke) {
        p.setStyle(kit.PaintStyle.Stroke);
        p.setStrokeWidth(d.stroke.width);
        p.setStrokeCap(d.stroke.cap === "round" ? kit.StrokeCap.Round : d.stroke.cap === "square" ? kit.StrokeCap.Square : kit.StrokeCap.Butt);
        p.setStrokeJoin(d.stroke.join === "round" ? kit.StrokeJoin.Round : d.stroke.join === "bevel" ? kit.StrokeJoin.Bevel : kit.StrokeJoin.Miter);
        const dash = d.stroke.dash;
        let dashEffect: ReturnType<CanvasKit["PathEffect"]["MakeDash"]> | null = null;
        if (Array.isArray(dash) && dash.length >= 2 && dash.length % 2 === 0 && dash.some((n) => n > 0)) {
          dashEffect = kit.PathEffect.MakeDash(dash, d.stroke.dashPhase ?? 0);
          if (dashEffect) p.setPathEffect(dashEffect);
        }
        sk.save();
        sk.concat(skiaMatrix(d.matrix));
        sk.drawPath(d.path, p);
        sk.restore();
        if (dashEffect) {
          p.setPathEffect(null);
          dashEffect.delete();
        }
      } else {
        p.setStyle(kit.PaintStyle.Fill);
        if (d.evenOdd) d.path.setFillType(kit.FillType.EvenOdd);
        sk.save();
        sk.concat(skiaMatrix(d.matrix));
        sk.drawPath(d.path, p);
        sk.restore();
      }
      p.delete();
    }
    sk.restore();
    filter.delete();
    layerPaint.delete();

    const img = surf.makeImageSnapshot();
    const png = img ? img.encodeToBytes(kit.ImageFormat.PNG, 100) : null;
    img?.delete();
    surf.delete();
    for (const d of local) d.path.delete();
    if (!png) {
      noteNoRasteriser(layer.name);
      return;
    }

    const obj = await pdf.embedPng(png);
    const name = pdfPage.node.newXObject("Shd", obj.ref);
    ops.push(pushGraphicsState());
    ops.push(concatTransformationMatrix(W, 0, 0, -H, L, T + H));
    ops.push(drawObject(name));
    ops.push(popGraphicsState());
    report.images += 1;

    if (!shadowMethodNoted) {
      shadowMethodNoted = true;
      report.notes.push(
        "Drop shadows are rendered: each shadow is rasterised with the same Skia Gaussian " +
          "drop-shadow filter the canvas uses (sigma = blur/2, 3σ kernel, colour alpha = " +
          "colour.a × opacity) and embedded beneath its layer as a transparent-PNG underlay; the " +
          "layer content itself remains vector. Underlays are rendered in the layer's parent " +
          "space, so an extremely scaled or rotated ancestor group can differ slightly at the " +
          "blur fringe.",
      );
    }
  };

  const emit = async (layer: Layer, inheritedAlpha: number): Promise<void> => {
    if (!layer.visible) return;
    // Adjustments take no effects on the canvas either (drawTree returns
    // before withEffects), so there is nothing to audit or underlay here.
    if (layer.kind === "adjustment") return;

    // Any enabled effect this exporter does not represent is recorded before
    // anything else — the PDF must never silently differ from the canvas.
    const others = unrepresentedEffectsOf(layer);
    if (others.length) {
      for (const fx of others) report.rasterFallbacks.push(`${layer.name} (${fx.type})`);
      if (!unrepresentedNoted) {
        unrepresentedNoted = true;
        report.notes.push(
          "Only drop shadows are rendered into the PDF. Other enabled layer effects (outer glow, " +
            "stroke, gradient overlay) are not represented; every affected layer is listed in " +
            "rasterFallbacks so the file states the divergence itself.",
        );
      }
    }
    await emitShadowUnderlay(layer, inheritedAlpha);

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
  if (face && report.glyphs > 0) {
    parts.push(`${face.name} embedded as a full TrueType font`);
    report.notes.push(
      "Faces are embedded whole, not subset: pdf-lib's font subsetter produces TrueType " +
        "output that third-party parsers reject (glyph offsets outside the glyf table), so " +
        "the file carries every glyph of each face it sets and is larger as a result.",
    );
  }
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

  // PRECEDENCE (v6): mirrors compositor.ts drawVector exactly — a non-empty
  // `contours` list is the authoritative compound path; otherwise the legacy
  // single `nodes`/`closed` is one contour.
  const multi = Array.isArray(layer.contours) && layer.contours.length > 0;
  const contours = multi ? layer.contours! : [{ nodes: layer.nodes, closed: layer.closed }];

  if (!multi && layer.nodes.length < 2) {
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

  // Same drawable-contour filter as the compositor: a contour with < 2 nodes
  // contributes nothing (no dot fallback once compound geometry is present).
  const drawableContours = contours.filter((c) => c.nodes.length >= 2);
  if (drawableContours.length === 0) return;
  const anyClosed = drawableContours.some((c) => c.closed);

  const doFill = !!layer.fill && anyClosed;
  const doStroke = !!layer.stroke;
  if (!doFill && !doStroke) return;

  // Compound path with more than one drawable contour needs an explicit
  // even-odd fill rule so a subtracted hole reads as a hole regardless of
  // winding — exactly compositor.ts's `multi && drawable > 1` condition. A
  // single contour keeps the default nonzero rule, so legacy output is
  // byte-identical to before this change.
  const evenOdd = multi && drawableContours.length > 1;

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

  for (const c of drawableContours) {
    const n0 = c.nodes[0]!;
    ops.push(moveTo(round(n0.x), round(n0.y)));
    for (let i = 1; i < c.nodes.length; i++) {
      const a = c.nodes[i - 1]!;
      const b = c.nodes[i]!;
      ops.push(appendBezierCurve(round(a.outX), round(a.outY), round(b.inX), round(b.inY), round(b.x), round(b.y)));
    }
    if (c.closed) {
      const last = c.nodes[c.nodes.length - 1]!;
      ops.push(appendBezierCurve(round(last.outX), round(last.outY), round(n0.inX), round(n0.inY), round(n0.x), round(n0.y)));
      ops.push(closePathOp());
    }
  }

  if (doFill && doStroke) {
    ops.push(evenOdd ? PDFOperator.of(Op.FillEvenOddAndStroke) : fillAndStroke());
  } else if (doFill) {
    ops.push(evenOdd ? PDFOperator.of(Op.FillEvenOdd) : fillOp());
  } else {
    ops.push(strokeOp());
  }
  report.vectorPaths += 1;
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

/**
 * The visible region of an image layer: the fit destination INTERSECTED with
 * the frame. The single definition of "which pixels can show" for both the
 * PDF emitter and the shadow silhouette.
 */
function visibleImageRect(layer: Layer, imgW: number, imgH: number): { x: number; y: number; w: number; h: number } | null {
  if (layer.kind !== "image-frame" && layer.kind !== "raster") return null;
  const t = layer.transform;
  const src = sourceWindow(layer, imgW, imgH);
  const dest = destWindow(layer, src, t.w, t.h);
  if (src.w <= 0 || src.h <= 0 || dest.w <= 0 || dest.h <= 0) return null;
  const cx0 = Math.max(dest.x, 0);
  const cy0 = Math.max(dest.y, 0);
  const cx1 = Math.min(dest.x + dest.w, t.w);
  const cy1 = Math.min(dest.y + dest.h, t.h);
  if (cx1 <= cx0 || cy1 <= cy0) return null;
  return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
}

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
  // and relies on this rect to window it. (Shared with the shadow silhouette
  // via visibleImageRect.)
  const vis = visibleImageRect(layer, imgW, imgH);
  if (!vis) return;
  const cx0 = vis.x;
  const cy0 = vis.y;
  const cx1 = cx0 + vis.w;
  const cy1 = cy0 + vis.h;

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
