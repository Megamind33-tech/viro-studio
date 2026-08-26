import { DOC_VERSION } from "./migrate";
import { defaultTextFrameProperties, emptyTextStyles, validateStoryTextModel } from "./text-model";
import { pageToLocal } from "./transform";
import type {
  Align,
  BlendMode,
  ColorSpace,
  Contour,
  ImageFit,
  Layer,
  LayerBase,
  Page,
  PathNode,
  PressDocument,
  RenderIntent,
  Rgba,
  Story,
  Swatch,
  VectorStroke,
} from "./types";

let n = 0;
export function uid(prefix: string): string {
  n += 1;
  return `${prefix}_${Date.now().toString(36)}_${n.toString(36)}`;
}

/** Deep-copy a vector stroke, preserving optional v5 dash/cap/join styling. */
export function cloneStroke(stroke: VectorStroke | null | undefined): VectorStroke | null {
  if (!stroke) return null;
  const out: VectorStroke = { color: { ...stroke.color }, width: stroke.width };
  if (stroke.dash && stroke.dash.length) out.dash = [...stroke.dash];
  if (stroke.dashPhase !== undefined) out.dashPhase = stroke.dashPhase;
  if (stroke.cap) out.cap = stroke.cap;
  if (stroke.join) out.join = stroke.join;
  return out;
}

/**
 * Deep-copy a v6 multi-contour list, or return undefined for the single-contour
 * (legacy `nodes`/`closed`) case. Keeps History and clone paths honest without
 * aliasing node arrays across document snapshots.
 */
export function cloneContours(contours: Contour[] | null | undefined): Contour[] | undefined {
  if (!contours || !contours.length) return undefined;
  return contours.map((c) => ({ closed: c.closed, nodes: c.nodes.map((p) => ({ ...p })) }));
}

export const ink: Rgba = { r: 0.12, g: 0.12, b: 0.12, a: 1 };
export const paper: Rgba = { r: 1, g: 1, b: 1, a: 1 };
export const copper: Rgba = { r: 224 / 255, g: 122 / 255, b: 47 / 255, a: 1 };

/**
 * What type sets in by default: [Black], 100 % K.
 *
 * `ink` is the desk's soft near-black. At 8 bits it quantises to #1F1F1F,
 * which is byte-identical to the pasteboard the compositor paints around the
 * page — so a type frame whose left edge sits a few px past the trim loses its
 * first glyph into an invisible match. Text on a press page is black.
 */
export const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/* ------------------------------------------------------------------ *
 * Units
 *
 * One inch is exactly 25.4 mm and exactly 72 PostScript points.
 * Page geometry is stored in device pixels at the document ppi, so
 * every physical measure has to pass through one of these.
 * ------------------------------------------------------------------ */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;

/** Millimetres → device pixels at `ppi`. Rounded: page rasters are whole pixels. */
export function mmToPx(mm: number, ppi: number): number {
  return Math.round((mm / MM_PER_INCH) * ppi);
}

/** Inches → device pixels at `ppi`. Rounded. */
export function inToPx(inches: number, ppi: number): number {
  return Math.round(inches * ppi);
}

/**
 * PostScript points → device pixels at `ppi`. NOT rounded — type sizes and
 * leading are legitimately fractional (10 pt at 300 ppi is 41.666… px) and
 * rounding them visibly damages leading rhythm on long columns.
 */
export function ptToPx(pt: number, ppi: number): number {
  return (pt * ppi) / PT_PER_INCH;
}

export function pxToMm(px: number, ppi: number): number {
  return (px / ppi) * MM_PER_INCH;
}

export function pxToIn(px: number, ppi: number): number {
  return px / ppi;
}

export function pxToPt(px: number, ppi: number): number {
  return (px / ppi) * PT_PER_INCH;
}

/* ------------------------------------------------------------------ *
 * Typographic defaults
 *
 * These are the numbers a new type frame is born with. They are stated in
 * points and resolved against the document's ppi, never hard-coded in px:
 * 12 pt is 50 px on a 300 ppi press page and 12 px on a 72 ppi screen page,
 * and both of those are the same type.
 * ------------------------------------------------------------------ */

/** Body size of a new type frame. InDesign's factory default. */
export const DEFAULT_TYPE_PT = 12;

/** InDesign's Auto leading: 120 % of the size. Leading is a ratio, never a constant. */
export const AUTO_LEADING_RATIO = 1.2;

/**
 * Default measure of a click-created type frame, in ems. 30 em of Noto Sans is
 * about 60 characters — the middle of the 45–75 character band that reads
 * without the eye losing the line. Clamped to the page's column at build time.
 */
export const DEFAULT_MEASURE_EM = 30;

/** The default type size for a document at `ppi`, in page px. */
export function defaultTypeSizePx(ppi: number): number {
  return ptToPx(DEFAULT_TYPE_PT, ppi > 0 ? ppi : 72);
}

/** Auto leading for a size in px. */
export function autoLeading(sizePx: number): number {
  return sizePx * AUTO_LEADING_RATIO;
}

export function cloneDoc(doc: PressDocument): PressDocument {
  return structuredClone(doc);
}

/* ------------------------------------------------------------------ *
 * Document construction
 * ------------------------------------------------------------------ */

