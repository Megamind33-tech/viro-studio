/**
 * UI editing commands.
 *
 * Foundation deliverable B, completing the migration begun in slice 3: these are
 * the actions that used to call `PressApp.commit()`, each of which cost a
 * whole-document clone in the undo stack (defect #10).
 *
 * Every command here uses `invertAfter` and lets `patch.ts` derive the inverse
 * by diffing, exactly as Anchor's ops do. That is why each definition is a few
 * lines rather than a hand-written reversal: the primitives in `ops.ts` already
 * know how to *do* the work, and the diff works out how to undo it.
 * See docs/adr/0003-derived-inverses.md.
 *
 * WHAT DELIBERATELY STAYS A SNAPSHOT: replacing the whole document — New, Open,
 * Open PSD, Open VDJ. Everything changes, so a diff would be the size of the
 * document with none of the benefit. `pushSnapshot` is the honest representation
 * there, which is why `stats().snapshotEntries` should be read as "document
 * replacements", not as migration debt.
 */
import type { Align, BlendMode, CharacterStyle, GradientFill, GradientStop, ImageFit, ParagraphStyle, PressDocument, ResampleAlgo, Rgba, StrokeCap, StrokeJoin, VectorLayer } from "./types";
import { SKIA_BLEND } from "./types";
import { applyCharacterRange, applyParagraphRange, assertTextRange, replaceStoryRange, type TextAffinity } from "./text-model";
import { CommandError, deriveInverse, registerCommand, v, type CommandDef } from "./commands";
import {
  booleanCombineVectors,
  requireBooleanEngine,
  type BooleanOp,
} from "./boolean-ops";
import {
  addEmptyImageFrame,
  addGuide,
  addImageFrame,
  fillImageFrame,
  addTypeFrame,
  addVectorEllipse,
  addVectorLine,
  addVectorPolygon,
  addVectorRect,
  addVectorRoundRect,
  addVectorStar,
  applyImageSize,
  cloneDoc,
  findLayer,
  MAX_DASH_INTERVALS,
  MAX_GRADIENT_STOPS,
  selectedLayers,
} from "./factory";
import {
  addAdjustment,
  addPage,
  applyBooleanCombine,
  addVectorPath,
  appendPathNode,
  applyFill,
  applyVectorFill,
  closePath,
  deleteSelected,
  duplicateSelected,
  flipLayers,
  groupSelected,
  mergeStroke,
  reorderLayer,
  replaceAssetData,
  setCharacter,
  type CharacterPatch,
  setLayerBlend,
  setLayerLocked,
  setLayerOpacity,
  setLayerVisible,
  setParagraphAlign,
  setStoryText,
  ungroupSelected,
} from "./ops";

const COORD = { min: -1_000_000, max: 1_000_000 };
const SIZE = { gt: 0, max: 200_000 };

/** A colour as the document stores it: four floats 0-1, not 0-255. */
function rgba(raw: unknown, type: string, key: string): Rgba {
  if (raw === undefined || raw === null) {
    throw new CommandError(`${type}: "${key}" is required as a float 0-1 colour {r,g,b,a}`);
  }
  const o = v.obj(raw, type);
  const ch = (k: string) => {
    const n = o[k];
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new CommandError(`${type}: "${key}.${k}" is required as a float 0-1`);
    }
    if (n < 0 || n > 1) {
      // The 0-255 mistake is the common one, so name it and do the conversion.
      const hint = n > 1 && n <= 255 ? ` — ${n} would be ${(n / 255).toFixed(4)}` : "";
      throw new CommandError(`${type}: "${key}.${k}" must be a float 0-1, got ${n}; these are not 0-255 values${hint}`);
    }
    return n;
  };
  const a = o.a === undefined ? 1 : ch("a");
  return { r: ch("r"), g: ch("g"), b: ch("b"), a };
}

function reqNum(
  o: Record<string, unknown>,
  key: string,
  type: string,
  opts: { min?: number; max?: number; gt?: number } = COORD,
): number {
  const n = v.num(o, key, type, opts);
  if (n === undefined) throw new CommandError(`${type}: "${key}" is required`);
  return n;
}

const STROKE_CAPS = ["butt", "round", "square"] as const;
const STROKE_JOINS = ["miter", "round", "bevel"] as const;
const BOOLEAN_OPS = ["union", "subtract", "intersect", "exclude"] as const;

/** Resolve selected vector operands in draw order (last = topmost). */
function booleanOperands(doc: PressDocument, layerIds?: string[]): VectorLayer[] {
  const page = doc.pages.find((p) => p.id === doc.activePageId);
  if (!page) return [];
  const ids = layerIds ?? doc.activeLayerIds;
  const idSet = new Set(ids);
  return page.layers.filter(
    (l): l is VectorLayer => l.kind === "vector" && idSet.has(l.id) && !l.locked,
  );
}

/** Optional stroke cap enum; undefined when absent. */
function strokeCap(raw: unknown, type: string): StrokeCap | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !(STROKE_CAPS as readonly string[]).includes(raw)) {
    throw new CommandError(`${type}: "cap" must be one of ${STROKE_CAPS.join(", ")}`);
  }
  return raw as StrokeCap;
}

