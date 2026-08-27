/**
 * HarfBuzz shaping → glyph IDs → SVG outlines → Skia paths. Not fillText.
 *
 * Everything is shaped **in font units** — the HarfBuzz font is pinned at
 * `scale = upem`, so both the positions and the outlines come back in the
 * face's own design grid and are scaled to the page by `size / upem` at draw
 * time. Shaping at the pixel size instead (the obvious thing) makes HarfBuzz
 * round every advance to a whole pixel: at 24 px "Type" measures 54 px when
 * the true advance is 53.4 px, and the error accumulates across a line as
 * visible tracking noise. Font units give exact 1/1000-em metrics at every
 * size, and they let one glyph outline cache serve every size on the page.
 */
import type { Canvas, CanvasKit, Path } from "canvaskit-wasm";
import type { Story, TypeFrameLayer } from "../document/types";
import { graphemeBoundaries } from "../document/text-model";

type Hb = typeof import("harfbuzzjs");
type HbFont = InstanceType<Hb["Font"]>;
type HbFeature = InstanceType<Hb["Feature"]>;

let hbMod: Hb | null = null;

export async function loadHarfBuzz(): Promise<Hb> {
  if (!hbMod) hbMod = await import("harfbuzzjs");
  return hbMod;
}

/** InDesign's Auto leading: 120 % of the type size. */
export const AUTO_LEADING_RATIO = 1.2;

/**
 * Tracking is stored in InDesign's unit: 1/1000 em. -20 is a tight caption,
 * +100 a letterspaced smallcaps line.
 */
export const TRACKING_UNITS_PER_EM = 1000;

/**
 * The two OpenType features a Character panel switches: Kerning (`kern`) and
 * Ligatures (`liga`, which carries `clig` with it exactly as InDesign's
 * Ligatures checkbox does). Any other tag in a story's `otFeatures` is passed
 * through as an opt-in. The mandatory shaping features — `ccmp`, `locl`,
 * `calt`, `mark`, `mkmk`, `rlig` — are never touched, because turning those
 * off does not produce typography, it produces damage.
 */
const TOGGLEABLE_FEATURES = ["kern", "liga", "clig"] as const;

/** Cap on the per-face shaping cache before it is dropped wholesale. */
const RUN_CACHE_LIMIT = 4096;

export interface ShapedGlyph {
  gid: number;
  /** Frame-space px. Origin of the glyph on its baseline. */
  x: number;
  y: number;
  /** SVG outline in font units. Scale by `size / upem` to draw. */
  path: string;
}

/** One shaped run in font units — size-independent, therefore cacheable. */
interface ShapedRun {
  glyphs: { gid: number; dx: number; dy: number; adv: number }[];
  /** Sum of advances, font units. Excludes tracking. */
  width: number;
}

export interface FacePack {
  id: string;
  name: string;
  hb: Hb;
  blob: InstanceType<Hb["Blob"]>;
  face: InstanceType<Hb["Face"]>;
  upem: number;
  bytes: ArrayBuffer;
  /** hhea ascender in font units (positive). First baseline sits this far below the frame top. */
  ascender: number;
  /** hhea descender in font units (negative). */
  descender: number;
  lineGap: number;
  /** Glyph id of U+0020, so justification can find the word gaps without decoding clusters. */
  spaceGid: number;
  /** The one font used for shaping and outlines, pinned at scale = upem. */
  unitFont: HbFont;
  /** gid → SVG path string, font units. */
  outlines: Map<number, string>;
  /** feature-key + text → shaped run, font units. */
  runs: Map<string, ShapedRun>;
  /** feature-key → HarfBuzz feature array. These own wasm memory; build each once. */
  features: Map<string, HbFeature[]>;
}