export interface PageMarginPx {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CreateDocumentOptions {
  name: string;
  ppi: number;
  widthPx: number;
  heightPx: number;
  bleedPx: number;
  pageCount: number;
  facingPages: boolean;
  slugPx?: number;
  /** Page margins in px. Omitted → 6% of the short edge, which is only a fallback. */
  margin?: Partial<PageMarginPx>;
  /**
   * Mirror `margin.left` (inside / binding edge) and `margin.right` (outside)
   * on verso pages. Page 1 is a recto.
   */
  mirrorMargins?: boolean;
  columns?: number;
  columnGutterPx?: number;
  background?: Rgba;
  colorSpace?: ColorSpace;
  intent?: RenderIntent;
  iccProfileName?: string | null;
  swatches?: Swatch[];
  pageNames?: string[];
}

/** The only document colour space the current compositor and exporters honour. */
export const SUPPORTED_DOCUMENT_COLOR_SPACE: ColorSpace = "rgb";

/**
 * The only sRGB profile in the build is LittleCMS' built-in one. No CMYK
 * profile, separation pipeline, soft proof or CMYK exporter ships with VIRO
 * Press, so new documents must not claim to be CMYK documents.
 */
export const BUILT_IN_RGB_PROFILE = "sRGB IEC61966-2.1 — LittleCMS built-in (no FOGRA/SWOP bundled)";

export function defaultSwatches(): Swatch[] {
  return [
    { id: uid("sw"), name: "Paper", space: "rgb", rgb: paper },
    { id: uid("sw"), name: "Ink", space: "rgb", rgb: ink },
    { id: uid("sw"), name: "Copper", space: "rgb", rgb: copper },
    {
      id: uid("sw"),
      name: "Process Black",
      space: "cmyk",
      cmyk: { c: 0, m: 0, y: 0, k: 1 },
      rgb: { r: 0, g: 0, b: 0, a: 1 },
    },
  ];
}

export function createDocument(opts: CreateDocumentOptions): PressDocument {
  const ppi = Number.isFinite(opts.ppi) && opts.ppi > 0 ? opts.ppi : 72;
  const w = Math.max(1, Math.round(opts.widthPx));
  const h = Math.max(1, Math.round(opts.heightPx));
  const bleed = Math.max(0, Math.round(opts.bleedPx));
  const slug = Math.max(0, Math.round(opts.slugPx ?? 0));
  const count = Math.max(1, Math.round(opts.pageCount));
  const columns = Math.max(1, Math.round(opts.columns ?? 1));
  // InDesign's default gutter is 12 pt. Derived from ppi, not from the page width:
  // a gutter is a physical measure, and 1.2 % of an A1 poster is not a gutter.
  const gutter = Math.max(0, Math.round(opts.columnGutterPx ?? ptToPx(12, ppi)));
  const background = opts.background ?? paper;
  // Keep accepting the option so older callers and preset records remain
  // readable, but normalise new documents to the capability that is real.
  // CMYK can return here only when its renderer, profiles and export path land.
  const space: ColorSpace = SUPPORTED_DOCUMENT_COLOR_SPACE;
  const margin = resolveMargin(opts.margin, w, h);

  const pages: Page[] = [];
  for (let i = 0; i < count; i++) {
    const mirrored = opts.mirrorMargins && (i + 1) % 2 === 0
      ? { top: margin.top, right: margin.left, bottom: margin.bottom, left: margin.right }
      : margin;
    pages.push({
      id: uid("pg"),
      name: opts.pageNames?.[i] ?? `Page ${i + 1}`,
      widthPx: w,
      heightPx: h,
      bleedPx: bleed,
      slugPx: slug,
      margin: { ...mirrored },
      columns,
      columnGutter: gutter,
      background: { ...background },
      layers: [],
      guides: [],
    });
  }

  const spreads = opts.facingPages
    ? chunkSpreads(pages)
    : pages.map((p) => ({ id: uid("sp"), pageIds: [p.id] }));

  return {
    version: DOC_VERSION,
    name: opts.name,
    ppi,
    color: {
      workingSpace: space,
      intent: opts.intent ?? "relative",
      iccProfileName:
        opts.iccProfileName !== undefined
          ? opts.iccProfileName
          : space === "rgb"
            ? BUILT_IN_RGB_PROFILE
            : null,
    },
    pages,
    spreads,
    stories: [],
    textStyles: emptyTextStyles(),
    fontSubstitutions: {},
    assets: {},
    swatches: opts.swatches ? opts.swatches.map((s) => ({ ...s })) : defaultSwatches(),
    activePageId: pages[0]!.id,
    activeLayerIds: [],
  };
}

/** Margins must leave a live area on the page; anything wider is clamped, not trusted. */
function resolveMargin(m: Partial<PageMarginPx> | undefined, w: number, h: number): PageMarginPx {
  const fallback = Math.round(Math.min(w, h) * 0.06);
  const top = Math.max(0, Math.round(m?.top ?? fallback));
  const right = Math.max(0, Math.round(m?.right ?? fallback));
  const bottom = Math.max(0, Math.round(m?.bottom ?? fallback));
  const left = Math.max(0, Math.round(m?.left ?? fallback));
  const hFit = left + right < w ? { left, right } : scalePair(left, right, w);
  const vFit = top + bottom < h ? { top, bottom } : scalePair2(top, bottom, h);
  return { top: vFit.top, right: hFit.right, bottom: vFit.bottom, left: hFit.left };
}

function scalePair(a: number, b: number, extent: number): { left: number; right: number } {
  const room = Math.max(0, extent - 2);
  const total = a + b || 1;
  return { left: Math.floor((a / total) * room), right: Math.floor((b / total) * room) };
}

function scalePair2(a: number, b: number, extent: number): { top: number; bottom: number } {
  const room = Math.max(0, extent - 2);
  const total = a + b || 1;
  return { top: Math.floor((a / total) * room), bottom: Math.floor((b / total) * room) };
}

function chunkSpreads(pages: Page[]) {
  const spreads = [];
  spreads.push({ id: uid("sp"), pageIds: [pages[0]!.id] });
  for (let i = 1; i < pages.length; i += 2) {
    const ids = [pages[i]!.id];
    if (pages[i + 1]) ids.push(pages[i + 1]!.id);
    spreads.push({ id: uid("sp"), pageIds: ids });
  }
  return spreads;
}

export function activePage(doc: PressDocument): Page {
  return doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]!;
}

