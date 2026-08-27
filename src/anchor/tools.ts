/**
 * Anchor — the op catalogue an AI authors and edits VIRO Press documents through.
 *
 * The law (DESK-CHROME.md): Anchor emits `{ id, op, target, params, reason }` against the
 * Press document graph. It does not flatten pixels and hope. Every op in this file lands as a
 * structured mutation of `PressDocument`, so whatever the model makes is a real layer the user
 * can select, move, restyle, and undo like any hand-made object.
 *
 * Two rules hold this file honest:
 *  1. Every advertised tool is derived from the same record that holds its implementation
 *     (`OPS` below), so a tool cannot exist without a working `run`.
 *  2. Nothing is advertised that the underlying primitive cannot really do. Where a field is
 *     written to the graph but not yet honoured by the compositor, the description says so.
 */

import type {
  Align,
  BlendMode,
  ImageFit,
  Layer,
  PathNode,
  PressDocument,
  Rgba,
  VectorLayer,
  VectorStroke,
} from "../document/types";
import { SKIA_BLEND } from "../document/types";
import {
  booleanCombineVectors,
  requireBooleanEngine,
  type BooleanOp,
} from "../document/boolean-ops";
import {
  activePage,
  addGuide,
  addImageFrame,
  addTypeFrame,
  addVectorLayer,
  applyImageSize,
  ellipseNodes,
  findLayer,
  lineNodes,
  polygonNodes,
  roundRectNodes,
  starNodes,
} from "../document/factory";
import {
  addAdjustment,
  addPage,
  applyBooleanCombine,
  appendPathNode,
  applyFill,
  closePath,
  deleteSelected,
  duplicateSelected,
  groupSelected,
  reorderLayer,
  selectIntersecting,
  setActiveLayers,
  setActivePage,
  setCharacter,
  setImageCrop,
  setImageFit,
  setImageFocal,
  setLayerBlend,
  setLayerLocked,
  setLayerName,
  setLayerOpacity,
  setLayerTransform,
  setLayerVisible,
  setParagraphAlign,
  setParagraphSpacing,
  setStoryText,
  ungroupSelected,
} from "../document/ops";

/* ------------------------------------------------------------------ *
 * Public shapes
 * ------------------------------------------------------------------ */

export interface AnchorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One op in the batch. Canonical envelope per DESK-CHROME.md. */
export interface AnchorOp {
  /** Caller-assigned id for this op. Echoed back in results and in error messages. */
  id?: string;
  /** Tool name, e.g. "press.set_transform". `name` is accepted as an alias. */
  op: string;
  /** Layer id, layer ids, or page id this op acts on. May also be passed inside `params`. */
  target?: string | string[];
  /** Tool arguments. Flat top-level arguments are accepted too. */
  params?: Record<string, unknown>;
  /** Why this change is being made. Required — this is the audit trail. */
  reason: string;
  [k: string]: unknown;
}

/** Rejected op. Nothing has been applied when this is thrown: the batch is all-or-nothing. */
export class AnchorOpError extends Error {
  readonly index: number;
  readonly opId: string | null;
  readonly opName: string;
  constructor(message: string, index: number, opId: string | null, opName: string) {
    const where = `Anchor op #${index}${opId ? ` (${opId})` : ""}${opName ? ` ${opName}` : ""}`;
    super(`${where}: ${message}`);
    this.name = "AnchorOpError";
    this.index = index;
    this.opId = opId;
    this.opName = opName;
  }
}

/** What one op did, for the queue surface and the audit trail. */
export interface AnchorOpResult {
  id: string | null;
  op: string;
  reason: string;
  /** Human-readable statement of the mutation that landed. */
  summary: string;
  /** Ids of layers this op brought into existence — how a caller addresses what it just made. */
  created: string[];
  /** The document selection after this op. */
  selection: string[];
}

export interface AnchorBatchResult {
  doc: PressDocument;
  results: AnchorOpResult[];
}

/** Contract text a calling model should be given alongside ANCHOR_TOOLS. */
export const ANCHOR_CONTRACT = [
  "Anchor ops are structured mutations of the VIRO Press document graph. They never rasterise.",
  "Envelope: { id?, op, target?, params, reason }. `reason` is required on every op and is kept as the audit trail.",
  "Flat form is also accepted: { op, reason, ...params }. `target` is the same value as the op's layerId / layerIds / pageId param.",
  "A batch is applied as one undo step. If any op is rejected, none of the batch is applied.",
  "All geometry is in page pixels with the origin at the top-left of the active page; y grows downward. Rotation is degrees clockwise about the layer's own centre.",
  "Colour channels are floats 0-1 (not 0-255). A CSS hex string is accepted anywhere a colour is.",
  "Ops act on the ACTIVE PAGE only. Use press.set_active_page to move first.",
  "Create ops select the layer they just made, so the next op may omit layerId to act on it.",
  "Each op reports back the layer ids it created and the resulting selection, so a follow-up batch can address new layers by id.",
].join("\n");

/* ------------------------------------------------------------------ *
 * Enum sources — drawn from the real type unions in document/types.ts
 * ------------------------------------------------------------------ */

/** Compile-time guard: fails the build if a union member is missing from a runtime list. */
function assertCovers<_T extends never>(): void {
  /* type-level only */
}

const BLEND_MODES = Object.keys(SKIA_BLEND) as BlendMode[];

const ALIGNS = ["left", "center", "right", "justify"] as const;
assertCovers<Exclude<Align, (typeof ALIGNS)[number]>>();

const IMAGE_FITS = ["cover", "contain", "stretch"] as const;
assertCovers<Exclude<ImageFit, (typeof IMAGE_FITS)[number]>>();

const LAYER_KINDS = ["raster", "image-frame", "type-frame", "vector", "group", "adjustment"] as const;
assertCovers<Exclude<Layer["kind"], (typeof LAYER_KINDS)[number]>>();

const REORDER_DIRECTIONS = ["forward", "backward", "front", "back"] as const;
const BOOLEAN_OPS = ["union", "subtract", "intersect", "exclude"] as const;

/** Nothing sane in this document model is larger than this; beyond it the input is garbage. */
const MAX_COORD = 1_000_000;
const MAX_SIZE = 200_000;

/* ------------------------------------------------------------------ *
 * Schema helpers
 * ------------------------------------------------------------------ */

type Schema = Record<string, unknown>;

interface NumOpts {
  min?: number;
  max?: number;
  /** Value must be strictly greater than this. */
  gt?: number;
  integer?: boolean;
}

function pNumber(description: string, o: NumOpts = {}): Schema {
  const s: Schema = { type: o.integer ? "integer" : "number", description };
  if (o.min !== undefined) s.minimum = o.min;
  if (o.gt !== undefined) s.exclusiveMinimum = o.gt;
  if (o.max !== undefined) s.maximum = o.max;
  return s;
}

function pString(description: string, o: { minLength?: number; maxLength?: number } = {}): Schema {
  const s: Schema = { type: "string", description };
  if (o.minLength !== undefined) s.minLength = o.minLength;
  if (o.maxLength !== undefined) s.maxLength = o.maxLength;
  return s;
}

function pBool(description: string): Schema {
  return { type: "boolean", description };
}

function pEnum(description: string, values: readonly string[]): Schema {
  return { type: "string", enum: [...values], description };
}

function pLayerId(needs: string): Schema {
  return pString(
    `Id of the layer to act on — ${needs}. Canonically supplied as the envelope's \`target\`. ` +
      "Omit it to act on the current selection, which is only legal when exactly one layer is selected; " +
      "every create op selects the layer it just made, so the op straight after a create may leave this out.",
  );
}

function pLayerIds(verb: string): Schema {
  return {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    description:
      `Ids of the layers to ${verb}. Every id must exist on the active page. ` +
      "Passing this also moves the document selection onto those layers, which is a real document change. " +
      "Omit it to act on the layers that are already selected.",
  };
}

