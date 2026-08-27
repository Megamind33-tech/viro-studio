import type { Canvas, CanvasKit, Font, Image as SkImage, Paint, PathEffect, Surface, Typeface } from "canvaskit-wasm";
import type {
  AdjustmentLayer,
  DropShadowEffect,
  GradientFill,
  GradientOverlayEffect,
  InnerShadowEffect,
  Layer,
  LayerEffect,
  LongShadowEffect,
  OuterGlowEffect,
  Page,
  PressDocument,
  ResampleAlgo,
  Rgba,
  StrokeCap,
  StrokeEffect,
  StrokeJoin,
  ToolId,
  Transform,
  VectorFill,
  VectorLayer,
  ViewState,
} from "../document/types";
import { SKIA_BLEND } from "../document/types";
import { isGradientFill } from "../document/paint";
import { applyPt, localMatrix } from "../document/transform";
import { destWindow, sourceWindow } from "../document/image-fit";
import { activePage } from "../document/factory";
import { composeFrame, drawTypeFrame, nearestCaretOffset, type CaretStop, type FacePack } from "./type";
import type { FontRegistry } from "./font-registry";
import { longShadowSteps } from "./long-shadow";

/** The layer's enabled drop shadow, if any. */
function dropShadowOf(layer: Layer): DropShadowEffect | null {
  const fx = layer.effects;
  if (!fx) return null;
  for (const e of fx) if (e.type === "drop-shadow" && e.enabled) return e;
  return null;
}

/** The layer's enabled gradient overlay, if any. */
function gradientOverlayOf(layer: Layer): GradientOverlayEffect | null {
  const fx = layer.effects;
  if (!fx) return null;
  for (const e of fx) if (e.type === "gradient-overlay" && e.enabled && e.stops.length >= 2) return e;
  return null;
}

/** The layer's enabled stroke/outline effect, if any. */
function strokeEffectOf(layer: Layer): StrokeEffect | null {
  const fx = layer.effects;
  if (!fx) return null;
  for (const e of fx) if (e.type === "stroke" && e.enabled && e.width > 0) return e;
  return null;
}

/** Map a document stroke cap to its CanvasKit enum. Default is butt. */
function strokeCap(ck: CanvasKit, cap: StrokeCap) {
  if (cap === "round") return ck.StrokeCap.Round;
  if (cap === "square") return ck.StrokeCap.Square;
  return ck.StrokeCap.Butt;
}

/** Map a document stroke join to its CanvasKit enum. Default is miter. */
function strokeJoin(ck: CanvasKit, join: StrokeJoin) {
  if (join === "round") return ck.StrokeJoin.Round;
  if (join === "bevel") return ck.StrokeJoin.Bevel;
  return ck.StrokeJoin.Miter;
}

/** The layer's enabled outer glow, if any. */
function outerGlowOf(layer: Layer): OuterGlowEffect | null {
  const fx = layer.effects;
  if (!fx) return null;
  for (const e of fx) if (e.type === "outer-glow" && e.enabled && e.blur >= 0) return e;
  return null;
}

function innerShadowOf(layer: Layer): InnerShadowEffect | null {
  const fx = layer.effects;
  if (!fx) return null;
  for (const e of fx) if (e.type === "inner-shadow" && e.enabled) return e;
  return null;
}

function longShadowOf(layer: Layer): LongShadowEffect | null {
  const fx = layer.effects;
  if (!fx) return null;
  for (const e of fx) if (e.type === "long-shadow" && e.enabled && e.length > 0) return e;
  return null;
}

/** Everything that alters how a layer draws, folded into its render hash. */
function hashEffect(h: number, e: LayerEffect): number {
  h = hashStr(h, e.type);
  h = mixHash(h, e.enabled ? 1 : 2);
  switch (e.type) {
    case "drop-shadow":
      h = hashRgba(h, e.color);
      h = hashNum(hashNum(hashNum(hashNum(h, e.offsetX), e.offsetY), e.blur), e.opacity);
      break;
    case "gradient-overlay":
      h = hashNum(hashNum(h, e.angle), e.opacity);
      for (const s of e.stops) h = hashRgba(hashNum(h, s.offset), s.color);
      break;
    case "stroke":
      h = hashRgba(h, e.color);
      h = hashNum(hashNum(h, e.width), e.opacity);
      break;
    case "outer-glow":
      h = hashRgba(h, e.color);
      h = hashNum(hashNum(h, e.blur), e.opacity);
      break;
    case "inner-shadow":
      h = hashRgba(h, e.color);
      h = hashNum(hashNum(hashNum(hashNum(h, e.offsetX), e.offsetY), e.blur), e.opacity);
      break;
    case "long-shadow":
      h = hashRgba(h, e.color);
      h = hashNum(hashNum(hashNum(h, e.angle), e.length), e.opacity);
      break;
  }
  return h;
}

/** Ruler band thickness in CSS px. Chrome imports this for its own hit maths. */
export const RULER = 18;

/** 5% … 3200%, Photoshop's range. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 32;

/** Ruler units. `PressDocument` carries no unit field yet, so the default is px. */
export type RulerUnit = "px" | "mm" | "in";

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate" | "move";

export interface ViewSnapshot {
  zoom: number;
  panX: number;
  panY: number;
  unit: RulerUnit;
}

export interface Engines {
  ck: CanvasKit;
  backend: "webgl" | "skia-cpu";
  face: FacePack | null;
  fonts?: FontRegistry;
}

/** Desk tokens (DESK-CHROME.md). Copper is reserved for the active tool and selection. */
const TOKEN = {
  pasteboard: 0x1f1f1f,
  rulerFace: 0x2b2b2b,
  rulerCorner: 0x323232,
  hair: 0x141414,
  tickMajor: 0x9a9a9a,
  tickHalf: 0x7e7e7e,
  tickMinor: 0x616161,
  label: 0xb4b4b4,
  labelZero: 0xe8e8e8,
  /** Live cursor rule on both rulers. Neutral — never copper. */
  cursorTick: 0xdcdcdc,
  accent: 0xe07a2f,
  pageEdge: 0x0b0b0b,
  guide: 0x35a9bc,
  margin: 0xc0498a,
  column: 0x8e76c8,
  bleed: 0xb4453a,
  slug: 0x4b8ad6,
  checkLight: 0xffffff,
  checkDark: 0xcbcbcb,
} as const;

/**
 * Guide opacity. InDesign guides are printing-plate reference, not artwork: thin,
 * one device pixel, and quiet enough that the layout stays the loudest thing on the
 * page. Bleed stays warm red and margin stays magenta so the two never read alike.
 */
const ALPHA = {
  guide: 0.75,
  margin: 0.55,
  column: 0.45,
  bleedLine: 0.85,
  bleedTint: 0.045,
  slugLine: 0.7,
  slugTint: 0.035,
  pageEdge: 0.6,
} as const;

/** Handle box side in CSS px. Odd so it centres on a device pixel at dpr 1. */
const HANDLE = 7;
/** Extra CSS px outside a corner handle that reads as the rotate zone (Photoshop). */
const ROTATE_BAND = 14;
/** Transparency checker square in CSS px. Fixed on screen — it does not scale with zoom. */
const CHECKER = 8;
/** Minimum CSS px between two numbered ruler ticks. Labels never collide. */
const LABEL_GAP = 58;

/**
 * Longest edge, in real pixels, that a panel thumbnail is ever rendered at. The Layers and
 * Pages panels ask in CSS px times device ratio; this is the ceiling, so a 300-ppi A3 spread
 * costs the same scratch surface as a business card and the wasm heap never sees a big
 * allocation on a repaint path.
 */
const THUMB_MAX_PX = 64;
/** Thumbnails kept as encoded data URLs. 64px PNGs — a full cache is well under a megabyte. */
const THUMB_CACHE_MAX = 512;
/**
 * Fresh thumbnails one panel pass may render. Cache hits are free and unlimited; only misses
 * draw. A 200-layer document therefore costs eight small surfaces on the frame it opens, not
 * two hundred, and the rest arrive over the following frames.
 */
const THUMB_PASS_BUDGET = 8;
/**
 * How long a pass holds its budget before refilling, in ms. A panel repaint is one burst of
 * calls inside a single frame, so a frame-sized window is what separates "this pass" from the
 * next one without chrome having to announce either.
 */
const THUMB_PASS_MS = 16;
/** Group nesting a thumbnail will walk. Guards a malformed parent chain from recursing forever. */
const THUMB_MAX_DEPTH = 16;

/** Scratch for hashing a float by its bits — no string allocation on the per-repaint path. */
const HASH_F64 = new Float64Array(1);
const HASH_I32 = new Int32Array(HASH_F64.buffer);
/** FNV-1a offset basis. */
const HASH_SEED = 2166136261;

function mixHash(h: number, v: number): number {
  return Math.imul(h ^ v, 16777619) >>> 0;
}

function hashNum(h: number, n: number): number {
  HASH_F64[0] = n;
  return mixHash(mixHash(h, HASH_I32[0]!), HASH_I32[1]!);
}

function hashStr(h: number, s: string): number {
  let x = h;
  for (let i = 0; i < s.length; i++) x = mixHash(x, s.charCodeAt(i));
  return mixHash(x, s.length);
}

function hashRgba(h: number, c: Rgba | null): number {
  if (!c) return mixHash(h, 0x9e37);
  return hashNum(hashNum(hashNum(hashNum(h, c.r), c.g), c.b), c.a);
}

function hashFill(h: number, fill: VectorFill | null): number {
  if (!fill) return mixHash(h, 0x9e37);
  if (isGradientFill(fill)) {
    h = mixHash(h, fill.type === "linear" ? 0x11ea : 0x11eb);
    h = hashNum(h, fill.angle);
    for (const s of fill.stops) {
      h = hashNum(h, s.offset);
      h = hashRgba(h, s.color);
    }
    return h;
  }
  return hashRgba(h, fill);
}

function rgb(ck: CanvasKit, hex: number, a = 1): Float32Array {
  return ck.Color4f(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, a);
}

function color(ck: CanvasKit, c: Rgba, a = c.a) {
  return ck.Color4f(c.r, c.g, c.b, a);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function pngDataUrl(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `data:image/png;base64,${btoa(bin)}`;
}

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const i = dataUrl.indexOf(",");
  if (i < 0) return null;
  const bin = atob(dataUrl.slice(i + 1));
  const out = new Uint8Array(bin.length);
  for (let n = 0; n < bin.length; n++) out[n] = bin.charCodeAt(n);
  return out;
}

/**
 * Contrast pivots about mid-grey, then brightness offsets: `out = f·in + (1 − f)/2 + brightness`.
 *
 * The translate column of a Skia colour matrix is in 0-1 units, the same scale as the channels
 * it is added to — not 0-255. Building the offset in 8-bit units put it a factor of 255 out, so
 * any adjustment at all drove every channel past the clamp and the layer beneath went solid
 * black. Verified against `ColorFilter.MakeMatrix` directly: a pure -0.25 translate takes opaque
 * white to 191, while -64 saturates to 0.
 */
function brightnessContrastMatrix(brightness: number, contrast: number): number[] {
  const f = contrast;
  const t = (1 - f) * 0.5 + brightness;
  return [f, 0, 0, 0, t, 0, f, 0, 0, t, 0, 0, f, 0, t, 0, 0, 0, 1, 0];
}