export async function loadFace(id: string, name: string, bytes: ArrayBuffer): Promise<FacePack> {
  const hb = await loadHarfBuzz();
  const blob = new hb.Blob(new Uint8Array(bytes));
  const face = new hb.Face(blob, 0);
  const upem = face.upem || 1000;
  const unitFont = new hb.Font(face);
  unitFont.setScale(upem, upem);

  const ext = unitFont.hExtents();
  const ascender = ext && ext.ascender > 0 ? ext.ascender : Math.round(upem * 0.8);
  const descender = ext && ext.descender < 0 ? ext.descender : -Math.round(upem * 0.2);
  const lineGap = ext?.lineGap ?? 0;

  const pack: FacePack = {
    id,
    name,
    hb,
    blob,
    face,
    upem,
    bytes,
    ascender,
    descender,
    lineGap,
    spaceGid: -1,
    unitFont,
    outlines: new Map(),
    runs: new Map(),
    features: new Map(),
  };
  pack.spaceGid = shapeRun(pack, " ", "").glyphs[0]?.gid ?? -1;
  return pack;
}

/* ------------------------------------------------------------------ *
 * Shaping
 * ------------------------------------------------------------------ */

function featureKey(tags: string[] | undefined): string {
  if (!tags || !tags.length) return "";
  const clean = tags
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9]{4}$/.test(t));
  return Array.from(new Set(clean)).sort().join(",");
}

function featuresFor(face: FacePack, key: string): HbFeature[] {
  const hit = face.features.get(key);
  if (hit) return hit;
  const wanted = new Set(key ? key.split(",") : []);
  if (wanted.has("liga")) wanted.add("clig");
  const list: HbFeature[] = [];
  for (const tag of wanted) list.push(new face.hb.Feature(tag, 1));
  for (const tag of TOGGLEABLE_FEATURES) {
    if (!wanted.has(tag)) list.push(new face.hb.Feature(tag, 0));
  }
  face.features.set(key, list);
  return list;
}

const EMPTY_RUN: ShapedRun = { glyphs: [], width: 0 };

/** Shape one run of text in font units. Cached: line breaking measures the same words over and over. */
function shapeRun(face: FacePack, text: string, key: string): ShapedRun {
  if (!text.length) return EMPTY_RUN;
  const cacheKey = `${key}${text}`;
  const hit = face.runs.get(cacheKey);
  if (hit) return hit;

  const features = featuresFor(face, key);
  const buffer = new face.hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  face.hb.shape(face.unitFont, buffer, features);
  const items = buffer.getGlyphInfosAndPositions();

  const glyphs: ShapedRun["glyphs"] = [];
  let width = 0;
  for (const item of items) {
    glyphs.push({
      gid: item.codepoint,
      dx: item.xOffset ?? 0,
      dy: item.yOffset ?? 0,
      adv: item.xAdvance ?? 0,
    });
    width += item.xAdvance ?? 0;
  }
  const run: ShapedRun = { glyphs, width };
  if (face.runs.size > RUN_CACHE_LIMIT) face.runs.clear();
  face.runs.set(cacheKey, run);
  return run;
}

