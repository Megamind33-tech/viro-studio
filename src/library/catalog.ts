import type { PathNode, PressDocument, Rgba } from "../document/types";
import { isGradientFill } from "../document/paint";
import {
  draftAsset,
  draftColumnGuides,
  draftGroup,
  draftGuides,
  draftImage,
  draftPath,
  draftRect,
  draftRule,
  draftSwatches,
  draftText,
  frameHeightFor,
  pageGrid,
  ptToPx,
  type DraftAsset,
} from "../document/factory";
import { documentFromPreset, presetById, type PresetCategory } from "../document/presets";

/** Press-generated marks and stock. Not Adobe Libraries, not a Canva Elements rail. */
export type MarkId =
  | "disc"
  | "diamond"
  | "plus"
  | "chevron"
  | "rule"
  | "register"
  | "triangle"
  | "star"
  | "arrow";

export interface MarkSpec {
  id: MarkId;
  name: string;
  closed: boolean;
  nodes: (w: number, h: number) => PathNode[];
  fill: boolean;
  stroke: boolean;
}

function n(x: number, y: number, ix = x, iy = y, ox = x, oy = y): PathNode {
  return { x, y, inX: ix, inY: iy, outX: ox, outY: oy };
}

const K = 0.5522847498;

export const MARKS: MarkSpec[] = [
  {
    id: "disc",
    name: "Disc",
    closed: true,
    fill: true,
    stroke: false,
    nodes: (w, h) => ellipseNodes(w, h),
  },
  {
    id: "diamond",
    name: "Diamond",
    closed: true,
    fill: true,
    stroke: false,
    nodes: (w, h) => [
      n(w / 2, 0),
      n(w, h / 2),
      n(w / 2, h),
      n(0, h / 2),
    ],
  },
  {
    id: "plus",
    name: "Plus",
    closed: true,
    fill: true,
    stroke: false,
    nodes: (w, h) => {
      const t = Math.min(w, h) * 0.22;
      const cx = w / 2;
      const cy = h / 2;
      return [
        n(cx - t, 0),
        n(cx + t, 0),
        n(cx + t, cy - t),
        n(w, cy - t),
        n(w, cy + t),
        n(cx + t, cy + t),
        n(cx + t, h),
        n(cx - t, h),
        n(cx - t, cy + t),
        n(0, cy + t),
        n(0, cy - t),
        n(cx - t, cy - t),
      ];
    },
  },
  {
    id: "chevron",
    name: "Chevron",
    closed: true,
    fill: true,
    stroke: false,
    nodes: (w, h) => [
      n(0, 0),
      n(w / 2, h * 0.42),
      n(w, 0),
      n(w, h * 0.38),
      n(w / 2, h),
      n(0, h * 0.38),
    ],
  },
  {
    id: "rule",
    name: "Rule",
    closed: false,
    fill: false,
    stroke: true,
    nodes: (w, h) => [n(0, h / 2), n(w, h / 2)],
  },
  {
    id: "register",
    name: "Register",
    closed: false,
    fill: false,
    stroke: true,
    nodes: (w, h) => {
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) * 0.38;
      return [
        n(cx - r, cy),
        n(cx + r, cy),
        n(cx, cy),
        n(cx, cy - r),
        n(cx, cy + r),
      ];
    },
  },
  {
    id: "triangle",
    name: "Triangle",
    closed: true,
    fill: true,
    stroke: false,
    nodes: (w, h) => [n(w / 2, 0), n(w, h), n(0, h)],
  },
  {
    id: "star",
    name: "Star",
    closed: true,
    fill: true,
    stroke: false,
    nodes: (w, h) => starNodes(w, h, 5),
  },
  {
    id: "arrow",
    name: "Arrow",
    closed: true,
    fill: true,
    stroke: false,
    nodes: (w, h) => [
      n(0, h * 0.35),
      n(w * 0.58, h * 0.35),
      n(w * 0.58, 0),
      n(w, h / 2),
      n(w * 0.58, h),
      n(w * 0.58, h * 0.65),
      n(0, h * 0.65),
    ],
  },
];

export function markNodes(id: MarkId, w: number, h: number): PathNode[] {
  const spec = MARKS.find((m) => m.id === id);
  if (!spec) throw new Error(`unknown mark ${id}`);
  return spec.nodes(w, h);
}

export interface PaperSpec {
  id: string;
  name: string;
}

export const PAPERS: PaperSpec[] = [
  { id: "newsprint", name: "Newsprint" },
  { id: "linen", name: "Linen" },
  { id: "charcoal", name: "Charcoal" },
  { id: "warm", name: "Warm stock" },
  { id: "cool", name: "Cool stock" },
  { id: "grid", name: "8pt grid" },
];

export function ellipseNodes(w: number, h: number): PathNode[] {
  const rx = w / 2;
  const ry = h / 2;
  const ox = rx * K;
  const oy = ry * K;
  const cx = rx;
  const cy = ry;
  return [
    n(cx + rx, cy, cx + rx, cy - oy, cx + rx, cy + oy),
    n(cx, cy + ry, cx + ox, cy + ry, cx - ox, cy + ry),
    n(cx - rx, cy, cx - rx, cy + oy, cx - rx, cy - oy),
    n(cx, cy - ry, cx - ox, cy - ry, cx + ox, cy - ry),
  ];
}

export function roundRectNodes(w: number, h: number, radius: number): PathNode[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r < 0.5) {
    return [n(0, 0), n(w, 0), n(w, h), n(0, h)];
  }
  const k = r * K;
  return [
    n(r, 0, r - k, 0, r, 0),
    n(w - r, 0, w - r, 0, w - r + k, 0),
    n(w, r, w, r - k, w, r),
    n(w, h - r, w, h - r, w, h - r + k),
    n(w - r, h, w - r + k, h, w - r, h),
    n(r, h, r, h, r - k, h),
    n(0, h - r, 0, h - r + k, 0, h - r),
    n(0, r, 0, r, 0, r - k),
  ];
}