/** Optional stroke join enum; undefined when absent. */
function strokeJoin(raw: unknown, type: string): StrokeJoin | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !(STROKE_JOINS as readonly string[]).includes(raw)) {
    throw new CommandError(`${type}: "join" must be one of ${STROKE_JOINS.join(", ")}`);
  }
  return raw as StrokeJoin;
}

/**
 * Optional dash pattern. An empty array clears the dash (solid). A non-empty
 * pattern must be an even list of finite, non-negative numbers, not all zero,
 * bounded in length — mirrors `validateStroke` so bad input never reaches Skia.
 */
function dashArray(raw: unknown, type: string): number[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new CommandError(`${type}: "dash" must be an array of numbers`);
  if (raw.length === 0) return [];
  if (raw.length % 2 !== 0) throw new CommandError(`${type}: "dash" needs an even number of on,off intervals`);
  if (raw.length > MAX_DASH_INTERVALS) throw new CommandError(`${type}: "dash" has too many intervals (max ${MAX_DASH_INTERVALS})`);
  const nums = raw.map((n, i) => {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      throw new CommandError(`${type}: "dash[${i}]" must be a finite number >= 0`);
    }
    return n;
  });
  if (nums.every((n) => n === 0)) throw new CommandError(`${type}: "dash" is all zeros, which draws nothing`);
  return nums;
}

/**
 * Define a command whose inverse is derived by diffing.
 *
 * `affects` returns nothing on purpose: the diff knows exactly which layers
 * changed, which is better information than the command could declare up front,
 * and the bus merges that in from the inverse.
 */
function define<P>(spec: {
  type: string;
  label: string | ((p: P, doc: PressDocument) => string);
  validate: (raw: unknown, doc: PressDocument) => P;
  apply: (p: P, doc: PressDocument) => PressDocument;
  summary?: (p: P, before: PressDocument, after: PressDocument) => string;
  coalesceKey?: (p: P) => string | null;
}): CommandDef<P> {
  return {
    type: spec.type,
    label: (p, doc) => (typeof spec.label === "function" ? spec.label(p, doc) : spec.label),
    validate: spec.validate,
    affects: () => [],
    apply: (p, doc) => ({ doc: spec.apply(p, doc) }),
    invertAfter: (p, before, after) => deriveInverse(spec.type, before, after),
    coalesceKey: spec.coalesceKey,
  };
}

/** Ops that act on the current selection take no target of their own. */
const noParams = (type: string) => (raw: unknown) => {
  if (raw && typeof raw === "object" && Object.keys(raw).length) {
    throw new CommandError(`${type}: takes no parameters — it acts on the current selection`);
  }
  return {} as Record<string, never>;
};

const layerOnly = (type: string, opts: { kind?: string; unlocked?: boolean } = {}) => (raw: unknown, doc: PressDocument) => {
  const o = v.obj(raw, type);
  const layerId = v.str(o, "layerId", type);
  v.requireLayer(doc, layerId, type, opts);
  return { layerId };
};

function typeStory(doc: PressDocument, layerId: string, type: string) {
  const layer = v.requireLayer(doc, layerId, type, { kind: "type-frame", unlocked: true });
  if (layer.kind !== "type-frame") throw new CommandError(`${type}: layer is not a type frame`);
  const story = doc.stories.find((candidate) => candidate.id === layer.storyId);
  if (!story) throw new CommandError(`${type}: type frame "${layer.name}" references missing story "${layer.storyId}"`);
  return story;
}

function textOffset(o: Record<string, unknown>, key: string, type: string): number {
  const n = reqNum(o, key, type, { min: 0, max: 10_000_000 });
  if (!Number.isInteger(n)) throw new CommandError(`${type}: "${key}" must be an integer UTF-16 offset`);
  return n;
}