export function findLayer(page: Page, id: string): Layer | undefined {
  return page.layers.find((l) => l.id === id);
}

export function selectedLayers(doc: PressDocument): Layer[] {
  const page = activePage(doc);
  return page.layers.filter((l) => doc.activeLayerIds.includes(l.id));
}

/* ------------------------------------------------------------------ *
 * Grid geometry
 * ------------------------------------------------------------------ */

export interface PageGrid {
  x: number;
  y: number;
  w: number;
  h: number;
  columns: number;
  gutter: number;
  columnWidth: number;
  /** Left edge of column `i` (0-based), page coordinates. */
  colX: (i: number) => number;
  /** Width of a run of `span` columns starting at column `i`. */
  colSpan: (i: number, span: number) => number;
}

/** The live area implied by a page's margins and column setup. */
export function pageGrid(page: Page): PageGrid {
  const x = page.margin.left;
  const y = page.margin.top;
  const w = Math.max(1, page.widthPx - page.margin.left - page.margin.right);
  const h = Math.max(1, page.heightPx - page.margin.top - page.margin.bottom);
  const columns = Math.max(1, page.columns);
  const gutter = Math.max(0, page.columnGutter);
  const columnWidth = (w - gutter * (columns - 1)) / columns;
  return {
    x,
    y,
    w,
    h,
    columns,
    gutter,
    columnWidth,
    colX: (i) => x + i * (columnWidth + gutter),
    colSpan: (i, span) => {
      void i;
      const s = Math.max(1, Math.min(span, columns));
      return s * columnWidth + (s - 1) * gutter;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Draft builders
 *
 * These MUTATE a document that is still being constructed and return the
 * id of the layer they created. They are for factory/template code only —
 * anything that edits a live document must go through src/document/ops.ts,
 * which clones first so History stays honest.
 * ------------------------------------------------------------------ */

function draftPage(doc: PressDocument, pageIndex: number): Page {
  const page = doc.pages[pageIndex];
  if (!page) throw new Error(`draft: page ${pageIndex} does not exist`);
  return page;
}

interface DraftCommon {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  opacity?: number;
  blend?: BlendMode;
  locked?: boolean;
  visible?: boolean;
  parentId?: string | null;
}

function base(spec: DraftCommon): LayerBase {
  return {
    id: uid("ly"),
    name: spec.name,
    visible: spec.visible ?? true,
    locked: spec.locked ?? false,
    opacity: spec.opacity ?? 1,
    blend: spec.blend ?? "srcOver",
    transform: {
      x: spec.x,
      y: spec.y,
      w: Math.max(1, spec.w),
      h: Math.max(1, spec.h),
      rotation: spec.rotation ?? 0,
    },
    parentId: spec.parentId ?? null,
  };
}

export interface DraftTextSpec extends DraftCommon {
  text: string;
  /** px. Use ptToPx(pt, doc.ppi) for print-honest sizes. */
  size: number;
  /** px, baseline to baseline. */
  leading: number;
  tracking?: number;
  fill?: Rgba;
  align?: Align;
  firstLineIndent?: number;
  spaceAfter?: number;
  otFeatures?: string[];
  fontId?: string;
}

export function draftText(doc: PressDocument, pageIndex: number, spec: DraftTextSpec): string {
  const page = draftPage(doc, pageIndex);
  const story: Story = {
    id: uid("st"),
    text: spec.text,
    runs: [],
    paragraphRuns: [],
    character: {
      fontId: spec.fontId ?? "noto-sans",
      size: spec.size,
      leading: spec.leading,
      tracking: spec.tracking ?? 0,
      fill: { ...(spec.fill ?? black) },
      otFeatures: spec.otFeatures ?? ["kern", "liga"],
    },
    paragraph: {
      align: spec.align ?? "left",
      firstLineIndent: spec.firstLineIndent ?? 0,
      spaceAfter: spec.spaceAfter ?? 0,
    },
  };
  doc.stories.push(story);
  const layer: Layer = { ...base(spec), kind: "type-frame", storyId: story.id, nextFrameId: null };
  page.layers.push(layer);
  return layer.id;
}

export interface DraftPathSpec extends DraftCommon {
  nodes: PathNode[];
  closed: boolean;
  fill: Rgba | null;
  stroke?: VectorStroke | null;
}

export function draftPath(doc: PressDocument, pageIndex: number, spec: DraftPathSpec): string {
  const page = draftPage(doc, pageIndex);
  const layer: Layer = {
    ...base(spec),
    kind: "vector",
    closed: spec.closed,
    nodes: spec.nodes.map((p) => ({ ...p })),
    fill: spec.fill ? { ...spec.fill } : null,
    stroke: cloneStroke(spec.stroke),
  };
  page.layers.push(layer);
  return layer.id;
}

export function rectNodes(w: number, h: number): PathNode[] {
  const p = (x: number, y: number): PathNode => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
}

/** Circular arc → cubic bezier constant: 4/3·tan(π/8). */
const KAPPA = 0.5522847498307936;

/**
 * An ellipse inscribed in a w×h box, as four cubic nodes at the cardinal
 * points. Layer-local coordinates, so the caller owns the page-space offset.
 */
export function ellipseNodes(w: number, h: number): PathNode[] {
  const rx = w / 2;
  const ry = h / 2;
  const cx = rx;
  const cy = ry;
  return [
    { x: cx, y: 0, inX: cx - KAPPA * rx, inY: 0, outX: cx + KAPPA * rx, outY: 0 },
    { x: w, y: cy, inX: w, inY: cy - KAPPA * ry, outX: w, outY: cy + KAPPA * ry },
    { x: cx, y: h, inX: cx + KAPPA * rx, inY: h, outX: cx - KAPPA * rx, outY: h },
    { x: 0, y: cy, inX: 0, inY: cy + KAPPA * ry, outX: 0, outY: cy - KAPPA * ry },
  ];
}

/** A two-node open path from a→b, in coordinates local to their bounding box. */
export function lineNodes(x1: number, y1: number, x2: number, y2: number): PathNode[] {
  const tx = Math.min(x1, x2);
  const ty = Math.min(y1, y2);
  const p = (x: number, y: number): PathNode => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(x1 - tx, y1 - ty), p(x2 - tx, y2 - ty)];
}

/** Ellipse inscribed in the given page-space box. Mirrors `press.add_ellipse`. */
export function addVectorEllipse(
  doc: PressDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: Rgba,
): PressDocument {
  return addVectorLayer(doc, "Ellipse", x, y, w, h, ellipseNodes(w, h), {
    closed: true,
    fill,
    stroke: null,
  });
}

/**
 * Rounded rectangle in a w×h box. Corner radius is clamped so it cannot exceed
 * half the shorter edge — a 200×80 box with radius 200 is a stadium, not a
 * self-intersecting path.
 */
export function roundRectNodes(w: number, h: number, radius: number): PathNode[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r < 0.5) return rectNodes(w, h);
  const k = r * KAPPA;
  const p = (x: number, y: number, ix: number, iy: number, ox: number, oy: number): PathNode => ({
    x, y, inX: ix, inY: iy, outX: ox, outY: oy,
  });
  return [
    p(r, 0, r - k, 0, r + k, 0),
    p(w - r, 0, w - r - k, 0, w - r + k, 0),
    p(w, r, w, r - k, w, r + k),
    p(w, h - r, w, h - r - k, w, h - r + k),
    p(w - r, h, w - r + k, h, w - r - k, h),
    p(r, h, r + k, h, r - k, h),
    p(0, h - r, 0, h - r + k, 0, h - r - k),
    p(0, r, 0, r + k, 0, r - k),
  ];
}

/** Regular n-gon inscribed in a w×h box, first vertex at 12 o'clock. */
export function polygonNodes(w: number, h: number, sides: number): PathNode[] {
  const count = Math.max(3, Math.min(24, Math.round(sides)));
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const nodes: PathNode[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const x = cx + rx * Math.cos(a);
    const y = cy + ry * Math.sin(a);
    nodes.push({ x, y, inX: x, inY: y, outX: x, outY: y });
  }
  return nodes;
}

export function addVectorRoundRect(
  doc: PressDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: Rgba,
  radius: number,
): PressDocument {
  return addVectorLayer(doc, "Rounded rectangle", x, y, w, h, roundRectNodes(w, h, radius), {
    closed: true,
    fill,
    stroke: null,
  });
}

export function addVectorPolygon(
  doc: PressDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: Rgba,
  sides: number,
): PressDocument {
  const n = Math.max(3, Math.min(24, Math.round(sides)));
  return addVectorLayer(doc, n === 3 ? "Triangle" : `${n}-gon`, x, y, w, h, polygonNodes(w, h, n), {
    closed: true,
    fill,
    stroke: null,
  });
}

/**
 * Star inscribed in a w×h box. `points` tips (3–16); `inner` is the valley
 * radius as a fraction of the tip radius (0.12–0.85, default 0.4). First tip
 * sits at 12 o'clock. Editable nodes — not a baked icon.
 */
export function starNodes(w: number, h: number, points: number, inner = 0.4): PathNode[] {
  const n = Math.max(3, Math.min(16, Math.round(points)));
  const ratio = Math.max(0.12, Math.min(0.85, inner));
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const nodes: PathNode[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const k = i % 2 === 0 ? 1 : ratio;
    const x = cx + rx * k * Math.cos(a);
    const y = cy + ry * k * Math.sin(a);
    nodes.push({ x, y, inX: x, inY: y, outX: x, outY: y });
  }
  return nodes;
}

export function addVectorStar(
  doc: PressDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: Rgba,
  points: number,
  inner = 0.4,
): PressDocument {
  const n = Math.max(3, Math.min(16, Math.round(points)));
  return addVectorLayer(doc, `${n}-point star`, x, y, w, h, starNodes(w, h, n, inner), {
    closed: true,
    fill,
    stroke: null,
  });
}

/**
 * Straight rule between two page points. A line has no fill, so the stroke is
 * what paints — mirrors the requirement `press.add_line` enforces.
 */
export function addVectorLine(
  doc: PressDocument,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: VectorStroke,
): PressDocument {
  return addVectorLayer(
    doc,
    "Line",
    Math.min(x1, x2),
    Math.min(y1, y2),
    Math.abs(x2 - x1),
    Math.abs(y2 - y1),
    lineNodes(x1, y1, x2, y2),
    { closed: false, fill: null, stroke },
  );
}

export interface DraftRectSpec extends DraftCommon {
  fill: Rgba | null;
  stroke?: VectorStroke | null;
}

export function draftRect(doc: PressDocument, pageIndex: number, spec: DraftRectSpec): string {
  return draftPath(doc, pageIndex, {
    ...spec,
    nodes: rectNodes(Math.max(1, spec.w), Math.max(1, spec.h)),
    closed: true,
    fill: spec.fill,
    stroke: spec.stroke ?? null,
  });
}

export interface DraftRuleSpec extends Omit<DraftCommon, "h"> {
  color: Rgba;
  /** Stroke weight in px. */
  weight: number;
}

/** A horizontal rule: an open two-node path, stroked. Fill is never used on open paths. */
export function draftRule(doc: PressDocument, pageIndex: number, spec: DraftRuleSpec): string {
  const w = Math.max(1, spec.w);
  const weight = Math.max(0.25, spec.weight);
  return draftPath(doc, pageIndex, {
    name: spec.name,
    x: spec.x,
    y: spec.y,
    w,
    h: weight,
    rotation: spec.rotation,
    opacity: spec.opacity,
    blend: spec.blend,
    locked: spec.locked,
    visible: spec.visible,
    parentId: spec.parentId,
    nodes: [
      { x: 0, y: weight / 2, inX: 0, inY: weight / 2, outX: 0, outY: weight / 2 },
      { x: w, y: weight / 2, inX: w, inY: weight / 2, outX: w, outY: weight / 2 },
    ],
    closed: false,
    fill: null,
    stroke: { color: spec.color, width: weight },
  });
}

export interface DraftAsset {
  name: string;
  mime: string;
  dataUrl: string;
  width: number;
  height: number;
}

/** Register an asset on a document under construction and return its id. */
export function draftAsset(doc: PressDocument, asset: DraftAsset): string {
  const id = uid("as");
  doc.assets[id] = { id, ...asset };
  return id;
}

export interface DraftImageSpec extends DraftCommon {
  assetId: string | null;
  fit?: ImageFit;
  focal?: { x: number; y: number };
  crop?: { x: number; y: number; w: number; h: number } | null;
}

export function draftImage(doc: PressDocument, pageIndex: number, spec: DraftImageSpec): string {
  const page = draftPage(doc, pageIndex);
  const layer: Layer = {
    ...base(spec),
    kind: "image-frame",
    assetId: spec.assetId,
    fit: spec.fit ?? "cover",
    focal: { x: spec.focal?.x ?? 0.5, y: spec.focal?.y ?? 0.5 },
    crop: spec.crop ? { ...spec.crop } : null,
  };
  page.layers.push(layer);
  return layer.id;
}

/**
 * Wrap already-drafted layers in a group. The group is inserted below its
 * members so the compositor's parent-walk reaches them in draw order.
 */
export function draftGroup(doc: PressDocument, pageIndex: number, name: string, memberIds: string[]): string {
  const page = draftPage(doc, pageIndex);
  const members = page.layers.filter((l) => memberIds.includes(l.id));
  if (!members.length) throw new Error(`draftGroup("${name}"): no members found`);
  const x = Math.min(...members.map((l) => l.transform.x));
  const y = Math.min(...members.map((l) => l.transform.y));
  const x2 = Math.max(...members.map((l) => l.transform.x + l.transform.w));
  const y2 = Math.max(...members.map((l) => l.transform.y + l.transform.h));
  const group: Layer = {
    id: uid("ly"),
    name,
    kind: "group",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y), rotation: 0 },
    parentId: null,
  };
  const first = Math.min(...members.map((l) => page.layers.indexOf(l)));
  for (const m of members) m.parentId = group.id;
  page.layers.splice(first, 0, group);
  return group.id;
}