export function polygonNodes(w: number, h: number, sides: number): PathNode[] {
  const count = Math.max(3, Math.min(24, Math.round(sides)));
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const nodes: PathNode[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    nodes.push(n(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
  }
  return nodes;
}

function starNodes(w: number, h: number, points: number): PathNode[] {
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.min(w, h) / 2;
  const inner = outer * 0.4;
  const nodes: PathNode[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 === 0 ? outer : inner;
    nodes.push(n(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return nodes;
}

export function markThumb(id: MarkId, fg = "#e07a2f"): string {
  const spec = MARKS.find((m) => m.id === id)!;
  const d = svgPath(spec.nodes(48, 48), spec.closed);
  const fill = spec.fill ? fg : "none";
  const stroke = spec.stroke ? fg : "none";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function svgPath(nodes: PathNode[], closed: boolean): string {
  if (!nodes.length) return "";
  const f = (v: number) => v.toFixed(2);
  let d = `M${f(nodes[0]!.x)} ${f(nodes[0]!.y)}`;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    d += `C${f(a.outX)} ${f(a.outY)} ${f(b.inX)} ${f(b.inY)} ${f(b.x)} ${f(b.y)}`;
  }
  if (closed) {
    const last = nodes[nodes.length - 1]!;
    const first = nodes[0]!;
    d += `C${f(last.outX)} ${f(last.outY)} ${f(first.inX)} ${f(first.inY)} ${f(first.x)} ${f(first.y)}Z`;
  }
  return d;
}

/* ================================================================== *
 * PNG writer
 *
 * CanvasKit decodes PNG/JPEG/WEBP/GIF/BMP — it does not decode SVG — so
 * any stock image that has to survive `MakeImageFromEncoded` must be real
 * raster bytes. This writes 8-bit indexed-colour PNG with stored (BTYPE=00)
 * deflate blocks: a genuinely valid PNG, larger than a compressed one, and
 * with no dependency on a DOM canvas so it works in the app and in a Node
 * verification run alike.
 * ================================================================== */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const tag = new Uint8Array(4);
  for (let i = 0; i < 4; i++) tag[i] = type.charCodeAt(i);
  const body = concat([tag, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

/** zlib container around stored deflate blocks. Valid, just not small. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  const MAX = 65535;
  if (raw.length === 0) parts.push(new Uint8Array([1, 0, 0, 0xff, 0xff]));
  for (let o = 0; o < raw.length; o += MAX) {
    const len = Math.min(MAX, raw.length - o);
    const last = o + len >= raw.length ? 1 : 0;
    parts.push(new Uint8Array([last, len & 255, (len >>> 8) & 255, ~len & 255, (~len >>> 8) & 255]));
    parts.push(raw.subarray(o, o + len));
  }
  parts.push(u32(adler32(raw)));
  return concat(parts);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(bin);
}

/** 8-bit indexed PNG. `palette` is RGB triplets, at most 256 entries. */
export function encodeIndexedPng(
  width: number,
  height: number,
  indices: Uint8Array,
  palette: Uint8Array,
): string {
  if (indices.length !== width * height) throw new Error("encodeIndexedPng: index buffer size mismatch");
  if (palette.length % 3 !== 0 || palette.length > 768) throw new Error("encodeIndexedPng: bad palette");
  const stride = width + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(indices.subarray(y * width, (y + 1) * width), y * stride + 1);
  }
  const png = concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", concat([u32(width), u32(height), new Uint8Array([8, 3, 0, 0, 0])])),
    pngChunk("PLTE", palette),
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
  return `data:image/png;base64,${toBase64(png)}`;
}

/* ------------------------------------------------------------------ *
 * Stock fields — procedural placeholder imagery
 * ------------------------------------------------------------------ */

export type StockFieldId = "duotone-vertical" | "duotone-diagonal" | "radial-bloom" | "halftone-grid" | "grain";

const STOCK_STEPS = 64;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function rampPalette(a: Rgba, b: Rgba, steps: number): Uint8Array {
  const out = new Uint8Array(steps * 3);
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    out[i * 3] = clamp255((a.r + (b.r - a.r) * t) * 255);
    out[i * 3 + 1] = clamp255((a.g + (b.g - a.g) * t) * 255);
    out[i * 3 + 2] = clamp255((a.b + (b.b - a.b) * t) * 255);
  }
  return out;
}

function hash(x: number, y: number, salt: string): number {
  let h = 2166136261;
  const s = `${salt}:${x}:${y}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function fieldValue(id: StockFieldId, x: number, y: number, w: number, h: number): number {
  const u = w > 1 ? x / (w - 1) : 0;
  const v = h > 1 ? y / (h - 1) : 0;
  switch (id) {
    case "duotone-vertical":
      return v;
    case "duotone-diagonal":
      return (u * 0.45 + v * 0.55);
    case "radial-bloom": {
      const dx = u - 0.42;
      const dy = v - 0.36;
      return Math.min(1, Math.sqrt(dx * dx + dy * dy) / 0.78);
    }
    case "halftone-grid": {
      const cell = Math.max(4, Math.round(Math.min(w, h) / 16));
      const line = x % cell === 0 || y % cell === 0 ? 0.26 : 0;
      return Math.min(1, v * 0.62 + u * 0.14 + line);
    }
    case "grain":
    default:
      return Math.min(1, Math.max(0, v * 0.5 + 0.25 + (hash(x, y, id) - 0.5) * 0.42));
  }
}

/**
 * A procedural two-ink field. These are placeholders with a considered ramp,
 * not photography — they are meant to be replaced, and every template names
 * the layer so that is obvious.
 */
export function stockField(id: StockFieldId, width: number, height: number, a: Rgba, b: Rgba): DraftAsset {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const palette = rampPalette(a, b, STOCK_STEPS);
  const indices = new Uint8Array(w * h);
  const amp = 1 / STOCK_STEPS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dither = (BAYER4[(y % 4) * 4 + (x % 4)]! / 16 - 0.5) * amp;
      const t = Math.max(0, Math.min(1, fieldValue(id, x, y, w, h) + dither));
      indices[y * w + x] = Math.round(t * (STOCK_STEPS - 1));
    }
  }
  return {
    name: `Stock field — ${id}`,
    mime: "image/png",
    dataUrl: encodeIndexedPng(w, h, indices, palette),
    width: w,
    height: h,
  };
}

/**
 * The long edge of a generated placeholder. The compositor upsamples with a
 * linear filter; these fields carry no high-frequency detail, so a modest
 * raster stays smooth at print size and keeps the document small enough to
 * structuredClone on every undo step.
 */
const PLACEHOLDER_MAX_EDGE = 384;

/**
 * Placeholder sized to the frame's aspect ratio. Matching the aspect matters:
 * the compositor does not clip image frames, so a "cover" fit on a mismatched
 * asset paints outside the frame.
 */
export function placeholderAsset(
  name: string,
  frameW: number,
  frameH: number,
  field: StockFieldId,
  a: Rgba,
  b: Rgba,
): DraftAsset {
  const scale = Math.min(1, PLACEHOLDER_MAX_EDGE / Math.max(frameW, frameH));
  const w = Math.max(8, Math.round(frameW * scale));
  const h = Math.max(8, Math.round(frameH * scale));
  return { ...stockField(field, w, h, a, b), name };
}

const PAPER_FIELDS: Record<string, { field: StockFieldId; a: string; b: string }> = {
  newsprint: { field: "grain", a: "#C7C1B2", b: "#A29B8B" },
  linen: { field: "halftone-grid", a: "#DAD3C4", b: "#BFB7A5" },
  charcoal: { field: "grain", a: "#26262A", b: "#43434B" },
  warm: { field: "duotone-vertical", a: "#F1DDC2", b: "#DEC29A" },
  cool: { field: "duotone-vertical", a: "#D7E2E9", b: "#B6C6D2" },
  grid: { field: "halftone-grid", a: "#F8F8FA", b: "#A8A8AC" },
};

/** Stock paper texture as a real PNG. No DOM canvas involved. */
export function paperPng(id: string, size = 128): { dataUrl: string; width: number; height: number } {
  const spec = PAPER_FIELDS[id] ?? PAPER_FIELDS.newsprint!;
  const asset = stockField(spec.field, size, size, hex(spec.a), hex(spec.b));
  return { dataUrl: asset.dataUrl, width: asset.width, height: asset.height };
}

export function inkFrom(fg: Rgba): Rgba {
  return { ...fg };
}

/* ================================================================== *
 * Templates
 *
 * Each entry builds a complete PressDocument through the factory: real
 * pages, real layers, real stories, a real grid. One face ships with the
 * app (public/fonts/NotoSans-Regular.ttf, registered as "noto-sans"), so
 * hierarchy here is made with size, measure, colour and space — there is
 * no bold to reach for, and pretending otherwise would render as regular.
 * ================================================================== */

export function hex(value: string, a = 1): Rgba {
  const v = value.replace("#", "");
  const s = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  const x = Number.parseInt(s, 16);
  if (!Number.isFinite(x) || s.length !== 6) return { r: 0, g: 0, b: 0, a };
  return { r: ((x >> 16) & 255) / 255, g: ((x >> 8) & 255) / 255, b: (x & 255) / 255, a };
}

/** The studio palette. Muted, printable, and deliberately not a SaaS accent ramp. */
export const INK = hex("#1A1A1A");
export const PAPER = hex("#FFFFFF");
export const CHALK = hex("#F4F1EA");
export const SAND = hex("#E8E1D5");
export const STONE = hex("#8A8F93");
export const MIST = hex("#C9CFD3");
export const HAIRLINE = hex("#E2E0DB");
export const SLATE = hex("#20262B");
export const NIGHT = hex("#12161A");
export const COPPER = hex("#E07A2F");
export const MOSS = hex("#3C5145");
export const OXBLOOD = hex("#6E2A2A");

export interface TemplateSpec {
  id: string;
  category: PresetCategory;
  /** Sub-group label inside the category. */
  family: string;
  name: string;
  /** What the template actually contains, in one line. */
  blurb: string;
  /** The New Document preset this template is cut for. */
  presetId: string;
  build(name?: string): PressDocument;
}

function fromPreset(presetId: string, name: string): PressDocument {
  const preset = presetById(presetId);
  if (!preset) throw new Error(`template references unknown preset ${presetId}`);
  return documentFromPreset(preset, name);
}

/* --- 1. Concert poster, A2 --------------------------------------- */

function buildConcertPoster(name = "Concert poster"): PressDocument {
  const doc = fromPreset("print-a2-poster", name);
  const page = doc.pages[0]!;
  const g = pageGrid(page);
  const bleed = page.bleedPx;
  const pt = (v: number) => ptToPx(v, doc.ppi);
  page.background = { ...NIGHT };
  draftSwatches(doc, [
    { name: "Night", rgb: NIGHT },
    { name: "Chalk", rgb: CHALK },
    { name: "Copper", rgb: COPPER },
  ]);

  const imgW = page.widthPx + bleed * 2;
  const imgH = 1600;
  draftRect(doc, 0, {
    name: "Backdrop",
    x: -bleed,
    y: -bleed,
    w: imgW,
    h: page.heightPx + bleed * 2,
    fill: NIGHT,
    locked: true,
  });
  draftImage(doc, 0, {
    name: "Poster image — replace",
    x: -bleed,
    y: -bleed,
    w: imgW,
    h: imgH,
    fit: "cover",
    assetId: draftAsset(doc, placeholderAsset("Poster image", imgW, imgH, "duotone-diagonal", COPPER, NIGHT)),
  });

  draftRule(doc, 0, { name: "Kicker rule", x: g.x, y: 1760, w: g.w, weight: 5, color: COPPER });
  const kickerSize = pt(24);
  draftText(doc, 0, {
    name: "Kicker",
    x: g.x,
    y: 1800,
    w: g.w,
    h: frameHeightFor(1, kickerSize, 62),
    text: "SATURDAY 14 MARCH · THE OLD PRESS HALL · DOORS 19:00",
    size: kickerSize,
    leading: 62,
    fill: COPPER,
  });

  const titleSize = pt(240);
  draftText(doc, 0, {
    name: "Title",
    x: g.x,
    y: 1940,
    w: g.w,
    h: frameHeightFor(2, titleSize, 470),
    text: "NIGHT\nPRESS",
    size: titleSize,
    leading: 470,
    fill: CHALK,
  });

  draftRule(doc, 0, { name: "Footer rule", x: g.x, y: 3130, w: g.w, weight: 2, color: hex("#4A5158") });
  const footSize = pt(15);
  const billing = draftText(doc, 0, {
    name: "Billing",
    x: g.x,
    y: 3180,
    w: 1400,
    h: frameHeightFor(3, footSize, 42),
    text: "Support from Marchlight and The Copper Sea\nAges 16+ · Late bar until 02:00\nviropress.example/night",
    size: footSize,
    leading: 42,
    fill: MIST,
  });
  const tickets = draftText(doc, 0, {
    name: "Tickets",
    x: g.x + g.w - 460,
    y: 3180,
    w: 460,
    h: frameHeightFor(2, footSize, 42),
    text: "TICKETS\n£18 ADVANCE",
    size: footSize,
    leading: 42,
    align: "right",
    fill: COPPER,
  });
  draftGroup(doc, 0, "Footer", [billing, tickets]);

  draftGuides(doc, 0, { h: [imgH - bleed, 1940] });
  doc.activeLayerIds = [];
  return doc;
}

/* --- 2. Event flyer, A5 ------------------------------------------- */

function buildEventFlyer(name = "Event flyer"): PressDocument {
  const doc = fromPreset("print-a5", name);
  const page = doc.pages[0]!;
  const g = pageGrid(page);
  const bleed = page.bleedPx;
  const pt = (v: number) => ptToPx(v, doc.ppi);
  page.background = { ...CHALK };
  draftSwatches(doc, [
    { name: "Chalk", rgb: CHALK },
    { name: "Moss", rgb: MOSS },
    { name: "Copper", rgb: COPPER },
  ]);

  const imgW = page.widthPx + bleed * 2;
  const imgH = 1120;
  draftImage(doc, 0, {
    name: "Header image — replace",
    x: -bleed,
    y: -bleed,
    w: imgW,
    h: imgH,
    fit: "cover",
    assetId: draftAsset(doc, placeholderAsset("Header image", imgW, imgH, "duotone-diagonal", MOSS, SAND)),
  });

  draftRule(doc, 0, { name: "Copper bar", x: g.x, y: 1180, w: g.w, weight: 12, color: COPPER });

  const kicker = pt(11);
  draftText(doc, 0, {
    name: "Kicker",
    x: g.x,
    y: 1240,
    w: g.w,
    h: frameHeightFor(1, kicker, 58),
    text: "THE PRESS ROOM · AUTUMN PROGRAMME",
    size: kicker,
    leading: 58,
    fill: MOSS,
  });

  const title = pt(58);
  draftText(doc, 0, {
    name: "Title",
    x: g.x,
    y: 1330,
    w: g.w,
    h: frameHeightFor(2, title, 232),
    text: "Paper,\nInk, Light",
    size: title,
    leading: 232,
    fill: INK,
  });

  const body = pt(13);
  draftText(doc, 0, {
    name: "Standfirst",
    x: g.x,
    y: 1900,
    w: g.w,
    h: frameHeightFor(4, body, 74),
    text:
      "Three evenings of letterpress, lithography and screen printing, with the studio open from six. Bring a sketchbook and leave with something printed.",
    size: body,
    leading: 74,
    fill: INK,
  });

  draftRule(doc, 0, { name: "Detail rule", x: g.x, y: 2240, w: g.w, weight: 2, color: STONE });
  const detail = pt(10);
  draftText(doc, 0, {
    name: "Details",
    x: g.x,
    y: 2280,
    w: g.w,
    h: frameHeightFor(1, detail, 52),
    text: "12–14 November · 6 pm · 44 Wharf Street · Free, no booking",
    size: detail,
    leading: 52,
    fill: INK,
  });

  draftGuides(doc, 0, { h: [imgH - bleed, 1330] });
  doc.activeLayerIds = [];
  return doc;
}

/* --- 3. Business card, two sides ---------------------------------- */

function buildBusinessCard(name = "Business card"): PressDocument {
  const doc = fromPreset("print-card-us", name);
  const front = doc.pages[0]!;
  const back = doc.pages[1]!;
  front.name = "Front";
  back.name = "Back";
  back.background = { ...NIGHT };
  const bleed = front.bleedPx;
  const pt = (v: number) => ptToPx(v, doc.ppi);
  draftSwatches(doc, [
    { name: "Copper", rgb: COPPER },
    { name: "Night", rgb: NIGHT },
  ]);

  draftRect(doc, 0, {
    name: "Edge block",
    x: -bleed,
    y: -bleed,
    w: 120 + bleed,
    h: front.heightPx + bleed * 2,
    fill: COPPER,
    locked: true,
  });
  draftRule(doc, 0, { name: "Name rule", x: 200, y: 205, w: 300, weight: 3, color: COPPER });
  const nameSize = pt(15);
  draftText(doc, 0, {
    name: "Name",
    x: 200,
    y: 245,
    w: 780,
    h: frameHeightFor(1, nameSize, 70),
    text: "Ada Whitfield",
    size: nameSize,
    leading: 70,
    fill: INK,
  });
  const roleSize = pt(8.5);
  draftText(doc, 0, {
    name: "Role",
    x: 200,
    y: 345,
    w: 780,
    h: frameHeightFor(1, roleSize, 44),
    text: "Studio Director · Press & Editions",
    size: roleSize,
    leading: 44,
    fill: STONE,
  });

  draftPath(doc, 1, {
    name: "Register mark",
    x: 880,
    y: 60,
    w: 90,
    h: 90,
    nodes: markNodes("register", 90, 90),
    closed: false,
    fill: null,
    stroke: { color: COPPER, width: 6 },
  });
  const studioSize = pt(10);
  draftText(doc, 1, {
    name: "Studio",
    x: 80,
    y: 140,
    w: 700,
    h: frameHeightFor(1, studioSize, 50),
    text: "WHITFIELD PRESS",
    size: studioSize,
    leading: 50,
    fill: COPPER,
  });
  const contactSize = pt(9);
  draftText(doc, 1, {
    name: "Contact",
    x: 80,
    y: 240,
    w: 780,
    h: frameHeightFor(4, contactSize, 52),
    text: "ada@viropress.example\n+44 113 496 0188\n44 Wharf Street, Leeds LS2\nviropress.example",
    size: contactSize,
    leading: 52,
    fill: CHALK,
  });

  doc.activeLayerIds = [];
  return doc;
}

/* --- 4. Letterhead, US Letter ------------------------------------- */

function buildLetterhead(name = "Letterhead"): PressDocument {
  const doc = fromPreset("print-letter", name);
  const page = doc.pages[0]!;
  const g = pageGrid(page);
  const pt = (v: number) => ptToPx(v, doc.ppi);
  draftSwatches(doc, [
    { name: "Ink", rgb: INK },
    { name: "Copper", rgb: COPPER },
  ]);

  const mark = draftPath(doc, 0, {
    name: "Mark",
    x: g.x,
    y: 162,
    w: 72,
    h: 72,
    nodes: markNodes("diamond", 72, 72),
    closed: true,
    fill: COPPER,
  });
  const logoSize = pt(20);
  const logotype = draftText(doc, 0, {
    name: "Logotype",
    x: g.x + 108,
    y: 150,
    w: 1100,
    h: frameHeightFor(1, logoSize, 92),
    text: "WHITFIELD PRESS",
    size: logoSize,
    leading: 92,
    fill: INK,
  });
  const senderSize = pt(8.5);
  const sender = draftText(doc, 0, {
    name: "Sender",
    x: g.x + g.w - 750,
    y: 150,
    w: 750,
    h: frameHeightFor(4, senderSize, 46),
    text: "44 Wharf Street\nLeeds LS2 7EQ\n+44 113 496 0188\nviropress.example",
    size: senderSize,
    leading: 46,
    align: "right",
    fill: STONE,
  });
  draftGroup(doc, 0, "Masthead", [mark, logotype, sender]);
  draftRule(doc, 0, { name: "Masthead rule", x: g.x, y: 400, w: g.w, weight: 3, color: INK });

  const metaSize = pt(10);
  draftText(doc, 0, {
    name: "Date",
    x: g.x,
    y: 520,
    w: 900,
    h: frameHeightFor(1, metaSize, 54),
    text: "14 March 2026",
    size: metaSize,
    leading: 54,
    fill: STONE,
  });
  const bodySize = pt(10.5);
  draftText(doc, 0, {
    name: "Recipient",
    x: g.x,
    y: 640,
    w: 900,
    h: frameHeightFor(3, bodySize, 58),
    text: "Marchlight Editions\nAttn: Commissioning\n12 Foundry Row, Sheffield S1 2GH",
    size: bodySize,
    leading: 58,
    fill: INK,
  });

  // 1500 px at 43.75 px type is a measure of roughly 68 characters.
  draftText(doc, 0, {
    name: "Body",
    x: g.x,
    y: 900,
    w: 1500,
    h: frameHeightFor(20, bodySize, 62),
    text:
      "Dear Ida,\n\nThank you for sending the proofs. We have set the whole of section two in 10.5 on 14 Plantin and the measure now runs to sixty-six characters, which is where it should have been from the start. The rag on the right is even and there are no rivers left in the second column.\n\nWe can hold press time on the fourteenth if the corrected files reach us by the sixth. Paper is confirmed: 120 gsm laid, cream, from the same making as the first edition.\n\nOne question remains on the half title. I would rather set it small and let the sheet carry the weight than fill the page.",
    size: bodySize,
    leading: 62,
    fill: INK,
  });
  draftText(doc, 0, {
    name: "Sign-off",
    x: g.x,
    y: 2680,
    w: 900,
    h: frameHeightFor(3, bodySize, 62),
    text: "Yours,\n\nAda Whitfield",
    size: bodySize,
    leading: 62,
    fill: INK,
  });

  draftRule(doc, 0, { name: "Footer rule", x: g.x, y: 3000, w: g.w, weight: 1.5, color: HAIRLINE });
  const footSize = pt(8);
  draftText(doc, 0, {
    name: "Footer",
    x: g.x,
    y: 3040,
    w: g.w,
    h: frameHeightFor(1, footSize, 42),
    text: "Whitfield Press Ltd · Registered in England 09934411 · VAT GB 274 9930 55",
    size: footSize,
    leading: 42,
    fill: STONE,
  });

  draftGuides(doc, 0, { h: [400, 900, 3000] });
  doc.activeLayerIds = [];
  return doc;
}

/* --- 5. Editorial, A4 facing pages -------------------------------- */

function buildEditorial(name = "Editorial"): PressDocument {
  const doc = fromPreset("print-magazine-a4", name);
  const cover = doc.pages[0]!;
  const verso = doc.pages[1]!;
  const recto = doc.pages[2]!;
  cover.name = "Cover";
  verso.name = "24 — Opening image";
  recto.name = "25 — Article opening";
  cover.background = { ...NIGHT };
  const bleed = cover.bleedPx;
  const pt = (v: number) => ptToPx(v, doc.ppi);
  draftSwatches(doc, [
    { name: "Night", rgb: NIGHT },
    { name: "Copper", rgb: COPPER },
    { name: "Mist", rgb: MIST },
  ]);

  /* Cover */
  const cg = pageGrid(cover);
  const coverW = cover.widthPx + bleed * 2;
  const coverH = cover.heightPx + bleed * 2;
  draftImage(doc, 0, {
    name: "Cover image — replace",
    x: -bleed,
    y: -bleed,
    w: coverW,
    h: coverH,
    fit: "cover",
    opacity: 0.85,
    assetId: draftAsset(doc, placeholderAsset("Cover image", coverW, coverH, "radial-bloom", SLATE, NIGHT)),
  });
  const mastSize = pt(96);
  draftText(doc, 0, {
    name: "Masthead",
    x: cg.x,
    y: cg.y,
    w: cg.w,
    h: frameHeightFor(1, mastSize, 400),
    text: "PRESS",
    size: mastSize,
    leading: 400,
    fill: CHALK,
  });
  draftRule(doc, 0, { name: "Issue rule", x: cg.x, y: 760, w: cg.w, weight: 4, color: COPPER });
  const issueSize = pt(13);
  draftText(doc, 0, {
    name: "Issue line",
    x: cg.x,
    y: 800,
    w: cg.w,
    h: frameHeightFor(1, issueSize, 66),
    text: "ISSUE 07 · TYPE, PAPER AND THE SLOW WEB · SPRING",
    size: issueSize,
    leading: 66,
    fill: COPPER,
  });
  const coverLineSize = pt(44);
  draftText(doc, 0, {
    name: "Cover line",
    x: cg.x,
    y: 2400,
    w: 1500,
    h: frameHeightFor(3, coverLineSize, 190),
    text: "The quiet\nreturn of the\nprinted page",
    size: coverLineSize,
    leading: 190,
    fill: CHALK,
  });
  const sellSize = pt(12);
  draftText(doc, 0, {
    name: "Cover sell",
    x: cg.x,
    y: 3080,
    w: 1500,
    h: frameHeightFor(2, sellSize, 64),
    text: "Twelve studios on why they went back to ink, and what it cost them.",
    size: sellSize,
    leading: 64,
    fill: MIST,
  });

  /* Verso — full-bleed opening image */
  const vg = pageGrid(verso);
  const vImgH = 2600;
  draftImage(doc, 1, {
    name: "Opening image — replace",
    x: -bleed,
    y: -bleed,
    w: coverW,
    h: vImgH,
    fit: "cover",
    assetId: draftAsset(doc, placeholderAsset("Opening image", coverW, vImgH, "duotone-vertical", SLATE, MIST)),
  });
  const capSize = pt(9);
  draftText(doc, 1, {
    name: "Caption",
    x: vg.x,
    y: 2680,
    w: 1400,
    h: frameHeightFor(3, capSize, 50),
    text:
      "Composing stick and a case of 12 pt Plantin at the Wharf Street works, photographed in February.",
    size: capSize,
    leading: 50,
    fill: INK,
  });
  draftText(doc, 1, {
    name: "Folio",
    x: vg.x,
    y: 3290,
    w: 500,
    h: frameHeightFor(1, capSize, 46),
    text: "24 · PRESS 07",
    size: capSize,
    leading: 46,
    fill: STONE,
  });

  /* Recto — three-column grid, two-column measure */
  const rg = pageGrid(recto);
  draftColumnGuides(doc, 2);
  draftRule(doc, 2, { name: "Kicker rule", x: rg.x, y: rg.y, w: rg.w, weight: 4, color: COPPER });
  const rKicker = pt(10);
  draftText(doc, 2, {
    name: "Kicker",
    x: rg.x,
    y: 220,
    w: rg.w,
    h: frameHeightFor(1, rKicker, 52),
    text: "REPORT · THE SLOW WEB",
    size: rKicker,
    leading: 52,
    fill: COPPER,
  });
  const headSize = pt(52);
  draftText(doc, 2, {
    name: "Headline",
    x: rg.x,
    y: 320,
    w: rg.w,
    h: frameHeightFor(2, headSize, 224),
    text: "Setting the\nrecord straight",
    size: headSize,
    leading: 224,
    fill: INK,
  });
  const standSize = pt(14);
  draftText(doc, 2, {
    name: "Standfirst",
    x: rg.x,
    y: 900,
    w: 1400,
    h: frameHeightFor(5, standSize, 76),
    text:
      "For twenty years the argument was that print was slower. It was, and that turned out to be the point. A report from the studios that never stopped setting metal.",
    size: standSize,
    leading: 76,
    fill: INK,
  });

  const sideSize = pt(9);
  draftText(doc, 2, {
    name: "Sidebar note",
    x: Math.round(rg.colX(0)),
    y: 1400,
    w: Math.round(rg.columnWidth),
    h: frameHeightFor(8, sideSize, 52),
    text:
      "Plantin was cut for the Monotype Corporation in 1913 and still sets the house style at Wharf Street.",
    size: sideSize,
    leading: 52,
    fill: STONE,
  });
  const quoteSize = pt(18);
  draftText(doc, 2, {
    name: "Pull quote",
    x: Math.round(rg.colX(0)),
    y: 2100,
    w: Math.round(rg.columnWidth),
    h: frameHeightFor(6, quoteSize, 88),
    text: "‘We set it by hand because the hand can see the line.’",
    size: quoteSize,
    leading: 88,
    fill: COPPER,
  });

  const colBody = pt(10.5);
  draftText(doc, 2, {
    name: "Body — columns 2–3",
    x: Math.round(rg.colX(1)),
    y: 1400,
    w: Math.round(rg.colSpan(1, 2)),
    h: frameHeightFor(28, colBody, 60),
    text:
      "The composing room at Wharf Street has not changed its working hours since 1974. Cases are pulled at eight, the stone is cleared at six, and the sheets that come off the press in between are the same sheets a reader will hold a month later.\n\nWhat changed is the argument around it. For most of two decades the studio was told that setting type by hand was nostalgia with an invoice attached. The reply, when it came, was not an argument at all. It was a stack of books that had survived being read.\n\n“You can tell within a page,” says Whitfield, turning a signature over. “The measure is right or it is not. Nobody needs to be told which.” The house measure here is sixty-six characters, and it has been for fifty years.",
    size: colBody,
    leading: 60,
    fill: INK,
  });
  draftText(doc, 2, {
    name: "Folio",
    x: rg.x + rg.w - 500,
    y: 3290,
    w: 500,
    h: frameHeightFor(1, capSize, 46),
    text: "PRESS 07 · 25",
    size: capSize,
    leading: 46,
    align: "right",
    fill: STONE,
  });

  doc.activePageId = recto.id;
  doc.activeLayerIds = [];
  return doc;
}

/* --- 6. Quote card, square ---------------------------------------- */

function buildQuoteCard(name = "Quote card"): PressDocument {
  const doc = fromPreset("social-square", name);
  const page = doc.pages[0]!;
  const g = pageGrid(page);
  page.background = { ...CHALK };
  draftSwatches(doc, [
    { name: "Chalk", rgb: CHALK },
    { name: "Copper", rgb: COPPER },
  ]);

  draftRule(doc, 0, { name: "Opening rule", x: g.x, y: 200, w: 160, weight: 8, color: COPPER });
  draftText(doc, 0, {
    name: "Quote",
    x: g.x,
    y: 280,
    w: 880,
    h: frameHeightFor(4, 66, 84),
    text: "Type is not decoration. It is the argument, set in a form you can read.",
    size: 66,
    leading: 84,
    fill: INK,
  });
  draftText(doc, 0, {
    name: "Attribution",
    x: g.x,
    y: 700,
    w: 880,
    h: frameHeightFor(2, 30, 40),
    text: "Ada Whitfield\nStudio Director, Whitfield Press",
    size: 30,
    leading: 40,
    fill: STONE,
  });

  draftRule(doc, 0, { name: "Footer rule", x: g.x, y: 900, w: g.w, weight: 2, color: hex("#C6C2B8") });
  const handle = draftText(doc, 0, {
    name: "Handle",
    x: g.x,
    y: 930,
    w: 500,
    h: frameHeightFor(1, 26, 34),
    text: "@whitfieldpress",
    size: 26,
    leading: 34,
    fill: STONE,
  });
  const series = draftText(doc, 0, {
    name: "Series",
    x: g.x + g.w - 400,
    y: 930,
    w: 400,
    h: frameHeightFor(1, 26, 34),
    text: "NOTES ON TYPE · 04",
    size: 26,
    leading: 34,
    align: "right",
    fill: COPPER,
  });
  draftGroup(doc, 0, "Footer", [handle, series]);

  doc.activeLayerIds = [];
  return doc;
}

/* --- 7. Launch story, 9:16 ---------------------------------------- */

function buildLaunchStory(name = "Launch story"): PressDocument {
  const doc = fromPreset("social-story", name);
  const page = doc.pages[0]!;
  page.background = { ...NIGHT };
  draftSwatches(doc, [
    { name: "Night", rgb: NIGHT },
    { name: "Copper", rgb: COPPER },
    { name: "Mist", rgb: MIST },
  ]);

  const imgH = 940;
  draftImage(doc, 0, {
    name: "Story image — replace",
    x: 0,
    y: 0,
    w: page.widthPx,
    h: imgH,
    fit: "cover",
    assetId: draftAsset(doc, placeholderAsset("Story image", page.widthPx, imgH, "duotone-diagonal", COPPER, NIGHT)),
  });

  draftText(doc, 0, {
    name: "Kicker",
    x: 80,
    y: 1010,
    w: 920,
    h: frameHeightFor(1, 34, 44),
    text: "NEW THIS WEEK",
    size: 34,
    leading: 44,
    fill: COPPER,
  });
  draftText(doc, 0, {
    name: "Headline",
    x: 80,
    y: 1110,
    w: 920,
    h: frameHeightFor(2, 96, 100),
    text: "The Wharf\nStreet Press",
    size: 96,
    leading: 100,
    fill: CHALK,
  });
  draftText(doc, 0, {
    name: "Body",
    x: 80,
    y: 1400,
    w: 860,
    h: frameHeightFor(3, 34, 46),
    text: "Twelve new editions, printed in the studio and numbered by hand. Open from Thursday.",
    size: 34,
    leading: 46,
    fill: MIST,
  });

  const bar = draftRect(doc, 0, {
    name: "Call-to-action bar",
    x: 80,
    y: 1560,
    w: 480,
    h: 96,
    fill: COPPER,
  });
  const label = draftText(doc, 0, {
    name: "Call-to-action label",
    x: 80,
    y: 1586,
    w: 480,
    h: frameHeightFor(1, 34, 44),
    text: "SEE THE EDITIONS",
    size: 34,
    leading: 44,
    align: "center",
    fill: NIGHT,
  });
  draftGroup(doc, 0, "Call to action", [bar, label]);

  // The page margins already mark the 250 px platform-UI zone; these repeat it
  // as movable guides so a beginner can see why the type starts where it does.
  draftGuides(doc, 0, { h: [250, page.heightPx - 250] });
  doc.activeLayerIds = [];
  return doc;
}

/* --- 8. Product post, 4:5 ----------------------------------------- */

function buildProductPost(name = "Product post"): PressDocument {
  const doc = fromPreset("social-portrait", name);
  const page = doc.pages[0]!;
  const g = pageGrid(page);
  page.background = { ...SAND };
  draftSwatches(doc, [
    { name: "Sand", rgb: SAND },
    { name: "Copper", rgb: COPPER },
    { name: "Ink", rgb: INK },
  ]);

  draftImage(doc, 0, {
    name: "Product image — replace",
    x: g.x,
    y: g.y,
    w: g.w,
    h: 792,
    fit: "cover",
    assetId: draftAsset(doc, placeholderAsset("Product image", g.w, 792, "radial-bloom", CHALK, MOSS)),
  });
  const badge = draftRect(doc, 0, {
    name: "Price badge",
    x: g.x,
    y: g.y,
    w: 220,
    h: 88,
    fill: COPPER,
  });
  const price = draftText(doc, 0, {
    name: "Price",
    x: g.x,
    y: 82,
    w: 220,
    h: frameHeightFor(1, 40, 50),
    text: "£48",
    size: 40,
    leading: 50,
    align: "center",
    fill: NIGHT,
  });
  draftGroup(doc, 0, "Price tag", [badge, price]);

  draftText(doc, 0, {
    name: "Title",
    x: g.x,
    y: 920,
    w: g.w,
    h: frameHeightFor(1, 62, 72),
    text: "Wharf Street Notebook",
    size: 62,
    leading: 72,
    fill: INK,
  });
  draftText(doc, 0, {
    name: "Body",
    x: g.x,
    y: 1030,
    w: 720,
    h: frameHeightFor(3, 30, 42),
    text: "Sewn signatures, 120 gsm laid paper, letterpressed cover. Made in the studio in runs of fifty.",
    size: 30,
    leading: 42,
    fill: INK,
  });

  draftRule(doc, 0, { name: "Footer rule", x: g.x, y: 1210, w: g.w, weight: 2, color: hex("#C4BDAE") });
  draftText(doc, 0, {
    name: "Site",
    x: g.x,
    y: 1240,
    w: 600,
    h: frameHeightFor(1, 26, 34),
    text: "whitfieldpress.example",
    size: 26,
    leading: 34,
    fill: hex("#6C6A64"),
  });
  draftText(doc, 0, {
    name: "Edition size",
    x: g.x + g.w - 300,
    y: 1240,
    w: 300,
    h: frameHeightFor(1, 26, 34),
    text: "50 MADE",
    size: 26,
    leading: 34,
    align: "right",
    fill: COPPER,
  });

  doc.activeLayerIds = [];
  return doc;
}

/* --- 9. Landing hero, desktop ------------------------------------- */

function buildLandingHero(name = "Landing hero"): PressDocument {
  const doc = fromPreset("screen-desktop-1440", name);
  const page = doc.pages[0]!;
  const g = pageGrid(page);
  page.background = { ...PAPER };
  draftColumnGuides(doc, 0);
  draftSwatches(doc, [
    { name: "Ink", rgb: INK },
    { name: "Copper", rgb: COPPER },
    { name: "Hairline", rgb: HAIRLINE },
  ]);

  const wordmark = draftText(doc, 0, {
    name: "Wordmark",
    x: g.x,
    y: 48,
    w: 320,
    h: frameHeightFor(1, 22, 28),
    text: "WHITFIELD PRESS",
    size: 22,
    leading: 28,
    fill: INK,
  });
  const nav = draftText(doc, 0, {
    name: "Navigation",
    x: g.x + g.w - 520,
    y: 48,
    w: 520,
    h: frameHeightFor(1, 18, 26),
    text: "Editions    Studio    Journal    Contact",
    size: 18,
    leading: 26,
    align: "right",
    fill: STONE,
  });
  const navRule = draftRule(doc, 0, { name: "Navigation rule", x: g.x, y: 112, w: g.w, weight: 1, color: HAIRLINE });
  draftGroup(doc, 0, "Navigation bar", [wordmark, nav, navRule]);

  draftText(doc, 0, {
    name: "Hero headline",
    x: g.x,
    y: 240,
    w: Math.round(g.colSpan(0, 7)),
    h: frameHeightFor(3, 76, 84),
    text: "Printing is\nthinking with\nyour hands",
    size: 76,
    leading: 84,
    fill: INK,
  });
  draftText(doc, 0, {
    name: "Hero body",
    x: g.x,
    y: 552,
    w: 600,
    h: frameHeightFor(4, 22, 34),
    text:
      "A working press in Leeds. Short-run books, editions and identities, set in metal and printed on a 1962 Heidelberg.",
    size: 22,
    leading: 34,
    fill: STONE,
  });

  const primary = draftRect(doc, 0, { name: "Primary button", x: g.x, y: 700, w: 220, h: 56, fill: INK });
  const primaryLabel = draftText(doc, 0, {
    name: "Primary label",
    x: g.x,
    y: 715,
    w: 220,
    h: frameHeightFor(1, 20, 28),
    text: "See editions",
    size: 20,
    leading: 28,
    align: "center",
    fill: PAPER,
  });
  draftGroup(doc, 0, "Primary action", [primary, primaryLabel]);

  const secondary = draftRect(doc, 0, {
    name: "Secondary button",
    x: g.x + 240,
    y: 700,
    w: 220,
    h: 56,
    fill: null,
    stroke: { color: INK, width: 2 },
  });
  const secondaryLabel = draftText(doc, 0, {
    name: "Secondary label",
    x: g.x + 240,
    y: 715,
    w: 220,
    h: frameHeightFor(1, 20, 28),
    text: "Visit the studio",
    size: 20,
    leading: 28,
    align: "center",
    fill: INK,
  });
  draftGroup(doc, 0, "Secondary action", [secondary, secondaryLabel]);

  const heroX = Math.round(g.colX(8));
  const heroW = Math.round(g.colSpan(8, 4));
  draftImage(doc, 0, {
    name: "Hero image — replace",
    x: heroX,
    y: 240,
    w: heroW,
    h: 620,
    fit: "cover",
    assetId: draftAsset(doc, placeholderAsset("Hero image", heroW, 620, "duotone-vertical", SLATE, MIST)),
  });
  draftText(doc, 0, {
    name: "Hero caption",
    x: heroX,
    y: 880,
    w: heroW,
    h: frameHeightFor(2, 16, 24),
    text: "No. 12 — Marchlight, 64 pp, hand-sewn.",
    size: 16,
    leading: 24,
    fill: STONE,
  });

  doc.activeLayerIds = [];
  return doc;
}

/* --- 10. App screen, iOS ------------------------------------------ */

function buildAppScreen(name = "App screen"): PressDocument {
  const doc = fromPreset("mobile-iphone-16", name);
  const page = doc.pages[0]!;
  const g = pageGrid(page);
  page.background = { ...CHALK };
  draftSwatches(doc, [
    { name: "Chalk", rgb: CHALK },
    { name: "Copper", rgb: COPPER },
    { name: "Hairline", rgb: HAIRLINE },
  ]);

  const appBar = draftRect(doc, 0, { name: "App bar", x: 0, y: 0, w: page.widthPx, h: 96, fill: PAPER });
  const appBarRule = draftRule(doc, 0, {
    name: "App bar rule",
    x: 0,
    y: 95,
    w: page.widthPx,
    weight: 1,
    color: HAIRLINE,
  });
  const screenTitle = draftText(doc, 0, {
    name: "Screen title",
    x: g.x,
    y: 44,
    w: 240,
    h: frameHeightFor(1, 24, 30),
    text: "Editions",
    size: 24,
    leading: 30,
    fill: INK,
  });
  const action = draftText(doc, 0, {
    name: "Bar action",
    x: g.x + g.w - 90,
    y: 48,
    w: 90,
    h: frameHeightFor(1, 16, 22),
    text: "Filter",
    size: 16,
    leading: 22,
    align: "right",
    fill: COPPER,
  });
  draftGroup(doc, 0, "App bar", [appBar, appBarRule, screenTitle, action]);

  const cardW = g.w;
  const heroCard = draftRect(doc, 0, { name: "Feature card", x: g.x, y: 120, w: cardW, h: 200, fill: PAPER });
  const cardImg = draftImage(doc, 0, {
    name: "Feature image — replace",
    x: g.x,
    y: 120,
    w: cardW,
    h: 128,
    fit: "cover",
    assetId: draftAsset(doc, placeholderAsset("Feature image", cardW, 128, "duotone-diagonal", MOSS, CHALK)),
  });
  const cardTitle = draftText(doc, 0, {
    name: "Feature title",
    x: g.x + 16,
    y: 262,
    w: 260,
    h: frameHeightFor(1, 18, 24),
    text: "Marchlight, No. 12",
    size: 18,
    leading: 24,
    fill: INK,
  });
  const cardMeta = draftText(doc, 0, {
    name: "Feature meta",
    x: g.x + 16,
    y: 292,
    w: 260,
    h: frameHeightFor(1, 13, 18),
    text: "64 pp · hand-sewn · £48",
    size: 13,
    leading: 18,
    fill: STONE,
  });
  draftGroup(doc, 0, "Feature card", [heroCard, cardImg, cardTitle, cardMeta]);

  const rowAsset = draftAsset(doc, placeholderAsset("List thumbnail", 48, 48, "halftone-grid", SAND, SLATE));
  const rows = [
    { title: "Foundry Row", meta: "Letterpress · 32 pp" },
    { title: "The Copper Sea", meta: "Litho · 96 pp" },
    { title: "Notes on Measure", meta: "Screen print · 16 pp" },
  ];
  rows.forEach((row, i) => {
    const y = 344 + i * 80;
    const bg = draftRect(doc, 0, { name: `Row ${i + 1}`, x: g.x, y, w: cardW, h: 72, fill: PAPER });
    const thumb = draftImage(doc, 0, {
      name: `Row ${i + 1} thumbnail`,
      x: g.x + 12,
      y: y + 12,
      w: 48,
      h: 48,
      fit: "cover",
      assetId: rowAsset,
    });
    const title = draftText(doc, 0, {
      name: `Row ${i + 1} title`,
      x: g.x + 76,
      y: y + 18,
      w: 200,
      h: frameHeightFor(1, 15, 20),
      text: row.title,
      size: 15,
      leading: 20,
      fill: INK,
    });
    const meta = draftText(doc, 0, {
      name: `Row ${i + 1} meta`,
      x: g.x + 76,
      y: y + 42,
      w: 200,
      h: frameHeightFor(1, 12, 16),
      text: row.meta,
      size: 12,
      leading: 16,
      fill: STONE,
    });
    draftGroup(doc, 0, `List row ${i + 1}`, [bg, thumb, title, meta]);
  });

  const tabBar = draftRect(doc, 0, {
    name: "Tab bar",
    x: 0,
    y: 772,
    w: page.widthPx,
    h: page.heightPx - 772,
    fill: PAPER,
  });
  const tabRule = draftRule(doc, 0, { name: "Tab bar rule", x: 0, y: 772, w: page.widthPx, weight: 1, color: HAIRLINE });
  const tabIds = [tabBar, tabRule];
  const tabs = ["Shop", "Journal", "Studio", "You"];
  const tabW = page.widthPx / tabs.length;
  tabs.forEach((tab, i) => {
    tabIds.push(
      draftText(doc, 0, {
        name: `Tab — ${tab}`,
        x: Math.round(i * tabW),
        y: 806,
        w: Math.round(tabW),
        h: frameHeightFor(1, 12, 16),
        text: tab,
        size: 12,
        leading: 16,
        align: "center",
        fill: i === 0 ? COPPER : STONE,
      }),
    );
  });
  tabIds.push(
    draftRule(doc, 0, {
      name: "Active tab marker",
      x: Math.round(tabW * 0.3),
      y: 794,
      w: Math.round(tabW * 0.4),
      weight: 3,
      color: COPPER,
    }),
  );
  draftGroup(doc, 0, "Tab bar", tabIds);

  doc.activeLayerIds = [];
  return doc;
}

export const TEMPLATES: TemplateSpec[] = [
  {
    id: "poster-a2-concert",
    category: "print",
    family: "Posters",
    name: "Concert poster — A2",
    blurb: "Full-bleed image, 240 pt display title on a night ground, billing and ticket block on a footer rule.",
    presetId: "print-a2-poster",
    build: buildConcertPoster,
  },
  {
    id: "flyer-a5-event",
    category: "print",
    family: "Flyers & leaflets",
    name: "Event flyer — A5",
    blurb: "Header image to the bleed, copper bar, 58 pt title, standfirst and a single detail line.",
    presetId: "print-a5",
    build: buildEventFlyer,
  },
  {
    id: "card-business-us",
    category: "print",
    family: "Stationery",
    name: "Business card — two sides",
    blurb: "Front and back as two pages: copper edge block and name on page 1, contact block and register mark on page 2.",
    presetId: "print-card-us",
    build: buildBusinessCard,
  },
  {
    id: "letterhead-us",
    category: "print",
    family: "Stationery",
    name: "Letterhead — US Letter",
    blurb: "Masthead group, sender block, a 68-character body measure at 10.5/14.9, and a registration footer.",
    presetId: "print-letter",
    build: buildLetterhead,
  },
  {
    id: "editorial-a4",
    category: "print",
    family: "Editorial",
    name: "Editorial opening — A4",
    blurb: "Cover, full-bleed verso with caption and folio, and a recto on a three-column grid with a two-column measure.",
    presetId: "print-magazine-a4",
    build: buildEditorial,
  },
  {
    id: "social-quote-square",
    category: "social",
    family: "Feed",
    name: "Quote card — square",
    blurb: "Opening rule, 66 px quote at a 3-line measure, attribution, and a footer split between handle and series.",
    presetId: "social-square",
    build: buildQuoteCard,
  },
  {
    id: "social-story-launch",
    category: "social",
    family: "Vertical video",
    name: "Launch story — 9:16",
    blurb: "Top image, kicker, two-line headline and a copper call-to-action, all inside the 250 px safe zone.",
    presetId: "social-story",
    build: buildLaunchStory,
  },
  {
    id: "social-product-portrait",
    category: "social",
    family: "Feed",
    name: "Product post — 4:5",
    blurb: "Product frame with a price badge, title, specification line and a two-part footer.",
    presetId: "social-portrait",
    build: buildProductPost,
  },
  {
    id: "web-landing-hero",
    category: "screen",
    family: "Web",
    name: "Landing hero — desktop",
    blurb: "Twelve-column grid: navigation bar, 7-column headline, two buttons, and a 4-column image with caption.",
    presetId: "screen-desktop-1440",
    build: buildLandingHero,
  },
  {
    id: "app-screen-ios",
    category: "mobile",
    family: "iOS",
    name: "App screen — list",
    blurb: "App bar, feature card, three grouped list rows sharing one thumbnail asset, and a four-item tab bar.",
    presetId: "mobile-iphone-16",
    build: buildAppScreen,
  },
];

export function templateById(id: string): TemplateSpec | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templatesIn(category: PresetCategory): TemplateSpec[] {
  return TEMPLATES.filter((t) => t.category === category);
}

/** Build a template's document. Returns null rather than throwing on an unknown id. */
export function documentFromTemplate(id: string, name?: string): PressDocument | null {
  const spec = templateById(id);
  if (!spec) return null;
  return spec.build(name ?? spec.name);
}

/**
 * Thumbnail for a template picker. Vectors are drawn as they are; type is
 * greeked to bars on the story's own leading; image frames get the DTP
 * empty-box cross. It is a plan of the layout, not a render — the render is
 * Skia's job and needs the engines up.
 */
export function documentPreviewSvg(doc: PressDocument, maxEdge = 240, pageIndex = 0): string {
  const page = doc.pages[pageIndex] ?? doc.pages[0]!;
  const scale = maxEdge / Math.max(page.widthPx, page.heightPx);
  const w = Math.round(page.widthPx * scale);
  const h = Math.round(page.heightPx * scale);
  const css = (c: Rgba) =>
    `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)} / ${c.a})`;
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${css(page.background)}"/>`];

  for (const layer of page.layers) {
    if (!layer.visible || layer.kind === "group" || layer.kind === "adjustment") continue;
    const t = layer.transform;
    const x = t.x * scale;
    const y = t.y * scale;
    const lw = t.w * scale;
    const lh = t.h * scale;
    if (layer.kind === "vector") {
      const d = svgPath(
        layer.nodes.map((p) => ({
          x: p.x * scale,
          y: p.y * scale,
          inX: p.inX * scale,
          inY: p.inY * scale,
          outX: p.outX * scale,
          outY: p.outY * scale,
        })),
        layer.closed,
      );
      const fill = layer.fill && layer.closed
        ? css(isGradientFill(layer.fill) ? layer.fill.stops[0]!.color : layer.fill)
        : "none";
      const stroke = layer.stroke ? css(layer.stroke.color) : "none";
      const sw = layer.stroke ? Math.max(0.4, layer.stroke.width * scale) : 0;
      parts.push(
        `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})" opacity="${layer.opacity}"><path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw.toFixed(2)}"/></g>`,
      );
    } else if (layer.kind === "type-frame") {
      const story = doc.stories.find((s) => s.id === layer.storyId);
      if (!story) continue;
      const lead = Math.max(1.2, story.character.leading * scale);
      const bar = Math.max(0.8, story.character.size * scale * 0.62);
      const lines = Math.max(1, Math.floor((lh - bar) / lead) + 1);
      for (let i = 0; i < lines; i++) {
        const last = i === lines - 1 && lines > 1;
        parts.push(
          `<rect x="${x.toFixed(2)}" y="${(y + i * lead).toFixed(2)}" width="${(lw * (last ? 0.62 : 1)).toFixed(2)}" height="${bar.toFixed(2)}" fill="${css(story.character.fill)}" opacity="${(layer.opacity * 0.82).toFixed(2)}"/>`,
        );
      }
    } else {
      parts.push(
        `<g opacity="${layer.opacity}"><rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${lw.toFixed(2)}" height="${lh.toFixed(2)}" fill="#cfcfcf" stroke="#9a9a9a" stroke-width="0.6"/>` +
          `<path d="M${x.toFixed(2)} ${y.toFixed(2)}L${(x + lw).toFixed(2)} ${(y + lh).toFixed(2)}M${(x + lw).toFixed(2)} ${y.toFixed(2)}L${x.toFixed(2)} ${(y + lh).toFixed(2)}" stroke="#9a9a9a" stroke-width="0.6" fill="none"/></g>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join("")}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