function pRgba(description: string): Schema {
  return {
    description:
      `${description} Either an object {r,g,b,a} where every channel is a float 0-1 (a defaults to 1), ` +
      'or a CSS hex string "#RGB", "#RRGGBB" or "#RRGGBBAA". 0-255 integers are rejected.',
    oneOf: [
      {
        type: "object",
        required: ["r", "g", "b"],
        additionalProperties: false,
        properties: {
          r: { type: "number", minimum: 0, maximum: 1 },
          g: { type: "number", minimum: 0, maximum: 1 },
          b: { type: "number", minimum: 0, maximum: 1 },
          a: { type: "number", minimum: 0, maximum: 1, default: 1 },
        },
      },
      { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" },
    ],
  };
}

function pStroke(): Schema {
  return {
    type: "object",
    description:
      "Outline for the path. Strokes are centred on the path and drawn in page pixels. " +
      "There is no primitive to change a stroke after creation, so set it here. " +
      "Optionally style it: dashes, and the line cap/join.",
    required: ["color", "width"],
    additionalProperties: false,
    properties: {
      color: pRgba("Stroke colour."),
      width: pNumber("Stroke width in page pixels.", { gt: 0, max: 10000 }),
      dash: {
        type: "array",
        description:
          "Dash pattern as an even list of on,off run lengths in page px (e.g. [12, 6]). " +
          "Omit or leave empty for a solid stroke.",
        maxItems: 128,
        items: { type: "number", minimum: 0, maximum: 100000 },
      },
      dashPhase: pNumber("Offset into the dash pattern, in page px.", { min: 0, max: 100000 }),
      cap: { type: "string", enum: ["butt", "round", "square"], description: "How open ends terminate. Default butt." },
      join: { type: "string", enum: ["miter", "round", "bevel"], description: "How corners turn. Default miter." },
    },
  };
}

function pNodes(): Schema {
  return {
    type: "array",
    minItems: 2,
    description:
      "Path anchors in layer-local pixels, where (0,0) is the top-left of the layer box and " +
      "(w,h) its bottom-right. Segments are cubic beziers: the segment from node i to node i+1 uses " +
      "node i's out handle and node i+1's in handle. Leave the handles off for straight corners.",
    items: {
      type: "object",
      required: ["x", "y"],
      additionalProperties: false,
      properties: {
        x: pNumber("Anchor x, layer-local px.", { min: -MAX_SIZE, max: MAX_SIZE }),
        y: pNumber("Anchor y, layer-local px.", { min: -MAX_SIZE, max: MAX_SIZE }),
        inX: pNumber("Incoming control point x. Defaults to the anchor (corner).", { min: -MAX_SIZE, max: MAX_SIZE }),
        inY: pNumber("Incoming control point y. Defaults to the anchor (corner).", { min: -MAX_SIZE, max: MAX_SIZE }),
        outX: pNumber("Outgoing control point x. Defaults to the anchor (corner).", { min: -MAX_SIZE, max: MAX_SIZE }),
        outY: pNumber("Outgoing control point y. Defaults to the anchor (corner).", { min: -MAX_SIZE, max: MAX_SIZE }),
      },
    },
  };
}

const REASON_SCHEMA: Schema = pString(
  "Why this change is being made, in the caller's own words. Required on every op — Anchor keeps it " +
    'as the audit trail shown next to the change (e.g. "raise the headline above the image so it reads first").',
  { minLength: 3, maxLength: 400 },
);

/* ------------------------------------------------------------------ *
 * Param readers — every one of these rejects rather than coerces silently
 * ------------------------------------------------------------------ */

type Params = Record<string, unknown>;

function fail(msg: string): never {
  throw new Error(msg);
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function absent(v: unknown): boolean {
  return v === undefined || v === null;
}

function rangeText(o: NumOpts): string {
  const bits: string[] = [];
  if (o.gt !== undefined) bits.push(`> ${o.gt}`);
  if (o.min !== undefined) bits.push(`>= ${o.min}`);
  if (o.max !== undefined) bits.push(`<= ${o.max}`);
  if (o.integer) bits.push("whole number");
  return bits.length ? ` (${bits.join(", ")})` : "";
}

function readNum(p: Params, key: string, o: NumOpts = {}): number | undefined {
  const raw = p[key];
  if (absent(raw) || raw === "") return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    fail(`"${key}" must be a number, got ${typeName(raw)}`);
  }
  const v = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(v)) fail(`"${key}" must be a finite number, got ${JSON.stringify(raw)}`);
  if (o.integer && !Number.isInteger(v)) fail(`"${key}" must be a whole number, got ${v}`);
  if (o.gt !== undefined && v <= o.gt) fail(`"${key}" must be greater than ${o.gt}, got ${v}`);
  if (o.min !== undefined && v < o.min) fail(`"${key}" must be >= ${o.min}, got ${v}`);
  if (o.max !== undefined && v > o.max) fail(`"${key}" must be <= ${o.max}, got ${v}`);
  return v;
}

function reqNum(p: Params, key: string, o: NumOpts = {}): number {
  const v = readNum(p, key, o);
  if (v === undefined) fail(`"${key}" is required${rangeText(o)}`);
  return v;
}

function readStr(p: Params, key: string, o: { minLength?: number; maxLength?: number } = {}): string | undefined {
  const raw = p[key];
  if (absent(raw)) return undefined;
  if (typeof raw !== "string") fail(`"${key}" must be a string, got ${typeName(raw)}`);
  if (o.minLength !== undefined && raw.length < o.minLength) {
    fail(`"${key}" must be at least ${o.minLength} character(s), got ${raw.length}`);
  }
  if (o.maxLength !== undefined && raw.length > o.maxLength) {
    fail(`"${key}" must be at most ${o.maxLength} characters, got ${raw.length}`);
  }
  return raw;
}

function reqStr(p: Params, key: string, o: { minLength?: number; maxLength?: number } = {}): string {
  const v = readStr(p, key, o);
  if (v === undefined) fail(`"${key}" is required`);
  return v;
}

function readBool(p: Params, key: string): boolean | undefined {
  const raw = p[key];
  if (absent(raw)) return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  fail(`"${key}" must be true or false, got ${JSON.stringify(raw)}`);
}

function reqBool(p: Params, key: string): boolean {
  const v = readBool(p, key);
  if (v === undefined) fail(`"${key}" is required (true or false)`);
  return v;
}