export function draftGuides(
  doc: PressDocument,
  pageIndex: number,
  guides: { v?: number[]; h?: number[] },
): void {
  const page = draftPage(doc, pageIndex);
  for (const offset of guides.v ?? []) page.guides.push({ id: uid("gd"), axis: "v", offset });
  for (const offset of guides.h ?? []) page.guides.push({ id: uid("gd"), axis: "h", offset });
}

/** Column-edge guides derived from the page's own grid. */
export function draftColumnGuides(doc: PressDocument, pageIndex: number): void {
  const page = draftPage(doc, pageIndex);
  const g = pageGrid(page);
  const v: number[] = [];
  for (let i = 0; i < g.columns; i++) {
    v.push(Math.round(g.colX(i)));
    v.push(Math.round(g.colX(i) + g.columnWidth));
  }
  draftGuides(doc, pageIndex, { v });
}

export function draftSwatches(doc: PressDocument, entries: { name: string; rgb: Rgba }[]): void {
  for (const e of entries) {
    doc.swatches.push({ id: uid("sw"), name: e.name, space: "rgb", rgb: { ...e.rgb } });
  }
}

/**
 * Conservative greedy line-count estimate, used to size type frames at build
 * time. The authoritative break is HarfBuzz in src/engine/type.ts at draw
 * time; this only has to be close enough that frames are never short.
 */
