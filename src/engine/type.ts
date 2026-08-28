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
import type { Canvas, CanvasKit, Paint, Path } from "canvaskit-wasm";
import type { CharacterStyle, Rgba, Story, TextFrameProperties, TypeFrameLayer } from "../document/types";
import { fontRegistry } from "./font-registry";

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
  /**
   * The face this glyph was shaped and outlined with — the story face, or the
   * face a character range's `fontId` resolved to.
   */
  face: FacePack;
  /** Font unit → px for this glyph's run (`run size / face upem`). */
  scale: number;
  /** The run's fill colour. */
  fill: Rgba;
  /**
   * UTF-16 offset into `story.text` where this glyph's HarfBuzz cluster starts
   * — the character (or ligature/combining group) the glyph was shaped from.
   * A ligature glyph carries the offset of its FIRST character; under RTL the
   * visual order of `glyphs` is reversed relative to these offsets.
   */
  cluster: number;
}

/** One shaped run in font units — size-independent, therefore cacheable. */
interface ShapedRun {
  glyphs: { gid: number; dx: number; dy: number; adv: number; cluster: number }[];
  /** Sum of advances, font units. Excludes tracking. */
  width: number;
}

/**
 * The HarfBuzz segment properties a story (or a character range) pins for one
 * shaping call. `null` means "let HarfBuzz guess it" — exactly what happened
 * before stories could name them, so unspecified fields change nothing.
 *
 * These are the three values `hb_buffer_set_segment_properties` groups as the
 * buffer's segment properties; harfbuzzjs exposes them as individual setters.
 */
interface SegProps {
  /** `"ltr"` / `"rtl"`; `"auto"` and undefined fall through to the guesser. */
  dir: "ltr" | "rtl" | null;
  /** ISO 15924 tag ("Latn", "Arab", …) when the author overrides detection. */
  script: string | null;
  /** BCP 47 tag; `und` means deliberately unspecified, so it is dropped. */
  lang: string | null;
}

/** Extract the story's segment properties; undefined when everything is a guess. */
function segFor(c: CharacterStyle): SegProps | undefined {
  const dir = c.direction === "ltr" || c.direction === "rtl" ? c.direction : null;
  const script =
    typeof c.script === "string" && /^[A-Za-z0-9]{4}$/.test(c.script.trim())
      ? c.script.trim()
      : null;
  const lang =
    typeof c.language === "string" && c.language.trim() && c.language.trim().toLowerCase() !== "und"
      ? c.language.trim()
      : null;
  if (!dir && !script && !lang) return undefined;
  return { dir, script, lang };
}