function readEnum<T extends string>(p: Params, key: string, values: readonly T[]): T | undefined {
  const raw = p[key];
  if (absent(raw) || raw === "") return undefined;
  if (typeof raw !== "string") fail(`"${key}" must be one of ${values.join(" | ")}, got ${typeName(raw)}`);
  if (!(values as readonly string[]).includes(raw)) {
    fail(`"${key}" must be one of ${values.join(" | ")}, got ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

function reqEnum<T extends string>(p: Params, key: string, values: readonly T[]): T {
  const v = readEnum(p, key, values);
  if (v === undefined) fail(`"${key}" is required — one of ${values.join(" | ")}`);
  return v;
}

function readStrArray(p: Params, key: string): string[] | undefined {
  const raw = p[key];
  if (absent(raw)) return undefined;
  if (!Array.isArray(raw)) fail(`"${key}" must be an array of layer ids, got ${typeName(raw)}`);
  return raw.map((v, i) => {
    if (typeof v !== "string" || !v) fail(`"${key}[${i}]" must be a non-empty layer id string, got ${typeName(v)}`);
    return v;
  });
}

function channel(key: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`colour channel "${key}" must be a finite number 0-1, got ${JSON.stringify(v)}`);
  }
  if (v > 1 || v < 0) {
    fail(
      `colour channel "${key}" must be a float 0-1, got ${v}` +
        (v > 1 && v <= 255 ? ` — these are not 0-255 values; ${v} would be ${(v / 255).toFixed(4)}, or pass a hex string` : ""),
    );
  }
  return v;
}

function hexToRgba(hex: string): Rgba {
  const h = hex.slice(1);
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
}

function readRgba(p: Params, key: string): Rgba | undefined {
  const raw = p[key];
  if (absent(raw)) return undefined;
  if (typeof raw === "string") {
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) {
      fail(`"${key}" must be a hex colour like "#E07A2F" or an {r,g,b,a} object of 0-1 floats, got ${JSON.stringify(raw)}`);
    }
    return hexToRgba(raw);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(`"${key}" must be an {r,g,b,a} object of 0-1 floats or a hex string, got ${typeName(raw)}`);
  }
  const o = raw as Record<string, unknown>;
  if (absent(o.r) || absent(o.g) || absent(o.b)) fail(`"${key}" needs r, g and b (floats 0-1)`);
  return {
    r: channel(`${key}.r`, o.r),
    g: channel(`${key}.g`, o.g),
    b: channel(`${key}.b`, o.b),
    a: absent(o.a) ? 1 : channel(`${key}.a`, o.a),
  };
}

function reqRgba(p: Params, key: string): Rgba {
  const v = readRgba(p, key);
  if (v === undefined) fail(`"${key}" is required — an {r,g,b,a} object of 0-1 floats or a hex string`);
  return v;
}

function readStroke(p: Params, key: string): VectorStroke | undefined {
  const raw = p[key];
  if (absent(raw)) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(`"${key}" must be an object { color, width }, got ${typeName(raw)}`);
  }
  const o = raw as Params;
  const color = readRgba(o, "color");
  if (!color) fail(`"${key}.color" is required when "${key}" is given`);
  const width = reqNum(o, "width", { gt: 0, max: 10000 });
  const stroke: VectorStroke = { color, width };
  const dash = o.dash;
  if (!absent(dash)) {
    if (!Array.isArray(dash)) fail(`"${key}.dash" must be an array of numbers`);
    if (dash.length) {
      if (dash.length % 2 !== 0) fail(`"${key}.dash" needs an even number of on,off intervals`);
      if (dash.length > 128) fail(`"${key}.dash" has too many intervals (max 128)`);
      const nums = dash.map((n, i) => {
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
          fail(`"${key}.dash[${i}]" must be a finite number >= 0`);
        }
        return n;
      });
      if (nums.every((n) => n === 0)) fail(`"${key}.dash" is all zeros, which draws nothing`);
      stroke.dash = nums;
    }
  }
  const phase = readNum(o, "dashPhase", { min: 0, max: 100000 });
  if (phase !== undefined) stroke.dashPhase = phase;
  const cap = readStr(o, "cap");
  if (cap !== undefined) {
    if (!["butt", "round", "square"].includes(cap)) fail(`"${key}.cap" must be butt, round or square`);
    stroke.cap = cap as VectorStroke["cap"];
  }
  const join = readStr(o, "join");
  if (join !== undefined) {
    if (!["miter", "round", "bevel"].includes(join)) fail(`"${key}.join" must be miter, round or bevel`);
    stroke.join = join as VectorStroke["join"];
  }
  return stroke;
}

function readNodes(p: Params, key: string): PathNode[] | undefined {
  const raw = p[key];
  if (absent(raw)) return undefined;
  if (!Array.isArray(raw)) fail(`"${key}" must be an array of path nodes, got ${typeName(raw)}`);
  if (raw.length < 2) {
    fail(`"${key}" needs at least 2 nodes to draw a path, got ${raw.length}`);
  }
  return raw.map((n, i) => {
    if (typeof n !== "object" || n === null || Array.isArray(n)) {
      fail(`"${key}[${i}]" must be an object with x and y, got ${typeName(n)}`);
    }
    const o = n as Params;
    const bound = { min: -MAX_SIZE, max: MAX_SIZE };
    const x = reqNum(o, "x", bound);
    const y = reqNum(o, "y", bound);
    return {
      x,
      y,
      inX: readNum(o, "inX", bound) ?? x,
      inY: readNum(o, "inY", bound) ?? y,
      outX: readNum(o, "outX", bound) ?? x,
      outY: readNum(o, "outY", bound) ?? y,
    };
  });
}

const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i;

/* ------------------------------------------------------------------ *
 * Document-aware resolution — these turn the "silent no-op" primitives
 * into hard errors before anything is written.
 * ------------------------------------------------------------------ */

function layerList(doc: PressDocument): string {
  const page = activePage(doc);
  if (!page.layers.length) return "the page has no layers yet";
  const shown = page.layers.slice(0, 8).map((l) => `${l.id} (${l.kind} "${l.name}")`);
  if (page.layers.length > 8) shown.push(`… ${page.layers.length - 8} more`);
  return shown.join(", ");
}

function resolveLayerId(doc: PressDocument, p: Params): string {
  const explicit = readStr(p, "layerId", { minLength: 1 });
  if (explicit) return explicit;
  const sel = doc.activeLayerIds;
  if (sel.length === 1) return sel[0];
  if (!sel.length) {
    fail('no "layerId" given and nothing is selected — pass the layer id, or run press.select first');
  }
  fail(`no "layerId" given and ${sel.length} layers are selected — pass exactly one layer id`);
}

interface LayerNeed {
  kinds?: readonly Layer["kind"][];
  /** The primitive refuses to touch a locked layer, so reject up front. */
  unlocked?: boolean;
}

function requireLayer(doc: PressDocument, id: string, need: LayerNeed = {}): Layer {
  const page = activePage(doc);
  const layer = findLayer(page, id);
  if (!layer) {
    fail(
      `no layer "${id}" on the active page "${page.name}" — Anchor ops act on the active page only ` +
        `(use press.set_active_page to move). On this page: ${layerList(doc)}`,
    );
  }
  if (need.kinds && !need.kinds.includes(layer.kind)) {
    fail(
      `layer "${layer.name}" (${id}) is a ${layer.kind} layer; this op needs ${need.kinds.join(" or ")}`,
    );
  }
  if (need.unlocked && layer.locked) {
    fail(`layer "${layer.name}" (${id}) is locked — unlock it with press.set_locked first`);
  }
  return layer;
}

/**
 * Selection-based primitives read `doc.activeLayerIds`. Passing `layerIds` moves the selection
 * there first, which is a real, visible document change and is documented on every such tool.
 */
function resolveSelection(doc: PressDocument, p: Params, need: LayerNeed = {}): { doc: PressDocument; layers: Layer[] } {
  const explicit = readStrArray(p, "layerIds");
  let next = doc;
  if (explicit) {
    if (!explicit.length) fail('"layerIds" was an empty array — pass at least one layer id, or omit it to use the selection');
    for (const id of explicit) requireLayer(doc, id, need);
    next = setActiveLayers(doc, explicit);
  } else if (!doc.activeLayerIds.length) {
    fail('nothing is selected and no "layerIds" given — pass layerIds, or run press.select first');
  } else {
    for (const id of doc.activeLayerIds) requireLayer(doc, id, need);
  }
  const page = activePage(next);
  const layers = page.layers.filter((l) => next.activeLayerIds.includes(l.id));
  if (!layers.length) fail("the selection resolved to no layers on the active page");
  return { doc: next, layers };
}

function storyOf(doc: PressDocument, layer: Layer) {
  if (layer.kind !== "type-frame") fail(`layer "${layer.name}" is a ${layer.kind} layer, not a type frame`);
  const story = doc.stories.find((s) => s.id === layer.storyId);
  if (!story) fail(`type frame "${layer.name}" points at story "${layer.storyId}" which is not in the document`);
  return story;
}

function name(layer: Layer): string {
  return `${layer.name} (${layer.id})`;
}

function newestLayerId(doc: PressDocument): string {
  const id = doc.activeLayerIds[0];
  if (!id) fail("the create primitive did not select the layer it made");
  return id;
}

function round(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Op registry — description, schema and implementation in one place, so
 * ANCHOR_TOOLS can only ever advertise ops that actually run.
 * ------------------------------------------------------------------ */

interface OpRun {
  doc: PressDocument;
  summary: string;
}

interface AnchorOpDef {
  description: string;
  params: Record<string, Schema>;
  required: string[];
  run: (doc: PressDocument, p: Params) => OpRun;
}

const GEOMETRY = { min: -MAX_COORD, max: MAX_COORD };
const SIZE = { gt: 0, max: MAX_SIZE };
/** Local scale factor. 0 is refused: it is non-invertible, so hit-testing dies. */
const SCALE = { min: -100, max: 100 };

const OPS: Record<string, AnchorOpDef> = {
  /* ---------------- selection & document navigation ---------------- */

  "press.select": {
    description:
      "Set the document selection to the given layer ids on the active page. Selection is real document " +
      "state: the selection-based ops (group, duplicate, delete, apply_fill) act on it, and the user sees " +
      "the copper selection rectangle. Pass an empty array to deselect everything.",
    params: {
      layerIds: {
        type: "array",
        items: { type: "string" },
        minItems: 0,
        description: "Layer ids to select. Every id must exist on the active page. Empty array deselects.",
      },
    },
    required: ["layerIds"],
    run: (doc, p) => {
      const ids = readStrArray(p, "layerIds");
      if (ids === undefined) fail('"layerIds" is required (pass [] to deselect)');
      for (const id of ids) requireLayer(doc, id);
      return {
        doc: setActiveLayers(doc, ids),
        summary: ids.length ? `selected ${ids.length} layer(s): ${ids.join(", ")}` : "deselected everything",
      };
    },
  },

  "press.select_in_region": {
    description:
      "Select every visible layer whose bounding box intersects a rectangle on the active page. Groups and " +
      "adjustment layers are skipped, matching the marquee tool. Selecting nothing is a valid result, not an error.",
    params: {
      x: pNumber("Rectangle left edge in page px.", GEOMETRY),
      y: pNumber("Rectangle top edge in page px.", GEOMETRY),
      w: pNumber("Rectangle width in page px.", { min: 0, max: MAX_SIZE }),
      h: pNumber("Rectangle height in page px.", { min: 0, max: MAX_SIZE }),
    },
    required: ["x", "y", "w", "h"],
    run: (doc, p) => {
      const r = {
        x: reqNum(p, "x", GEOMETRY),
        y: reqNum(p, "y", GEOMETRY),
        w: reqNum(p, "w", { min: 0, max: MAX_SIZE }),
        h: reqNum(p, "h", { min: 0, max: MAX_SIZE }),
      };
      const next = selectIntersecting(doc, r);
      return { doc: next, summary: `selected ${next.activeLayerIds.length} layer(s) inside ${round(r.w)}×${round(r.h)} at ${round(r.x)},${round(r.y)}` };
    },
  },

  "press.set_active_page": {
    description:
      "Make another page of the document active. Every other Anchor op reads and writes the active page only, " +
      "so switch here before addressing layers on a different page. Clears the selection.",
    params: {
      pageId: pString("Id of a page in this document (see document().pages).", { minLength: 1 }),
    },
    required: ["pageId"],
    run: (doc, p) => {
      const id = reqStr(p, "pageId", { minLength: 1 });
      const page = doc.pages.find((pg) => pg.id === id);
      if (!page) {
        fail(`no page "${id}" in this document — pages are: ${doc.pages.map((pg) => `${pg.id} ("${pg.name}")`).join(", ")}`);
      }
      return { doc: setActivePage(doc, id), summary: `active page is now "${page.name}" (${id})` };
    },
  },

  "press.add_page": {
    description:
      "Append an empty page that copies the active page's size, bleed, margins, columns and background, and " +
      "make it active. Takes no parameters. The new page starts with no layers and no guides.",
    params: {},
    required: [],
    run: (doc) => {
      const next = addPage(doc);
      const page = activePage(next);
      return { doc: next, summary: `added page "${page.name}" (${page.id}), now active` };
    },
  },

  "press.add_guide": {
    description:
      "Add a ruler guide to the active page. Guides are document state (saved with the page) and are drawn " +
      "when View → Guides is on. With View → Snap to Guides on, a move snaps to these offsets the same way " +
      "it snaps to page edges and other layers.",
    params: {
      axis: pEnum(
        'Guide direction: "v" for a vertical guide at x = offset, "h" for a horizontal guide at y = offset.',
        ["h", "v"],
      ),
      offset: pNumber("Distance from the page origin in page px.", GEOMETRY),
    },
    required: ["axis", "offset"],
    run: (doc, p) => {
      const axis = reqEnum(p, "axis", ["h", "v"] as const);
      const offset = reqNum(p, "offset", GEOMETRY);
      return { doc: addGuide(doc, axis, offset), summary: `added ${axis === "v" ? "vertical" : "horizontal"} guide at ${round(offset)}px` };
    },
  },

  "press.image_size": {
    description:
      "Page size and resolution. With resample true the page pixel grid is rescaled and every layer's " +
      "geometry (and any image crop) is scaled with it. With resample false only ppi changes — width and " +
      "height are ignored and the pixel grid is untouched, so the physical print size changes instead. " +
      "Note: this does not resample the pixels of placed images; only the Image Size dialog does that, " +
      "because pixel resampling runs through the compositor.",
    params: {
      width: pNumber("New page width in pixels. Required when resample is true.", { gt: 0, max: MAX_SIZE, integer: true }),
      height: pNumber("New page height in pixels. Required when resample is true.", { gt: 0, max: MAX_SIZE, integer: true }),
      ppi: pNumber("Document resolution in pixels per inch.", { gt: 0, max: 4800 }),
      resample: pBool("True (default) rescales the pixel grid and all layer geometry. False changes ppi only."),
    },
    required: ["ppi"],
    run: (doc, p) => {
      const resample = readBool(p, "resample") ?? true;
      const page = activePage(doc);
      const w = readNum(p, "width", { gt: 0, max: MAX_SIZE, integer: true });
      const h = readNum(p, "height", { gt: 0, max: MAX_SIZE, integer: true });
      const ppi = reqNum(p, "ppi", { gt: 0, max: 4800 });
      if (resample && (w === undefined || h === undefined)) {
        fail('"width" and "height" are required when resample is true (pass resample:false to change ppi only)');
      }
      const nw = w ?? page.widthPx;
      const nh = h ?? page.heightPx;
      return {
        doc: applyImageSize(doc, nw, nh, ppi, resample),
        summary: resample
          ? `page resampled ${page.widthPx}×${page.heightPx} → ${nw}×${nh} px at ${round(ppi)} ppi`
          : `ppi ${round(doc.ppi)} → ${round(ppi)}, pixel grid unchanged`,
      };
    },
  },

  /* ---------------- layer lifecycle ---------------- */

  "press.duplicate": {
    description:
      "Duplicate layers. Each copy is offset 16px right and down, named \"<name> copy\", and — for type " +
      "frames — gets its own copy of the story so editing the copy's text does not change the original. " +
      "The copies become the selection, so the next op can omit layerId.",
    params: { layerIds: pLayerIds("duplicate") },
    required: [],
    run: (doc, p) => {
      const sel = resolveSelection(doc, p);
      const next = duplicateSelected(sel.doc);
      return { doc: next, summary: `duplicated ${sel.layers.length} layer(s) → ${next.activeLayerIds.join(", ")}` };
    },
  },

  "press.delete": {
    description:
      "Delete layers from the active page. Deleting a group also deletes its children. This is undoable " +
      "with the rest of the batch as a single history step. Leaves nothing selected.",
    params: { layerIds: pLayerIds("delete") },
    required: [],
    run: (doc, p) => {
      const sel = resolveSelection(doc, p);
      const labels = sel.layers.map(name).join(", ");
      return { doc: deleteSelected(sel.doc), summary: `deleted ${sel.layers.length} layer(s): ${labels}` };
    },
  },

  "press.group": {
    description:
      "Wrap layers in a new group layer sized to their combined bounding box. The group carries its own " +
      "opacity and blend mode, which the compositor applies to the children as one composited layer. " +
      "Only top-level layers can be grouped; layers already inside a group are ignored. The new group becomes the selection.",
    params: { layerIds: pLayerIds("group") },
    required: [],
    run: (doc, p) => {
      const sel = resolveSelection(doc, p);
      const top = sel.layers.filter((l) => !l.parentId);
      if (!top.length) {
        fail("every targeted layer is already inside a group — press.group only takes top-level layers");
      }
      const next = groupSelected(sel.doc);
      return { doc: next, summary: `grouped ${top.length} layer(s) into ${next.activeLayerIds[0]}` };
    },
  },

  "press.boolean": {
    description:
      "Combine 2+ vector layers with a Pathfinder boolean (union, subtract, intersect, exclude). " +
      "Operands are consumed into ONE multi-contour result layer on the active page — destructive, like " +
      "Illustrator's shape modes. Subtract = topmost minus the one beneath (or minus the union of all " +
      "beneath when >2 are selected). Union of disjoint shapes yields one layer with multiple visible " +
      "pieces. Undo restores all operands as one history step. Only unlocked vector layers count.",
    params: {
      op: pEnum("Pathfinder operation.", BOOLEAN_OPS),
      layerIds: pLayerIds("vector operands — draw order is preserved; last id is topmost"),
    },
    required: ["op"],
    run: (doc, p) => {
      const sel = resolveSelection(doc, p);
      const page = activePage(sel.doc);
      const idSet = new Set(sel.layers.map((l) => l.id));
      const ordered = page.layers.filter(
        (l): l is VectorLayer => l.kind === "vector" && idSet.has(l.id) && !l.locked,
      );
      if (ordered.length < 2) {
        fail(
          `boolean needs at least 2 unlocked vector layers — got ${ordered.length} ` +
            `(target was ${sel.layers.map((l) => `${l.kind} "${l.name}"`).join(", ")})`,
        );
      }
      const op = reqEnum(p, "op", BOOLEAN_OPS) as BooleanOp;
      const ck = requireBooleanEngine();
      const result = booleanCombineVectors(ck, page, ordered, op);
      if (!result) {
        fail(`press.boolean ${op}: produced an empty shape — operands unchanged`);
      }
      const ids = ordered.map((l) => l.id);
      const next = applyBooleanCombine(sel.doc, ids, result);
      return {
        doc: next,
        summary: `${op} ${ordered.length} vector(s) → "${result.name}" (${result.contours?.length ?? 1} contour(s))`,
        created: [result.id],
      };
    },
  },

  "press.ungroup": {
    description:
      "Dissolve groups, re-parenting their children to the group's own parent and deleting the group layer. " +
      "The released children become the selection.",
    params: { layerIds: pLayerIds("ungroup — each must be a group layer") },
    required: [],
    run: (doc, p) => {
      const sel = resolveSelection(doc, p);
      const groups = sel.layers.filter((l) => l.kind === "group");
      if (!groups.length) {
        fail(`no group layer in the target — got ${sel.layers.map((l) => `${l.kind} "${l.name}"`).join(", ")}`);
      }
      const next = ungroupSelected(sel.doc);
      return { doc: next, summary: `ungrouped ${groups.length} group(s), released ${next.activeLayerIds.length} layer(s)` };
    },
  },

  "press.reorder": {
    description:
      'Change stacking order on the active page. Later in the page order paints later, so "forward" moves ' +
      'a layer towards the viewer and "backward" moves it behind. "front" and "back" move as far as they can ' +
      'go and are idempotent — asking for a layer that is already there succeeds and says so. "forward" and ' +
      '"backward" are relative steps, so they are rejected when the layer is already at that end and the move ' +
      "cannot be honoured.",
    params: {
      layerId: pLayerId("any layer on the active page"),
      direction: pEnum(
        'forward = one step towards the viewer, backward = one step away, front = all the way to the top, back = all the way to the bottom.',
        REORDER_DIRECTIONS,
      ),
      steps: pNumber('How many positions to move for "forward"/"backward". Default 1. Ignored for front/back.', {
        min: 1,
        max: 10000,
        integer: true,
      }),
    },
    required: ["direction"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id);
      const direction = reqEnum(p, "direction", REORDER_DIRECTIONS);
      const page = activePage(doc);
      const from = page.layers.findIndex((l) => l.id === id);
      const dir: 1 | -1 = direction === "forward" || direction === "front" ? 1 : -1;
      const absolute = direction === "front" || direction === "back";
      const atEnd = dir === 1 ? from === page.layers.length - 1 : from === 0;
      if (atEnd) {
        const end = dir === 1 ? "frontmost" : "backmost";
        if (!absolute) fail(`layer ${name(layer)} is already ${end}, so "${direction}" cannot move it — nothing to do`);
        return { doc, summary: `${name(layer)} is already ${end} — no change` };
      }
      const steps = absolute ? page.layers.length : readNum(p, "steps", { min: 1, max: 10000, integer: true }) ?? 1;
      let next = doc;
      let moved = 0;
      for (let i = 0; i < steps; i++) {
        const before = activePage(next).layers.findIndex((l) => l.id === id);
        const candidate = reorderLayer(next, id, dir);
        if (activePage(candidate).layers.findIndex((l) => l.id === id) === before) break;
        next = candidate;
        moved += 1;
      }
      return { doc: next, summary: `${name(layer)} moved ${direction} ${moved} position(s) (index ${from} → ${activePage(next).layers.findIndex((l) => l.id === id)})` };
    },
  },

  /* ---------------- layer properties ---------------- */

  "press.set_name": {
    description: "Rename a layer. This is the label the user sees in the Layers panel; it does not affect rendering.",
    params: {
      layerId: pLayerId("any layer on the active page"),
      name: pString("New layer name.", { minLength: 1, maxLength: 120 }),
    },
    required: ["name"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id);
      const value = reqStr(p, "name", { minLength: 1, maxLength: 120 });
      return { doc: setLayerName(doc, id, value), summary: `renamed "${layer.name}" → "${value}" (${id})` };
    },
  },

  "press.set_visible": {
    description: "Show or hide a layer. A hidden layer keeps all of its content and is skipped by the compositor and by export.",
    params: {
      layerId: pLayerId("any layer on the active page"),
      visible: pBool("True to show, false to hide."),
    },
    required: ["visible"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id);
      const v = reqBool(p, "visible");
      return { doc: setLayerVisible(doc, id, v), summary: `${v ? "showed" : "hid"} ${name(layer)}` };
    },
  },

  "press.set_locked": {
    description:
      "Lock or unlock a layer. A locked layer refuses geometry, crop and fill changes — both from the user and " +
      "from Anchor — so unlock before editing one and consider re-locking after.",
    params: {
      layerId: pLayerId("any layer on the active page"),
      locked: pBool("True to lock, false to unlock."),
    },
    required: ["locked"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id);
      const v = reqBool(p, "locked");
      return { doc: setLayerLocked(doc, id, v), summary: `${v ? "locked" : "unlocked"} ${name(layer)}` };
    },
  },

  "press.set_opacity": {
    description:
      "Set layer opacity. 0 is fully transparent, 1 fully opaque. This is a float, not a percentage. " +
      "On a group it applies to the composited group as a whole.",
    params: {
      layerId: pLayerId("any layer on the active page"),
      opacity: pNumber("Opacity as a float 0-1.", { min: 0, max: 1 }),
    },
    required: ["opacity"],
    run: (doc, p) => {
      const raw = readNum(p, "opacity", { min: 0, max: 100 });
      if (raw === undefined) fail('"opacity" is required (float 0-1)');
      if (raw > 1) fail(`"opacity" is a float 0-1, not a percentage — got ${raw}, did you mean ${raw / 100}?`);
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id);
      return { doc: setLayerOpacity(doc, id, raw), summary: `${name(layer)} opacity → ${round(raw)}` };
    },
  },

  "press.set_blend": {
    description:
      "Set the Skia blend mode used to composite this layer onto everything below it on the page. " +
      "srcOver is normal. The names are the document model's own blend ids and map 1:1 onto Skia blend modes.",
    params: {
      layerId: pLayerId("any layer on the active page"),
      blend: pEnum("Blend mode id.", BLEND_MODES),
    },
    required: ["blend"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id);
      const blend = reqEnum(p, "blend", BLEND_MODES);
      return { doc: setLayerBlend(doc, id, blend), summary: `${name(layer)} blend → ${blend}` };
    },
  },

  "press.set_transform": {
    description:
      "Set a layer's frame. x/y/w/h are in the layer's PARENT space — page pixels for a top-level layer, " +
      "or the group's own coordinate space for a layer inside a group — with the origin at the top-left and y " +
      "growing downward; give only the fields you want to change. w and h are the layer box: " +
      "for a type frame that is the text column the story flows into, for an image frame the crop window the " +
      "picture is fitted to, for a vector the box its nodes are laid out in. Rejected on a locked layer.",
    params: {
      layerId: pLayerId("any unlocked layer on the active page"),
      x: pNumber("Left edge in page px.", GEOMETRY),
      y: pNumber("Top edge in page px.", GEOMETRY),
      w: pNumber("Width in page px. Must be greater than 0.", SIZE),
      h: pNumber("Height in page px. Must be greater than 0.", SIZE),
      rotation: pNumber("Rotation in degrees clockwise about the layer's own centre.", { min: -3600, max: 3600 }),
      scaleX: pNumber(
        "Horizontal scale about the layer's own centre. 1 is unscaled; negative flips. This is how a GROUP " +
          "is resized, because a group has no geometry of its own — resize a leaf with w/h instead.",
        SCALE,
      ),
      scaleY: pNumber("Vertical scale about the layer's own centre. 1 is unscaled; negative flips.", SCALE),
    },
    required: [],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { unlocked: true });
      const patch = {
        x: readNum(p, "x", GEOMETRY),
        y: readNum(p, "y", GEOMETRY),
        w: readNum(p, "w", SIZE),
        h: readNum(p, "h", SIZE),
        rotation: readNum(p, "rotation", { min: -3600, max: 3600 }),
        scaleX: readNum(p, "scaleX", SCALE),
        scaleY: readNum(p, "scaleY", SCALE),
      };
      if (patch.scaleX === 0 || patch.scaleY === 0) {
        fail("scale of 0 would make the layer invisible and non-invertible; use press.set_visible to hide it");
      }
      const given = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (!given.length) fail('give at least one of "x", "y", "w", "h", "rotation", "scaleX", "scaleY"');
      return {
        doc: setLayerTransform(doc, id, patch),
        summary: `${name(layer)} ${given.map(([k, v]) => `${k}=${round(v as number)}`).join(" ")}`,
      };
    },
  },

  /* ---------------- type ---------------- */

  "press.add_type_frame": {
    description:
      "Create a live type frame — a text column the HarfBuzz shaper flows a story into, not a picture of text. " +
      "The frame is created, then the optional fields are applied through the same primitives the panels use, " +
      "so everything stays editable. Text that does not fit shows the red overflow marker; enlarge h or lower " +
      "size to clear it. The new frame becomes the selection.",
    params: {
      x: pNumber("Frame left edge in page px.", GEOMETRY),
      y: pNumber("Frame top edge in page px.", GEOMETRY),
      w: pNumber(
        "Frame width in page px — the column the text wraps inside. Defaults to a 30-em measure (about 60 " +
          "characters) clamped to the page's column width and to the room left of the right trim.",
        SIZE,
      ),
      h: pNumber(
        "Frame height in page px. Text past this height overflows. Defaults to two lines at the document's " +
          "default size.",
        SIZE,
      ),
      text: pString('Story text. "\\n" starts a new paragraph. Defaults to "Type".', { maxLength: 20000 }),
      size: pNumber("Type size in page px.", { gt: 0, max: 10000 }),
      leading: pNumber("Baseline-to-baseline distance in page px. Typically 1.2-1.5 × size.", { gt: 0, max: 20000 }),
      tracking: pNumber(
        "Letter tracking in 1/1000 em, InDesign's unit: -20 is a tight caption, +100 a letterspaced line. " +
          "The shaper applies it to every glyph advance.",
        { min: -2000, max: 2000 },
      ),
      align: pEnum(
        'Paragraph alignment. "justify" flushes both edges by opening the word spaces; the last line of a ' +
          "paragraph stays flush left.",
        ALIGNS,
      ),
      fill: pRgba("Text colour."),
      name: pString("Layer name for the Layers panel. Defaults to \"Type\".", { minLength: 1, maxLength: 120 }),
    },
    required: ["x", "y"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const w = readNum(p, "w", SIZE);
      const h = readNum(p, "h", SIZE);
      const text = readStr(p, "text", { maxLength: 20000 });
      const size = readNum(p, "size", { gt: 0, max: 10000 });
      const leading = readNum(p, "leading", { gt: 0, max: 20000 });
      const tracking = readNum(p, "tracking", { min: -2000, max: 2000 });
      const align = readEnum(p, "align", ALIGNS);
      const fill = readRgba(p, "fill");
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 });

      // The compositor shapes every story with the one loaded face, so the fontId is fixed here
      // rather than advertised as a choice it cannot honour.
      let next = addTypeFrame(doc, "noto-sans", x, y);
      const id = newestLayerId(next);
      if (text !== undefined) next = setStoryText(next, id, text);
      if (w !== undefined || h !== undefined) next = setLayerTransform(next, id, { w, h });
      if (size !== undefined || leading !== undefined || tracking !== undefined || fill !== undefined) {
        next = setCharacter(next, id, { size, leading, tracking, fill });
      }
      if (align !== undefined) next = setParagraphAlign(next, id, align);
      if (label !== undefined) next = setLayerName(next, id, label);
      return { doc: next, summary: `type frame ${id} at ${round(x)},${round(y)}${text !== undefined ? ` — "${text.slice(0, 40)}"` : ""}` };
    },
  },

  "press.set_story_text": {
    description:
      "Replace the text of a type frame's story. The frame re-shapes and re-wraps through HarfBuzz — nothing " +
      'is flattened. "\\n" starts a new paragraph. Because it edits the story, every frame showing that story ' +
      "updates. An empty string clears the frame.",
    params: {
      layerId: pLayerId("a type-frame layer"),
      text: pString('New story text. "\\n" starts a new paragraph. Empty string clears it.', { maxLength: 20000 }),
    },
    required: ["text"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["type-frame"] });
      storyOf(doc, layer);
      const text = readStr(p, "text", { maxLength: 20000 });
      if (text === undefined) fail('"text" is required (pass "" to clear the frame)');
      return { doc: setStoryText(doc, id, text), summary: `${name(layer)} text → "${text.slice(0, 60)}"${text.length > 60 ? "…" : ""}` };
    },
  },

  "press.set_character": {
    description:
      "Character formatting for a type frame's story. Give only what you want to change. size and leading are " +
      "in page pixels and drive the shaper directly. fill is the glyph colour.",
    params: {
      layerId: pLayerId("a type-frame layer"),
      size: pNumber("Type size in page px.", { gt: 0, max: 10000 }),
      leading: pNumber("Baseline-to-baseline distance in page px. Typically 1.2-1.5 × size.", { gt: 0, max: 20000 }),
      tracking: pNumber(
        "Letter tracking in 1/1000 em, InDesign's unit: -20 is a tight caption, +100 a letterspaced line. " +
          "The shaper applies it to every glyph advance.",
        { min: -2000, max: 2000 },
      ),
      fill: pRgba("Glyph colour."),
      underline: pBool("Draw a rule under each composed line at the type colour."),
      strikethrough: pBool("Draw a rule through each composed line at the type colour."),
      baselineShift: pNumber("Raise (positive) or lower the glyphs relative to the baseline, in page px.", { min: -2000, max: 2000 }),
    },
    required: [],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["type-frame"] });
      storyOf(doc, layer);
      const patch = {
        size: readNum(p, "size", { gt: 0, max: 10000 }),
        leading: readNum(p, "leading", { gt: 0, max: 20000 }),
        tracking: readNum(p, "tracking", { min: -2000, max: 2000 }),
        fill: readRgba(p, "fill"),
        underline: readBool(p, "underline"),
        strikethrough: readBool(p, "strikethrough"),
        baselineShift: readNum(p, "baselineShift", { min: -2000, max: 2000 }),
      };
      const given = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (!given.length) fail('give at least one of "size", "leading", "tracking", "fill", "underline", "strikethrough", "baselineShift"');
      return {
        doc: setCharacter(doc, id, patch),
        summary: `${name(layer)} ${given.map(([k, v]) => `${k}=${typeof v === "number" ? round(v) : "colour"}`).join(" ")}`,
      };
    },
  },

  "press.set_paragraph_align": {
    description:
      'Paragraph alignment for a type frame\'s story. All four are composed by the text engine: "justify" ' +
      "flushes both edges by opening the word spaces, leaving each paragraph's last line flush left.",
    params: {
      layerId: pLayerId("a type-frame layer"),
      align: pEnum("Alignment.", ALIGNS),
    },
    required: ["align"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["type-frame"] });
      storyOf(doc, layer);
      const align = reqEnum(p, "align", ALIGNS);
      return { doc: setParagraphAlign(doc, id, align), summary: `${name(layer)} align → ${align}` };
    },
  },

  "press.set_paragraph": {
    description:
      "Story-level left/right indent, first-line indent, and space before/after. These change how HarfBuzz " +
      "composes the frame (wrap measure and baseline), not a decorative inset.",
    params: {
      layerId: pLayerId("a type-frame layer"),
      startIndent: pNumber("Left indent in page px, applied to every line.", { min: -100_000, max: 100_000 }),
      endIndent: pNumber("Right indent in page px; shrinks the wrap measure.", { min: -100_000, max: 100_000 }),
      firstLineIndent: pNumber("Extra indent on the first line (negative is a hanging indent).", { min: -100_000, max: 100_000 }),
      spaceBefore: pNumber("Space before each paragraph, in page px.", { min: 0, max: 100_000 }),
      spaceAfter: pNumber("Space after each paragraph, in page px.", { min: 0, max: 100_000 }),
    },
    required: [],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["type-frame"] });
      storyOf(doc, layer);
      const patch = {
        startIndent: readNum(p, "startIndent", { min: -100_000, max: 100_000 }),
        endIndent: readNum(p, "endIndent", { min: -100_000, max: 100_000 }),
        firstLineIndent: readNum(p, "firstLineIndent", { min: -100_000, max: 100_000 }),
        spaceBefore: readNum(p, "spaceBefore", { min: 0, max: 100_000 }),
        spaceAfter: readNum(p, "spaceAfter", { min: 0, max: 100_000 }),
      };
      const given = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (!given.length) {
        fail('give at least one of "startIndent", "endIndent", "firstLineIndent", "spaceBefore", "spaceAfter"');
      }
      return {
        doc: setParagraphSpacing(doc, id, patch),
        summary: `${name(layer)} ${given.map(([k, v]) => `${k}=${round(v as number)}`).join(" ")}`,
      };
    },
  },

  /* ---------------- vector ---------------- */

  "press.add_rect": {
    description:
      "Create a rectangle as an editable closed vector path — four corner nodes the user can drag with the " +
      "pen tool, not a flattened box. A fill only paints on a closed path; add a stroke for an outlined box. " +
      "The new layer becomes the selection.",
    params: {
      x: pNumber("Left edge in page px.", GEOMETRY),
      y: pNumber("Top edge in page px.", GEOMETRY),
      w: pNumber("Width in page px.", SIZE),
      h: pNumber("Height in page px.", SIZE),
      fill: pRgba("Fill colour. Omit for an unfilled (outline-only) rectangle."),
      stroke: pStroke(),
      name: pString('Layer name. Defaults to "Rectangle".', { minLength: 1, maxLength: 120 }),
    },
    required: ["x", "y", "w", "h"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const w = reqNum(p, "w", SIZE);
      const h = reqNum(p, "h", SIZE);
      const fill = readRgba(p, "fill") ?? null;
      const stroke = readStroke(p, "stroke") ?? null;
      if (!fill && !stroke) fail('a rectangle needs a "fill", a "stroke", or both — otherwise nothing paints');
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 }) ?? "Rectangle";
      const nodes: PathNode[] = [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
        { x: w, y: 0, inX: w, inY: 0, outX: w, outY: 0 },
        { x: w, y: h, inX: w, inY: h, outX: w, outY: h },
        { x: 0, y: h, inX: 0, inY: h, outX: 0, outY: h },
      ];
      const next = addVectorLayer(doc, label, x, y, w, h, nodes, { closed: true, fill, stroke });
      return { doc: next, summary: `rectangle ${newestLayerId(next)} ${round(w)}×${round(h)} at ${round(x)},${round(y)}` };
    },
  },

  "press.add_ellipse": {
    description:
      "Create an ellipse inscribed in the given box, as an editable closed vector path of four cubic-bezier " +
      "nodes at the cardinal points. Pass equal w and h for a circle. A fill only paints on a closed path. " +
      "The new layer becomes the selection.",
    params: {
      x: pNumber("Bounding box left edge in page px.", GEOMETRY),
      y: pNumber("Bounding box top edge in page px.", GEOMETRY),
      w: pNumber("Bounding box width in page px (the ellipse's full width).", SIZE),
      h: pNumber("Bounding box height in page px (the ellipse's full height).", SIZE),
      fill: pRgba("Fill colour. Omit for an unfilled (outline-only) ellipse."),
      stroke: pStroke(),
      name: pString('Layer name. Defaults to "Ellipse".', { minLength: 1, maxLength: 120 }),
    },
    required: ["x", "y", "w", "h"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const w = reqNum(p, "w", SIZE);
      const h = reqNum(p, "h", SIZE);
      const fill = readRgba(p, "fill") ?? null;
      const stroke = readStroke(p, "stroke") ?? null;
      if (!fill && !stroke) fail('an ellipse needs a "fill", a "stroke", or both — otherwise nothing paints');
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 }) ?? "Ellipse";
      const next = addVectorLayer(doc, label, x, y, w, h, ellipseNodes(w, h), { closed: true, fill, stroke });
      return { doc: next, summary: `ellipse ${newestLayerId(next)} ${round(w)}×${round(h)} at ${round(x)},${round(y)}` };
    },
  },

  "press.add_round_rect": {
    description:
      "Create a rounded rectangle as an editable closed vector path of eight cubic-bezier nodes. " +
      "Corner radius is clamped to half the shorter edge so the path never self-intersects.",
    params: {
      x: pNumber("Left edge in page px.", GEOMETRY),
      y: pNumber("Top edge in page px.", GEOMETRY),
      w: pNumber("Width in page px.", SIZE),
      h: pNumber("Height in page px.", SIZE),
      radius: pNumber("Corner radius in page px.", { min: 0, max: 200_000 }),
      fill: pRgba("Fill colour. Omit for an unfilled (outline-only) shape."),
      stroke: pStroke(),
      name: pString('Layer name. Defaults to "Rounded rectangle".', { minLength: 1, maxLength: 120 }),
    },
    required: ["x", "y", "w", "h"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const w = reqNum(p, "w", SIZE);
      const h = reqNum(p, "h", SIZE);
      const radius = readNum(p, "radius") ?? Math.min(w, h) * 0.2;
      const fill = readRgba(p, "fill") ?? null;
      const stroke = readStroke(p, "stroke") ?? null;
      if (!fill && !stroke) fail('a rounded rectangle needs a "fill", a "stroke", or both — otherwise nothing paints');
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 }) ?? "Rounded rectangle";
      const next = addVectorLayer(doc, label, x, y, w, h, roundRectNodes(w, h, radius), { closed: true, fill, stroke });
      return { doc: next, summary: `rounded rect ${newestLayerId(next)} ${round(w)}×${round(h)} r=${round(radius)}` };
    },
  },

  "press.add_polygon": {
    description:
      "Create a regular n-gon inscribed in the given box as an editable closed vector path. " +
      "sides defaults to 6. First vertex is at 12 o'clock.",
    params: {
      x: pNumber("Bounding box left edge in page px.", GEOMETRY),
      y: pNumber("Bounding box top edge in page px.", GEOMETRY),
      w: pNumber("Bounding box width in page px.", SIZE),
      h: pNumber("Bounding box height in page px.", SIZE),
      sides: pNumber("Number of sides (3–24). Default 6.", { min: 3, max: 24 }),
      fill: pRgba("Fill colour. Omit for an unfilled (outline-only) polygon."),
      stroke: pStroke(),
      name: pString('Layer name. Defaults to "n-gon".', { minLength: 1, maxLength: 120 }),
    },
    required: ["x", "y", "w", "h"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const w = reqNum(p, "w", SIZE);
      const h = reqNum(p, "h", SIZE);
      const sides = Math.round(readNum(p, "sides") ?? 6);
      const fill = readRgba(p, "fill") ?? null;
      const stroke = readStroke(p, "stroke") ?? null;
      if (!fill && !stroke) fail('a polygon needs a "fill", a "stroke", or both — otherwise nothing paints');
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 }) ?? (sides === 3 ? "Triangle" : `${sides}-gon`);
      const next = addVectorLayer(doc, label, x, y, w, h, polygonNodes(w, h, sides), { closed: true, fill, stroke });
      return { doc: next, summary: `${sides}-gon ${newestLayerId(next)} ${round(w)}×${round(h)}` };
    },
  },

  "press.add_star": {
    description:
      "Create a star inscribed in the given box as an editable closed vector path. points is the tip count (3–16, default 5). " +
      "First tip sits at 12 o'clock. The path is real nodes, not a baked icon.",
    params: {
      x: pNumber("Bounding box left edge in page px.", GEOMETRY),
      y: pNumber("Bounding box top edge in page px.", GEOMETRY),
      w: pNumber("Bounding box width in page px.", SIZE),
      h: pNumber("Bounding box height in page px.", SIZE),
      points: pNumber("Number of tips (3–16). Default 5.", { min: 3, max: 16 }),
      fill: pRgba("Fill colour. Omit for an unfilled (outline-only) star."),
      stroke: pStroke(),
      name: pString('Layer name. Defaults to "n-point star".', { minLength: 1, maxLength: 120 }),
    },
    required: ["x", "y", "w", "h"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const w = reqNum(p, "w", SIZE);
      const h = reqNum(p, "h", SIZE);
      const points = Math.round(readNum(p, "points") ?? 5);
      const fill = readRgba(p, "fill") ?? null;
      const stroke = readStroke(p, "stroke") ?? null;
      if (!fill && !stroke) fail('a star needs a "fill", a "stroke", or both — otherwise nothing paints');
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 }) ?? `${points}-point star`;
      const next = addVectorLayer(doc, label, x, y, w, h, starNodes(w, h, points), { closed: true, fill, stroke });
      return { doc: next, summary: `${points}-point star ${newestLayerId(next)} ${round(w)}×${round(h)}` };
    },
  },

  "press.add_line": {
    description:
      "Create a straight rule between two page points as an open, editable vector path. Use this for " +
      "dividers and underlines. A line has no fill, so a stroke is required.",
    params: {
      x1: pNumber("Start x in page px.", GEOMETRY),
      y1: pNumber("Start y in page px.", GEOMETRY),
      x2: pNumber("End x in page px.", GEOMETRY),
      y2: pNumber("End y in page px.", GEOMETRY),
      stroke: pStroke(),
      name: pString('Layer name. Defaults to "Line".', { minLength: 1, maxLength: 120 }),
    },
    required: ["x1", "y1", "x2", "y2", "stroke"],
    run: (doc, p) => {
      const x1 = reqNum(p, "x1", GEOMETRY);
      const y1 = reqNum(p, "y1", GEOMETRY);
      const x2 = reqNum(p, "x2", GEOMETRY);
      const y2 = reqNum(p, "y2", GEOMETRY);
      const stroke = readStroke(p, "stroke");
      if (!stroke) fail('"stroke" is required — a line has no fill, so without a stroke nothing paints');
      if (x1 === x2 && y1 === y2) fail("the start and end points are identical — a line needs two distinct points");
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 }) ?? "Line";
      const next = addVectorLayer(doc, label, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), lineNodes(x1, y1, x2, y2), {
        closed: false,
        fill: null,
        stroke,
      });
      return { doc: next, summary: `line ${newestLayerId(next)} ${round(x1)},${round(y1)} → ${round(x2)},${round(y2)}` };
    },
  },

  "press.add_path": {
    description:
      "Create an arbitrary editable vector path from explicit bezier nodes — the general shape op behind " +
      "rect, ellipse and line. Nodes are layer-local pixels inside the x/y/w/h box you declare. Set closed " +
      "true for a shape (a fill only paints on a closed path) or false for an open stroke. The new layer becomes the selection.",
    params: {
      x: pNumber("Layer box left edge in page px.", GEOMETRY),
      y: pNumber("Layer box top edge in page px.", GEOMETRY),
      w: pNumber("Layer box width in page px. Clamped to a 4px minimum.", SIZE),
      h: pNumber("Layer box height in page px. Clamped to a 4px minimum.", SIZE),
      nodes: pNodes(),
      closed: pBool("True closes the path back to the first node. A fill only paints when closed. Default false."),
      fill: pRgba("Fill colour. Ignored unless closed is true."),
      stroke: pStroke(),
      name: pString('Layer name. Defaults to "Path".', { minLength: 1, maxLength: 120 }),
    },
    required: ["x", "y", "w", "h", "nodes"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const w = reqNum(p, "w", SIZE);
      const h = reqNum(p, "h", SIZE);
      const nodes = readNodes(p, "nodes");
      if (!nodes) fail('"nodes" is required — at least 2 path anchors');
      const closed = readBool(p, "closed") ?? false;
      const fill = readRgba(p, "fill") ?? null;
      const stroke = readStroke(p, "stroke") ?? null;
      if (!stroke && !(closed && fill)) {
        fail(
          'nothing would paint: give a "stroke", or set closed:true together with a "fill" ' +
            "(an open path has no fill area)",
        );
      }
      const label = readStr(p, "name", { minLength: 1, maxLength: 120 }) ?? "Path";
      const next = addVectorLayer(doc, label, x, y, w, h, nodes, { closed, fill, stroke });
      return { doc: next, summary: `path ${newestLayerId(next)} with ${nodes.length} node(s)${closed ? ", closed" : ""}` };
    },
  },

  "press.append_path_node": {
    description:
      "Append a corner node to an existing open vector path, given in page coordinates. The layer box is " +
      "re-fitted around the path afterwards, exactly as the pen tool does. Rejected on a locked layer.",
    params: {
      layerId: pLayerId("an unlocked vector layer"),
      x: pNumber("New node x in PAGE px (not layer-local).", GEOMETRY),
      y: pNumber("New node y in PAGE px (not layer-local).", GEOMETRY),
    },
    required: ["x", "y"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["vector"], unlocked: true });
      if (layer.kind === "vector" && layer.closed) fail(`path ${name(layer)} is already closed — nodes cannot be appended to it`);
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      return { doc: appendPathNode(doc, id, x, y), summary: `${name(layer)} + node at ${round(x)},${round(y)}` };
    },
  },

  "press.close_path": {
    description:
      "Close an open vector path, joining the last node back to the first. Closing is what lets a fill paint. " +
      "Rejected if the path is already closed or has fewer than two nodes.",
    params: { layerId: pLayerId("an open vector layer") },
    required: [],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["vector"] });
      if (layer.kind !== "vector") fail("expected a vector layer");
      if (layer.closed) fail(`path ${name(layer)} is already closed`);
      if (layer.nodes.length < 2) fail(`path ${name(layer)} has ${layer.nodes.length} node(s); a closed path needs at least 2`);
      return { doc: closePath(doc, id), summary: `closed path ${name(layer)}` };
    },
  },

  /* ---------------- image ---------------- */

  "press.place_image": {
    description:
      "Place encoded image bytes as an image frame. The bytes are stored as a document asset so the frame " +
      "stays re-croppable and undoable — the picture is not baked into the page. The frame is created at the " +
      "asset's own aspect ratio, scaled down to at most half the page width, unless you pass w and h. " +
      "The new frame becomes the selection.",
    params: {
      x: pNumber("Frame left edge in page px.", GEOMETRY),
      y: pNumber("Frame top edge in page px.", GEOMETRY),
      dataUrl: pString(
        'The encoded image as a base64 data URL, e.g. "data:image/png;base64,iVBORw0…". ' +
          "Raw URLs and file paths are rejected: the bytes must travel with the document.",
        { minLength: 32 },
      ),
      width: pNumber("True pixel width of the image. Wrong values give wrong crops and scaling.", { gt: 0, max: MAX_SIZE, integer: true }),
      height: pNumber("True pixel height of the image.", { gt: 0, max: MAX_SIZE, integer: true }),
      name: pString('Asset and layer name, e.g. "cover.png".', { minLength: 1, maxLength: 120 }),
      w: pNumber("Optional frame width in page px. Defaults to the fitted size.", SIZE),
      h: pNumber("Optional frame height in page px. Defaults to the fitted size.", SIZE),
      fit: pEnum("How the picture fills the frame. Default cover.", IMAGE_FITS),
    },
    required: ["x", "y", "dataUrl", "width", "height", "name"],
    run: (doc, p) => {
      const x = reqNum(p, "x", GEOMETRY);
      const y = reqNum(p, "y", GEOMETRY);
      const dataUrl = reqStr(p, "dataUrl", { minLength: 32 });
      if (!DATA_URL.test(dataUrl)) {
        fail('"dataUrl" must be a base64 image data URL like "data:image/png;base64,…" — remote URLs and file paths cannot be stored in the document');
      }
      const width = reqNum(p, "width", { gt: 0, max: MAX_SIZE, integer: true });
      const height = reqNum(p, "height", { gt: 0, max: MAX_SIZE, integer: true });
      const label = reqStr(p, "name", { minLength: 1, maxLength: 120 });
      const w = readNum(p, "w", SIZE);
      const h = readNum(p, "h", SIZE);
      const fit = readEnum(p, "fit", IMAGE_FITS);
      const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
      let next = addImageFrame(doc, { name: label, mime, dataUrl, width, height }, x, y);
      const id = newestLayerId(next);
      if (w !== undefined || h !== undefined) next = setLayerTransform(next, id, { w, h });
      if (fit !== undefined) next = setImageFit(next, id, fit);
      const frame = findLayer(activePage(next), id);
      return {
        doc: next,
        summary: `placed "${label}" ${width}×${height}px as ${id} at ${round(x)},${round(y)}${
          frame ? ` (frame ${round(frame.transform.w)}×${round(frame.transform.h)})` : ""
        }`,
      };
    },
  },

  "press.set_image_fit": {
    description:
      "How the picture sits inside its frame. cover fills the frame and crops the overflow; contain fits the " +
      "whole picture inside and leaves gaps; stretch and fill both draw the source to the exact frame box, " +
      "distorting the aspect ratio (fill is an alias of stretch in the current compositor). " +
      "cover and contain honour the focal point. Rejected on a locked layer.",
    params: {
      layerId: pLayerId("an unlocked image-frame layer"),
      fit: pEnum("Fit mode.", IMAGE_FITS),
    },
    required: ["fit"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["image-frame"], unlocked: true });
      const fit = reqEnum(p, "fit", IMAGE_FITS);
      return { doc: setImageFit(doc, id, fit), summary: `${name(layer)} fit → ${fit}` };
    },
  },

  "press.set_image_focal": {
    description:
      "Move the point of the picture the frame keeps in view when cover or contain has to leave something out. " +
      "0,0 is the picture's top-left, 1,1 its bottom-right, 0.5,0.5 the centre. Has no visible effect under " +
      "stretch or fill. Rejected on a locked layer.",
    params: {
      layerId: pLayerId("an unlocked image-frame layer"),
      x: pNumber("Horizontal focal point, 0-1.", { min: 0, max: 1 }),
      y: pNumber("Vertical focal point, 0-1.", { min: 0, max: 1 }),
    },
    required: ["x", "y"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["image-frame"], unlocked: true });
      const x = reqNum(p, "x", { min: 0, max: 1 });
      const y = reqNum(p, "y", { min: 0, max: 1 });
      return { doc: setImageFocal(doc, id, x, y), summary: `${name(layer)} focal → ${round(x)},${round(y)}` };
    },
  },

  "press.set_image_crop": {
    description:
      "Set the source window of an image frame — the rectangle of the ORIGINAL image pixels the frame shows. " +
      "Coordinates are in the asset's own pixels, not page pixels, and must lie inside the asset. " +
      "Pass crop:null to clear the crop and show the whole picture again. This changes what is shown, not " +
      "where the frame sits; move the frame with press.set_transform. Rejected on a locked layer.",
    params: {
      layerId: pLayerId("an unlocked image-frame layer"),
      crop: {
        description: "Source-pixel rectangle, or null to clear the crop.",
        oneOf: [
          {
            type: "object",
            required: ["x", "y", "w", "h"],
            additionalProperties: false,
            properties: {
              x: { type: "number", minimum: 0, description: "Left edge in source pixels." },
              y: { type: "number", minimum: 0, description: "Top edge in source pixels." },
              w: { type: "number", exclusiveMinimum: 0, description: "Width in source pixels." },
              h: { type: "number", exclusiveMinimum: 0, description: "Height in source pixels." },
            },
          },
          { type: "null" },
        ],
      },
    },
    required: ["crop"],
    run: (doc, p) => {
      const id = resolveLayerId(doc, p);
      const layer = requireLayer(doc, id, { kinds: ["image-frame"], unlocked: true });
      if (layer.kind !== "image-frame") fail("expected an image frame");
      if (!("crop" in p)) fail('"crop" is required — a {x,y,w,h} source rectangle, or null to clear');
      const raw = p.crop;
      if (raw === null) {
        return { doc: setImageCrop(doc, id, null), summary: `${name(layer)} crop cleared` };
      }
      if (typeof raw !== "object" || Array.isArray(raw)) {
        fail(`"crop" must be an object {x,y,w,h} in source pixels, or null, got ${typeName(raw)}`);
      }
      const asset = layer.assetId ? doc.assets[layer.assetId] : undefined;
      if (!asset) fail(`image frame ${name(layer)} has no asset to crop`);
      const c = raw as Params;
      const crop = {
        x: reqNum(c, "x", { min: 0, max: asset.width }),
        y: reqNum(c, "y", { min: 0, max: asset.height }),
        w: reqNum(c, "w", { gt: 0, max: asset.width }),
        h: reqNum(c, "h", { gt: 0, max: asset.height }),
      };
      if (crop.x + crop.w > asset.width + 0.5 || crop.y + crop.h > asset.height + 0.5) {
        fail(
          `crop ${round(crop.x)},${round(crop.y)} ${round(crop.w)}×${round(crop.h)} falls outside the source image ` +
            `(${asset.width}×${asset.height}px) — crop coordinates are source pixels, not page pixels`,
        );
      }
      return {
        doc: setImageCrop(doc, id, crop),
        summary: `${name(layer)} crop → ${round(crop.w)}×${round(crop.h)} at ${round(crop.x)},${round(crop.y)} source px`,
      };
    },
  },

  /* ---------------- colour ---------------- */

  "press.apply_fill": {
    description:
      "Fill layers with a colour: a vector layer's fill (which paints only where the path is closed) and a " +
      "type frame's glyph colour. Image, raster, group and adjustment layers have no fill and are rejected. " +
      "Locked layers are refused rather than silently skipped.",
    params: {
      layerIds: pLayerIds("fill — each must be a vector or type-frame layer"),
      r: pNumber("Red 0-1. Use this with g and b, or pass `color` instead.", { min: 0, max: 1 }),
      g: pNumber("Green 0-1.", { min: 0, max: 1 }),
      b: pNumber("Blue 0-1.", { min: 0, max: 1 }),
      a: pNumber("Alpha 0-1. Defaults to 1.", { min: 0, max: 1 }),
      color: pRgba("The fill colour, as an alternative to separate r/g/b/a."),
    },
    required: [],
    run: (doc, p) => {
      let colour = readRgba(p, "color");
      if (!colour) {
        if (absent(p.r) || absent(p.g) || absent(p.b)) {
          fail('give a colour: either "color" (hex string or {r,g,b,a}) or all three of "r", "g", "b" as 0-1 floats');
        }
        colour = {
          r: channel("r", readNum(p, "r", { min: 0, max: 255 })),
          g: channel("g", readNum(p, "g", { min: 0, max: 255 })),
          b: channel("b", readNum(p, "b", { min: 0, max: 255 })),
          a: absent(p.a) ? 1 : channel("a", readNum(p, "a", { min: 0, max: 255 })),
        };
      }
      const sel = resolveSelection(doc, p, { kinds: ["vector", "type-frame"], unlocked: true });
      return {
        doc: applyFill(sel.doc, colour),
        summary: `filled ${sel.layers.length} layer(s) with rgba(${round(colour.r)}, ${round(colour.g)}, ${round(colour.b)}, ${round(colour.a)})`,
      };
    },
  },

  /* ---------------- adjustment ---------------- */

  "press.add_adjustment": {
    description:
      "Add a brightness/contrast adjustment layer covering the whole page. It is a live layer applied by the " +
      "Skia colour matrix to everything composited beneath it — the pixels underneath are never changed, and " +
      "the layer can be hidden, moved in the stack, or deleted afterwards. The new layer becomes the selection.",
    params: {
      brightness: pNumber("Brightness offset. 0 is neutral, -1 is black, 1 is white.", { min: -1, max: 1 }),
      contrast: pNumber("Contrast multiplier. 1 is neutral, below 1 flattens, above 1 steepens.", { min: 0, max: 4 }),
    },
    required: ["brightness", "contrast"],
    run: (doc, p) => {
      const brightness = reqNum(p, "brightness", { min: -1, max: 1 });
      const contrast = reqNum(p, "contrast", { min: 0, max: 4 });
      const next = addAdjustment(doc, brightness, contrast);
      return { doc: next, summary: `adjustment ${newestLayerId(next)} brightness=${round(brightness)} contrast=${round(contrast)}` };
    },
  },
};

/* ------------------------------------------------------------------ *
 * The catalogue — derived from OPS, so an advertised tool always runs.
 * ------------------------------------------------------------------ */

export const ANCHOR_TOOLS: AnchorTool[] = Object.entries(OPS).map(([toolName, def]) => ({
  name: toolName,
  description: def.description,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [...def.required, "reason"],
    properties: { ...def.params, reason: REASON_SCHEMA },
  },
}));

export const ANCHOR_OP_NAMES: string[] = Object.keys(OPS);

/* ------------------------------------------------------------------ *
 * Envelope parsing + application
 * ------------------------------------------------------------------ */

interface ParsedOp {
  index: number;
  id: string | null;
  op: string;
  reason: string;
  params: Params;
  def: AnchorOpDef;
}

function allLayerIds(doc: PressDocument): Set<string> {
  const out = new Set<string>();
  for (const page of doc.pages) for (const layer of page.layers) out.add(layer.id);
  return out;
}

function suggest(op: string): string {
  const lower = op.toLowerCase();
  const near = ANCHOR_OP_NAMES.filter((n) => {
    const tail = n.slice("press.".length);
    return lower.includes(tail) || tail.includes(lower.replace(/^press\./, ""));
  });
  return near.length ? ` Did you mean ${near.slice(0, 3).join(" or ")}?` : ` Known ops: ${ANCHOR_OP_NAMES.join(", ")}`;
}

/** Envelope check. Runs over the whole batch before anything is applied. */
function parseOp(raw: unknown, index: number): ParsedOp {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AnchorOpError(`expected an op object { op, params, reason }, got ${typeName(raw)}`, index, null, "");
  }
  const env = raw as Params;
  const id = typeof env.id === "string" && env.id ? env.id : null;
  // `name` is only an alias for `op` when `op` is absent — several ops take a "name" parameter.
  const nameIsOp = env.op === undefined || env.op === null;
  const opRaw = nameIsOp ? env.name : env.op;
  if (typeof opRaw !== "string" || !opRaw) {
    throw new AnchorOpError(`"op" is required and must be a tool name string.${suggest("")}`, index, id, "");
  }
  const def = OPS[opRaw];
  if (!def) {
    throw new AnchorOpError(`unknown op "${opRaw}".${suggest(opRaw)}`, index, id, opRaw);
  }

  let params: Params;
  if (env.params === undefined || env.params === null) {
    // Flat form: everything except the envelope keys is a parameter.
    params = {};
    for (const [k, v] of Object.entries(env)) {
      if (k === "op" || k === "id" || k === "reason" || k === "target" || k === "params") continue;
      if (k === "name" && nameIsOp) continue;
      params[k] = v;
    }
  } else if (typeof env.params !== "object" || Array.isArray(env.params)) {
    throw new AnchorOpError(`"params" must be an object, got ${typeName(env.params)}`, index, id, opRaw);
  } else {
    params = { ...(env.params as Params) };
  }

  // `target` is the canonical envelope slot for whatever the op acts on. Fold it into the one
  // parameter this op actually declares, so a target an op cannot use is an error, not a no-op.
  const takes = (key: string) => Object.prototype.hasOwnProperty.call(def.params, key);
  if (typeof env.target === "string") {
    if (takes("layerId")) params.layerId ??= env.target;
    else if (takes("layerIds")) params.layerIds ??= [env.target];
    else if (takes("pageId")) params.pageId ??= env.target;
    else throw new AnchorOpError(`${opRaw} takes no target`, index, id, opRaw);
  } else if (Array.isArray(env.target)) {
    if (takes("layerIds")) params.layerIds ??= env.target;
    else if (takes("layerId") && env.target.length === 1) params.layerId ??= env.target[0];
    else if (takes("layerId")) {
      throw new AnchorOpError(`${opRaw} acts on one layer — "target" must be a single layer id`, index, id, opRaw);
    } else throw new AnchorOpError(`${opRaw} takes no target`, index, id, opRaw);
  } else if (env.target !== undefined && env.target !== null) {
    throw new AnchorOpError('"target" must be a layer id, an array of layer ids, or a page id', index, id, opRaw);
  }

  const reasonRaw = env.reason ?? params.reason;
  if (typeof reasonRaw !== "string" || reasonRaw.trim().length < 3) {
    throw new AnchorOpError(
      '"reason" is required on every op and must be at least 3 characters — it is the audit trail Anchor keeps ' +
        "next to the change. Say why this edit is being made, not what it does.",
      index,
      id,
      opRaw,
    );
  }
  delete params.reason;

  const known = new Set(Object.keys(def.params));
  const unknownKeys = Object.keys(params).filter((k) => !known.has(k));
  if (unknownKeys.length) {
    throw new AnchorOpError(
      `unknown parameter(s) ${unknownKeys.map((k) => `"${k}"`).join(", ")} for ${opRaw}. ` +
        `It takes: ${Object.keys(def.params).join(", ") || "no parameters"}`,
      index,
      id,
      opRaw,
    );
  }

  return { index, id, op: opRaw, reason: reasonRaw.trim(), params, def };
}

/**
 * Apply a batch of Anchor ops to a document.
 *
 * All-or-nothing: every envelope is checked first, then the ops run against a working copy. Any
 * rejection throws an AnchorOpError and the caller's document is left exactly as it was, which is
 * what keeps `PressApp.applyAnchor` a single undo step.
 */
export function applyAnchorBatch(doc: PressDocument, ops: AnchorOp[] | unknown): AnchorBatchResult {
  if (!Array.isArray(ops)) {
    throw new AnchorOpError(`expected an array of ops, got ${typeName(ops)}`, 0, null, "");
  }
  const parsed = ops.map((raw, i) => parseOp(raw, i));
  let next = doc;
  const results: AnchorOpResult[] = [];
  for (const op of parsed) {
    const before = allLayerIds(next);
    let outcome: OpRun;
    try {
      outcome = op.def.run(next, op.params);
    } catch (err) {
      if (err instanceof AnchorOpError) throw err;
      throw new AnchorOpError(err instanceof Error ? err.message : String(err), op.index, op.id, op.op);
    }
    next = outcome.doc;
    results.push({
      id: op.id,
      op: op.op,
      reason: op.reason,
      summary: outcome.summary,
      created: [...allLayerIds(next)].filter((layerId) => !before.has(layerId)),
      selection: [...next.activeLayerIds],
    });
  }
  return { doc: next, results };
}

/** Existing contract: apply a batch and return the new document. One undo step at the caller. */
export function applyAnchorOps(doc: PressDocument, ops: AnchorOp[]): PressDocument {
  return applyAnchorBatch(doc, ops).doc;
}