function checkedRange(doc: PressDocument, layerId: string, o: Record<string, unknown>, type: string) {
  const story = typeStory(doc, layerId, type);
  const start = textOffset(o, "start", type);
  const end = textOffset(o, "end", type);
  try {
    assertTextRange(story.text, start, end);
  } catch (error) {
    throw new CommandError(`${type}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { start, end };
}

function replaceStoryInDocument(
  doc: PressDocument,
  layerId: string,
  update: (story: PressDocument["stories"][number]) => PressDocument["stories"][number],
): PressDocument {
  const next = cloneDoc(doc);
  const page = next.pages.find((candidate) => candidate.id === next.activePageId);
  const layer = page?.layers.find((candidate) => candidate.id === layerId);
  if (!layer || layer.kind !== "type-frame") return next;
  const index = next.stories.findIndex((candidate) => candidate.id === layer.storyId);
  if (index >= 0) next.stories[index] = update(next.stories[index]!);
  return next;
}

const DEFS: CommandDef<never>[] = [
  // ── selection-scoped structural edits ──
  define({ type: "layer.delete", label: "Delete", validate: noParams("layer.delete"), apply: (_p, doc) => deleteSelected(doc) }),
  define({ type: "layer.group", label: "Group", validate: noParams("layer.group"), apply: (_p, doc) => groupSelected(doc) }),
  define({ type: "layer.ungroup", label: "Ungroup", validate: noParams("layer.ungroup"), apply: (_p, doc) => ungroupSelected(doc) }),
  define({ type: "layer.duplicate", label: "Duplicate", validate: noParams("layer.duplicate"), apply: (_p, doc) => duplicateSelected(doc) }),
  define({
    type: "vector.boolean",
    label: (p: { op: BooleanOp; layerIds: string[] }) => `Pathfinder ${p.op}`,
    validate: (raw, doc) => {
      const o = v.obj(raw, "vector.boolean");
      const opRaw = o.op;
      if (typeof opRaw !== "string" || !(BOOLEAN_OPS as readonly string[]).includes(opRaw)) {
        throw new CommandError(`vector.boolean: "op" must be one of ${BOOLEAN_OPS.join(", ")}`);
      }
      let layerIds: string[] | undefined;
      if (o.layerIds !== undefined) {
        if (!Array.isArray(o.layerIds) || !o.layerIds.every((id) => typeof id === "string")) {
          throw new CommandError(`vector.boolean: "layerIds" must be an array of layer id strings`);
        }
        layerIds = o.layerIds as string[];
        for (const id of layerIds) {
          v.requireLayer(doc, id, "vector.boolean", { kind: "vector", unlocked: true });
        }
      }
      const ordered = booleanOperands(doc, layerIds);
      if (ordered.length < 2) {
        throw new CommandError(
          `vector.boolean: needs at least 2 unlocked vector layers on the active page, got ${ordered.length}`,
        );
      }
      return { op: opRaw as BooleanOp, layerIds: ordered.map((l) => l.id) };
    },
    apply: (p, doc) => {
      const page = doc.pages.find((candidate) => candidate.id === doc.activePageId)!;
      const ordered = p.layerIds.map((id) => findLayer(page, id)!).filter(Boolean) as VectorLayer[];
      const ck = requireBooleanEngine();
      const result = booleanCombineVectors(ck, page, ordered, p.op);
      if (!result) {
        throw new CommandError(`vector.boolean: ${p.op} produced an empty shape — nothing changed`);
      }
      return applyBooleanCombine(doc, p.layerIds, result);
    },
    summary: (p: { op: BooleanOp; layerIds: string[] }) => `${p.op} ${p.layerIds.length} shape(s) → 1 compound path`,
  }),
  define({ type: "page.add", label: "Add page", validate: noParams("page.add"), apply: (_p, doc) => addPage(doc) }),

  // ── layer properties ──
  define({
    type: "layer.opacity",
    label: "Opacity",
    validate: (raw, doc) => {
      const o = v.obj(raw, "layer.opacity");
      const layerId = v.str(o, "layerId", "layer.opacity");
      v.requireLayer(doc, layerId, "layer.opacity", { unlocked: true });
      const opacity = v.num(o, "opacity", "layer.opacity", { min: 0, max: 1 });
      if (opacity === undefined) {
        throw new CommandError(`layer.opacity: "opacity" is a float 0-1, not a percentage`);
      }
      return { layerId, opacity };
    },
    apply: (p, doc) => setLayerOpacity(doc, p.layerId, p.opacity),
  }),
  define({
    type: "layer.blend",
    label: (p: { layerId: string; blend: BlendMode }) => `Blend ${p.blend}`,
    validate: (raw, doc) => {
      const o = v.obj(raw, "layer.blend");
      const layerId = v.str(o, "layerId", "layer.blend");
      v.requireLayer(doc, layerId, "layer.blend", { unlocked: true });
      const modes = Object.keys(SKIA_BLEND);
      const blend = o.blend;
      if (typeof blend !== "string" || !modes.includes(blend)) {
        throw new CommandError(`layer.blend: "blend" must be one of ${modes.join(" | ")}, got ${JSON.stringify(blend)}`);
      }
      return { layerId, blend: blend as BlendMode };
    },
    apply: (p, doc) => setLayerBlend(doc, p.layerId, p.blend),
  }),
  define({
    type: "layer.visible",
    label: (p: { layerId: string; visible: boolean }) => (p.visible ? "Show" : "Hide"),
    validate: (raw, doc) => {
      const o = v.obj(raw, "layer.visible");
      const layerId = v.str(o, "layerId", "layer.visible");
      v.requireLayer(doc, layerId, "layer.visible");
      if (typeof o.visible !== "boolean") throw new CommandError(`layer.visible: "visible" must be true or false`);
      return { layerId, visible: o.visible };
    },
    apply: (p, doc) => setLayerVisible(doc, p.layerId, p.visible),
  }),
  define({
    type: "layer.locked",
    label: (p: { layerId: string; locked: boolean }) => (p.locked ? "Lock" : "Unlock"),
    validate: (raw, doc) => {
      const o = v.obj(raw, "layer.locked");
      const layerId = v.str(o, "layerId", "layer.locked");
      v.requireLayer(doc, layerId, "layer.locked");
      if (typeof o.locked !== "boolean") throw new CommandError(`layer.locked: "locked" must be true or false`);
      return { layerId, locked: o.locked };
    },
    apply: (p, doc) => setLayerLocked(doc, p.layerId, p.locked),
  }),
  define({
    type: "layer.reorder",
    label: "Reorder",
    validate: (raw, doc) => {
      const o = v.obj(raw, "layer.reorder");
      const layerId = v.str(o, "layerId", "layer.reorder");
      v.requireLayer(doc, layerId, "layer.reorder", { unlocked: true });
      if (o.dir !== 1 && o.dir !== -1) throw new CommandError(`layer.reorder: "dir" must be 1 (forward) or -1 (backward)`);
      return { layerId, dir: o.dir as 1 | -1 };
    },
    apply: (p, doc) => reorderLayer(doc, p.layerId, p.dir),
  }),
  define({
    type: "layer.fill",
    label: "Fill",
    validate: (raw) => ({ color: rgba(v.obj(raw, "layer.fill").color, "layer.fill", "color") }),
    apply: (p, doc) => applyFill(doc, p.color),
  }),
  define({
    type: "vector.gradientFill",
    label: "Gradient fill",
    validate: (raw) => {
      const o = v.obj(raw, "vector.gradientFill");
      if (o.type !== "linear" && o.type !== "radial") {
        throw new CommandError(`vector.gradientFill: "type" must be linear or radial`);
      }
      const angle = v.num(o, "angle", "vector.gradientFill", { min: -3600, max: 3600 });
      if (!Array.isArray(o.stops) || o.stops.length < 2) {
        throw new CommandError(`vector.gradientFill: "stops" needs at least 2 entries`);
      }
      if (o.stops.length > MAX_GRADIENT_STOPS) {
        throw new CommandError(`vector.gradientFill: "stops" has too many entries (max ${MAX_GRADIENT_STOPS})`);
      }
      const stops: GradientStop[] = o.stops.map((s, i) => {
        const so = v.obj(s, "vector.gradientFill");
        const offset = so.offset;
        if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0 || offset > 1) {
          throw new CommandError(`vector.gradientFill: stops[${i}].offset must be 0..1`);
        }
        return { offset, color: rgba(so.color, "vector.gradientFill", "color") };
      });
      const fill: GradientFill = { type: o.type, angle: angle ?? 90, stops };
      return { fill };
    },
    apply: (p, doc) => {
      const next = applyVectorFill(doc, p.fill);
      if (next === doc) throw new CommandError(`vector.gradientFill: select at least one unlocked vector`);
      return next;
    },
  }),

  // ── creation ──
  define({
    type: "vector.addRect",
    label: "Rectangle",
    validate: (raw) => {
      const o = v.obj(raw, "vector.addRect");
      return {
        x: reqNum(o, "x", "vector.addRect"),
        y: reqNum(o, "y", "vector.addRect"),
        w: reqNum(o, "w", "vector.addRect", SIZE),
        h: reqNum(o, "h", "vector.addRect", SIZE),
        fill: rgba(o.fill, "vector.addRect", "fill"),
      };
    },
    apply: (p, doc) => addVectorRect(doc, p.x, p.y, p.w, p.h, p.fill),
  }),
  define({
    type: "vector.addEllipse",
    label: "Ellipse",
    validate: (raw) => {
      const o = v.obj(raw, "vector.addEllipse");
      return {
        x: reqNum(o, "x", "vector.addEllipse"),
        y: reqNum(o, "y", "vector.addEllipse"),
        w: reqNum(o, "w", "vector.addEllipse", SIZE),
        h: reqNum(o, "h", "vector.addEllipse", SIZE),
        fill: rgba(o.fill, "vector.addEllipse", "fill"),
      };
    },
    apply: (p, doc) => addVectorEllipse(doc, p.x, p.y, p.w, p.h, p.fill),
  }),
  define({
    type: "vector.addRoundRect",
    label: "Rounded rectangle",
    validate: (raw) => {
      const o = v.obj(raw, "vector.addRoundRect");
      return {
        x: reqNum(o, "x", "vector.addRoundRect"),
        y: reqNum(o, "y", "vector.addRoundRect"),
        w: reqNum(o, "w", "vector.addRoundRect", SIZE),
        h: reqNum(o, "h", "vector.addRoundRect", SIZE),
        fill: rgba(o.fill, "vector.addRoundRect", "fill"),
        radius: reqNum(o, "radius", "vector.addRoundRect", { min: 0, max: 200_000 }),
      };
    },
    apply: (p, doc) => addVectorRoundRect(doc, p.x, p.y, p.w, p.h, p.fill, p.radius),
  }),
  define({
    type: "vector.addPolygon",
    label: "Polygon",
    validate: (raw) => {
      const o = v.obj(raw, "vector.addPolygon");
      return {
        x: reqNum(o, "x", "vector.addPolygon"),
        y: reqNum(o, "y", "vector.addPolygon"),
        w: reqNum(o, "w", "vector.addPolygon", SIZE),
        h: reqNum(o, "h", "vector.addPolygon", SIZE),
        fill: rgba(o.fill, "vector.addPolygon", "fill"),
        sides: reqNum(o, "sides", "vector.addPolygon", { min: 3, max: 24 }),
      };
    },
    apply: (p, doc) => addVectorPolygon(doc, p.x, p.y, p.w, p.h, p.fill, p.sides),
  }),
  define({
    type: "vector.addStar",
    label: "Star",
    validate: (raw) => {
      const o = v.obj(raw, "vector.addStar");
      return {
        x: reqNum(o, "x", "vector.addStar"),
        y: reqNum(o, "y", "vector.addStar"),
        w: reqNum(o, "w", "vector.addStar", SIZE),
        h: reqNum(o, "h", "vector.addStar", SIZE),
        fill: rgba(o.fill, "vector.addStar", "fill"),
        points: reqNum(o, "points", "vector.addStar", { min: 3, max: 16 }),
      };
    },
    apply: (p, doc) => addVectorStar(doc, p.x, p.y, p.w, p.h, p.fill, p.points),
  }),
  define({
    type: "vector.addLine",
    label: "Line",
    validate: (raw) => {
      const o = v.obj(raw, "vector.addLine");
      const s = v.obj(o.stroke, "vector.addLine");
      return {
        x1: reqNum(o, "x1", "vector.addLine"),
        y1: reqNum(o, "y1", "vector.addLine"),
        x2: reqNum(o, "x2", "vector.addLine"),
        y2: reqNum(o, "y2", "vector.addLine"),
        stroke: { color: rgba(s.color, "vector.addLine", "stroke.color"), width: reqNum(s, "width", "vector.addLine", SIZE) },
      };
    },
    apply: (p, doc) => addVectorLine(doc, p.x1, p.y1, p.x2, p.y2, p.stroke),
  }),
  define({
    type: "vector.addPath",
    label: "Pen",
    validate: (raw) => {
      const o = v.obj(raw, "vector.addPath");
      return {
        x: reqNum(o, "x", "vector.addPath"),
        y: reqNum(o, "y", "vector.addPath"),
        color: rgba(o.color, "vector.addPath", "color"),
      };
    },
    apply: (p, doc) => addVectorPath(doc, p.x, p.y, p.color),
  }),
  define({
    type: "path.appendNode",
    label: "Add node",
    validate: (raw, doc) => {
      const o = v.obj(raw, "path.appendNode");
      const layerId = v.str(o, "layerId", "path.appendNode");
      v.requireLayer(doc, layerId, "path.appendNode", { kind: "vector", unlocked: true });
      return { layerId, x: reqNum(o, "x", "path.appendNode"), y: reqNum(o, "y", "path.appendNode") };
    },
    apply: (p, doc) => appendPathNode(doc, p.layerId, p.x, p.y),
  }),
  define({
    type: "path.close",
    label: "Close path",
    validate: layerOnly("path.close", { kind: "vector", unlocked: true }),
    apply: (p, doc) => closePath(doc, p.layerId),
  }),
  define({
    type: "type.addFrame",
    label: "Type frame",
    validate: (raw) => {
      const o = v.obj(raw, "type.addFrame");
      const w = v.num(o, "w", "type.addFrame", SIZE);
      const h = v.num(o, "h", "type.addFrame", SIZE);
      return {
        fontId: v.str(o, "fontId", "type.addFrame"),
        x: reqNum(o, "x", "type.addFrame"),
        y: reqNum(o, "y", "type.addFrame"),
        w,
        h,
        text: typeof o.text === "string" ? o.text : undefined,
      };
    },
    apply: (p, doc) => addTypeFrame(doc, p.fontId, p.x, p.y, { w: p.w, h: p.h, text: p.text }),
  }),
  define({
    type: "image.place",
    label: "Place image",
    validate: (raw) => {
      const o = v.obj(raw, "image.place");
      const a = v.obj(o.asset, "image.place");
      const dataUrl = v.str(a, "dataUrl", "image.place");
      if (!dataUrl.startsWith("data:")) throw new CommandError(`image.place: "asset.dataUrl" must be a data: URL`);
      return {
        asset: {
          name: v.str(a, "name", "image.place"),
          mime: v.str(a, "mime", "image.place"),
          dataUrl,
          width: reqNum(a, "width", "image.place", SIZE),
          height: reqNum(a, "height", "image.place", SIZE),
        },
        x: reqNum(o, "x", "image.place"),
        y: reqNum(o, "y", "image.place"),
      };
    },
    apply: (p, doc) => addImageFrame(doc, p.asset, p.x, p.y),
  }),
  define({
    type: "image.addFrame",
    label: "Frame",
    validate: (raw) => {
      const o = v.obj(raw, "image.addFrame");
      return {
        x: reqNum(o, "x", "image.addFrame"),
        y: reqNum(o, "y", "image.addFrame"),
        w: reqNum(o, "w", "image.addFrame", SIZE),
        h: reqNum(o, "h", "image.addFrame", SIZE),
      };
    },
    apply: (p, doc) => addEmptyImageFrame(doc, p.x, p.y, p.w, p.h),
  }),
  define({
    type: "image.fillFrame",
    label: "Place into frame",
    validate: (raw, doc) => {
      const o = v.obj(raw, "image.fillFrame");
      const layerId = v.str(o, "layerId", "image.fillFrame");
      v.requireLayer(doc, layerId, "image.fillFrame", { kind: "image-frame", unlocked: true });
      const a = v.obj(o.asset, "image.fillFrame");
      const dataUrl = v.str(a, "dataUrl", "image.fillFrame");
      if (!dataUrl.startsWith("data:")) throw new CommandError(`image.fillFrame: "asset.dataUrl" must be a data: URL`);
      return {
        layerId,
        asset: {
          name: v.str(a, "name", "image.fillFrame"),
          mime: v.str(a, "mime", "image.fillFrame"),
          dataUrl,
          width: reqNum(a, "width", "image.fillFrame", SIZE),
          height: reqNum(a, "height", "image.fillFrame", SIZE),
        },
      };
    },
    apply: (p, doc) => fillImageFrame(doc, p.layerId, p.asset),
  }),
  define({
    type: "page.guide",
    label: "Guide",
    validate: (raw) => {
      const o = v.obj(raw, "page.guide");
      if (o.axis !== "h" && o.axis !== "v") {
        throw new CommandError(`page.guide: "axis" must be h or v, got ${JSON.stringify(o.axis)}`);
      }
      return { axis: o.axis as "h" | "v", offset: reqNum(o, "offset", "page.guide") };
    },
    apply: (p, doc) => addGuide(doc, p.axis, p.offset),
  }),

  // ── type ──
  define({
    type: "story.setText",
    label: "Edit text",
    validate: (raw, doc) => {
      const o = v.obj(raw, "story.setText");
      const layerId = v.str(o, "layerId", "story.setText");
      v.requireLayer(doc, layerId, "story.setText", { kind: "type-frame" });
      if (typeof o.text !== "string") throw new CommandError(`story.setText: "text" must be a string`);
      const session = o.session === undefined ? undefined : v.str(o, "session", "story.setText");
      return { layerId, text: o.text, session };
    },
    apply: (p, doc) => setStoryText(doc, p.layerId, p.text),
    coalesceKey: (p) => (p.session ? `story.setText:${p.layerId}:${p.session}` : null),
  }),
  define({
    type: "story.replaceRange",
    label: "Edit text range",
    validate: (raw, doc) => {
      const o = v.obj(raw, "story.replaceRange");
      const layerId = v.str(o, "layerId", "story.replaceRange");
      const { start, end } = checkedRange(doc, layerId, o, "story.replaceRange");
      if (typeof o.text !== "string") throw new CommandError(`story.replaceRange: "text" must be a string`);
      const affinities: TextAffinity[] = ["backward", "forward", "none"];
      const affinity = o.affinity === undefined ? "backward" : o.affinity;
      if (typeof affinity !== "string" || !affinities.includes(affinity as TextAffinity)) {
        throw new CommandError(`story.replaceRange: "affinity" must be backward | forward | none`);
      }
      return { layerId, start, end, text: o.text, affinity: affinity as TextAffinity };
    },
    apply: (p, doc) =>
      replaceStoryInDocument(doc, p.layerId, (story) => replaceStoryRange(story, p.start, p.end, p.text, p.affinity)),
  }),
  define({
    type: "type.characterRange",
    label: "Format character range",
    validate: (raw, doc) => {
      const o = v.obj(raw, "type.characterRange");
      const layerId = v.str(o, "layerId", "type.characterRange");
      const { start, end } = checkedRange(doc, layerId, o, "type.characterRange");
      if (start === end) throw new CommandError(`type.characterRange: formatting range must not be empty`);
      const overrides: Partial<CharacterStyle> = {};
      const size = v.num(o, "size", "type.characterRange", SIZE);
      const leading = v.num(o, "leading", "type.characterRange", SIZE);
      const tracking = v.num(o, "tracking", "type.characterRange", { min: -2000, max: 2000 });
      const horizontalScale = v.num(o, "horizontalScale", "type.characterRange", { gt: 0, max: 1000 });
      const verticalScale = v.num(o, "verticalScale", "type.characterRange", { gt: 0, max: 1000 });
      const baselineShift = v.num(o, "baselineShift", "type.characterRange", COORD);
      if (size !== undefined) overrides.size = size;
      if (leading !== undefined) overrides.leading = leading;
      if (tracking !== undefined) overrides.tracking = tracking;
      if (horizontalScale !== undefined) overrides.horizontalScale = horizontalScale;
      if (verticalScale !== undefined) overrides.verticalScale = verticalScale;
      if (baselineShift !== undefined) overrides.baselineShift = baselineShift;
      if (o.fontId !== undefined) overrides.fontId = v.str(o, "fontId", "type.characterRange");
      if (o.fill !== undefined) overrides.fill = rgba(o.fill, "type.characterRange", "fill");
      if (o.underline !== undefined) {
        if (typeof o.underline !== "boolean") throw new CommandError(`type.characterRange: "underline" must be true or false`);
        overrides.underline = o.underline;
      }
      if (o.strikethrough !== undefined) {
        if (typeof o.strikethrough !== "boolean") throw new CommandError(`type.characterRange: "strikethrough" must be true or false`);
        overrides.strikethrough = o.strikethrough;
      }
      if (!Object.keys(overrides).length) {
        throw new CommandError(`type.characterRange: give at least one character property`);
      }
      const styleId = o.styleId === undefined || o.styleId === null ? null : v.str(o, "styleId", "type.characterRange");
      return { layerId, start, end, overrides, styleId };
    },
    apply: (p, doc) =>
      replaceStoryInDocument(doc, p.layerId, (story) => applyCharacterRange(story, p.start, p.end, p.overrides, p.styleId)),
  }),
  define({
    type: "type.paragraphRange",
    label: "Format paragraph range",
    validate: (raw, doc) => {
      const o = v.obj(raw, "type.paragraphRange");
      const layerId = v.str(o, "layerId", "type.paragraphRange");
      const { start, end } = checkedRange(doc, layerId, o, "type.paragraphRange");
      const overrides: Partial<ParagraphStyle> = {};
      const aligns: Align[] = ["left", "center", "right", "justify"];
      if (o.align !== undefined) {
        if (typeof o.align !== "string" || !aligns.includes(o.align as Align)) {
          throw new CommandError(`type.paragraphRange: "align" must be one of ${aligns.join(" | ")}`);
        }
        overrides.align = o.align as Align;
      }
      for (const key of ["firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter"] as const) {
        const value = v.num(o, key, "type.paragraphRange", COORD);
        if (value !== undefined) overrides[key] = value;
      }
      if (!Object.keys(overrides).length) {
        throw new CommandError(`type.paragraphRange: give at least one paragraph property`);
      }
      const styleId = o.styleId === undefined || o.styleId === null ? null : v.str(o, "styleId", "type.paragraphRange");
      return { layerId, start, end, overrides, styleId };
    },
    apply: (p, doc) =>
      replaceStoryInDocument(doc, p.layerId, (story) => applyParagraphRange(story, p.start, p.end, p.overrides, p.styleId)),
  }),
  define({
    type: "type.character",
    label: "Character",
    validate: (raw, doc) => {
      const o = v.obj(raw, "type.character");
      const layerId = v.str(o, "layerId", "type.character");
      v.requireLayer(doc, layerId, "type.character", { kind: "type-frame" });
      const patch: CharacterPatch = {};
      const size = v.num(o, "size", "type.character", SIZE);
      const leading = v.num(o, "leading", "type.character", SIZE);
      const tracking = v.num(o, "tracking", "type.character", { min: -1000, max: 1000 });
      const baselineShift = v.num(o, "baselineShift", "type.character", COORD);
      if (size !== undefined) patch.size = size;
      if (leading !== undefined) patch.leading = leading;
      if (tracking !== undefined) patch.tracking = tracking;
      if (baselineShift !== undefined) patch.baselineShift = baselineShift;
      if (o.fill !== undefined) patch.fill = rgba(o.fill, "type.character", "fill");
      if (o.fontId !== undefined) patch.fontId = v.str(o, "fontId", "type.character");
      if (o.underline !== undefined) {
        if (typeof o.underline !== "boolean") throw new CommandError(`type.character: "underline" must be true or false`);
        patch.underline = o.underline;
      }
      if (o.strikethrough !== undefined) {
        if (typeof o.strikethrough !== "boolean") throw new CommandError(`type.character: "strikethrough" must be true or false`);
        patch.strikethrough = o.strikethrough;
      }
      if (!Object.keys(patch).length) {
        throw new CommandError(`type.character: give at least one of "size", "leading", "tracking", "fill", "fontId", "underline", "strikethrough", "baselineShift"`);
      }
      return { layerId, patch };
    },
    apply: (p, doc) => setCharacter(doc, p.layerId, p.patch),
  }),
  define({
    type: "layer.flip",
    label: (p: { axis: "h" | "v" }) => (p.axis === "h" ? "Flip Horizontal" : "Flip Vertical"),
    validate: (raw) => {
      const o = v.obj(raw, "layer.flip");
      if (o.axis !== "h" && o.axis !== "v") {
        throw new CommandError(`layer.flip: "axis" must be h or v, got ${JSON.stringify(o.axis)}`);
      }
      return { axis: o.axis as "h" | "v" };
    },
    apply: (p, doc) => {
      const next = flipLayers(doc, doc.activeLayerIds, p.axis);
      if (next === doc) {
        throw new CommandError(`layer.flip: select at least one unlocked layer`);
      }
      return next;
    },
  }),
  define({
    type: "type.paragraphAlign",
    label: "Paragraph",
    validate: (raw, doc) => {
      const o = v.obj(raw, "type.paragraphAlign");
      const layerId = v.str(o, "layerId", "type.paragraphAlign");
      v.requireLayer(doc, layerId, "type.paragraphAlign", { kind: "type-frame" });
      const aligns: Align[] = ["left", "center", "right", "justify"];
      if (typeof o.align !== "string" || !aligns.includes(o.align as Align)) {
        throw new CommandError(`type.paragraphAlign: "align" must be one of ${aligns.join(" | ")}, got ${JSON.stringify(o.align)}`);
      }
      return { layerId, align: o.align as Align };
    },
    apply: (p, doc) => setParagraphAlign(doc, p.layerId, p.align),
  }),
  define({
    type: "type.paragraphSpacing",
    label: "Paragraph",
    validate: (raw, doc) => {
      const o = v.obj(raw, "type.paragraphSpacing");
      const layerId = v.str(o, "layerId", "type.paragraphSpacing");
      v.requireLayer(doc, layerId, "type.paragraphSpacing", { kind: "type-frame" });
      const firstLineIndent = v.num(o, "firstLineIndent", "type.paragraphSpacing", { min: -100_000, max: 100_000 });
      const spaceAfter = v.num(o, "spaceAfter", "type.paragraphSpacing", { min: -100_000, max: 100_000 });
      if (firstLineIndent === undefined && spaceAfter === undefined) {
        throw new CommandError(`type.paragraphSpacing: give at least one of "firstLineIndent", "spaceAfter"`);
      }
      return { layerId, firstLineIndent, spaceAfter };
    },
    // No primitive exists in ops.ts for these two fields, so the command owns
    // the mutation. It stays copy-on-write like everything else.
    apply: (p, doc) => {
      const next = cloneDoc(doc);
      const page = next.pages.find((pg) => pg.id === next.activePageId);
      const layer = page?.layers.find((l) => l.id === p.layerId);
      if (!layer || layer.kind !== "type-frame") return next;
      const story = next.stories.find((s) => s.id === layer.storyId);
      if (!story) return next;
      if (p.firstLineIndent !== undefined) story.paragraph.firstLineIndent = p.firstLineIndent;
      if (p.spaceAfter !== undefined) story.paragraph.spaceAfter = p.spaceAfter;
      return next;
    },
  }),

  // ── vector stroke ──
  define({
    type: "vector.strokeWidth",
    label: "Stroke",
    validate: (raw) => {
      const o = v.obj(raw, "vector.strokeWidth");
      return {
        width: reqNum(o, "width", "vector.strokeWidth", { min: 0, max: 10_000 }),
        fallbackColor: rgba(o.fallbackColor, "vector.strokeWidth", "fallbackColor"),
        cap: strokeCap(o.cap, "vector.strokeWidth"),
        join: strokeJoin(o.join, "vector.strokeWidth"),
        dash: dashArray(o.dash, "vector.strokeWidth"),
        dashPhase: o.dashPhase === undefined ? undefined : reqNum(o, "dashPhase", "vector.strokeWidth", { min: 0, max: 100_000 }),
      };
    },
    // Applies to every selected vector, merging so width, cap, join and dash
    // edit independently and colour is preserved (v5 stroke styling).
    apply: (p, doc) => {
      const next = cloneDoc(doc);
      for (const layer of selectedLayers(next)) {
        if (layer.kind !== "vector" || layer.locked) continue;
        layer.stroke = mergeStroke(
          layer.stroke,
          { width: p.width, cap: p.cap, join: p.join, dash: p.dash, dashPhase: p.dashPhase },
          p.fallbackColor,
        );
      }
      return next;
    },
  }),

  // ── adjustments and assets ──
  define({
    type: "adjustment.add",
    label: "Brightness/Contrast",
    validate: (raw) => {
      const o = v.obj(raw, "adjustment.add");
      return {
        brightness: reqNum(o, "brightness", "adjustment.add", { min: -1, max: 1 }),
        contrast: reqNum(o, "contrast", "adjustment.add", { min: 0, max: 4 }),
      };
    },
    apply: (p, doc) => addAdjustment(doc, p.brightness, p.contrast),
  }),
  define({
    type: "asset.replace",
    label: "Replace asset",
    validate: (raw, doc) => {
      const o = v.obj(raw, "asset.replace");
      const assetId = v.str(o, "assetId", "asset.replace");
      if (!doc.assets[assetId]) {
        throw new CommandError(`asset.replace: no asset "${assetId}" in this document`);
      }
      const dataUrl = v.str(o, "dataUrl", "asset.replace");
      if (!dataUrl.startsWith("data:")) throw new CommandError(`asset.replace: "dataUrl" must be a data: URL`);
      return {
        assetId,
        dataUrl,
        width: reqNum(o, "width", "asset.replace", SIZE),
        height: reqNum(o, "height", "asset.replace", SIZE),
      };
    },
    apply: (p, doc) => replaceAssetData(doc, p.assetId, p.dataUrl, p.width, p.height),
  }),

  /**
   * Image Size. Resampling needs the compositor, which the document layer has no
   * access to and should not. The caller does the pixel work and passes the
   * resulting bytes in as `assets`; this command applies the geometry and swaps
   * them atomically. The derived inverse therefore carries the ORIGINAL bytes,
   * which is genuinely what undoing a resample requires.
   */
  define({
    type: "doc.imageSize",
    label: "Image Size",
    validate: (raw, doc) => {
      const o = v.obj(raw, "doc.imageSize");
      const assets: Record<string, { dataUrl: string; width: number; height: number }> = {};
      if (o.assets !== undefined) {
        const a = v.obj(o.assets, "doc.imageSize");
        for (const [id, spec] of Object.entries(a)) {
          if (!doc.assets[id]) throw new CommandError(`doc.imageSize: no asset "${id}" in this document`);
          const s = v.obj(spec, "doc.imageSize");
          assets[id] = {
            dataUrl: v.str(s, "dataUrl", "doc.imageSize"),
            width: reqNum(s, "width", "doc.imageSize", SIZE),
            height: reqNum(s, "height", "doc.imageSize", SIZE),
          };
        }
      }
      return {
        w: reqNum(o, "w", "doc.imageSize", SIZE),
        h: reqNum(o, "h", "doc.imageSize", SIZE),
        ppi: reqNum(o, "ppi", "doc.imageSize", { gt: 0, max: 10_000 }),
        resample: o.resample === true,
        assets,
      };
    },
    apply: (p, doc) => {
      const next = applyImageSize(doc, p.w, p.h, p.ppi, p.resample);
      for (const [id, a] of Object.entries(p.assets)) {
        const asset = next.assets[id];
        if (!asset) continue;
        asset.dataUrl = a.dataUrl;
        asset.width = a.width;
        asset.height = a.height;
      }
      return next;
    },
  }),
] as unknown as CommandDef<never>[];

let installed = false;

/** Register the UI editing commands. Explicit, like `installAnchorCommands`. */
export function installUiCommands(): void {
  if (installed) return;
  for (const def of DEFS) registerCommand(def);
  installed = true;
}

/** Names of the commands this module contributes. */
export const UI_COMMAND_TYPES: string[] = DEFS.map((d) => d.type);

export type { ImageFit, ResampleAlgo };