/** Stable identity of a SegProps for cache keys and span merging. */
function segKeyOf(seg: SegProps | undefined): string {
  if (!seg) return "";
  return `${seg.dir ?? ""}\u0001${seg.script ?? ""}\u0001${seg.lang ?? ""}`;
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
function shapeRun(face: FacePack, text: string, key: string, seg?: SegProps): ShapedRun {
  if (!text.length) return EMPTY_RUN;
  const cacheKey = `${key}\u0000${segKeyOf(seg)}\u0000${text}`;
  const hit = face.runs.get(cacheKey);
  if (hit) return hit;

  const features = featuresFor(face, key);
  const buffer = new face.hb.Buffer();
  buffer.addText(text);
  // Pin what the story named BEFORE guessing: guessSegmentProperties only
  // fills properties the buffer does not carry, so an explicit direction or
  // script survives and everything left unset is guessed exactly as before.
  // addText feeds the buffer as UTF-16, so cluster values come back as UTF-16
  // offsets into `text` — the identity carets and selection map back through.
  if (seg?.dir) buffer.setDirection(seg.dir === "rtl" ? face.hb.Direction.RTL : face.hb.Direction.LTR);
  if (seg?.script) buffer.setScript(seg.script);
  if (seg?.lang) buffer.setLanguage(seg.lang);
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
      cluster: item.cluster,
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

export interface ComposeResult {
  glyphs: ShapedGlyph[];
  /** True when a line had to be dropped because it fell past the frame's foot. */
  overflow: boolean;
  lineCount: number;
  /** px from the frame top to the descender of the last set line. */
  heightPx: number;
  /** px from the frame top to the first baseline. The frame's optical top edge. */
  firstBaselinePx: number;
  /** Descent depth in px of the last set line; the story face's descent when nothing was set. */
  lastDescentPx: number;
  caretStops: CaretStop[];
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

/**
 * The rendering-relevant character formatting for one contiguous span of text:
 * the story-level style, or the story style with a character range's overrides
 * merged over it, resolved against the face that range asks for.
 */
interface RunStyle {
  face: FacePack;
  size: number;
  leading: number;
  /** Font unit → px. */
  scale: number;
  /** px added after every glyph. */
  track: number;
  key: string;
  /** Story/range segment properties for the shaper; undefined = all guessed. */
  seg?: SegProps;
  /** `seg`'s cache identity — the merge key that keeps same-segment spans one run. */
  segKey: string;
  fill: Rgba;
}

function styleFor(face: FacePack, c: CharacterStyle): RunStyle {
  const size = c.size > 0 ? c.size : 1;
  const tracking = Number.isFinite(c.tracking) ? c.tracking : 0;
  const seg = segFor(c);
  return {
    face,
    size,
    leading: c.leading > 0 ? c.leading : size * AUTO_LEADING_RATIO,
    scale: size / face.upem,
    track: (tracking / TRACKING_UNITS_PER_EM) * size,
    key: featureKey(c.otFeatures),
    seg,
    segKey: segKeyOf(seg),
    fill: c.fill,
  };
}

/** Character formatting with one range's overrides merged over the story defaults. */
function characterWith(story: Story, o: Partial<CharacterStyle> | undefined): CharacterStyle {
  const c = story.character;
  if (!o) return c;
  const num = (v: number | undefined, d: number): number =>
    v !== undefined && Number.isFinite(v) ? v : d;
  return {
    ...c,
    fontId: o.fontId !== undefined ? o.fontId : c.fontId,
    size: num(o.size, c.size),
    leading: num(o.leading, c.leading),
    tracking: num(o.tracking, c.tracking),
    fill: o.fill ?? c.fill,
    otFeatures: o.otFeatures ?? c.otFeatures,
    // Segment properties are character formatting too: a range may name its own
    // language/script/direction the same way it names a face or a size.
    language: o.language ?? c.language,
    script: o.script ?? c.script,
    direction: o.direction ?? c.direction,
  };
}

/**
 * The face a range's `fontId` resolves to. Unknown or unloaded ids fall back to
 * the story's face — the same never-throws contract `FontRegistry.resolve`
 * gives the compositor for the story-level font.
 */
function faceForRun(story: Story, o: Partial<CharacterStyle> | undefined, base: FacePack): FacePack {
  const id = o?.fontId;
  if (!id) return base;
  return fontRegistry().resolve(id) ?? base;
}

/** One contiguous same-styled stretch of a paragraph, in paragraph-local offsets. */
interface CharSpan {
  start: number;
  end: number;
  style: RunStyle;
}

function sameRunStyle(a: RunStyle, b: RunStyle): boolean {
  return (
    a.face === b.face &&
    a.size === b.size &&
    a.leading === b.leading &&
    a.track === b.track &&
    a.key === b.key &&
    a.segKey === b.segKey &&
    a.fill === b.fill
  );
}

/**
 * Cut a paragraph's offset range into same-styled spans. Sparse ranges leave
 * the story-level style in the gaps; adjacent spans with identical resolved
 * styling are merged so plain text stays one shaping call per line, exactly as
 * it was before ranges existed.
 */
function charSpansFor(story: Story, baseFace: FacePack, from: number, to: number): CharSpan[] {
  const len = to - from;
  const runs: { start: number; end: number; overrides: Partial<CharacterStyle> }[] = [];
  for (const run of story.runs ?? []) {
    const start = Math.max(0, Math.min(run.start, story.text.length));
    const end = Math.max(0, Math.min(run.end, story.text.length));
    if (end <= start || end <= from || start >= to) continue;
    runs.push({ start: start - from, end: end - from, overrides: run.overrides });
  }
  runs.sort((a, b) => a.start - b.start || a.end - b.end);

  const bounds = new Set<number>([0, len]);
  for (const r of runs) {
    if (r.start > 0 && r.start < len) bounds.add(r.start);
    if (r.end > 0 && r.end < len) bounds.add(r.end);
  }
  const points = Array.from(bounds).sort((a, b) => a - b);

  const spans: CharSpan[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const s = points[i]!;
    const e = points[i + 1]!;
    // A span interior contains no range boundary, so any run reaching across
    // it covers all of it; the last run in sort order wins the overlap.
    let overrides: Partial<CharacterStyle> | undefined;
    for (const r of runs) if (r.start <= s && r.end >= e) overrides = r.overrides;
    const style = styleFor(faceForRun(story, overrides, baseFace), characterWith(story, overrides));
    const prior = spans[spans.length - 1];
    if (prior && sameRunStyle(prior.style, style)) prior.end = e;
    else spans.push({ start: s, end: e, style });
  }
  return spans;
}

/** The paragraph-level formatting for one paragraph, paragraph-range overrides merged in. */
interface ParaStyle {
  align: Story["paragraph"]["align"];
  firstLineIndent: number;
  startIndent: number;
  spaceBefore: number;
  spaceAfter: number;
}

function paraStyleFor(story: Story, from: number, to: number): ParaStyle {
  const p = story.paragraph;
  const out: ParaStyle = {
    align: p.align,
    firstLineIndent: p.firstLineIndent || 0,
    startIndent: p.startIndent || 0,
    spaceBefore: p.spaceBefore || 0,
    spaceAfter: p.spaceAfter || 0,
  };
  for (const run of story.paragraphRuns ?? []) {
    if (run.end <= from || run.start >= to) continue;
    const o = run.overrides ?? {};
    if (o.align !== undefined) out.align = o.align;
    if (o.firstLineIndent !== undefined && Number.isFinite(o.firstLineIndent)) out.firstLineIndent = o.firstLineIndent;
    if (o.startIndent !== undefined && Number.isFinite(o.startIndent)) out.startIndent = o.startIndent;
    if (o.spaceBefore !== undefined && Number.isFinite(o.spaceBefore)) out.spaceBefore = o.spaceBefore;
    if (o.spaceAfter !== undefined && Number.isFinite(o.spaceAfter)) out.spaceAfter = o.spaceAfter;
  }
  return out;
}

function metricsFor(face: FacePack, story: Story): Metrics {
  const s = styleFor(face, story.character);
  return {
    size: s.size,
    leading: s.leading,
    scale: s.scale,
    track: s.track,
    key: s.key,
    ascent: face.ascender * s.scale,
    descent: -face.descender * s.scale,
  };
}

/** Width of a clipped stretch of spans in px, tracking included. */
function spanWidth(spans: CharSpan[], text: string, start: number, end: number): number {
  let w = 0;
  for (const sp of spans) {
    const s = Math.max(sp.start, start);
    const e = Math.min(sp.end, end);
    if (e <= s) continue;
    const run = shapeRun(sp.style.face, text.slice(s, e), sp.style.key, sp.style.seg);
    w += run.width * sp.style.scale + sp.style.track * run.glyphs.length;
  }
  return w;
}

/** The tallest line box the spans on [start, end) imply; the story style when none. */
function spanLeading(spans: CharSpan[], start: number, end: number, fallback: number): number {
  let leading = 0;
  for (const sp of spans) {
    if (sp.end <= start || sp.start >= end) continue;
    leading = Math.max(leading, sp.style.leading);
  }
  return leading || fallback;
}

/** Split a word that cannot fit any measure. Better a hard break than glyphs outside the frame. */
function breakWord(spans: CharSpan[], text: string, wordAt: number, wordEnd: number, limit: number): string[] {
  const chars = Array.from(text.slice(wordAt, wordEnd));
  const chunks: string[] = [];
  let chunk = "";
  for (const ch of chars) {
    const trial = chunk + ch;
    if (chunk && spanWidth(spans, text, wordAt, wordAt + trial.length) > limit) {
      chunks.push(chunk);
      chunk = ch;
    } else chunk = trial;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [text.slice(wordAt, wordEnd)];
}

/** Greedy line breaker over styled spans. `firstW` carries the first-line indent, `restW` the full measure. */
function breakParagraph(spans: CharSpan[], text: string, firstW: number, restW: number): string[] {
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

  let cursor = 0;
  for (const token of text.split(/(\s+)/)) {
    if (!token.length) continue;
    const at = cursor;
    cursor += token.length;
    if (/^\s+$/.test(token)) {
      // Spaces never force a break: a break trims them anyway.
      if (line.length) {
        line += token;
        width += spanWidth(spans, text, at, cursor);
      }
      continue;
    }
    const w = spanWidth(spans, text, at, cursor);
    if (line.length && width + w > limit + 0.01) push();
    if (!line.length && w > limit + 0.01) {
      const chunks = breakWord(spans, text, at, cursor, limit);
      for (let i = 0; i < chunks.length - 1; i++) {
        line = chunks[i]!;
        push();
      }
      line = chunks[chunks.length - 1]!;
      width = spanWidth(spans, text, cursor - line.length, cursor);
      continue;
    }
    line += token;
    width += w;
  }
  if (line.trim().length || !lines.length) push();
  return lines;
}

/** Where the pen starts on a line: the indent, or the indent plus the alignment slack. */
function alignPen(
  lineW: number,
  origin: number,
  x0: number,
  measure: number,
  align: Story["paragraph"]["align"],
): { pen: number; slack: number } {
  // `origin` is the absolute pen origin (inset left + indent); `x0` is the
  // paragraph indent alone. Room and slack live inside the measure, so the
  // indent — never the inset origin — reduces them.
  const room = Math.max(0, measure - x0);
  const slack = room - lineW;
  let pen = origin;
  if (align === "right") pen = origin + Math.max(0, slack);
  else if (align === "center") pen = origin + Math.max(0, slack / 2);
  return { pen, slack };
}

/** Inset values resolved for composition; absent or invalid entries are 0. */
interface FrameInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function insetsOf(tf: TextFrameProperties | undefined): FrameInsets {
  const v = (x: number | undefined): number =>
    x !== undefined && Number.isFinite(x) ? Math.max(0, x) : 0;
  return {
    top: v(tf?.inset.top),
    right: v(tf?.inset.right),
    bottom: v(tf?.inset.bottom),
    left: v(tf?.inset.left),
  };
}

export function composeFrame(
  face: FacePack,
  story: Story,
  frameW: number,
  frameH: number,
  textFrame?: TextFrameProperties,
): ComposeResult {
  const inset = insetsOf(textFrame);
  // The pen starts at the top-left inset; the measure and the foot shrink by
  // the insets. With zero insets every expression below reduces to the exact
  // arithmetic this file shipped with, so legacy frames render bit-identically.
  const originX = inset.left;
  const measure = Math.max(1, frameW - inset.left - inset.right);
  const contentH = Math.max(1, frameH - inset.top - inset.bottom);
  const foot = frameH - inset.bottom;

  // `dy` shifts the whole composed block down inside the content box; vertical
  // alignment resolves it after a measuring pass.
  const compose = (dy: number): ComposeResult => {
    const m = metricsFor(face, story);
    const glyphs: ShapedGlyph[] = [];
    /** Caret stops by UTF-16 offset; first insertion wins a duplicated boundary. */
    const stops = new Map<number, CaretStop>();
    let y = inset.top + dy + m.ascent;
  let overflow = false;
  let lineCount = 0;
  let lastBaseline = 0;
  let lastDescent = m.descent;

  /**
   * Set one line of the paragraph-local range [start, start + line.length).
   * `paraStart` places the line inside the story; `x0` is the indent, `last`
   * suppresses justification on a paragraph's final line. Each span of the
   * line is shaped with its own face and styled with its own size, tracking
   * and fill; the line box takes the tallest span. Caret stops fall out of the
   * same glyph walk that places the glyphs, so a caret can only ever land
   * where shaping put a glyph edge.
   */
  const setLine = (
    spans: CharSpan[],
    para: string,
    line: string,
    paraStart: number,
    start: number,
    x0: number,
    last: boolean,
    align: ParaStyle["align"],
  ): void => {
    const end = start + line.length;
    const over = y > foot + 0.5;
    if (over) overflow = true;
    const pieces: { style: RunStyle; run: ShapedRun; s: number; e: number }[] = [];
    let lineW = 0;
    let spaces = 0;
    for (const sp of spans) {
      const s = Math.max(sp.start, start);
      const e = Math.min(sp.end, end);
      if (e <= s) continue;
      const run = shapeRun(sp.style.face, para.slice(s, e), sp.style.key, sp.style.seg);
      lineW += run.width * sp.style.scale + sp.style.track * run.glyphs.length;
      for (const g of run.glyphs) if (g.gid === sp.style.face.spaceGid) spaces += 1;
      pieces.push({ style: sp.style, run, s, e });
    }
    const { pen: startPen, slack } = alignPen(lineW, originX + x0, x0, measure, align);
    let gap = 0;
    if (align === "justify" && !last && slack > 0 && spaces > 0) gap = slack / spaces;
    let pen = startPen;
    const lineH = spanLeading(spans, start, end, m.leading);
    let boundaries = 0;

    /** One caret boundary at paragraph-local `offset`, first x claimed wins. */
    const stop = (offset: number, x: number): void => {
      boundaries += 1;
      const at = paraStart + offset;
      if (!stops.has(at)) stops.set(at, { offset: at, x, y, height: lineH });
    };

    for (const piece of pieces) {
      const st = piece.style;
      const gs = piece.run.glyphs;
      // HarfBuzz returns glyphs in visual order with monotone clusters: rising
      // for an LTR piece, falling for RTL (reversed against the logical text).
      // Ligature members tie and carry no direction, so only a clean fall —
      // never a rise — marks the piece right-to-left.
      let rises = false;
      let falls = false;
      for (let i = 1; i < gs.length; i++) {
        const prev = gs[i - 1]!.cluster;
        const cur = gs[i]!.cluster;
        if (cur > prev) rises = true;
        else if (cur < prev) falls = true;
      }
      const rtl = falls && !rises;
      // One cluster group: consecutive glyphs shaped from the same characters
      // (a ligature, a base plus its combining marks). `left`/`right` are the
      // pen edges of the group's box — where a caret can sit — plus the
      // origin of its first glyph, which is where an LTR caret before the
      // cluster belongs.
      const groups: { c: number; left: number; right: number; origin: number }[] = [];
      let gi = 0;
      while (gi < gs.length) {
        const cluster = gs[gi]!.cluster;
        const penBefore = pen;
        const origin = pen + gs[gi]!.dx * st.scale;
        let j = gi;
        while (j < gs.length && gs[j]!.cluster === cluster) {
          const g = gs[j]!;
          if (!over) {
            const path = outlineOf(st.face, g.gid);
            if (path) {
              glyphs.push({
                gid: g.gid,
                x: pen + g.dx * st.scale,
                y: y - g.dy * st.scale,
                path,
                face: st.face,
                scale: st.scale,
                fill: st.fill,
                cluster: paraStart + piece.s + cluster,
              });
            }
          }
          pen += g.adv * st.scale + st.track;
          if (gap && g.gid === st.face.spaceGid) pen += gap;
          j += 1;
        }
        groups.push({ c: cluster, left: penBefore, right: pen, origin });
        gi = j;
      }
      // LTR: a cluster's "before" caret is its left edge and its "after"
      // caret the left edge of the next cluster. RTL mirrors: before is the
      // right edge, after the right edge of the visually left neighbour —
      // which is the logically NEXT text. The edges agree where boxes touch,
      // so whichever neighbour claims a shared boundary first records the
      // same x.
      for (let k = 0; k < groups.length; k++) {
        const g = groups[k]!;
        const next = rtl ? groups[k - 1] : groups[k + 1];
        const end = next ? next.c : piece.e - piece.s;
        if (rtl) {
          stop(piece.s + g.c, g.right);
          stop(piece.s + end, g.left);
        } else {
          stop(piece.s + g.c, g.left);
          stop(piece.s + end, g.right);
        }
      }
    }

    // A line that shaped to no glyphs at all (blank line) still needs a stop
    // to put the caret in.
    if (!boundaries) {
      stop(start, startPen);
      if (line.length) stop(end, pen);
    }

    if (over) return;

    let leading = m.leading;
    let descent = m.descent;
    if (pieces.length) {
      leading = 0;
      descent = 0;
      for (const piece of pieces) {
        leading = Math.max(leading, piece.style.leading);
        descent = Math.max(descent, -piece.style.face.descender * piece.style.scale);
      }
    }
    lastBaseline = y;
    lastDescent = descent;
    y += leading;
    lineCount += 1;
  };

  const text = story.text.replace(/\r\n/g, "\n");
  const paras = text.split("\n");
  let storyAt = 0;

  for (let p = 0; p < paras.length; p++) {
    const para = paras[p]!;
    const paraStart = storyAt;
    const spans = charSpansFor(story, face, paraStart, paraStart + para.length);
    const ps = paraStyleFor(story, paraStart, paraStart + para.length + 1);

    const startIndent = Math.max(0, Math.min(ps.startIndent, measure - 1));
    const firstIndent = Math.min(
      startIndent + Math.max(0, Math.min(ps.firstLineIndent || 0, measure - 1)),
      measure - 1,
    );
    const lines = breakParagraph(spans, para, measure - firstIndent, measure - startIndent);
    let searchFrom = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const x0 = i === 0 ? firstIndent : startIndent;
      const last = i === lines.length - 1;
      let lineStart = line.length ? para.indexOf(line, searchFrom) : searchFrom;
      if (lineStart < 0) lineStart = searchFrom;
      setLine(spans, para, line, paraStart, lineStart, x0, last, ps.align);
      searchFrom = lineStart + line.length;
      if (overflow) break;
    }
    if (overflow) break;
    storyAt = paraStart + para.length + 1;
    if (p < paras.length - 1) {
      const nextPara = paras[p + 1]!;
      const next = paraStyleFor(story, storyAt, storyAt + nextPara.length + 1);
      const gap = Math.max(0, ps.spaceAfter) + Math.max(0, next.spaceBefore);
      if (gap) y += gap;
    }
  }

  if (!stops.size) {
    stops.set(0, {
      offset: 0,
      x: originX + Math.max(0, Math.min(story.paragraph.firstLineIndent || 0, measure - 1)),
      y: inset.top + dy + m.ascent,
      height: m.leading,
    });
  }
  const caretStops = Array.from(stops.values()).sort((a, b) => a.offset - b.offset);

  return {
    glyphs,
    overflow,
    lineCount,
    heightPx: lineCount ? lastBaseline + lastDescent : 0,
    firstBaselinePx: inset.top + dy + m.ascent,
    lastDescentPx: lastDescent,
    caretStops,
  };
  };

  // Vertical justification ("justify") needs per-line gap distribution and is
  // not composed yet; like "top" it starts the block at the top inset.
  // Center/bottom shift only text that FITS — an overflowing frame aligns at
  // the top inset exactly as it would without vertical alignment, so the
  // overflow indicator and the dropped lines stay where the measure puts them.
  const va = textFrame?.verticalAlign;
  if (va === "center" || va === "bottom") {
    const topSet = compose(0);
    if (topSet.overflow) return topSet;
    const blockH = Math.max(0, topSet.heightPx - inset.top);
    const free = Math.max(0, contentH - blockH);
    const dy = va === "center" ? free / 2 : free;
    return dy > 0 ? compose(dy) : topSet;
  }
  return compose(0);
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
  const composed = composeFrame(face, story, layer.transform.w, layer.transform.h, layer.textFrame);
  if (!composed.glyphs.length) return composed;

  // One paint per distinct fill: a uniform story paints exactly as it did
  // before ranges existed, a styled story switches colour between spans
  // without touching glyph geometry.
  const paints = new Map<string, Paint>();
  const paintFor = (f: Rgba): Paint => {
    const key = `${f.r},${f.g},${f.b},${f.a * layer.opacity}`;
    let p = paints.get(key);
    if (!p) {
      p = new ck.Paint();
      p.setAntiAlias(true);
      p.setStyle(ck.PaintStyle.Fill);
      p.setColor(ck.Color4f(f.r, f.g, f.b, f.a * layer.opacity));
      paints.set(key, p);
    }
    return p;
  };

  for (const g of composed.glyphs) {
    const path = skiaPath(ck, g.face, g.gid, g.path);
    if (!path) continue;
    const paint = paintFor(g.fill);
    canvas.save();
    canvas.translate(g.x, g.y);
    // Font units are y-up from the baseline; the page is y-down.
    canvas.scale(g.scale, -g.scale);
    canvas.drawPath(path, paint);
    canvas.restore();
  }
  for (const p of paints.values()) p.delete();
  return composed;
}

/* ------------------------------------------------------------------ *
 * Auto-size measurement (read-only)
 * ------------------------------------------------------------------ */

export interface AutoFitMeasure {
  /** Frame width in px. "height" auto-size never changes the measure. */
  w: number;
  /** Frame height in px that fits the composed story, insets included. */
  h: number;
}

/**
 * How big the frame should be so its story fits without overflow. Only
 * `autoSize: "height"` is measured: the measure (width) is kept and the foot
 * lands on the last descender plus the bottom inset; an empty frame still gets
 * one line box. Any other autoSize mode ("none", "width", "both") returns null
 * — point-type composition without a measure is a different breaker mode and
 * is deliberately not approximated here.
 *
 * Measurement is read-only on purpose: applying it mutates layer geometry,
 * which is document state and therefore belongs to a reversible bus command.
 * That command cannot live in this leased file (the commands registry is
 * `src/document/ui-commands.ts`); the exact command spec the registry still
 * needs is recorded in `docs/agents/deliveries/VIRO-0143.json`.
 */
export function measureAutoFit(face: FacePack, story: Story, layer: TypeFrameLayer): AutoFitMeasure | null {
  const tf = layer.textFrame;
  if (tf?.autoSize !== "height") return null;
  const inset = insetsOf(tf);
  // Measure against an UNBOUNDED foot with vertical alignment neutralized: a
  // frame that is currently too small drops its trailing lines before the
  // measurement can see them, and center/bottom placement only means anything
  // once the content already fits. The insets still shrink the measure, so the
  // line breaking is exactly what the fitted frame will show.
  const measuring: TextFrameProperties = { ...tf, verticalAlign: "top" };
  const composed = composeFrame(face, story, layer.transform.w, Number.MAX_VALUE / 16, measuring);
  const contentH = composed.lineCount
    ? composed.heightPx
    : composed.firstBaselinePx + composed.lastDescentPx;
  return { w: layer.transform.w, h: contentH + inset.bottom };
}