/** Trailing-zero-free decimal, for ruler labels. */
function tickLabel(v: number): string {
  const n = Math.abs(v) < 1e-9 ? 0 : v;
  if (Number.isInteger(n)) return String(n);
  return n
    .toFixed(5)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

/** Decimal 1-2-5 ladder, plus a binary ladder for inches. */
function ladderFor(unit: RulerUnit): number[] {
  if (unit === "in") {
    const out: number[] = [];
    for (let e = -5; e <= 10; e++) out.push(2 ** e);
    return out;
  }
  const out: number[] = [];
  for (let e = -2; e <= 7; e++) {
    const p = 10 ** e;
    out.push(1 * p, 2 * p, 5 * p);
  }
  return out;
}

interface TickPlan {
  /** Labelled step, in ruler units. */
  major: number;
  /** Smallest drawn step, in ruler units. */
  step: number;
  /** step multiples that land on a half / major tick. 0 = that level has no room. */
  halfEvery: number;
  majorEvery: number;
}

function planTicks(unit: RulerUnit, cssPerUnit: number): TickPlan | null {
  if (!(cssPerUnit > 0) || !Number.isFinite(cssPerUnit)) return null;
  const ladder = ladderFor(unit);
  let major = ladder[ladder.length - 1]!;
  for (const s of ladder) {
    if (s * cssPerUnit >= LABEL_GAP) {
      major = s;
      break;
    }
  }
  const div = unit === "in" ? 8 : mantissaDiv(major);
  const minor = major / div;
  const half = major / 2;
  let step = minor;
  let majorEvery = div;
  let halfEvery = div / 2;
  if (minor * cssPerUnit < 4) {
    if (half * cssPerUnit >= 4) {
      step = half;
      majorEvery = 2;
      halfEvery = 1;
    } else {
      step = major;
      majorEvery = 1;
      halfEvery = 0;
    }
  }
  if (!Number.isInteger(halfEvery) || halfEvery < 1) halfEvery = 0;
  return { major, step, halfEvery, majorEvery };
}

/**
 * 1 → tenths, 2 → quarters, 5 → tenths. Keeps every tick on a round number, and —
 * because the count is always even — always leaves a midpoint for the half tick.
 * A 5-mantissa major divided into fifths has no midpoint, which silently collapsed
 * the ruler to two tick levels at every 500/50/5 step.
 */
function mantissaDiv(major: number): number {
  const e = Math.floor(Math.log10(major) + 1e-9);
  const m = Math.round(major / 10 ** e);
  if (m === 2) return 4;
  return 10;
}

interface Geom {
  dpr: number;
  /** CSS px */
  viewW: number;
  viewH: number;
  /** backing-store size in device px — the exact right and bottom edges */
  devW: number;
  devH: number;
  ruler: number;
  contentW: number;
  contentH: number;
  zoom: number;
  pageW: number;
  pageH: number;
  originX: number;
  originY: number;
  /** hairline thickness in device px (1 CSS px, snapped) */
  hair: number;
  /** doc x → device x, snapped to the device pixel grid */
  dx(docX: number): number;
  dy(docY: number): number;
  /** CSS x → device x, snapped */
  sx(cssX: number): number;
  sy(cssY: number): number;
}

/**
 * The live view. `zoom`, `panX` and `panY` are accessors onto the compositor, so the
 * compositor is the single source of truth: every write is clamped, re-centred and
 * announced through `onViewChange`, wherever it came from.
 */
class PressView implements ViewState {
  showRulers = true;
  showBleed = true;
  showGuides = true;
  tool: ToolId = "move";
  fg: Rgba = { r: 0.12, g: 0.12, b: 0.12, a: 1 };
  bg: Rgba = { r: 1, g: 1, b: 1, a: 1 };
  marquee: { x: number; y: number; w: number; h: number } | null = null;
  /**
   * Live feedback for a shape tool mid-drag, in page px. Painted as a plain
   * copper outline so the user sees the geometry before it is committed —
   * without this a shape drag gives no feedback at all until pointerup.
   */
  shapePreview: {
    kind: "rect" | "ellipse" | "line" | "roundrect" | "polygon" | "star" | "frame";
    x: number;
    y: number;
    w: number;
    h: number;
    radius?: number;
    sides?: number;
    points?: number;
  } | null = null;
  textEdit: { layerId: string; anchor: number; focus: number } | null = null;
  smartGuides: { xs: Float64Array; xn: number; ys: Float64Array; yn: number } | null = null;

  constructor(private readonly owner: Compositor) {}

  get zoom(): number {
    return this.owner.zoom;
  }
  set zoom(v: number) {
    this.owner.setZoom(v);
  }
  get panX(): number {
    return this.owner.panX;
  }
  set panX(v: number) {
    this.owner.setPanX(v);
  }
  get panY(): number {
    return this.owner.panY;
  }
  set panY(v: number) {
    this.owner.setPanY(v);
  }
}

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  readonly view: ViewState;
  private surface: Surface | null = null;
  private images = new Map<string, SkImage>();

  private zoomValue = 0.35;
  private rawPanX = 0;
  private rawPanY = 0;
  private pageW = 0;
  private pageH = 0;
  private cssW = 1;
  private cssH = 1;
  private ppi = 72;
  private unit: RulerUnit = "px";
  private needsInitialFit = true;

  private watchers = new Set<(v: ViewSnapshot) => void>();
  private notifying = false;

  private typefaceTried = false;
  private typeface: Typeface | null = null;
  private font: Font | null = null;
  private fontPx = 0;
  private checker: SkImage | null = null;
  private checkerPx = 0;

  /** Cursor in canvas CSS coordinates, for the live ruler rule. Null = pointer is away. */
  private pointer: { x: number; y: number } | null = null;
  private lastDoc: PressDocument | null = null;
  private raf = 0;
  /** Set only while repainting for a pointer move: reuse the last page composite. */
  private reuseComposite = false;
  private pageCache: SkImage | null = null;
  /**
   * One persistent surface for the page composite, rebuilt only when the page
   * size changes.
   *
   * A fresh `MakeSurface` per composite allocates the whole page — 2480×3508
   * RGBA is ~35 MB — and an interactive drag re-composites every frame. That
   * churn exhausts the WASM heap and CanvasKit dies with `Aborted()`, taking
   * the edit in progress with it. Reusing the surface makes a drag allocation-
   * free. `makeImageSnapshot` is copy-on-write, so the snapshot handed out
   * stays valid once we draw into the surface again.
   */
  private pageSurf: Surface | null = null;
  private pageSurfW = 0;
  private pageSurfH = 0;

  /** Panel thumbnails: `kind:id:px` → the last encoding and the content hash it came from. */
  private thumbs = new Map<string, { hash: number; url: string }>();
  /** One scratch surface, reused across a pass. The thumbnails are tiny; the churn is not. */
  private thumbSurf: Surface | null = null;
  private thumbSurfW = 0;
  private thumbSurfH = 0;
  private thumbBudget = 0;
  private thumbDeferred = false;
  /** Start of the current thumbnail pass, on the performance clock. */
  private thumbPassAt = -Infinity;
  /** Story text hashes, so a document of 200 frames does not rehash every story per repaint. */
  private storyHashes = new Map<string, { text: string; hash: number }>();
  /** Bumped by `invalidateAsset`. Folded into the hash of any layer that draws that asset. */
  private assetEpoch = 0;

  constructor(
    public engines: Engines,
    canvas: HTMLCanvasElement,
  ) {
    this.canvas = canvas;
    this.cssW = Math.max(1, canvas.clientWidth);
    this.cssH = Math.max(1, canvas.clientHeight);
    this.view = new PressView(this);
    // The rulers carry a live cursor rule, so the compositor tracks the pointer itself
    // rather than asking chrome to push it in. Repaints are rAF-coalesced and reuse the
    // cached page composite, so hovering costs an overlay pass, not a re-render.
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerAway);
    canvas.addEventListener("pointercancel", this.onPointerAway);
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.cssW > 0 ? this.canvas.width / this.cssW : 1;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const prev = this.pointer;
    if (
      prev &&
      Math.round(prev.x * dpr) === Math.round(x * dpr) &&
      Math.round(prev.y * dpr) === Math.round(y * dpr)
    ) {
      return;
    }
    this.pointer = { x, y };
    this.scheduleOverlayRepaint();
  };

  private readonly onPointerAway = (): void => {
    if (!this.pointer) return;
    this.pointer = null;
    this.scheduleOverlayRepaint();
  };

  private scheduleOverlayRepaint(): void {
    // The pointer is tracked even with the rulers hidden, so switching them back on
    // shows the rule in the right place — but there is nothing to repaint for until then.
    if (!this.view.showRulers) return;
    this.requestOverlayRepaint();
  }

  /**
   * Repaint the overlay only, reusing the last page composite.
   *
   * For anything that moves without changing the document — a shape-tool drag,
   * a marquee, the ruler pointer rule — this is the path to use. Calling the
   * app's full `emit()` instead re-composites the whole page on every pointer
   * move, unthrottled; at 2480×3508 that allocates a fresh Skia surface per
   * event and exhausts the WASM heap, which surfaces as `Aborted()`.
   */
  requestOverlayRepaint(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const doc = this.lastDoc;
      if (!doc) return;
      this.reuseComposite = true;
      try {
        this.draw(doc);
      } finally {
        this.reuseComposite = false;
      }
    });
  }

  private dropPageCache(): void {
    this.pageCache?.delete();
    this.pageCache = null;
  }

  resize(cssW: number, cssH: number): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.max(1, Math.floor(this.cssW * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.cssH * dpr));
    this.dropPageCache();
    this.surface?.delete();
    const gpu = this.engines.ck.MakeWebGLCanvasSurface(this.canvas);
    if (gpu) {
      this.surface = gpu;
      this.engines.backend = "webgl";
    } else {
      const sw = this.engines.ck.MakeSWCanvasSurface(this.canvas);
      if (!sw) throw new Error("CanvasKit could not create a Skia surface");
      this.surface = sw;
      this.engines.backend = "skia-cpu";
    }
    // Pan is derived, so the page re-centres itself on the new viewport.
    this.notify();
  }

  // ── view: single source of truth ────────────────────────────────────────────

  /** Current zoom as a scale factor. 1 = 100%. */
  get zoom(): number {
    return this.zoomValue;
  }

  /** Photoshop-style label: "100%", "33.33%", "12.5%". */
  get zoomLabel(): string {
    const pct = this.zoomValue * 100;
    const rounded = Math.round(pct * 100) / 100;
    return `${Number.isInteger(rounded) ? rounded : Number(rounded.toFixed(2))}%`;
  }

  /**
   * Page origin offset from the ruler corner, in CSS px. Derived, never stored raw:
   * a page smaller than the viewport is pinned to the centre on that axis, and a larger
   * one may be scrolled until its edge reaches the middle of the viewport.
   */
  get panX(): number {
    return this.clampPan(this.rawPanX, this.contentW, this.pageW * this.zoomValue);
  }

  get panY(): number {
    return this.clampPan(this.rawPanY, this.contentH, this.pageH * this.zoomValue);
  }

  private get rulerSize(): number {
    return this.view.showRulers ? RULER : 0;
  }

  private get contentW(): number {
    return Math.max(1, this.cssW - this.rulerSize);
  }

  private get contentH(): number {
    return Math.max(1, this.cssH - this.rulerSize);
  }

  private clampPan(raw: number, content: number, span: number): number {
    if (!(span > 0)) return (content - span) / 2;
    if (span <= content) return (content - span) / 2;
    return clamp(raw, content / 2 - span, content / 2);
  }

  setPanX(v: number): void {
    if (!Number.isFinite(v)) return;
    const before = this.panX;
    this.rawPanX = v;
    if (this.panX !== before) this.notify();
  }

  setPanY(v: number): void {
    if (!Number.isFinite(v)) return;
    const before = this.panY;
    this.rawPanY = v;
    if (this.panY !== before) this.notify();
  }

  /**
   * Set zoom, holding one point still. Without an anchor the centre of the viewport is
   * held, which is what the menu, the Navigator slider and the status dropdown want.
   */
  setZoom(next: number, anchorCssX?: number, anchorCssY?: number): void {
    if (!Number.isFinite(next)) return;
    const z = clamp(next, ZOOM_MIN, ZOOM_MAX);
    this.needsInitialFit = false;
    const prev = this.zoomValue;
    if (z === prev) return;
    const r = this.rulerSize;
    const ax = anchorCssX ?? r + this.contentW / 2;
    const ay = anchorCssY ?? r + this.contentH / 2;
    const docX = (ax - r - this.panX) / prev;
    const docY = (ay - r - this.panY) / prev;
    this.zoomValue = z;
    this.rawPanX = ax - r - docX * z;
    this.rawPanY = ay - r - docY * z;
    this.notify();
  }

  /** Multiply the zoom, optionally about a point in canvas CSS coordinates. */
  zoomBy(factor: number, anchorCssX?: number, anchorCssY?: number): void {
    this.setZoom(this.zoomValue * factor, anchorCssX, anchorCssY);
  }

  /** Fit the page in the viewport and centre it. Pass the document to refresh page size. */
  fitToView(doc?: PressDocument): void {
    if (doc) {
      const page = activePage(doc);
      this.pageW = page.widthPx;
      this.pageH = page.heightPx;
      this.ppi = doc.ppi;
    }
    if (!(this.pageW > 0) || !(this.pageH > 0)) return;
    const pad = 24;
    const w = Math.max(1, this.contentW - pad * 2);
    const h = Math.max(1, this.contentH - pad * 2);
    this.zoomValue = clamp(Math.min(w / this.pageW, h / this.pageH), ZOOM_MIN, ZOOM_MAX);
    this.rawPanX = 0;
    this.rawPanY = 0;
    this.needsInitialFit = false;
    this.notify();
  }

  /** Centre the page without changing zoom. */
  centre(): void {
    this.rawPanX = 0;
    this.rawPanY = 0;
    this.notify();
  }

  /** Ruler unit. Defaults to px — `PressDocument` has no unit field to follow yet. */
  get rulerUnit(): RulerUnit {
    return this.unit;
  }

  setRulerUnit(u: RulerUnit): void {
    if (u === this.unit) return;
    this.unit = u;
    this.notify();
  }

  /** Subscribe to zoom/pan/unit changes. Returns an unsubscribe. */
  onViewChange(fn: (v: ViewSnapshot) => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  private notify(): void {
    if (this.notifying || this.watchers.size === 0) return;
    this.notifying = true;
    const snap: ViewSnapshot = { zoom: this.zoomValue, panX: this.panX, panY: this.panY, unit: this.unit };
    try {
      for (const fn of this.watchers) fn(snap);
    } finally {
      this.notifying = false;
    }
  }

  screenToPage(sx: number, sy: number): { x: number; y: number } {
    const r = this.rulerSize;
    return {
      x: (sx - r - this.panX) / this.zoomValue,
      y: (sy - r - this.panY) / this.zoomValue,
    };
  }

  /** Sample the composited page at a page-space point. Used by the eyedropper. */
  samplePageColor(pageX: number, pageY: number): Rgba | null {
    const ck = this.engines.ck;
    const img = this.pageCache;
    if (!img) return null;
    const x = Math.max(0, Math.min(img.width() - 1, Math.floor(pageX)));
    const y = Math.max(0, Math.min(img.height() - 1, Math.floor(pageY)));
    const pixels = img.readPixels(x, y, {
      width: 1,
      height: 1,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    }) as Uint8Array | Float32Array | null;
    if (!pixels || pixels.length < 4) return null;
    return { r: pixels[0]! / 255, g: pixels[1]! / 255, b: pixels[2]! / 255, a: pixels[3]! / 255 };
  }

  pageToScreen(x: number, y: number): { x: number; y: number } {
    const r = this.rulerSize;
    return { x: r + this.panX + x * this.zoomValue, y: r + this.panY + y * this.zoomValue };
  }

  faceFor(fontId: string | undefined): FacePack | null {
    return this.engines.fonts?.resolve(fontId) ?? this.engines.face;
  }

  typeLayout(doc: PressDocument, layerId: string): { stops: CaretStop[]; firstBaselinePx: number } | null {
    const page = activePage(doc);
    const layer = page.layers.find((l) => l.id === layerId);
    if (!layer || layer.kind !== "type-frame") return null;
    const story = doc.stories.find((s) => s.id === layer.storyId);
    if (!story) return null;
    const face = this.faceFor(story.character.fontId);
    if (!face) return null;
    const composed = composeFrame(face, story, layer.transform.w, layer.transform.h);
    return { stops: composed.caretStops, firstBaselinePx: composed.firstBaselinePx };
  }

  hitTypeOffset(doc: PressDocument, layerId: string, pageX: number, pageY: number): number | null {
    const page = activePage(doc);
    const layer = page.layers.find((l) => l.id === layerId);
    if (!layer || layer.kind !== "type-frame") return null;
    const layout = this.typeLayout(doc, layerId);
    if (!layout?.stops.length) return 0;
    const t = layer.transform;
    return nearestCaretOffset(layout.stops, pageX - t.x, pageY - t.y);
  }

  // ── selection geometry ──────────────────────────────────────────────────────

  /**
   * The frame the transform handles sit on: one layer keeps its rotation, several
   * collapse to the axis-aligned union, as in Photoshop.
   */
  selectionFrame(doc: PressDocument): { x: number; y: number; w: number; h: number; rotation: number } | null {
    const page = activePage(doc);
    const picked = page.layers.filter((l) => doc.activeLayerIds.includes(l.id));
    if (picked.length === 0) return null;
    if (picked.length === 1) {
      const t = picked[0]!.transform;
      return { x: t.x, y: t.y, w: t.w, h: t.h, rotation: t.rotation };
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const l of picked) {
      for (const p of quadOf(l.transform)) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
    if (!Number.isFinite(x0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rotation: 0 };
  }

  /**
   * Which transform handle is under a canvas point, in CSS coordinates.
   * Pure geometry — chrome owns the drag that would act on it.
   */
  hitHandle(doc: PressDocument, cssX: number, cssY: number): HandleId | null {
    const frame = this.selectionFrame(doc);
    if (!frame) return null;
    const p = this.screenToPage(cssX, cssY);
    const cx = frame.x + frame.w / 2;
    const cy = frame.y + frame.h / 2;
    const rad = (-frame.rotation * Math.PI) / 180;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const lx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    const tol = (HANDLE / 2 + 2) / this.zoomValue;
    const band = ROTATE_BAND / this.zoomValue;
    const left = frame.x;
    const right = frame.x + frame.w;
    const top = frame.y;
    const bottom = frame.y + frame.h;
    const onLeft = Math.abs(lx - left) <= tol;
    const onRight = Math.abs(lx - right) <= tol;
    const onTop = Math.abs(ly - top) <= tol;
    const onBottom = Math.abs(ly - bottom) <= tol;
    const midX = Math.abs(lx - (left + right) / 2) <= tol;
    const midY = Math.abs(ly - (top + bottom) / 2) <= tol;
    if (onLeft && onTop) return "nw";
    if (onRight && onTop) return "ne";
    if (onRight && onBottom) return "se";
    if (onLeft && onBottom) return "sw";
    if (onTop && midX) return "n";
    if (onBottom && midX) return "s";
    if (onLeft && midY) return "w";
    if (onRight && midY) return "e";
    const outX = lx < left ? left - lx : lx > right ? lx - right : 0;
    const outY = ly < top ? top - ly : ly > bottom ? ly - bottom : 0;
    if (outX > 0 && outY > 0 && outX <= band && outY <= band) return "rotate";
    if (lx >= left && lx <= right && ly >= top && ly <= bottom) return "move";
    return null;
  }

  /**
   * Which ruler the pointer is over, in canvas CSS px. Origin is the square
   * where the two rulers meet. Null when rulers are hidden or the pointer is
   * on the pasteboard.
   */
  hitRuler(cssX: number, cssY: number): "h" | "v" | "origin" | null {
    if (!this.view.showRulers) return null;
    const r = this.rulerSize;
    if (cssX < r && cssY < r) return "origin";
    if (cssY < r) return "h";
    if (cssX < r) return "v";
    return null;
  }

  /**
   * Nearest page guide under the pointer, within 5 CSS px. Null when guides
   * are hidden or the pointer is on a ruler.
   */
  hitGuide(doc: PressDocument, cssX: number, cssY: number): { id: string; axis: "h" | "v"; offset: number } | null {
    if (!this.view.showGuides) return null;
    if (this.hitRuler(cssX, cssY)) return null;
    const page = activePage(doc);
    const p = this.screenToPage(cssX, cssY);
    const tol = 5 / this.zoomValue;
    let best: { id: string; axis: "h" | "v"; offset: number } | null = null;
    let bestD = tol;
    for (const g of page.guides) {
      const d = g.axis === "v" ? Math.abs(p.x - g.offset) : Math.abs(p.y - g.offset);
      if (d <= bestD) {
        best = g;
        bestD = d;
      }
    }
    return best;
  }

  invalidateAsset(id: string): void {
    const img = this.images.get(id);
    img?.delete();
    this.images.delete(id);
    this.dropPageCache();
    // Resampling replaces the bytes behind an id the document already holds, so nothing in a
    // layer's own fields changes. Bump the epoch and every thumbnail that draws an asset
    // re-hashes, which is what stops a Panel showing the picture at its old resolution.
    this.assetEpoch++;
  }

  // ── paint ───────────────────────────────────────────────────────────────────

  draw(doc: PressDocument): void {
    const ck = this.engines.ck;
    const surface = this.surface;
    if (!surface) return;
    const page = activePage(doc);
    if (!page) return;
    this.lastDoc = doc;
    this.pageW = page.widthPx;
    this.pageH = page.heightPx;
    this.ppi = doc.ppi > 0 ? doc.ppi : 72;
    if (this.needsInitialFit && this.pageW > 0 && this.pageH > 0) this.fitToView();

    const sk = surface.getCanvas();
    const g = this.geom();
    sk.clear(rgb(ck, TOKEN.pasteboard, 1));

    sk.save();
    sk.clipRect(ck.LTRBRect(g.sx(g.ruler), g.sy(g.ruler), g.devW, g.devH), ck.ClipOp.Intersect, false);
    this.paintUnderlay(ck, sk, page, g);
    this.paintPage(ck, sk, doc, g);
    this.paintOverlay(ck, sk, doc, page, g);
    sk.restore();

    if (this.view.showRulers) this.paintRulers(ck, sk, g);
    surface.flush();
  }

  private geom(): Geom {
    const dpr = this.cssW > 0 ? this.canvas.width / this.cssW : Math.max(1, window.devicePixelRatio || 1);
    const ruler = this.rulerSize;
    const zoom = this.zoomValue;
    const originX = ruler + this.panX;
    const originY = ruler + this.panY;
    return {
      dpr,
      viewW: this.cssW,
      viewH: this.cssH,
      devW: this.canvas.width,
      devH: this.canvas.height,
      ruler,
      contentW: this.contentW,
      contentH: this.contentH,
      zoom,
      pageW: this.pageW,
      pageH: this.pageH,
      originX,
      originY,
      hair: Math.max(1, Math.round(dpr)),
      dx: (docX: number) => Math.round((originX + docX * zoom) * dpr),
      dy: (docY: number) => Math.round((originY + docY * zoom) * dpr),
      sx: (cssX: number) => Math.round(cssX * dpr),
      sy: (cssY: number) => Math.round(cssY * dpr),
    };
  }

  /** Page drop shadow, bleed/slug tint, transparency checkerboard. Device space. */
  private paintUnderlay(ck: CanvasKit, sk: Canvas, page: Page, g: Geom): void {
    const x0 = g.dx(0);
    const y0 = g.dy(0);
    const x1 = g.dx(page.widthPx);
    const y1 = g.dy(page.heightPx);

    // The sheet floats above the pasteboard. Shadow first, so the bleed tint washes
    // over it rather than the shadow smearing the tint into a muddy halo.
    this.pageShadow(ck, sk, x0, y0, x1, y1, g.dpr);

    if (this.view.showBleed && page.slugPx > 0) {
      const s = new ck.Paint();
      s.setColor(rgb(ck, TOKEN.slug, ALPHA.slugTint));
      const b = page.bleedPx + page.slugPx;
      sk.drawRect(ck.LTRBRect(g.dx(-b), g.dy(-b), g.dx(page.widthPx + b), g.dy(page.heightPx + b)), s);
      s.delete();
    }
    if (this.view.showBleed && page.bleedPx > 0) {
      const b = new ck.Paint();
      b.setColor(rgb(ck, TOKEN.bleed, ALPHA.bleedTint));
      sk.drawRect(
        ck.LTRBRect(
          g.dx(-page.bleedPx),
          g.dy(-page.bleedPx),
          g.dx(page.widthPx + page.bleedPx),
          g.dy(page.heightPx + page.bleedPx),
        ),
        b,
      );
      b.delete();
    }

    const checker = this.checkerImage(ck, g.dpr);
    if (checker) {
      const tile = Math.max(2, Math.round(CHECKER * g.dpr)) * 2;
      const phaseX = ((x0 % tile) + tile) % tile;
      const phaseY = ((y0 % tile) + tile) % tile;
      const shader = checker.makeShaderOptions(
        ck.TileMode.Repeat,
        ck.TileMode.Repeat,
        ck.FilterMode.Nearest,
        ck.MipmapMode.None,
        [1, 0, phaseX, 0, 1, phaseY, 0, 0, 1],
      );
      const p = new ck.Paint();
      p.setShader(shader);
      sk.drawRect(ck.LTRBRect(x0, y0, x1, y1), p);
      p.delete();
      shader.delete();
    }
  }

  /**
   * Two passes, both straight down, no sideways offset — Photoshop's canvas shadow.
   * A wide ambient pass gives the lift; a tight contact pass seats the sheet on the
   * pasteboard. Kept small on purpose: a large blur reads as a glow, which is worse
   * than no shadow at all.
   */
  private pageShadow(ck: CanvasKit, sk: Canvas, x0: number, y0: number, x1: number, y1: number, dpr: number): void {
    if (!(x1 > x0) || !(y1 > y0)) return;
    const pass = (alpha: number, sigmaCss: number, dropCss: number, spreadCss: number) => {
      const paint = new ck.Paint();
      paint.setColor(ck.Color4f(0, 0, 0, alpha));
      paint.setAntiAlias(true);
      const blur = ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, sigmaCss * dpr, false);
      paint.setMaskFilter(blur);
      const drop = Math.round(dropCss * dpr);
      const s = Math.round(spreadCss * dpr);
      sk.drawRect(ck.LTRBRect(x0 - s, y0 + drop - s, x1 + s, y1 + drop + s), paint);
      blur.delete();
      paint.delete();
    };
    // The pasteboard is already #1F1F1F, so a timid alpha simply disappears: the sheet
    // has to reach near-black at the contact for the lift to read at all. The spread
    // carries full density just past the trim before the blur takes over, so the sheet
    // sits *on* the pasteboard instead of hovering over a grey smudge. Reach stays
    // short — under ~8 CSS px — so it is a shadow, not a halo.
    pass(0.45, 5, 3, 1);
    pass(0.6, 1.5, 1, 1);
  }

  private checkerImage(ck: CanvasKit, dpr: number): SkImage | null {
    const s = Math.max(2, Math.round(CHECKER * dpr));
    if (this.checker && this.checkerPx === s) return this.checker;
    this.checker?.delete();
    this.checker = null;
    const surf = ck.MakeSurface(s * 2, s * 2);
    if (!surf) return null;
    const c = surf.getCanvas();
    const light = new ck.Paint();
    light.setColor(rgb(ck, TOKEN.checkLight, 1));
    const dark = new ck.Paint();
    dark.setColor(rgb(ck, TOKEN.checkDark, 1));
    c.drawRect(ck.LTRBRect(0, 0, s * 2, s * 2), light);
    c.drawRect(ck.LTRBRect(s, 0, s * 2, s), dark);
    c.drawRect(ck.LTRBRect(0, s, s, s * 2), dark);
    light.delete();
    dark.delete();
    this.checker = surf.makeImageSnapshot();
    this.checkerPx = s;
    surf.delete();
    return this.checker;
  }

  /**
   * The page composite for this frame. A pointer-move repaint reuses the last one —
   * every other caller re-renders, so an overlay-only pass can never show stale art.
   */
  private pageImage(ck: CanvasKit, doc: PressDocument): SkImage | null {
    if (this.reuseComposite && this.pageCache) return this.pageCache;
    const next = this.compositePage(ck, doc, false);
    if (!next) return this.pageCache;
    this.pageCache?.delete();
    this.pageCache = next;
    return next;
  }

  /** The composited page, blitted into a device-pixel-snapped rect. */
  private paintPage(ck: CanvasKit, sk: Canvas, doc: PressDocument, g: Geom): void {
    const img = this.pageImage(ck, doc);
    if (!img) return;
    const dst = ck.LTRBRect(g.dx(0), g.dy(0), g.dx(g.pageW), g.dy(g.pageH));
    const src = ck.LTRBRect(0, 0, img.width(), img.height());
    const paint = new ck.Paint();
    paint.setAntiAlias(true);
    // Above 200% Photoshop shows real pixels; below 100% mipmaps stop the shimmer.
    if (g.zoom >= 2) {
      sk.drawImageRectOptions(img, src, dst, ck.FilterMode.Nearest, ck.MipmapMode.None, paint);
    } else if (g.zoom < 1) {
      sk.drawImageRectOptions(img, src, dst, ck.FilterMode.Linear, ck.MipmapMode.Linear, paint);
    } else {
      sk.drawImageRectOptions(img, src, dst, ck.FilterMode.Linear, ck.MipmapMode.None, paint);
    }
    paint.delete();
    // `img` is owned by `pageCache` — do not delete it here.
  }

  /** Page edge, guides, margins, columns, bleed marks, selection. Device space, hairline-crisp. */
  private paintOverlay(ck: CanvasKit, sk: Canvas, doc: PressDocument, page: Page, g: Geom): void {
    const h = g.hair;
    const x0 = g.dx(0);
    const y0 = g.dy(0);
    const x1 = g.dx(page.widthPx);
    const y1 = g.dy(page.heightPx);

    const edge = new ck.Paint();
    edge.setColor(rgb(ck, TOKEN.pageEdge, ALPHA.pageEdge));
    this.frame(ck, sk, edge, x0 - h, y0 - h, x1 + h, y1 + h, h);
    edge.delete();

    if (this.view.showBleed && page.bleedPx > 0) {
      const bx0 = g.dx(-page.bleedPx);
      const by0 = g.dy(-page.bleedPx);
      const bx1 = g.dx(page.widthPx + page.bleedPx);
      const by1 = g.dy(page.heightPx + page.bleedPx);
      const bleed = new ck.Paint();
      bleed.setColor(rgb(ck, TOKEN.bleed, ALPHA.bleedLine));
      this.frame(ck, sk, bleed, bx0, by0, bx1, by1, h);
      // Crop marks: aligned with the trim, but standing clear *outside* the bleed, the
      // way a printer's-marks page places them. Offsetting them from the trim instead
      // made each one cross the bleed rule and read as a stray plus sign.
      const gap = Math.round(3 * g.dpr);
      const len = Math.round(9 * g.dpr);
      const mark = new ck.Paint();
      mark.setColor(rgb(ck, TOKEN.bleed, ALPHA.bleedLine));
      for (const x of [x0, x1 - h]) {
        sk.drawRect(ck.LTRBRect(x, by0 - gap - len, x + h, by0 - gap), mark);
        sk.drawRect(ck.LTRBRect(x, by1 + gap, x + h, by1 + gap + len), mark);
      }
      for (const y of [y0, y1 - h]) {
        sk.drawRect(ck.LTRBRect(bx0 - gap - len, y, bx0 - gap, y + h), mark);
        sk.drawRect(ck.LTRBRect(bx1 + gap, y, bx1 + gap + len, y + h), mark);
      }
      mark.delete();
      bleed.delete();
    }

    if (this.view.showBleed && page.slugPx > 0) {
      const s = page.bleedPx + page.slugPx;
      const slug = new ck.Paint();
      slug.setColor(rgb(ck, TOKEN.slug, ALPHA.slugLine));
      this.frame(
        ck,
        sk,
        slug,
        g.dx(-s),
        g.dy(-s),
        g.dx(page.widthPx + s),
        g.dy(page.heightPx + s),
        h,
      );
      slug.delete();
    }

    if (this.view.showGuides) {
      const m = page.margin;
      const mx0 = g.dx(m.left);
      const my0 = g.dy(m.top);
      const mx1 = g.dx(page.widthPx - m.right);
      const my1 = g.dy(page.heightPx - m.bottom);
      const marg = new ck.Paint();
      marg.setColor(rgb(ck, TOKEN.margin, ALPHA.margin));
      this.frame(ck, sk, marg, mx0, my0, mx1, my1, h);
      marg.delete();

      if (page.columns > 1) {
        const inner = page.widthPx - m.left - m.right;
        const gut = page.columnGutter;
        const colW = (inner - gut * (page.columns - 1)) / page.columns;
        const col = new ck.Paint();
        col.setColor(rgb(ck, TOKEN.column, ALPHA.column));
        for (let i = 1; i < page.columns; i++) {
          const a = m.left + i * colW + (i - 1) * gut;
          const b = a + gut;
          for (const cx of gut > 0 ? [a, b] : [a]) {
            const px = g.dx(cx);
            sk.drawRect(ck.LTRBRect(px, my0, px + h, my1), col);
          }
        }
        col.delete();
      }

      const guide = new ck.Paint();
      guide.setColor(rgb(ck, TOKEN.guide, ALPHA.guide));
      for (const gd of page.guides) {
        if (gd.axis === "v") {
          const px = g.dx(gd.offset);
          sk.drawRect(ck.LTRBRect(px, g.sy(g.ruler), px + h, g.devH), guide);
        } else {
          const py = g.dy(gd.offset);
          sk.drawRect(ck.LTRBRect(g.sx(g.ruler), py, g.devW, py + h), guide);
        }
      }
      guide.delete();
    }

    this.paintSelection(ck, sk, doc, g);
    this.paintSmartGuides(ck, sk, g);

    if (this.view.marquee) {
      const m = this.view.marquee;
      const ants = new ck.Paint();
      ants.setColor(rgb(ck, TOKEN.accent, 1));
      ants.setStyle(ck.PaintStyle.Stroke);
      ants.setStrokeWidth(h);
      ants.setAntiAlias(false);
      const dash = ck.PathEffect.MakeDash([4 * g.dpr, 3 * g.dpr], 0);
      ants.setPathEffect(dash);
      const back = new ck.Paint();
      back.setColor(ck.Color4f(0, 0, 0, 0.55));
      back.setStyle(ck.PaintStyle.Stroke);
      back.setStrokeWidth(h);
      back.setAntiAlias(false);
      const rect = ck.LTRBRect(
        g.dx(m.x) + h / 2,
        g.dy(m.y) + h / 2,
        g.dx(m.x + m.w) + h / 2,
        g.dy(m.y + m.h) + h / 2,
      );
      sk.drawRect(rect, back);
      sk.drawRect(rect, ants);
      back.delete();
      dash.delete();
      ants.delete();
    }

    if (this.view.shapePreview) {
      const s = this.view.shapePreview;
      const ink = new ck.Paint();
      ink.setColor(rgb(ck, TOKEN.accent, 1));
      ink.setStyle(ck.PaintStyle.Stroke);
      ink.setStrokeWidth(h);
      ink.setAntiAlias(true);
      const l = g.dx(s.x);
      const t = g.dy(s.y);
      const r = g.dx(s.x + s.w);
      const b = g.dy(s.y + s.h);
      if (s.kind === "line") sk.drawLine(l, t, r, b, ink);
      else if (s.kind === "ellipse") sk.drawOval(ck.LTRBRect(l, t, r, b), ink);
      else if (s.kind === "roundrect") {
        const rr = Math.max(0, Math.min(s.radius ?? 24, Math.abs(r - l) / 2, Math.abs(b - t) / 2));
        sk.drawRRect(ck.RRectXY(ck.LTRBRect(l + h / 2, t + h / 2, r + h / 2, b + h / 2), rr, rr), ink);
      } else if (s.kind === "polygon" || s.kind === "star") {
        const cx = (l + r) / 2;
        const cy = (t + b) / 2;
        const rx = (r - l) / 2;
        const ry = (b - t) / 2;
        const path = new ck.PathBuilder();
        if (s.kind === "star") {
          const pts = Math.max(3, Math.min(16, Math.round(s.points ?? 5)));
          for (let i = 0; i < pts * 2; i++) {
            const a = -Math.PI / 2 + (i * Math.PI) / pts;
            const k = i % 2 === 0 ? 1 : 0.4;
            const x = cx + rx * k * Math.cos(a);
            const y = cy + ry * k * Math.sin(a);
            if (i === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
          }
        } else {
          const sides = Math.max(3, Math.min(24, Math.round(s.sides ?? 6)));
          for (let i = 0; i < sides; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
            const x = cx + rx * Math.cos(a);
            const y = cy + ry * Math.sin(a);
            if (i === 0) path.moveTo(x, y);
            else path.lineTo(x, y);
          }
        }
        path.close();
        const drawn = path.detach();
        sk.drawPath(drawn, ink);
        drawn.delete();
        path.delete();
      } else if (s.kind === "frame") {
        sk.drawRect(ck.LTRBRect(l + h / 2, t + h / 2, r + h / 2, b + h / 2), ink);
        sk.drawLine(l, t, r, b, ink);
        sk.drawLine(r, t, l, b, ink);
      } else sk.drawRect(ck.LTRBRect(l + h / 2, t + h / 2, r + h / 2, b + h / 2), ink);
      ink.delete();
    }
  }

  private paintTextEdit(
    ck: CanvasKit,
    sk: Canvas,
    doc: PressDocument,
    g: Geom,
    edit: { layerId: string; anchor: number; focus: number },
  ): void {
    const page = activePage(doc);
    const layer = page.layers.find((l) => l.id === edit.layerId);
    if (!layer || layer.kind !== "type-frame") return;
    const layout = this.typeLayout(doc, layer.id);
    const t = layer.transform;
    const q = quadOf(t).map((p) => ({ x: g.dx(p.x), y: g.dy(p.y) }));
    const h = g.hair;
    const line = new ck.Paint();
    line.setColor(rgb(ck, TOKEN.accent, 1));
    this.polyline(ck, sk, line, q, h);
    line.delete();
    if (!layout) return;

    const a = Math.min(edit.anchor, edit.focus);
    const b = Math.max(edit.anchor, edit.focus);
    const stopAt = (offset: number) =>
      layout.stops.find((s) => s.offset === offset) ??
      layout.stops.reduce((best, s) => (Math.abs(s.offset - offset) < Math.abs(best.offset - offset) ? s : best), layout.stops[0]!);

    if (a !== b) {
      const fill = new ck.Paint();
      fill.setColor(rgb(ck, TOKEN.accent, 0.28));
      const starts = layout.stops.filter((s) => s.offset >= a && s.offset < b);
      for (const s of starts) {
        const next = layout.stops.find((n) => n.offset > s.offset && n.y === s.y) ?? {
          ...s,
          x: s.x + 6,
        };
        const x0 = g.dx(t.x + Math.min(s.x, next.x));
        const x1 = g.dx(t.x + Math.max(s.x, next.x, s.x + 4));
        const y0 = g.dy(t.y + s.y - s.height * 0.85);
        const y1 = g.dy(t.y + s.y + s.height * 0.2);
        sk.drawRect(ck.LTRBRect(x0, y0, x1, y1), fill);
      }
      fill.delete();
    }

    const caret = stopAt(edit.focus);
    if (caret) {
      const ink = new ck.Paint();
      ink.setColor(rgb(ck, TOKEN.accent, 1));
      const x = g.dx(t.x + caret.x);
      const y0 = g.dy(t.y + caret.y - caret.height * 0.85);
      const y1 = g.dy(t.y + caret.y + caret.height * 0.2);
      sk.drawRect(ck.LTRBRect(x, y0, x + Math.max(1, h), y1), ink);
      ink.delete();
    }
  }

  private paintSelection(ck: CanvasKit, sk: Canvas, doc: PressDocument, g: Geom): void {
    const page = activePage(doc);
    const picked = page.layers.filter((l) => doc.activeLayerIds.includes(l.id));
    if (picked.length === 0) return;

    const edit = this.view.textEdit;
    if (edit) {
      this.paintTextEdit(ck, sk, doc, g, edit);
      return;
    }
    const h = g.hair;

    if (picked.length > 1) {
      const thin = new ck.Paint();
      thin.setColor(rgb(ck, TOKEN.accent, 0.45));
      for (const l of picked) {
        const q = quadOf(l.transform).map((p) => ({ x: g.dx(p.x), y: g.dy(p.y) }));
        this.polyline(ck, sk, thin, q, h);
      }
      thin.delete();
    }

    const frame = this.selectionFrame(doc);
    if (!frame) return;
    const t: Transform = { x: frame.x, y: frame.y, w: frame.w, h: frame.h, rotation: frame.rotation };
    const q = quadOf(t).map((p) => ({ x: g.dx(p.x), y: g.dy(p.y) }));
    const line = new ck.Paint();
    line.setColor(rgb(ck, TOKEN.accent, 1));
    this.polyline(ck, sk, line, q, h);
    line.delete();

    const pts = [
      q[0]!,
      { x: (q[0]!.x + q[1]!.x) / 2, y: (q[0]!.y + q[1]!.y) / 2 },
      q[1]!,
      { x: (q[1]!.x + q[2]!.x) / 2, y: (q[1]!.y + q[2]!.y) / 2 },
      q[2]!,
      { x: (q[2]!.x + q[3]!.x) / 2, y: (q[2]!.y + q[3]!.y) / 2 },
      q[3]!,
      { x: (q[3]!.x + q[0]!.x) / 2, y: (q[3]!.y + q[0]!.y) / 2 },
    ];
    const side = Math.max(3, Math.round(HANDLE * g.dpr));
    const half = Math.floor(side / 2);
    const fill = new ck.Paint();
    fill.setColor(rgb(ck, TOKEN.accent, 1));
    const ring = new ck.Paint();
    ring.setColor(rgb(ck, TOKEN.pageEdge, 0.9));
    for (const p of pts) {
      const hx = Math.round(p.x) - half;
      const hy = Math.round(p.y) - half;
      sk.drawRect(ck.LTRBRect(hx - h, hy - h, hx + side + h, hy + side + h), ring);
      sk.drawRect(ck.LTRBRect(hx, hy, hx + side, hy + side), fill);
    }
    ring.delete();
    fill.delete();

    // Free-transform reference point: the pivot rotation turns about.
    const cx = g.dx(frame.x + frame.w / 2);
    const cy = g.dy(frame.y + frame.h / 2);
    const r = Math.max(3, Math.round(4 * g.dpr));
    const pivot = new ck.Paint();
    pivot.setColor(rgb(ck, TOKEN.accent, 1));
    pivot.setStyle(ck.PaintStyle.Stroke);
    pivot.setStrokeWidth(h);
    pivot.setAntiAlias(true);
    sk.drawCircle(cx + h / 2, cy + h / 2, r, pivot);
    pivot.setStyle(ck.PaintStyle.Fill);
    pivot.setAntiAlias(false);
    sk.drawRect(ck.LTRBRect(cx - r * 2, cy, cx + r * 2 + h, cy + h), pivot);
    sk.drawRect(ck.LTRBRect(cx, cy - r * 2, cx + h, cy + r * 2 + h), pivot);
    pivot.delete();
  }

  /**
   * Smart-guide alignment lines drawn during a move, in the copper accent.
   *
   * View-only chrome: the positions are resolved in the pointer-move handler
   * (allocation-free) and stashed on the view, and this pass reads them off the
   * SAME overlay repaint the move already triggers. Nothing here touches the
   * page composite. Lines span the full canvas so the alignment reads at a
   * glance, the way Figma/InDesign draw them.
   */
  private paintSmartGuides(ck: CanvasKit, sk: Canvas, g: Geom): void {
    const sg = this.view.smartGuides;
    if (!sg || (sg.xn === 0 && sg.yn === 0)) return;
    const h = g.hair;
    const paint = new ck.Paint();
    paint.setColor(rgb(ck, TOKEN.accent, 0.9));
    const top = g.sy(g.ruler);
    const left = g.sx(g.ruler);
    for (let i = 0; i < sg.xn; i++) {
      const px = g.dx(sg.xs[i]!);
      if (px >= left && px <= g.devW) sk.drawRect(ck.LTRBRect(px, top, px + h, g.devH), paint);
    }
    for (let i = 0; i < sg.yn; i++) {
      const py = g.dy(sg.ys[i]!);
      if (py >= top && py <= g.devH) sk.drawRect(ck.LTRBRect(left, py, g.devW, py + h), paint);
    }
    paint.delete();
  }

  /** One-device-pixel rectangle outline built from filled rects — never a 2px blur. */
  private frame(
    ck: CanvasKit,
    sk: Canvas,
    paint: Paint,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    h: number,
  ): void {
    sk.drawRect(ck.LTRBRect(x0, y0, x1, y0 + h), paint);
    sk.drawRect(ck.LTRBRect(x0, y1 - h, x1, y1), paint);
    sk.drawRect(ck.LTRBRect(x0, y0, x0 + h, y1), paint);
    sk.drawRect(ck.LTRBRect(x1 - h, y0, x1, y1), paint);
  }

  private polyline(
    ck: CanvasKit,
    sk: Canvas,
    paint: Paint,
    pts: { x: number; y: number }[],
    h: number,
  ): void {
    if (pts.length < 2) return;
    const axis = pts.every((p, i) => {
      const n = pts[(i + 1) % pts.length]!;
      return Math.abs(p.x - n.x) < 0.5 || Math.abs(p.y - n.y) < 0.5;
    });
    if (axis) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      this.frame(ck, sk, paint, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), h);
      return;
    }
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(h);
    paint.setAntiAlias(true);
    // A stroke of width h centres on its path, so the path runs down the middle of the
    // device-pixel run: +h/2, not +0.5. At dpr 2 the old half-pixel smeared it over two.
    const c = h / 2;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      sk.drawLine(a.x + c, a.y + c, b.x + c, b.y + c, paint);
    }
    paint.setStyle(ck.PaintStyle.Fill);
    paint.setAntiAlias(false);
  }

  // ── rulers ──────────────────────────────────────────────────────────────────

  /** Doc px per ruler unit. */
  private unitPx(): number {
    if (this.unit === "mm") return this.ppi / 25.4;
    if (this.unit === "in") return this.ppi;
    return 1;
  }

  private rulerFont(ck: CanvasKit, devicePx: number): Font | null {
    if (!this.typefaceTried) {
      this.typefaceTried = true;
      const factory = ck.Typeface as unknown as {
        MakeTypefaceFromData?: (b: ArrayBuffer) => Typeface | null;
        MakeFreeTypeFaceFromData?: (b: ArrayBuffer) => Typeface | null;
        GetDefault?: () => Typeface | null;
      };
      const bytes = this.engines.face?.bytes;
      if (bytes) {
        this.typeface =
          factory.MakeTypefaceFromData?.(bytes) ?? factory.MakeFreeTypeFaceFromData?.(bytes) ?? null;
      }
      if (!this.typeface) this.typeface = factory.GetDefault?.() ?? null;
    }
    if (!this.typeface) return null;
    const px = Math.max(6, Math.round(devicePx));
    if (!this.font || this.fontPx !== px) {
      this.font?.delete();
      this.font = new ck.Font(this.typeface, px);
      this.font.setEdging(ck.FontEdging.AntiAlias);
      this.font.setSubpixel(true);
      this.fontPx = px;
    }
    return this.font;
  }

  private paintRulers(ck: CanvasKit, sk: Canvas, g: Geom): void {
    const R = g.sy(RULER);
    const W = g.devW;
    const H = g.devH;
    const h = g.hair;

    const face = new ck.Paint();
    face.setColor(rgb(ck, TOKEN.rulerFace, 1));
    sk.drawRect(ck.LTRBRect(0, 0, W, R), face);
    sk.drawRect(ck.LTRBRect(0, 0, R, H), face);
    face.delete();

    const corner = new ck.Paint();
    corner.setColor(rgb(ck, TOKEN.rulerCorner, 1));
    sk.drawRect(ck.LTRBRect(0, 0, R, R), corner);
    corner.delete();

    const hair = new ck.Paint();
    hair.setColor(rgb(ck, TOKEN.hair, 1));
    sk.drawRect(ck.LTRBRect(0, R - h, W, R), hair);
    sk.drawRect(ck.LTRBRect(R - h, 0, R, H), hair);
    hair.delete();

    // Zero-point widget in the corner box: the two axes meeting at the origin, drawn
    // in the minor-tick grey so it sits behind the ruler numbers rather than beside them.
    const originMark = new ck.Paint();
    originMark.setColor(rgb(ck, TOKEN.tickMinor, 1));
    const inset = Math.round(5 * g.dpr);
    sk.drawRect(ck.LTRBRect(inset, R - inset - h, R - inset, R - inset), originMark);
    sk.drawRect(ck.LTRBRect(R - inset - h, inset, R - inset, R - inset), originMark);
    originMark.delete();

    const cssPerUnit = this.unitPx() * g.zoom;
    const plan = planTicks(this.unit, cssPerUnit);
    if (!plan) {
      this.paintCursorRule(ck, sk, g, R);
      return;
    }

    const major = new ck.Paint();
    major.setColor(rgb(ck, TOKEN.tickMajor, 1));
    const half = new ck.Paint();
    half.setColor(rgb(ck, TOKEN.tickHalf, 1));
    const minor = new ck.Paint();
    minor.setColor(rgb(ck, TOKEN.tickMinor, 1));
    const zero = new ck.Paint();
    zero.setColor(rgb(ck, TOKEN.labelZero, 1));
    const text = new ck.Paint();
    text.setColor(rgb(ck, TOKEN.label, 1));
    text.setAntiAlias(true);
    const zeroText = new ck.Paint();
    zeroText.setColor(rgb(ck, TOKEN.labelZero, 1));
    zeroText.setAntiAlias(true);
    const font = this.rulerFont(ck, 9 * g.dpr);

    const unitPx = this.unitPx();
    // Three lengths and three greys: major / half / micro. Photoshop's ladder.
    const lenMajor = Math.round(8 * g.dpr);
    const lenHalf = Math.round(5 * g.dpr);
    const lenMinor = Math.round(2.5 * g.dpr);
    const labelPad = Math.round(3 * g.dpr);
    // Numbers sit above the major tick, clear of it, with a fixed baseline so a longer
    // tick never pushes them off the top of the band.
    const labelBase = R - lenMajor - Math.round(2 * g.dpr);
    // Vertical labels are rotated 90° CW: this is the baseline, glyphs grow to its right.
    const vBaseline = Math.round(2.5 * g.dpr);

    const drawAxis = (horizontal: boolean) => {
      const spanCss = horizontal ? g.viewW : g.viewH;
      const originCss = horizontal ? g.originX : g.originY;
      const first = (RULER - originCss) / g.zoom / unitPx;
      const last = (spanCss - originCss) / g.zoom / unitPx;
      const i0 = Math.floor(first / plan.step) - 1;
      const i1 = Math.ceil(last / plan.step) + 1;
      if (!Number.isFinite(i0) || !Number.isFinite(i1)) return;
      const count = i1 - i0;
      if (count > 4000 || count < 0) return;
      for (let i = i0; i <= i1; i++) {
        const value = i * plan.step;
        const docPos = value * unitPx;
        const pos = horizontal ? g.dx(docPos) : g.dy(docPos);
        if (pos < R - 1 || pos > (horizontal ? W : H)) continue;
        const k = Math.round(value / plan.step);
        const isMajor = plan.majorEvery > 0 && k % plan.majorEvery === 0;
        const isHalf = !isMajor && plan.halfEvery > 0 && k % plan.halfEvery === 0;
        const len = isMajor ? lenMajor : isHalf ? lenHalf : lenMinor;
        const isZero = Math.abs(value) < 1e-9;
        const paint = isZero ? zero : isMajor ? major : isHalf ? half : minor;
        if (horizontal) sk.drawRect(ck.LTRBRect(pos, R - len, pos + h, R), paint);
        else sk.drawRect(ck.LTRBRect(R - len, pos, R, pos + h), paint);
        if (!isMajor || !font) continue;
        const label = tickLabel(value);
        const ink = isZero ? zeroText : text;
        if (horizontal) {
          sk.drawText(label, pos + labelPad, labelBase, ink, font);
        } else {
          sk.save();
          sk.translate(vBaseline, pos + labelPad);
          sk.rotate(90, 0, 0);
          sk.drawText(label, 0, 0, ink, font);
          sk.restore();
        }
      }
    };

    drawAxis(true);
    drawAxis(false);

    zeroText.delete();
    text.delete();
    zero.delete();
    minor.delete();
    half.delete();
    major.delete();

    this.paintCursorRule(ck, sk, g, R);
  }

  /**
   * The live cursor rule Photoshop draws on both rulers: a full-height neutral hairline
   * at the pointer, on top of the ticks and the numbers. Absent while the pointer is
   * outside the canvas, which is also its state in a headless capture.
   */
  private paintCursorRule(ck: CanvasKit, sk: Canvas, g: Geom, R: number): void {
    const p = this.pointer;
    if (!p) return;
    const h = g.hair;
    const paint = new ck.Paint();
    paint.setColor(rgb(ck, TOKEN.cursorTick, 0.9));
    const px = g.sx(p.x);
    const py = g.sy(p.y);
    if (px >= R && px < g.devW) sk.drawRect(ck.LTRBRect(px, 0, px + h, R - h), paint);
    if (py >= R && py < g.devH) sk.drawRect(ck.LTRBRect(0, py, R - h, py + h), paint);
    paint.delete();
  }

  // ── page composite ──────────────────────────────────────────────────────────

  private compositePage(ck: CanvasKit, doc: PressDocument, withSelectionChrome: boolean): SkImage | null {
    void withSelectionChrome;
    const page = activePage(doc);
    const pw = Math.max(1, page.widthPx);
    const ph = Math.max(1, page.heightPx);
    if (!this.pageSurf || this.pageSurfW !== pw || this.pageSurfH !== ph) {
      this.pageSurf?.delete();
      this.pageSurf = ck.MakeSurface(pw, ph);
      this.pageSurfW = pw;
      this.pageSurfH = ph;
    }
    const surf = this.pageSurf;
    if (!surf) return null;
    const sk = surf.getCanvas();
    // The surface is reused, so every composite must start from a clean slate;
    // `clear` ignores the clip, which is what we want here.
    sk.clear(color(ck, page.background));
    // Document content is clipped to the trim, exactly as Photoshop and InDesign clip
    // to the canvas: a layer that straddles an edge shows nothing on the pasteboard.
    // The scratch surface already bounds it; the clip states the rule so a future
    // oversized surface (bleed render, spread composite) cannot quietly break it.
    // Overlay chrome — handles, frame, guides, marks, rulers — is painted outside this
    // composite and is deliberately not clipped.
    // save/restore is mandatory now the canvas is reused: clips and matrices
    // accumulate across composites otherwise, and the page would shrink a
    // little on every frame of a drag.
    sk.save();
    sk.clipRect(ck.LTRBRect(0, 0, page.widthPx, page.heightPx), ck.ClipOp.Intersect, false);
    for (const layer of page.layers) {
      if (layer.parentId) continue;
      this.drawTree(ck, sk, surf, doc, layer);
    }
    sk.restore();
    return surf.makeImageSnapshot();
  }

  /**
   * Push a layer's LOCAL transform onto the canvas. Every renderer in this file
   * goes through here, so canvas, thumbnails and hit-testing cannot drift apart.
   * CanvasKit concat takes a row-major 3x3.
   */
  private concatLocal(sk: Canvas, t: Layer["transform"]): void {
    const m = localMatrix(t);
    sk.concat([m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1]);
  }

  private drawTree(ck: CanvasKit, sk: Canvas, surf: Surface, doc: PressDocument, layer: Layer): void {
    if (!layer.visible) return;
    const page = activePage(doc);
    if (layer.kind === "adjustment") {
      this.applyAdjustment(ck, sk, surf, layer);
      return;
    }
    if (layer.kind === "group") {
      // Groups honour effects too — a drop shadow, glow or outline applies to
      // the composited group silhouette, not each child. Renders on canvas,
      // export and thumbs.
      this.withEffects(ck, sk, layer, () => this.drawGroup(ck, sk, surf, doc, page, layer));
      return;
    }
    this.drawLayerWithEffects(ck, sk, doc, layer);
  }

  /** Composite a group and its children (one save-layer for opacity + blend). */
  private drawGroup(ck: CanvasKit, sk: Canvas, surf: Surface, doc: PressDocument, page: Page, layer: Layer): void {
    const paint = new ck.Paint();
    paint.setAlphaf(layer.opacity);
    const blendName = SKIA_BLEND[layer.blend];
    const modes = ck.BlendMode as unknown as Record<string, Parameters<Paint["setBlendMode"]>[0]>;
    if (modes[blendName]) paint.setBlendMode(modes[blendName]);
    sk.saveLayer(paint);
    paint.delete();
    // A group establishes a coordinate space for its children. Before v2 this
    // line was missing, so moving a group changed the record and nothing on
    // screen. Children carry transforms LOCAL to this space.
    this.concatLocal(sk, layer.transform);
    for (const child of page.layers) {
      if (child.parentId === layer.id) this.drawTree(ck, sk, surf, doc, child);
    }
    sk.restore();
  }

  /**
   * Run `draw` once through a shadow-only image filter (Photoshop-style pre-pass
   * that takes the exact silhouette), then again normally on top. Absent shadow
   * costs nothing. Shared by leaf layers and groups so neither can silently
   * ignore an enabled effect.
   */
  private withDropShadow(ck: CanvasKit, sk: Canvas, shadow: DropShadowEffect | null, draw: () => void): void {
    if (shadow && shadow.enabled && shadow.blur >= 0) {
      const paint = new ck.Paint();
      const a = Math.min(1, Math.max(0, shadow.color.a * shadow.opacity));
      const c = ck.Color4f(shadow.color.r, shadow.color.g, shadow.color.b, a);
      const sigma = Math.max(0, shadow.blur) * 0.5;
      const filter = ck.ImageFilter.MakeDropShadowOnly(shadow.offsetX, shadow.offsetY, sigma, sigma, c, null);
      paint.setImageFilter(filter);
      sk.saveLayer(paint);
      draw();
      sk.restore();
      filter.delete();
      paint.delete();
    }
    draw();
  }

  /**
   * A soft coloured halo behind the layer (Photoshop "Outer Glow") — a blurred
   * silhouette of the glow colour with zero offset, drawn as a pre-pass, then
   * the layer on top. Shared by leaves and groups. Absent glow costs nothing.
   */
  private withOuterGlow(ck: CanvasKit, sk: Canvas, glow: OuterGlowEffect | null, draw: () => void): void {
    if (glow && glow.enabled && glow.blur >= 0) {
      const paint = new ck.Paint();
      const a = Math.min(1, Math.max(0, glow.color.a * glow.opacity));
      const c = ck.Color4f(glow.color.r, glow.color.g, glow.color.b, a);
      const sigma = Math.max(0, glow.blur) * 0.5;
      const filter = ck.ImageFilter.MakeDropShadowOnly(0, 0, sigma, sigma, c, null);
      paint.setImageFilter(filter);
      sk.saveLayer(paint);
      draw();
      sk.restore();
      filter.delete();
      paint.delete();
    }
    draw();
  }

  /**
   * Inner shadow: invert the silhouette's alpha, offset+blur, tint, then SrcATop
   * so the result lives only inside the already-drawn pixels.
   */
  private withInnerShadow(ck: CanvasKit, sk: Canvas, inner: InnerShadowEffect | null, draw: () => void): void {
    draw();
    if (!inner || !inner.enabled) return;
    const a = Math.min(1, Math.max(0, inner.color.a * inner.opacity));
    if (a <= 0) return;
    const c = ck.Color4f(inner.color.r, inner.color.g, inner.color.b, a);
    const invert = ck.ColorFilter.MakeMatrix([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 1]);
    const tint = ck.ColorFilter.MakeBlend(c, ck.BlendMode.SrcIn);
    const offset = ck.ImageFilter.MakeOffset(inner.offsetX, inner.offsetY, null);
    const sigma = Math.max(0, inner.blur) * 0.5;
    const blur = ck.ImageFilter.MakeBlur(sigma, sigma, ck.TileMode.Decal, offset);
    const inverted = ck.ImageFilter.MakeColorFilter(invert, blur);
    const colored = ck.ImageFilter.MakeColorFilter(tint, inverted);
    const paint = new ck.Paint();
    paint.setImageFilter(colored);
    paint.setBlendMode(ck.BlendMode.SrcATop);
    sk.saveLayer(paint);
    draw();
    sk.restore();
    colored.delete();
    inverted.delete();
    blur.delete();
    offset.delete();
    tint.delete();
    invert.delete();
    paint.delete();
  }

  /**
   * 3D-on-2D extrusion: stacked zero-blur drop-shadows along an angle. Step
   * count is capped so a 400px extrusion does not issue 400 saveLayers.
   */
  private withLongShadow(ck: CanvasKit, sk: Canvas, fx: LongShadowEffect | null, draw: () => void): void {
    if (fx && fx.enabled && fx.length > 0) {
      const a = Math.min(1, Math.max(0, fx.color.a * fx.opacity));
      const rad = (fx.angle * Math.PI) / 180;
      const steps = longShadowSteps(fx.length);
      const step = fx.length / steps;
      const c = ck.Color4f(fx.color.r, fx.color.g, fx.color.b, a);
      for (let i = steps; i >= 1; i--) {
        const ox = Math.cos(rad) * step * i;
        const oy = Math.sin(rad) * step * i;
        const paint = new ck.Paint();
        const filter = ck.ImageFilter.MakeDropShadowOnly(ox, oy, 0.4, 0.4, c, null);
        paint.setImageFilter(filter);
        sk.saveLayer(paint);
        draw();
        sk.restore();
        filter.delete();
        paint.delete();
      }
    }
    draw();
  }

  /**
   * A solid outline around the layer's silhouette (Photoshop "Stroke"). The
   * silhouette is dilated by the stroke width and re-tinted to the stroke
   * colour (SrcIn keeps the dilated alpha), drawn as a pre-pass behind the
   * layer, so a ring of `width` stands proud of the original content. Absent
   * stroke costs nothing.
   */
  private withStrokeEffect(ck: CanvasKit, sk: Canvas, stroke: StrokeEffect | null, draw: () => void): void {
    if (stroke && stroke.enabled && stroke.width > 0) {
      const paint = new ck.Paint();
      const a = Math.min(1, Math.max(0, stroke.color.a * stroke.opacity));
      const c = ck.Color4f(stroke.color.r, stroke.color.g, stroke.color.b, a);
      const r = Math.max(0.5, stroke.width);
      const dilate = ck.ImageFilter.MakeDilate(r, r, null);
      const cf = ck.ColorFilter.MakeBlend(c, ck.BlendMode.SrcIn);
      const filter = ck.ImageFilter.MakeColorFilter(cf, dilate);
      paint.setImageFilter(filter);
      sk.saveLayer(paint);
      draw();
      sk.restore();
      filter.delete();
      cf.delete();
      dilate.delete();
      paint.delete();
    }
    draw();
  }

  /**
   * Compose every enabled non-destructive effect around a layer's own draw.
   * Nested so the pre-passes stack behind the content, bottom-to-top: drop
   * shadow, then outer glow, then the outline ring closest to the layer. Each
   * wrapper no-ops when its effect is absent. Gradient overlay is painted
   * inside `drawLayer` (clipped to the layer's own alpha) and so is not here.
   */
  private withEffects(ck: CanvasKit, sk: Canvas, layer: Layer, draw: () => void): void {
    this.withLongShadow(ck, sk, longShadowOf(layer), () =>
      this.withDropShadow(ck, sk, dropShadowOf(layer), () =>
        this.withOuterGlow(ck, sk, outerGlowOf(layer), () =>
          this.withStrokeEffect(ck, sk, strokeEffectOf(layer), () =>
            this.withInnerShadow(ck, sk, innerShadowOf(layer), draw),
          ),
        ),
      ),
    );
  }

  /** Draw a leaf layer, applying any enabled non-destructive effects. */
  private drawLayerWithEffects(ck: CanvasKit, sk: Canvas, doc: PressDocument, layer: Layer): void {
    this.withEffects(ck, sk, layer, () => this.drawLayer(ck, sk, doc, layer));
  }

  private applyAdjustment(ck: CanvasKit, sk: Canvas, surf: Surface, layer: AdjustmentLayer): void {
    const img = surf.makeImageSnapshot();
    const paint = new ck.Paint();
    paint.setColorFilter(
      ck.ColorFilter.MakeMatrix(brightnessContrastMatrix(layer.adjustment.brightness, layer.adjustment.contrast)),
    );
    paint.setAlphaf(layer.opacity);
    sk.clear(ck.Color4f(0, 0, 0, 0));
    sk.drawImage(img, 0, 0, paint);
    paint.delete();
    img.delete();
  }

  private drawLayer(ck: CanvasKit, sk: Canvas, doc: PressDocument, layer: Layer): void {
    const paint = new ck.Paint();
    paint.setAntiAlias(true);
    paint.setAlphaf(layer.opacity);
    const blendName = SKIA_BLEND[layer.blend];
    const modes = ck.BlendMode as unknown as Record<string, Parameters<Paint["setBlendMode"]>[0]>;
    if (modes[blendName]) paint.setBlendMode(modes[blendName]);
    const t = layer.transform;
    sk.save();
    this.concatLocal(sk, t);

    if (layer.kind === "vector") this.drawVector(ck, sk, layer, paint);
    else if (layer.kind === "type-frame") {
      const story = doc.stories.find((s) => s.id === layer.storyId);
      const face = story ? this.faceFor(story.character.fontId) : null;
      if (story && face) {
        const composed = drawTypeFrame(ck, sk, layer, story, face);
        if (composed.overflow) {
          const plus = new ck.Paint();
          plus.setColor(ck.Color4f(0.84, 0.18, 0.18, 1));
          plus.setStyle(ck.PaintStyle.Stroke);
          plus.setStrokeWidth(2);
          sk.drawLine(t.w - 10, 4, t.w - 10, 14, plus);
          sk.drawLine(t.w - 15, 9, t.w - 5, 9, plus);
          plus.delete();
        }
      }
    } else if (layer.kind === "image-frame" || layer.kind === "raster") {
      this.drawImageLayer(ck, sk, doc, layer, paint);
    }

    this.drawGradientOverlay(ck, sk, layer);

    sk.restore();
    paint.delete();
  }

  /**
   * Paint a gradient over the layer's silhouette (SrcATop keeps it within the
   * already-drawn content's alpha). Runs in the layer's local space, so the box
   * is [0,0,w,h]. No effect when absent or under two stops.
   */
  private drawGradientOverlay(ck: CanvasKit, sk: Canvas, layer: Layer): void {
    const g = gradientOverlayOf(layer);
    if (!g) return;
    const fill: GradientFill = { type: "linear", angle: g.angle, stops: g.stops };
    const shader = this.makeFillShader(ck, fill, layer.transform.w, layer.transform.h);
    if (!shader) return;
    const paint = new ck.Paint();
    paint.setShader(shader);
    paint.setAlphaf(Math.min(1, Math.max(0, g.opacity)));
    const modes = ck.BlendMode as unknown as Record<string, Parameters<Paint["setBlendMode"]>[0]>;
    if (modes.SrcATop) paint.setBlendMode(modes.SrcATop);
    const w = Math.max(1, layer.transform.w);
    const h = Math.max(1, layer.transform.h);
    sk.drawRect(ck.LTRBRect(0, 0, w, h), paint);
    paint.delete();
    shader.delete();
  }

  /** Linear or radial shader in the layer's local [0,0,w,h] box. Caller deletes. */
  private makeFillShader(ck: CanvasKit, fill: GradientFill, w: number, h: number) {
    if (fill.stops.length < 2) return null;
    const boxW = Math.max(1, w);
    const boxH = Math.max(1, h);
    const stops = [...fill.stops].sort((a, b) => a.offset - b.offset);
    const colors = stops.map((s) => ck.Color4f(s.color.r, s.color.g, s.color.b, s.color.a));
    const positions = stops.map((s) => Math.min(1, Math.max(0, s.offset)));
    if (fill.type === "radial") {
      const r = Math.hypot(boxW, boxH) / 2;
      return ck.Shader.MakeRadialGradient([boxW / 2, boxH / 2], Math.max(1, r), colors, positions, ck.TileMode.Clamp);
    }
    const cx = boxW / 2;
    const cy = boxH / 2;
    const rad = (fill.angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const half = (Math.abs(dx) * boxW + Math.abs(dy) * boxH) / 2;
    return ck.Shader.MakeLinearGradient(
      [cx - dx * half, cy - dy * half],
      [cx + dx * half, cy + dy * half],
      colors,
      positions,
      ck.TileMode.Clamp,
    );
  }

  private drawImageLayer(ck: CanvasKit, sk: Canvas, doc: PressDocument, layer: Layer, paint: Paint): void {
    if (layer.kind !== "image-frame" && layer.kind !== "raster") return;
    const id = layer.assetId;
    if (!id || !doc.assets[id]) {
      if (layer.kind !== "image-frame") return;
      // Empty picture box: a copper wash, a stroke, and an X. Hairline-only
      // marks vanish when the page is thumbnailed (2px on A4 → subpixel), so
      // the wash is what makes the box occupy real pixels — it is a frame with
      // no picture, not a missing thumbnail.
      const t = layer.transform;
      const w = Math.max(2, t.w);
      const hgt = Math.max(2, t.h);
      const stroke = Math.max(4, Math.min(w, hgt) * 0.02);
      paint.setAntiAlias(true);
      paint.setStyle(ck.PaintStyle.Fill);
      paint.setColor(ck.Color4f(0.878, 0.478, 0.184, 0.18));
      sk.drawRect(ck.LTRBRect(0, 0, w, hgt), paint);
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeWidth(stroke);
      paint.setColor(ck.Color4f(0.878, 0.478, 0.184, 0.95));
      sk.drawRect(ck.LTRBRect(stroke / 2, stroke / 2, w - stroke / 2, hgt - stroke / 2), paint);
      sk.drawLine(0, 0, w, hgt, paint);
      sk.drawLine(w, 0, 0, hgt, paint);
      return;
    }
    const img = this.imageFor(ck, id, doc.assets[id].dataUrl);
    if (!img) return;
    const t = layer.transform;
    const src = sourceWindow(layer, img.width(), img.height());
    const dest = destWindow(layer, src, t.w, t.h);
    // THE FRAME CLIPS THE CONTENT. `cover` deliberately produces a dest rect
    // larger than the frame; without this the picture spilled across
    // neighbouring layers, bounded only by the page edge (defect #2).
    // Antialiased so a rotated frame has a clean edge.
    sk.save();
    sk.clipRect(ck.LTRBRect(0, 0, t.w, t.h), ck.ClipOp.Intersect, true);
    this.blit(ck, sk, img, src, dest, paint, "bilinear");
    sk.restore();
  }


  private blit(
    ck: CanvasKit,
    sk: Canvas,
    img: SkImage,
    src: { x: number; y: number; w: number; h: number },
    dest: { x: number; y: number; w: number; h: number },
    paint: Paint,
    algo: ResampleAlgo,
  ): void {
    const srcR = ck.XYWHRect(src.x, src.y, src.w, src.h);
    const dstR = ck.XYWHRect(dest.x, dest.y, dest.w, dest.h);
    if (algo === "nearest") {
      sk.drawImageRectOptions(img, srcR, dstR, ck.FilterMode.Nearest, ck.MipmapMode.None, paint);
    } else if (algo === "bicubic") {
      sk.drawImageRectCubic(img, srcR, dstR, 1 / 3, 1 / 3, paint);
    } else {
      sk.drawImageRectOptions(img, srcR, dstR, ck.FilterMode.Linear, ck.MipmapMode.None, paint);
    }
  }

  private drawVector(ck: CanvasKit, sk: Canvas, layer: VectorLayer, paint: Paint): void {
    // PRECEDENCE (v6): a non-empty `contours` list is the authoritative
    // compound path; otherwise the legacy single `nodes`/`closed` is one contour.
    const multi = Array.isArray(layer.contours) && layer.contours.length > 0;
    const contours = multi
      ? layer.contours!
      : [{ nodes: layer.nodes, closed: layer.closed }];

    // Single-node degenerate case (a just-started pen path) keeps its dot.
    if (!multi && layer.nodes.length < 2) {
      if (layer.nodes.length === 1) {
        paint.setStyle(ck.PaintStyle.Fill);
        paint.setColor(ck.Color4f(0.878, 0.478, 0.184, 1));
        sk.drawCircle(layer.nodes[0].x, layer.nodes[0].y, 3, paint);
      }
      return;
    }

    const builder = new ck.PathBuilder();
    let drawable = 0;
    let anyClosed = false;
    for (const c of contours) {
      if (c.nodes.length < 2) continue;
      drawable++;
      if (c.closed) anyClosed = true;
      const n0 = c.nodes[0];
      builder.moveTo(n0.x, n0.y);
      for (let i = 1; i < c.nodes.length; i++) {
        const a = c.nodes[i - 1];
        const b = c.nodes[i];
        builder.cubicTo(a.outX, a.outY, b.inX, b.inY, b.x, b.y);
      }
      if (c.closed) {
        const last = c.nodes[c.nodes.length - 1];
        const first = c.nodes[0];
        builder.cubicTo(last.outX, last.outY, first.inX, first.inY, first.x, first.y);
        builder.close();
      }
    }
    if (drawable === 0) {
      builder.delete();
      return;
    }
    const path = builder.detach();
    builder.delete();
    // A compound path needs an explicit fill rule so subtracted holes read as
    // holes regardless of winding — even-odd. A single contour keeps Skia's
    // default (winding) so existing vectors are byte-identical to v5.
    if (multi && drawable > 1) path.setFillType(ck.FillType.EvenOdd);
    if (layer.fill && anyClosed) {
      paint.setStyle(ck.PaintStyle.Fill);
      if (isGradientFill(layer.fill)) {
        const shader = this.makeFillShader(ck, layer.fill, layer.transform.w, layer.transform.h);
        if (shader) {
          paint.setShader(shader);
          paint.setAlphaf(Math.min(1, Math.max(0, layer.opacity)));
          sk.drawPath(path, paint);
          paint.setShader(null);
          shader.delete();
        }
      } else {
        paint.setColor(color(ck, layer.fill, layer.fill.a * layer.opacity));
        sk.drawPath(path, paint);
      }
    }
    if (layer.stroke) {
      const s = layer.stroke;
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeWidth(s.width);
      paint.setColor(color(ck, s.color, s.color.a * layer.opacity));
      if (s.cap) paint.setStrokeCap(strokeCap(ck, s.cap));
      if (s.join) paint.setStrokeJoin(strokeJoin(ck, s.join));
      // A dash is a path effect on the stroked geometry. Skia needs an even
      // interval count; a stray odd/empty array falls back to a solid stroke.
      let dashEffect: PathEffect | null = null;
      if (s.dash && s.dash.length >= 2 && s.dash.length % 2 === 0 && s.dash.some((n) => n > 0)) {
        dashEffect = ck.PathEffect.MakeDash(s.dash, s.dashPhase ?? 0);
        paint.setPathEffect(dashEffect);
      }
      sk.drawPath(path, paint);
      // The paint is per-layer and about to be deleted, but the PathEffect is a
      // separate WASM object the compositor treats as churn to be freed.
      if (dashEffect) {
        paint.setPathEffect(null);
        dashEffect.delete();
      }
    }
    path.delete();
  }

  private imageFor(ck: CanvasKit, id: string, dataUrl: string): SkImage | null {
    const hit = this.images.get(id);
    if (hit) return hit;
    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes) return null;
    const img = ck.MakeImageFromEncoded(bytes);
    if (img) this.images.set(id, img);
    return img;
  }

  snapshotPagePng(doc: PressDocument): Uint8Array {
    const ck = this.engines.ck;
    const img = this.compositePage(ck, doc, false);
    if (!img) throw new Error("page composite failed");
    const bytes = img.encodeToBytes(ck.ImageFormat.PNG, 100);
    img.delete();
    if (!bytes) throw new Error("PNG encode failed");
    return bytes;
  }

  /**
   * A small PNG data URL rendered from the ACTUAL active page — for project and
   * dashboard previews (GOVERNOR.md §15/§61). Never stock art: this composites
   * the real document and downscales it with the same Skia blit the exporter
   * uses, preserving aspect ratio within `maxEdge`.
   */
  thumbnailDataUrl(doc: PressDocument, maxEdge = 320): string | null {
    const ck = this.engines.ck;
    const img = this.compositePage(ck, doc, false);
    if (!img) return null;
    const iw = Math.max(1, img.width());
    const ih = Math.max(1, img.height());
    const scale = Math.min(1, maxEdge / Math.max(iw, ih));
    const tw = Math.max(1, Math.round(iw * scale));
    const th = Math.max(1, Math.round(ih * scale));
    const surf = ck.MakeSurface(tw, th);
    if (!surf) {
      img.delete();
      return null;
    }
    const paint = new ck.Paint();
    this.blit(ck, surf.getCanvas(), img, { x: 0, y: 0, w: iw, h: ih }, { x: 0, y: 0, w: tw, h: th }, paint, "bilinear");
    paint.delete();
    const out = surf.makeImageSnapshot();
    const encoded = out.encodeToBytes(ck.ImageFormat.PNG, 90);
    out.delete();
    surf.delete();
    img.delete();
    if (!encoded) return null;
    let bin = "";
    for (let i = 0; i < encoded.length; i++) bin += String.fromCharCode(encoded[i]!);
    return `data:image/png;base64,${btoa(bin)}`;
  }

  /** Image Size resample: Skia FilterMode.Nearest / FilterMode.Linear / cubic Mitchell (B=C=1/3). */
  resampleDataUrl(dataUrl: string, nextW: number, nextH: number, algo: ResampleAlgo): string {
    const ck = this.engines.ck;
    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes) return dataUrl;
    const src = ck.MakeImageFromEncoded(bytes);
    if (!src) return dataUrl;
    const surf = ck.MakeSurface(Math.max(1, Math.round(nextW)), Math.max(1, Math.round(nextH)));
    if (!surf) {
      src.delete();
      return dataUrl;
    }
    const paint = new ck.Paint();
    this.blit(
      ck,
      surf.getCanvas(),
      src,
      { x: 0, y: 0, w: src.width(), h: src.height() },
      { x: 0, y: 0, w: nextW, h: nextH },
      paint,
      algo,
    );
    paint.delete();
    const out = surf.makeImageSnapshot();
    const encoded = out.encodeToBytes(ck.ImageFormat.PNG, 100);
    out.delete();
    surf.delete();
    src.delete();
    if (!encoded) return dataUrl;
    let bin = "";
    for (let i = 0; i < encoded.length; i++) bin += String.fromCharCode(encoded[i]!);
    return `data:image/png;base64,${btoa(bin)}`;
  }

  channelThumbs(doc: PressDocument): { r: string; g: string; b: string; rgb: string } | null {
    const ck = this.engines.ck;
    const page = activePage(doc);
    const img = this.compositePage(ck, doc, false);
    if (!img) return null;
    const info = {
      width: page.widthPx,
      height: page.heightPx,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    };
    const pixels = img.readPixels(0, 0, info) as Uint8Array | null;
    img.delete();
    if (!pixels) return null;
    const mk = (channel: 0 | 1 | 2 | "rgb") => {
      const surf = ck.MakeSurface(page.widthPx, page.heightPx);
      if (!surf) return "";
      const out = new Uint8Array(page.widthPx * page.heightPx * 4);
      for (let i = 0; i < page.widthPx * page.heightPx; i++) {
        const o = i * 4;
        if (channel === "rgb") {
          out[o] = pixels[o]!;
          out[o + 1] = pixels[o + 1]!;
          out[o + 2] = pixels[o + 2]!;
        } else {
          const v = pixels[o + channel]!;
          out[o] = v;
          out[o + 1] = v;
          out[o + 2] = v;
        }
        out[o + 3] = 255;
      }
      const skImg = ck.MakeImage({
        width: page.widthPx,
        height: page.heightPx,
        alphaType: ck.AlphaType.Unpremul,
        colorType: ck.ColorType.RGBA_8888,
        colorSpace: ck.ColorSpace.SRGB,
      }, out, page.widthPx * 4);
      if (!skImg) {
        surf.delete();
        return "";
      }
      const bytes = skImg.encodeToBytes(ck.ImageFormat.PNG, 80);
      skImg.delete();
      surf.delete();
      if (!bytes) return "";
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return `data:image/png;base64,${btoa(bin)}`;
    };
    return { r: mk(0), g: mk(1), b: mk(2), rgb: mk("rgb") };
  }

  // ── panel thumbnails ────────────────────────────────────────────────────────

  /**
   * A PNG data URL of one layer on its own, alpha preserved, aspect-fitted into a `size` box.
   * The returned image is the fitted rectangle — a tall layer comes back narrow — so a panel
   * can letterbox it or draw tight to it as it likes.
   *
   * Null means there is genuinely nothing to show: no such layer, an empty group, a degenerate
   * transform, or an adjustment layer, which owns no pixels of its own — it re-tones what is
   * beneath it. Photoshop puts a swatch icon in that row; a swatch is chrome, so chrome draws
   * it. Nothing here ever invents an image.
   */
  layerThumb(doc: PressDocument, layerId: string, size: number): string | null {
    const ck = this.engines.ck;
    if (!Number.isFinite(size) || size < 1) return null;
    const page = doc.pages.find((p) => p.layers.some((l) => l.id === layerId));
    const layer = page?.layers.find((l) => l.id === layerId);
    if (!page || !layer) return null;
    if (layer.kind === "adjustment") return null;
    const box = this.layerBounds(page, layer, 0);
    if (!box) return null;
    const px = clamp(Math.round(size), 1, THUMB_MAX_PX);
    const fit = fitBox(box.w, box.h, px);
    if (!fit) return null;
    const hash = this.hashLayer(doc, page, layer, 0);
    return this.cachedThumb(`layer:${layerId}:${px}`, hash, () => {
      const surf = this.thumbSurface(ck, fit.w, fit.h);
      if (!surf) return null;
      const sk = surf.getCanvas();
      // Transparent ground. A layer thumbnail sits on the panel's own checker, as in Photoshop,
      // so the alpha the layer actually has is the alpha that comes back.
      sk.clear(ck.Color4f(0, 0, 0, 0));
      sk.save();
      sk.clipRect(ck.LTRBRect(0, 0, fit.w, fit.h), ck.ClipOp.Intersect, false);
      const view: ThumbFit = { x: box.x, y: box.y, kx: fit.w / box.w, ky: fit.h / box.h };
      sk.scale(view.kx, view.ky);
      sk.translate(-view.x, -view.y);
      if (layer.kind === "group") {
        // The group's own opacity and blend are skipped on purpose: the thumbnail answers
        // "what is in here", and a group turned down to 0% still has contents worth seeing.
        // Its TRANSFORM is not skipped — children are local to it.
        this.concatLocal(sk, layer.transform);
        for (const child of page.layers) {
          if (child.parentId === layer.id) this.drawThumbTree(ck, sk, surf, doc, page, child, view, 1);
        }
      } else {
        // `drawTree` gates on `visible`; a thumbnail does not. The eye controls the canvas,
        // not the panel — Photoshop keeps drawing the row of a layer whose eye is off.
        this.drawLayer(ck, sk, doc, layer);
      }
      sk.restore();
      return this.encodeThumb(ck, surf, fit.w, fit.h);
    });
  }

  /**
   * A PNG data URL of a whole page composited, aspect-fitted into a `size` box. Works for any
   * page in the document, not only the active one. The page background is painted first with
   * its own alpha, so a transparent document thumbnails transparent.
   */
  pageThumb(doc: PressDocument, pageId: string, size: number): string | null {
    const ck = this.engines.ck;
    if (!Number.isFinite(size) || size < 1) return null;
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return null;
    const px = clamp(Math.round(size), 1, THUMB_MAX_PX);
    const fit = fitBox(page.widthPx, page.heightPx, px);
    if (!fit) return null;
    let hash = hashStr(HASH_SEED, page.id);
    hash = hashNum(hashNum(hash, page.widthPx), page.heightPx);
    hash = hashRgba(hash, page.background);
    for (const layer of page.layers) hash = mixHash(hash, this.hashLayer(doc, page, layer, 0));
    return this.cachedThumb(`page:${pageId}:${px}`, hash, () => {
      const surf = this.thumbSurface(ck, fit.w, fit.h);
      if (!surf) return null;
      const sk = surf.getCanvas();
      sk.clear(ck.Color4f(0, 0, 0, 0));
      sk.save();
      sk.clipRect(ck.LTRBRect(0, 0, fit.w, fit.h), ck.ClipOp.Intersect, false);
      const bg = new ck.Paint();
      bg.setColor(color(ck, page.background));
      sk.drawRect(ck.LTRBRect(0, 0, fit.w, fit.h), bg);
      bg.delete();
      const view: ThumbFit = { x: 0, y: 0, kx: fit.w / page.widthPx, ky: fit.h / page.heightPx };
      sk.scale(view.kx, view.ky);
      for (const layer of page.layers) {
        if (!layer.parentId) this.drawThumbTree(ck, sk, surf, doc, page, layer, view, 0);
      }
      sk.restore();
      return this.encodeThumb(ck, surf, fit.w, fit.h);
    });
  }

  /**
   * True when the last pass ran out of budget and handed a panel an older render of a layer
   * that has since changed. Ask again on the next frame and the queue drains.
   */
  thumbsPending(): boolean {
    return this.thumbDeferred;
  }

  /**
   * The same walk as `drawTree`, but bound to an explicit page rather than the active one —
   * the Pages panel thumbnails pages nobody is looking at — and carrying the fit so an
   * adjustment layer can undo the thumbnail's scale before it re-reads the surface.
   */
  private drawThumbTree(
    ck: CanvasKit,
    sk: Canvas,
    surf: Surface,
    doc: PressDocument,
    page: Page,
    layer: Layer,
    view: ThumbFit,
    depth: number,
  ): void {
    if (!layer.visible || depth > THUMB_MAX_DEPTH) return;
    if (layer.kind === "adjustment") {
      // `applyAdjustment` snapshots the surface and blits it back at 0,0 in device pixels.
      // Undo the fit first or it would resample the snapshot through the scale a second time.
      sk.save();
      sk.translate(view.x, view.y);
      sk.scale(1 / view.kx, 1 / view.ky);
      this.applyAdjustment(ck, sk, surf, layer);
      sk.restore();
      return;
    }
    if (layer.kind === "group") {
      const paint = new ck.Paint();
      paint.setAlphaf(layer.opacity);
      const blendName = SKIA_BLEND[layer.blend];
      const modes = ck.BlendMode as unknown as Record<string, Parameters<Paint["setBlendMode"]>[0]>;
      if (modes[blendName]) paint.setBlendMode(modes[blendName]);
      sk.saveLayer(paint);
      paint.delete();
      this.concatLocal(sk, layer.transform);
      for (const child of page.layers) {
        if (child.parentId === layer.id) this.drawThumbTree(ck, sk, surf, doc, page, child, view, depth + 1);
      }
      sk.restore();
      return;
    }
    this.drawLayer(ck, sk, doc, layer);
  }

  /**
   * Cache gate. A hit whose hash still matches costs nothing, which is the whole point: panels
   * re-render on every document change and would otherwise redraw every row every time.
   *
   * On a miss the pass budget decides. A key with nothing cached always renders — a panel must
   * never show a blank where a layer exists — but a key that already holds a render keeps it
   * for this frame when the budget is gone. That is an older picture of the same layer, not a
   * placeholder, and `thumbsPending()` says another pass is owed.
   */
  private cachedThumb(key: string, hash: number, render: () => string | null): string | null {
    const hit = this.thumbs.get(key);
    if (hit && hit.hash === hash) return hit.url;
    this.openThumbPass();
    if (hit && this.thumbBudget <= 0) {
      this.thumbDeferred = true;
      return hit.url;
    }
    const url = render();
    if (!url) return null;
    this.thumbBudget--;
    // Re-insert rather than mutate so the map's order stays least-recently-rendered first.
    this.thumbs.delete(key);
    this.thumbs.set(key, { hash, url });
    while (this.thumbs.size > THUMB_CACHE_MAX) {
      const oldest = this.thumbs.keys().next();
      if (oldest.done) break;
      this.thumbs.delete(oldest.value);
    }
    return url;
  }

  private openThumbPass(): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this.thumbPassAt < THUMB_PASS_MS) return;
    this.thumbPassAt = now;
    this.thumbBudget = THUMB_PASS_BUDGET;
    this.thumbDeferred = false;
  }

  /**
   * One scratch surface for every thumbnail, grown to the largest ever asked for and never
   * shrunk. `THUMB_MAX_PX` caps it, so this is a few kilobytes of wasm heap held for the life
   * of the compositor rather than a fresh allocation per row per repaint.
   */
  private thumbSurface(ck: CanvasKit, w: number, h: number): Surface | null {
    if (this.thumbSurf && this.thumbSurfW >= w && this.thumbSurfH >= h) return this.thumbSurf;
    const sw = Math.max(w, this.thumbSurfW, 1);
    const sh = Math.max(h, this.thumbSurfH, 1);
    const next = ck.MakeSurface(sw, sh);
    if (!next) return null;
    this.thumbSurf?.delete();
    this.thumbSurf = next;
    this.thumbSurfW = sw;
    this.thumbSurfH = sh;
    return next;
  }

  /** Encode the top-left `w × h` of the scratch surface. The rest of it belongs to no one. */
  private encodeThumb(ck: CanvasKit, surf: Surface, w: number, h: number): string | null {
    const img = surf.makeImageSnapshot([0, 0, w, h]);
    if (!img) return null;
    const bytes = img.encodeToBytes(ck.ImageFormat.PNG, 100);
    img.delete();
    if (!bytes) return null;
    return pngDataUrl(bytes);
  }

  /**
   * Doc-space bounds of what a layer actually draws. A group is the union of its descendants —
   * its own transform is a container, not content — so an empty group has no bounds and no
   * thumbnail.
   */
  private layerBounds(page: Page, layer: Layer, depth: number): Box | null {
    if (layer.kind === "group") {
      if (depth > THUMB_MAX_DEPTH) return null;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const child of page.layers) {
        if (child.parentId !== layer.id) continue;
        // An adjustment inside the group covers the whole page but contributes no pixels of
        // its own. Letting its transform into the union would frame the group to the page and
        // shrink the actual artwork to a speck.
        if (child.kind === "adjustment") continue;
        const b = this.layerBounds(page, child, depth + 1);
        if (!b) continue;
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
      }
      if (!(x1 > x0) || !(y1 > y0)) return null;
      // The union is in the group's LOCAL space. Map it out through the group's
      // own matrix so the caller gets bounds in the same space as a leaf's.
      const gm = localMatrix(layer.transform);
      const pts = [
        applyPt(gm, x0, y0),
        applyPt(gm, x1, y0),
        applyPt(gm, x1, y1),
        applyPt(gm, x0, y1),
      ];
      const gx0 = Math.min(...pts.map((p) => p.x));
      const gy0 = Math.min(...pts.map((p) => p.y));
      const gx1 = Math.max(...pts.map((p) => p.x));
      const gy1 = Math.max(...pts.map((p) => p.y));
      return { x: gx0, y: gy0, w: gx1 - gx0, h: gy1 - gy0 };
    }
    const quad = quadOf(layer.transform);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of quad) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Everything that changes what a layer looks like, folded into one number. Cheap enough to
   * run for every row of every repaint — that is the contract that lets the cache above be a
   * plain map lookup on the hot path.
   */
  private hashLayer(doc: PressDocument, page: Page, layer: Layer, depth: number): number {
    let h = hashStr(HASH_SEED, layer.id);
    h = hashStr(h, layer.kind);
    h = mixHash(h, layer.visible ? 1 : 2);
    h = hashStr(h, layer.blend);
    h = hashNum(h, layer.opacity);
    const t = layer.transform;
    h = hashNum(hashNum(hashNum(hashNum(hashNum(h, t.x), t.y), t.w), t.h), t.rotation);
    h = hashNum(hashNum(h, t.scaleX ?? 1), t.scaleY ?? 1);
    // Non-destructive effects change the rendered pixels without touching the
    // layer's own fields, so a panel thumbnail must re-render when they change.
    if (layer.effects) for (const e of layer.effects) h = hashEffect(h, e);
    switch (layer.kind) {
      case "vector": {
        h = mixHash(h, layer.closed ? 1 : 2);
        h = hashFill(h, layer.fill);
        h = hashRgba(h, layer.stroke ? layer.stroke.color : null);
        h = hashNum(h, layer.stroke ? layer.stroke.width : -1);
        if (layer.stroke) {
          h = hashStr(h, layer.stroke.cap ?? "butt");
          h = hashStr(h, layer.stroke.join ?? "miter");
          h = hashNum(h, layer.stroke.dashPhase ?? 0);
          for (const d of layer.stroke.dash ?? []) h = hashNum(h, d);
          if (!layer.stroke.dash?.length) h = mixHash(h, 0x50_11d);
        }
        // v6 compound paths: fold every contour and the multi-contour fill rule
        // so a boolean-op result invalidates thumbnails/repaints. The legacy
        // single-contour case still hashes `nodes` exactly as before.
        const multi = Array.isArray(layer.contours) && layer.contours.length > 0;
        if (multi) {
          h = mixHash(h, 0xc0_11d);
          for (const c of layer.contours!) {
            h = mixHash(h, c.closed ? 1 : 2);
            for (const n of c.nodes) {
              h = hashNum(hashNum(hashNum(hashNum(hashNum(hashNum(h, n.x), n.y), n.inX), n.inY), n.outX), n.outY);
            }
          }
        } else {
          for (const n of layer.nodes) {
            h = hashNum(hashNum(hashNum(hashNum(hashNum(hashNum(h, n.x), n.y), n.inX), n.inY), n.outX), n.outY);
          }
        }
        break;
      }
      case "raster":
      case "image-frame": {
        h = hashStr(h, layer.assetId ?? "");
        // Resampling rewrites the bytes behind an id the layer still points at, so nothing in
        // the layer's own fields moves. The epoch is what stops the panel showing the picture
        // at its old resolution for the rest of the session.
        h = mixHash(h, this.assetEpoch);
        const asset = layer.assetId ? doc.assets[layer.assetId] : undefined;
        if (asset) h = hashNum(hashNum(h, asset.width), asset.height);
        if (layer.kind === "image-frame") {
          h = hashStr(h, layer.fit);
          h = hashNum(hashNum(h, layer.focal.x), layer.focal.y);
          const c = layer.crop;
          h = c ? hashNum(hashNum(hashNum(hashNum(h, c.x), c.y), c.w), c.h) : mixHash(h, 0x5bf0);
        }
        break;
      }
      case "type-frame": {
        h = hashStr(h, layer.storyId);
        h = mixHash(h, this.storyHash(doc, layer.storyId));
        break;
      }
      case "adjustment": {
        h = hashStr(h, layer.adjustment.type);
        h = hashNum(hashNum(h, layer.adjustment.brightness), layer.adjustment.contrast);
        break;
      }
      case "group": {
        if (depth <= THUMB_MAX_DEPTH) {
          for (const child of page.layers) {
            if (child.parentId === layer.id) h = mixHash(h, this.hashLayer(doc, page, child, depth + 1));
          }
        }
        break;
      }
    }
    return h;
  }

  /**
   * Story text can run to tens of thousands of characters and a page of threaded frames would
   * rehash all of it on every repaint. Hash the body once per edit, keyed by the string itself;
   * the styles are a dozen numbers and are cheap enough to fold in each time.
   */
  private storyHash(doc: PressDocument, storyId: string): number {
    const story = doc.stories.find((s) => s.id === storyId);
    if (!story) return mixHash(HASH_SEED, 0x7a11);
    let cached = this.storyHashes.get(storyId);
    if (!cached || cached.text !== story.text) {
      cached = { text: story.text, hash: hashStr(HASH_SEED, story.text) };
      this.storyHashes.set(storyId, cached);
    }
    let h = cached.hash;
    const c = story.character;
    h = hashStr(h, c.fontId);
    h = hashNum(hashNum(hashNum(h, c.size), c.leading), c.tracking);
    h = hashRgba(h, c.fill);
    h = mixHash(h, c.underline ? 1 : 2);
    h = mixHash(h, c.strikethrough ? 1 : 2);
    h = hashNum(h, c.baselineShift ?? 0);
    for (const f of c.otFeatures) h = hashStr(h, f);
    const p = story.paragraph;
    h = hashStr(h, p.align);
    h = hashNum(hashNum(h, p.firstLineIndent), p.spaceAfter);
    return h;
  }
}

/** Doc-space rectangle, axis-aligned. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The transform a thumbnail put on its canvas: fit origin in doc space, plus the scale. */
interface ThumbFit {
  x: number;
  y: number;
  kx: number;
  ky: number;
}

/** Largest whole-pixel rectangle of `w × h` proportions that fits a `px` box. */
function fitBox(w: number, h: number, px: number): { w: number; h: number } | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const k = Math.min(px / w, px / h);
  return { w: clamp(Math.round(w * k), 1, px), h: clamp(Math.round(h * k), 1, px) };
}

/** The four corners of a transform, rotated about its centre. Doc space, clockwise from top-left. */
/** Corners of a layer box in its PARENT space, via the shared local matrix. */
function quadOf(t: Transform): { x: number; y: number }[] {
  const m = localMatrix(t);
  return [
    applyPt(m, 0, 0),
    applyPt(m, t.w, 0),
    applyPt(m, t.w, t.h),
    applyPt(m, 0, t.h),
  ];
}