export function estimateLines(text: string, sizePx: number, frameWpx: number, avgAdvanceEm = 0.53): number {
  const perChar = sizePx * avgAdvanceEm;
  if (perChar <= 0 || frameWpx <= 0) return 1;
  let lines = 0;
  for (const para of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!para.length) {
      lines += 1;
      continue;
    }
    let used = 0;
    let count = 1;
    for (const word of para.split(/\s+/)) {
      const wWidth = (word.length + 1) * perChar;
      if (used > 0 && used + wWidth > frameWpx) {
        count += 1;
        used = wWidth;
      } else used += wWidth;
    }
    lines += count;
  }
  return Math.max(1, lines);
}

/**
 * Frame height that clears `lines` baselines with the engine's overflow rule.
 *
 * The engine puts the first baseline at the face's ascender (about 1.07 em for
 * Noto Sans) and drops any line whose baseline falls past the frame foot, so
 * the height has to cover ascender + (lines-1)·leading + descender. The
 * trailing term is a proportion of the leading, with a floor tied to the size
 * so that tight leading — display type set solid or negative — still leaves
 * room for the descender rather than clipping it.
 */
export function frameHeightFor(lines: number, sizePx: number, leadingPx: number): number {
  const foot = Math.max(leadingPx * 0.35, sizePx * 0.32);
  return Math.ceil(sizePx + Math.max(0, lines - 1) * leadingPx + foot);
}