function outlineOf(face: FacePack, gid: number): string {
  let path = face.outlines.get(gid);
  if (path === undefined) {
    path = face.unitFont.glyphToPath(gid) || "";
    face.outlines.set(gid, path);
  }
  return path;
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

export interface CaretStop {
  /** UTF-16 offset into `story.text`. */
  offset: number;
  x: number;
  /** Baseline y, frame-local px. */
  y: number;
  height: number;
}

/** One composed line, for underlines / strikethroughs that follow the glyphs. */
export interface ComposeLine {
  x: number;
  /** Baseline y, frame-local px. */
  baseline: number;
  width: number;
}

export interface ComposeResult {
  glyphs: ShapedGlyph[];
  /** True when a line had to be dropped because it fell past the frame's foot. */
  overflow: boolean;
  lineCount: number;
  /** px from the frame top to the descender of the last set line. */
  heightPx: number;
  /** px from the frame top to the first baseline. The frame's optical top edge. */
  firstBaselinePx: number;
  caretStops: CaretStop[];
  lines: ComposeLine[];
}

export function nearestCaretOffset(stops: CaretStop[], x: number, y: number): number {
  if (!stops.length) return 0;
  let best = stops[0]!;
  let bestD = Infinity;
  for (const stop of stops) {
    const dy = y - (stop.y - stop.height * 0.8);
    const linePenalty = dy < -2 || dy > stop.height ? Math.abs(dy) * 6 : 0;
    const d = Math.abs(x - stop.x) + linePenalty;
    if (d < bestD) {
      bestD = d;
      best = stop;
    }
  }
  return best.offset;
}

/** Everything one story contributes to the shaper, resolved once per compose. */
interface Metrics {
  size: number;
  leading: number;
  /** Font unit → px. */
  scale: number;
  /** px added after every glyph. */
  track: number;
  key: string;
  ascent: number;
  descent: number;
}

function metricsFor(face: FacePack, story: Story): Metrics {
  const size = story.character.size > 0 ? story.character.size : 1;
  const leading = story.character.leading > 0 ? story.character.leading : size * AUTO_LEADING_RATIO;
  const scale = size / face.upem;
  const tracking = Number.isFinite(story.character.tracking) ? story.character.tracking : 0;
  return {
    size,
    leading,
    scale,
    track: (tracking / TRACKING_UNITS_PER_EM) * size,
    key: featureKey(story.character.otFeatures),
    ascent: face.ascender * scale,
    descent: -face.descender * scale,
  };
}

/** Width of a run in px, tracking included. */
function advanceOf(face: FacePack, text: string, m: Metrics): number {
  const run = shapeRun(face, text, m.key);
  return run.width * m.scale + m.track * run.glyphs.length;
}

/** Split a word that cannot fit any measure. Better a hard break than glyphs outside the frame. */
function breakWord(face: FacePack, word: string, limit: number, m: Metrics): string[] {
  const chars = Array.from(word);
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of chars) {
    const trial = chunk + ch;
    if (chunk && advanceOf(face, trial, m) > limit) {
      chunks.push(chunk);
      chunk = ch;
    } else chunk = trial;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [word];
}

/** Greedy line breaker. `firstW` carries the first-line indent, `restW` is the full measure. */
function breakParagraph(
  face: FacePack,
  text: string,
  firstW: number,
  restW: number,
  m: Metrics,
): string[] {
  if (!text.length) return [""];
  const lines: string[] = [];
  let line = "";
  let width = 0;
  let limit = Math.max(1, firstW);

  const push = () => {
    lines.push(line.replace(/\s+$/, ""));
    line = "";
    width = 0;
    limit = Math.max(1, restW);
  };

  for (const token of text.split(/(\s+)/)) {
    if (!token.length) continue;
    if (/^\s+$/.test(token)) {
      // Spaces never force a break: a break trims them anyway.
      if (line.length) {
        line += token;
        width += advanceOf(face, token, m);
      }
      continue;
    }
    const w = advanceOf(face, token, m);
    if (line.length && width + w > limit + 0.01) push();
    if (!line.length && w > limit + 0.01) {
      const chunks = breakWord(face, token, limit, m);
      for (let i = 0; i < chunks.length - 1; i++) {
        line = chunks[i]!;
        push();
      }
      line = chunks[chunks.length - 1]!;
      width = advanceOf(face, line, m);
      continue;
    }
    line += token;
    width += w;
  }
  if (line.trim().length || !lines.length) push();
  return lines;
}

function linePen(face: FacePack, text: string, x0: number, last: boolean, m: Metrics, rightEdge: number, align: Story["paragraph"]["align"]): { pen: number; gap: number; lineW: number } {
  const run = shapeRun(face, text, m.key);
  const lineW = run.width * m.scale + m.track * run.glyphs.length;
  const room = Math.max(0, rightEdge - x0);
  const slack = room - lineW;
  let pen = x0;
  let gap = 0;
  if (align === "right") pen = x0 + Math.max(0, slack);
  else if (align === "center") pen = x0 + Math.max(0, slack / 2);
  else if (align === "justify" && !last && slack > 0) {
    const gaps = run.glyphs.reduce((n, g) => n + (g.gid === face.spaceGid ? 1 : 0), 0);
    if (gaps > 0) gap = slack / gaps;
  }
  return { pen, gap, lineW };
}

export function composeFrame(face: FacePack, story: Story, frameW: number, frameH: number): ComposeResult {
  const m = metricsFor(face, story);
  const measure = Math.max(1, frameW);
  const startInd = Number.isFinite(story.paragraph.startIndent) ? (story.paragraph.startIndent as number) : 0;
  const endInd = Number.isFinite(story.paragraph.endIndent) ? (story.paragraph.endIndent as number) : 0;
  const firstInd = Number.isFinite(story.paragraph.firstLineIndent) ? story.paragraph.firstLineIndent : 0;
  const spaceAfter = Math.max(0, story.paragraph.spaceAfter || 0);
  const spaceBefore = Math.max(0, Number.isFinite(story.paragraph.spaceBefore) ? (story.paragraph.spaceBefore as number) : 0);
  const left = Math.max(0, Math.min(startInd, measure - 2));
  const rightPad = Math.max(0, Math.min(endInd, measure - left - 2));
  const rightEdge = measure - rightPad;
  const x0Rest = left;
  const x0First = Math.max(0, Math.min(left + firstInd, rightEdge - 1));
  const firstW = Math.max(1, rightEdge - x0First);
  const restW = Math.max(1, rightEdge - x0Rest);
  const align = story.paragraph.align;

  const glyphs: ShapedGlyph[] = [];
  const caretStops: CaretStop[] = [];
  const decoLines: ComposeLine[] = [];
  const shift = Number.isFinite(story.character.baselineShift) ? (story.character.baselineShift as number) : 0;
  let y = m.ascent;
  let overflow = false;
  let lineCount = 0;
  let lastBaseline = 0;

  /** Set one line. `x0` is the indent, `last` suppresses justification on a paragraph's final line. */
  const setLine = (text: string, x0: number, last: boolean) => {
    if (y > frameH + 0.5) {
      overflow = true;
      return;
    }
    const run = shapeRun(face, text, m.key);
    const { pen: startPen, gap, lineW } = linePen(face, text, x0, last, m, rightEdge, align);
    let pen = startPen;
    const baseline = y - shift;

    for (const g of run.glyphs) {
      const path = outlineOf(face, g.gid);
      if (path) {
        glyphs.push({
          gid: g.gid,
          x: pen + g.dx * m.scale,
          y: baseline - g.dy * m.scale,
          path,
        });
      }
      pen += g.adv * m.scale + m.track;
      if (gap && g.gid === face.spaceGid) pen += gap;
    }

    if (lineW > 0.5) decoLines.push({ x: startPen, baseline, width: lineW });
    lastBaseline = baseline;
    y += m.leading;
    lineCount += 1;
  };

  const text = story.text.replace(/\r\n/g, "\n");
  const paras = text.split("\n");
  let storyAt = 0;

  const emitStops = (line: string, lineStart: number, x0: number, last: boolean, baseline: number) => {
    const { pen: startPen } = linePen(face, line, x0, last, m, rightEdge, align);
    const bounds = graphemeBoundaries(line);
    for (const local of bounds) {
      const prefix = line.slice(0, local);
      caretStops.push({
        offset: lineStart + local,
        x: startPen + (prefix ? advanceOf(face, prefix, m) : 0),
        y: baseline,
        height: m.leading,
      });
    }
  };

  for (let p = 0; p < paras.length; p++) {
    const para = paras[p]!;
    const paraStart = storyAt;
    y += spaceBefore;
    const lines = breakParagraph(face, para, firstW, restW, m);
    let searchFrom = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const x0 = i === 0 ? x0First : x0Rest;
      const last = i === lines.length - 1;
      let lineStart = line.length ? para.indexOf(line, searchFrom) : searchFrom;
      if (lineStart < 0) lineStart = searchFrom;
      emitStops(line, paraStart + lineStart, x0, last, y - shift);
      setLine(line, x0, last);
      searchFrom = lineStart + line.length;
      if (overflow) break;
    }
    if (overflow) break;
    storyAt = paraStart + para.length + 1;
    if (p < paras.length - 1) y += spaceAfter;
  }

  if (!caretStops.length) {
    caretStops.push({ offset: 0, x: x0First, y: m.ascent - shift + spaceBefore, height: m.leading });
  }

  return {
    glyphs,
    overflow,
    lineCount,
    heightPx: lineCount ? lastBaseline + m.descent : 0,
    firstBaselinePx: m.ascent - shift + spaceBefore,
    caretStops,
    lines: decoLines,
  };
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/**
 * Skia paths are wasm objects; rebuilding one per glyph per frame is the single
 * most expensive thing this file could do. Outlines are in font units, so one
 * path per glyph id serves every size, colour and frame on the page.
 */
interface PathCache {
  ck: CanvasKit;
  paths: Map<number, Path | null>;
}
const pathCaches = new WeakMap<FacePack, PathCache>();

function skiaPath(ck: CanvasKit, face: FacePack, gid: number, svg: string): Path | null {
  let cache = pathCaches.get(face);
  if (!cache || cache.ck !== ck) {
    cache = { ck, paths: new Map() };
    pathCaches.set(face, cache);
  }
  const hit = cache.paths.get(gid);
  if (hit !== undefined) return hit;
  const path = svg ? ck.Path.MakeFromSVGString(svg) : null;
  cache.paths.set(gid, path ?? null);
  return path ?? null;
}

export function drawTypeFrame(
  ck: CanvasKit,
  canvas: Canvas,
  layer: TypeFrameLayer,
  story: Story,
  face: FacePack,
): ComposeResult {
  const composed = composeFrame(face, story, layer.transform.w, layer.transform.h);
  if (!composed.glyphs.length) return composed;

  const size = story.character.size > 0 ? story.character.size : 1;
  const scale = size / face.upem;
  const fill = story.character.fill;
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(ck.PaintStyle.Fill);
  paint.setColor(ck.Color4f(fill.r, fill.g, fill.b, fill.a * layer.opacity));

  for (const g of composed.glyphs) {
    const path = skiaPath(ck, face, g.gid, g.path);
    if (!path) continue;
    canvas.save();
    canvas.translate(g.x, g.y);
    // Font units are y-up from the baseline; the page is y-down.
    canvas.scale(scale, -scale);
    canvas.drawPath(path, paint);
    canvas.restore();
  }

  const underline = !!story.character.underline;
  const strike = !!story.character.strikethrough;
  if ((underline || strike) && composed.lines.length) {
    const deco = new ck.Paint();
    deco.setAntiAlias(true);
    deco.setStyle(ck.PaintStyle.Stroke);
    deco.setStrokeCap(ck.StrokeCap.Butt);
    deco.setColor(ck.Color4f(fill.r, fill.g, fill.b, fill.a * layer.opacity));
    deco.setStrokeWidth(Math.max(1, size * 0.055));
    for (const line of composed.lines) {
      if (underline) {
        const y = line.baseline + size * 0.12;
        canvas.drawLine(line.x, y, line.x + line.width, y, deco);
      }
      if (strike) {
        const y = line.baseline - size * 0.28;
        canvas.drawLine(line.x, y, line.x + line.width, y, deco);
      }
    }
    deco.delete();
  }

  paint.delete();
  return composed;
}