/* ------------------------------------------------------------------ *
 * Live-document helpers (clone-and-return, as ops.ts expects)
 * ------------------------------------------------------------------ */

/**
 * A story with the document's typographic defaults.
 *
 * `sizePx` should come from `defaultTypeSizePx(doc.ppi)` — passing nothing
 * gives 12 pt at 72 ppi, which is only right for a screen document.
 */
export function makeStory(text: string, fontId: string, sizePx = ptToPx(DEFAULT_TYPE_PT, 72)): Story {
  const size = sizePx > 0 ? sizePx : ptToPx(DEFAULT_TYPE_PT, 72);
  return {
    id: uid("st"),
    text,
    runs: [],
    paragraphRuns: [],
    character: {
      fontId,
      size,
      leading: autoLeading(size),
      tracking: 0,
      fill: { ...black },
      otFeatures: ["kern", "liga"],
    },
    // InDesign's [Basic Paragraph]: flush left, no indent, no space after.
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
  };
}

/**
 * The type tool's click: a new frame whose top-left is where the pointer went
 * down, carrying the document's typographic defaults.
 *
 * Size and leading come from the document ppi — 12 pt, auto leading — so the
 * same click gives 50 px type on a 300 ppi press page and 12 px type on a
 * 72 ppi screen page, and both set at the same physical size.
 *
 * The measure is a 30-em line clamped to the page's own column and to the room
 * left of the right trim, so a frame dropped on a three-column magazine lands
 * on the column, a frame dropped on a 300 × 250 banner is not wider than the
 * banner, and a frame dropped near the right edge does not run off the sheet.
 *
 * `x` and `y` are honoured exactly, including negative ones: the pasteboard is
 * a legitimate place to park a frame, and Anchor addresses this function with
 * coordinates it means.
 */
export function addTypeFrame(
  doc: PressDocument,
  fontId: string,
  x: number,
  y: number,
  extras: { w?: number; h?: number; text?: string } = {},
): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const size = defaultTypeSizePx(next.ppi);
  const story = makeStory(extras.text ?? "Type", fontId, size);
  next.stories.push(story);

  const grid = pageGrid(page);
  const room = page.widthPx - Math.max(0, Math.min(x, page.widthPx));
  const w = Math.round(
    extras.w && extras.w >= 4
      ? extras.w
      : Math.max(
          Math.min(size * 4, page.widthPx),
          Math.min(size * DEFAULT_MEASURE_EM, grid.columnWidth, room || page.widthPx),
        ),
  );
  const h = Math.round(
    extras.h && extras.h >= 4 ? extras.h : frameHeightFor(2, size, story.character.leading),
  );

  const layer: Layer = {
    id: uid("ly"),
    name: "Type",
    kind: "type-frame",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    storyId: story.id,
    nextFrameId: null,
    textFrame: defaultTextFrameProperties("area"),
  };
  page.layers.push(layer);
  next.activeLayerIds = [layer.id];
  return next;
}

export function addVectorRect(doc: PressDocument, x: number, y: number, w: number, h: number, fill: Rgba): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const layer: Layer = {
    id: uid("ly"),
    name: "Rectangle",
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: rectNodes(w, h),
    fill,
    stroke: null,
  };
  page.layers.push(layer);
  next.activeLayerIds = [layer.id];
  return next;
}

export function addVectorLayer(
  doc: PressDocument,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  nodes: PathNode[],
  opts: { closed: boolean; fill: Rgba | null; stroke: VectorStroke | null },
): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const layer: Layer = {
    id: uid("ly"),
    name,
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w: Math.max(4, w), h: Math.max(4, h), rotation: 0 },
    parentId: null,
    closed: opts.closed,
    nodes,
    fill: opts.fill,
    stroke: cloneStroke(opts.stroke),
  };
  page.layers.push(layer);
  next.activeLayerIds = [layer.id];
  return next;
}

export function addGuide(doc: PressDocument, axis: "h" | "v", offset: number): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  page.guides.push({ id: uid("gd"), axis, offset });
  return next;
}

export function addImageFrame(
  doc: PressDocument,
  asset: { name: string; mime: string; dataUrl: string; width: number; height: number },
  x: number,
  y: number,
): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const id = uid("as");
  next.assets[id] = { id, ...asset };
  const maxW = page.widthPx * 0.5;
  const scale = Math.min(1, maxW / asset.width);
  const w = Math.round(asset.width * scale);
  const h = Math.round(asset.height * scale);
  const layer: Layer = {
    id: uid("ly"),
    name: asset.name,
    kind: "image-frame",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    assetId: id,
    fit: "cover",
    focal: { x: 0.5, y: 0.5 },
    crop: null,
  };
  page.layers.push(layer);
  next.activeLayerIds = [layer.id];
  return next;
}

export function hitTest(doc: PressDocument, x: number, y: number): Layer | null {
  const page = activePage(doc);
  for (let i = page.layers.length - 1; i >= 0; i--) {
    const l = page.layers[i]!;
    if (!l.visible || l.kind === "group" || l.kind === "adjustment") continue;
    // Test in the layer's own local space. This is what makes a click land on a
    // child inside a moved/rotated/scaled group, and it fixes rotated leaves too:
    // the old page-space AABB test hit the bounding box, not the shape.
    const p = pageToLocal(page, l, x, y);
    if (!p) continue;
    const t = l.transform;
    if (p.x >= 0 && p.x <= t.w && p.y >= 0 && p.y <= t.h) return l;
  }
  return null;
}

export function applyImageSize(
  doc: PressDocument,
  nextW: number,
  nextH: number,
  nextPpi: number,
  resample: boolean,
): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  next.ppi = nextPpi;
  if (!resample) return next;
  const sx = nextW / page.widthPx;
  const sy = nextH / page.heightPx;
  page.widthPx = nextW;
  page.heightPx = nextH;
  page.bleedPx = Math.round(page.bleedPx * sx);
  for (const layer of page.layers) {
    layer.transform.x *= sx;
    layer.transform.y *= sy;
    layer.transform.w *= sx;
    layer.transform.h *= sy;
    if (layer.kind === "image-frame" && layer.crop) {
      layer.crop.x *= sx;
      layer.crop.y *= sy;
      layer.crop.w *= sx;
      layer.crop.h *= sy;
    }
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Validation — used by the preset/template verification pass
 * ------------------------------------------------------------------ */

const STROKE_CAPS = new Set(["butt", "round", "square"]);
const STROKE_JOINS = new Set(["miter", "round", "bevel"]);
/** A dashed rule made of 64 on/off pairs is already excessive; cap the parser surface. */
export const MAX_DASH_INTERVALS = 128;
/** A compound path with thousands of subpaths is a corrupt/hostile file; cap it. */
export const MAX_CONTOURS = 4096;
/** Per-contour node cap — bounds the geometry a single subpath can carry. */
export const MAX_CONTOUR_NODES = 200_000;

/**
 * Validate a v6 multi-contour list (a boolean-op result). Each contour needs ≥2
 * finite nodes and a boolean `closed`; the counts are bounded to keep the parser
 * surface small, mirroring `validateStroke`. Returns problems; empty = ok.
 */
export function validateContours(contours: Contour[], where: string): string[] {
  const errs: string[] = [];
  if (!Array.isArray(contours)) {
    errs.push(`${where}: contours must be an array`);
    return errs;
  }
  if (contours.length > MAX_CONTOURS) errs.push(`${where}: too many contours (max ${MAX_CONTOURS})`);
  for (let i = 0; i < contours.length; i++) {
    const c = contours[i]!;
    const at = `${where}: contour ${i}`;
    if (typeof c.closed !== "boolean") errs.push(`${at}: closed must be a boolean`);
    if (!Array.isArray(c.nodes)) {
      errs.push(`${at}: nodes must be an array`);
      continue;
    }
    if (c.nodes.length < 2) errs.push(`${at}: needs at least 2 nodes`);
    if (c.nodes.length > MAX_CONTOUR_NODES) errs.push(`${at}: too many nodes (max ${MAX_CONTOUR_NODES})`);
    for (const n of c.nodes) {
      if (![n.x, n.y, n.inX, n.inY, n.outX, n.outY].every((v) => Number.isFinite(v))) {
        errs.push(`${at}: node coordinates must be finite`);
        break;
      }
    }
  }
  return errs;
}

/** Validate a vector stroke's optional v5 styling. Returns problems; empty = ok. */
export function validateStroke(stroke: VectorStroke, where: string): string[] {
  const errs: string[] = [];
  if (!(stroke.width > 0)) errs.push(`${where}: stroke width must be > 0`);
  if (stroke.dash !== undefined) {
    if (!Array.isArray(stroke.dash)) errs.push(`${where}: stroke dash must be an array of numbers`);
    else if (stroke.dash.length) {
      if (stroke.dash.length % 2 !== 0) {
        errs.push(`${where}: stroke dash needs an even number of intervals (on,off pairs)`);
      }
      if (stroke.dash.length > MAX_DASH_INTERVALS) {
        errs.push(`${where}: stroke dash has too many intervals (max ${MAX_DASH_INTERVALS})`);
      }
      if (!stroke.dash.every((n) => Number.isFinite(n) && n >= 0)) {
        errs.push(`${where}: stroke dash intervals must be finite and >= 0`);
      }
      if (stroke.dash.every((n) => n === 0)) {
        errs.push(`${where}: stroke dash is all zeros, which draws nothing`);
      }
    }
  }
  if (stroke.dashPhase !== undefined && !Number.isFinite(stroke.dashPhase)) {
    errs.push(`${where}: stroke dashPhase must be finite`);
  }
  if (stroke.cap !== undefined && !STROKE_CAPS.has(stroke.cap)) {
    errs.push(`${where}: stroke cap must be butt, round or square`);
  }
  if (stroke.join !== undefined && !STROKE_JOINS.has(stroke.join)) {
    errs.push(`${where}: stroke join must be miter, round or bevel`);
  }
  return errs;
}

/** Structural check against types.ts. Returns a list of problems; empty means valid. */
export function validateDocument(doc: PressDocument): string[] {
  const errs: string[] = [];
  if (![1, 2, 3, 4, 5, 6].includes(doc.version)) {
    errs.push("version must be 1, 2, 3, 4, 5 or 6");
  }
  if (!doc.name) errs.push("name is empty");
  if (!(doc.ppi > 0)) errs.push(`ppi must be > 0 (got ${doc.ppi})`);
  if (!doc.pages.length) errs.push("document has no pages");
  if (!doc.pages.some((p) => p.id === doc.activePageId)) errs.push("activePageId does not name a page");

  const pageIds = new Set<string>();
  const storyIds = new Set(doc.stories.map((s) => s.id));
  const usedStories = new Set<string>();
  const layerIds = new Set<string>();

  for (const page of doc.pages) {
    if (pageIds.has(page.id)) errs.push(`duplicate page id ${page.id}`);
    pageIds.add(page.id);
    if (!Number.isInteger(page.widthPx) || page.widthPx < 1) errs.push(`${page.name}: widthPx must be a positive integer`);
    if (!Number.isInteger(page.heightPx) || page.heightPx < 1) errs.push(`${page.name}: heightPx must be a positive integer`);
    if (page.bleedPx < 0) errs.push(`${page.name}: negative bleed`);
    if (page.slugPx < 0) errs.push(`${page.name}: negative slug`);
    if (page.columns < 1) errs.push(`${page.name}: columns must be >= 1`);
    if (page.columnGutter < 0) errs.push(`${page.name}: negative gutter`);
    const m = page.margin;
    if (m.left + m.right >= page.widthPx) errs.push(`${page.name}: horizontal margins leave no live area`);
    if (m.top + m.bottom >= page.heightPx) errs.push(`${page.name}: vertical margins leave no live area`);
    const grid = pageGrid(page);
    if (grid.columnWidth <= 0) errs.push(`${page.name}: column width collapses to <= 0`);

    for (const layer of page.layers) {
      if (layerIds.has(layer.id)) errs.push(`duplicate layer id ${layer.id}`);
      layerIds.add(layer.id);
      if (!layer.name) errs.push(`${page.name}: a layer has no name`);
      if (layer.opacity < 0 || layer.opacity > 1) errs.push(`${page.name}/${layer.name}: opacity out of range`);
      if (!(layer.transform.w > 0) || !(layer.transform.h > 0)) {
        errs.push(`${page.name}/${layer.name}: transform must have positive w/h`);
      }
      if (layer.parentId && !page.layers.some((l) => l.id === layer.parentId)) {
        errs.push(`${page.name}/${layer.name}: parentId points outside the page`);
      }
      if (layer.kind === "type-frame") {
        if (!storyIds.has(layer.storyId)) errs.push(`${page.name}/${layer.name}: storyId has no story`);
        usedStories.add(layer.storyId);
        if (doc.version >= 4) {
          if (!layer.textFrame) errs.push(`${page.name}/${layer.name}: v4 type frame has no textFrame properties`);
          else {
            if (layer.textFrame.columns < 1 || !Number.isInteger(layer.textFrame.columns)) {
              errs.push(`${page.name}/${layer.name}: text columns must be a positive integer`);
            }
            if (layer.textFrame.columnGutter < 0) errs.push(`${page.name}/${layer.name}: negative text column gutter`);
            const inset = layer.textFrame.inset;
            if (Object.values(inset).some((value) => value < 0)) {
              errs.push(`${page.name}/${layer.name}: negative text-frame inset`);
            }
            if (layer.textFrame.kind === "path" && !layer.textFrame.pathLayerId) {
              errs.push(`${page.name}/${layer.name}: path text has no pathLayerId`);
            }
          }
        }
      }
      if ((layer.kind === "image-frame" || layer.kind === "raster") && layer.assetId && !doc.assets[layer.assetId]) {
        errs.push(`${page.name}/${layer.name}: assetId has no asset`);
      }
      if (layer.kind === "vector") {
        const where = `${page.name}/${layer.name}`;
        // PRECEDENCE (v6): a non-empty `contours` list is authoritative; the
        // legacy single `nodes`/`closed` is the one-contour case otherwise.
        const multi = Array.isArray(layer.contours) && layer.contours.length > 0;
        if (multi) {
          const anyClosed = layer.contours!.some((c) => c.closed);
          if (layer.fill && !anyClosed) {
            errs.push(`${where}: filled compound path has no closed contour the compositor will draw`);
          }
          if (!layer.fill && !layer.stroke) errs.push(`${where}: vector has neither fill nor stroke`);
          for (const e of validateContours(layer.contours!, where)) errs.push(e);
        } else {
          if (layer.fill && !layer.closed) {
            errs.push(`${where}: open path carries a fill the compositor will not draw`);
          }
          if (!layer.fill && !layer.stroke) errs.push(`${where}: vector has neither fill nor stroke`);
          if (layer.nodes.length < 2) errs.push(`${where}: vector needs at least 2 nodes`);
        }
        if (layer.stroke) for (const e of validateStroke(layer.stroke, where)) errs.push(e);
      }
    }
  }

  for (const story of doc.stories) {
    if (!usedStories.has(story.id)) errs.push(`story ${story.id} is not referenced by any type frame`);
    if (!(story.character.size > 0)) errs.push(`story ${story.id}: size must be > 0`);
    if (!(story.character.leading > 0)) errs.push(`story ${story.id}: leading must be > 0`);
    if (doc.version >= 4) {
      if (!Array.isArray(story.runs)) errs.push(`story ${story.id}: v4 story has no character runs`);
      if (!Array.isArray(story.paragraphRuns)) errs.push(`story ${story.id}: v4 story has no paragraph runs`);
      for (const error of validateStoryTextModel(story)) errs.push(`story ${story.id}: ${error}`);
    }
  }

  if (doc.version >= 4) {
    if (!doc.textStyles) errs.push("v4 document has no text style registry");
    if (!doc.fontSubstitutions) errs.push("v4 document has no font substitution map");
  }

  for (const spread of doc.spreads) {
    for (const id of spread.pageIds) {
      if (!pageIds.has(id)) errs.push(`spread ${spread.id} references missing page ${id}`);
    }
  }
  const inSpreads = new Set(doc.spreads.flatMap((s) => s.pageIds));
  for (const p of doc.pages) if (!inSpreads.has(p.id)) errs.push(`page ${p.name} is in no spread`);

  for (const [id, asset] of Object.entries(doc.assets)) {
    if (asset.id !== id) errs.push(`asset key ${id} does not match asset.id ${asset.id}`);
    if (!asset.dataUrl.startsWith("data:")) errs.push(`asset ${asset.name}: dataUrl is not a data URL`);
    if (!(asset.width > 0) || !(asset.height > 0)) errs.push(`asset ${asset.name}: bad dimensions`);
  }
  return errs;
}
