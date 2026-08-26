/**
 * Typed command registry — the one way the document is mutated.
 *
 * Foundation deliverable B. Every UI action, keyboard shortcut, import and AI
 * proposal is meant to arrive here as the same kind of object, so that undo,
 * audit, preview and automation are one mechanism rather than four.
 *
 * A command is a plain `{ type, params }` value. That is deliberate:
 *
 *   serializable   it can be logged, replayed, sent over a wire, or emitted by
 *                  a model. No closures, no class instances, no document refs.
 *   validated      `validate` throws a precise, quotable error. The primitives
 *                  in `ops.ts` mostly return the document UNCHANGED when the
 *                  layer is missing, the wrong kind, or locked — a silent
 *                  no-op. Every command closes that hole before applying.
 *   declares scope `affects` names the layers touched, which is what lets the
 *                  bus report a dirty region instead of repainting the world.
 *   invertible     `invert` is read against the document BEFORE `apply`, and
 *                  returns a command that puts it back. Undo therefore costs
 *                  one small command, not a clone of the whole document.
 *   coalescable    `coalesceKey` lets a drag of two hundred pointer events
 *                  collapse into one history entry.
 *
 * See docs/adr/0002-command-bus.md.
 */
import type { ImageFit, PressDocument, Transform } from "./types";
import { applyPatch, diffDocuments, type DocPatch } from "./patch";
import { activePage, findLayer } from "./factory";
import { setImageCrop, setImageFit, setImageFocal, setLayerTransform } from "./ops";

export interface Command<P = Record<string, unknown>> {
  type: string;
  params: P;
}

export interface ApplyResult {
  doc: PressDocument;
  /** What this command actually did, for the audit trail. */
  summary?: string;
}

/** Thrown by `validate`. The message is meant to be shown verbatim. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Raised when a change touched a document field the diff cannot express, so no
 * honest inverse can be built. The caller falls back to a snapshot entry rather
 * than recording an undo that would silently lose data.
 */
export class PatchScopeError extends CommandError {
  constructor(message: string) {
    super(message);
    this.name = "PatchScopeError";
  }
}

/**
 * Derive an inverse by diffing. This is what lets a command with complex or
 * open-ended effects opt into undo without hand-writing the reversal. See
 * docs/adr/0003-derived-inverses.md.
 */
export function deriveInverse(what: string, before: PressDocument, after: PressDocument): Command {
  const { patch, outOfScope, affected } = diffDocuments(before, after);
  if (outOfScope.length) {
    throw new PatchScopeError(
      `${what} changed ${outOfScope.join(", ")}, which the diff cannot express — ` +
        `this change must be applied through the snapshot path until patch.ts covers it`,
    );
  }
  return { type: "doc.restore", params: { patch: patch ?? {}, affected } };
}

export interface CommandDef<P> {
  type: string;
  /** Shown in the History panel. */
  label(params: P, doc: PressDocument): string;
  /** Normalise and check. MUST throw rather than silently correct. */
  validate(params: unknown, doc: PressDocument): P;
  /** Layer ids read or written, for dirty-region reporting. */
  affects(params: P, doc: PressDocument): string[];
  /**
   * Read against the PRE-apply document; returns a command restoring it.
   *
   * A command must provide EXACTLY ONE of `invert` or `invertAfter`. Most know
   * their inverse up front: to undo "set x to 900" you only need the current x.
   */
  invert?(params: P, doc: PressDocument): Command;
  /**
   * For commands whose inverse cannot be known until the work is done — an
   * Anchor op may create, delete and reorder layers in one step. The bus
   * applies first, then derives the inverse by diffing. See patch.ts.
   */
  invertAfter?(params: P, before: PressDocument, after: PressDocument): Command;
  /**
   * Do the work. `summary` is what actually happened, in the command's own
   * words ("rectangle ly_x 900x300 at 200,200"). The bus collects these into the
   * audit trail, which is what makes a batch reviewable after the fact.
   */
  apply(params: P, doc: PressDocument): ApplyResult;
  /** Consecutive commands with an equal non-null key merge into one entry. */
  coalesceKey?(params: P): string | null;
}

// ── validation helpers ───────────────────────────────────────────────────────

function obj(params: unknown, type: string): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new CommandError(`${type}: params must be an object, got ${Array.isArray(params) ? "array" : typeof params}`);
  }
  return params as Record<string, unknown>;
}

function num(p: Record<string, unknown>, key: string, type: string, opts: { min?: number; max?: number; gt?: number } = {}): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new CommandError(`${type}: "${key}" must be a finite number, got ${JSON.stringify(v)}`);
  }
  if (opts.gt !== undefined && v <= opts.gt) {
    throw new CommandError(`${type}: "${key}" must be greater than ${opts.gt}, got ${v}`);
  }
  if (opts.min !== undefined && v < opts.min) throw new CommandError(`${type}: "${key}" must be >= ${opts.min}, got ${v}`);
  if (opts.max !== undefined && v > opts.max) throw new CommandError(`${type}: "${key}" must be <= ${opts.max}, got ${v}`);
  return v;
}

function str(p: Record<string, unknown>, key: string, type: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new CommandError(`${type}: "${key}" is required and must be a non-empty string`);
  return v;
}

/**
 * Resolve a layer id, refusing every case `ops.ts` would silently ignore.
 * A command that cannot do what it says must fail loudly.
 */
function requireLayer(doc: PressDocument, layerId: string, type: string, opts: { kind?: string; unlocked?: boolean } = {}) {
  const page = activePage(doc);
  const layer = findLayer(page, layerId);
  if (!layer) {
    const ids = page.layers.slice(0, 6).map((l) => l.id).join(", ");
    throw new CommandError(
      `${type}: no layer "${layerId}" on the active page "${page.name}"` + (ids ? ` — ids here: ${ids}` : " — the page is empty"),
    );
  }
  if (opts.kind && layer.kind !== opts.kind) {
    throw new CommandError(`${type}: layer "${layer.name}" is a ${layer.kind} layer; this command needs ${opts.kind}`);
  }
  if (opts.unlocked && layer.locked) {
    throw new CommandError(`${type}: layer "${layer.name}" is locked — unlock it first`);
  }
  return layer;
}

/**
 * Shared validation helpers. Exported so commands defined in other modules
 * validate the same way and produce the same error wording, rather than each
 * growing its own dialect.
 */
export const v = { obj, num, str, requireLayer };

const COORD = { min: -1_000_000, max: 1_000_000 };
const SCALE = { min: -100, max: 100 };

// ── layer.transform ──────────────────────────────────────────────────────────

export interface TransformParams {
  layerId: string;
  patch: Partial<Transform>;
  /** Groups a drag into one history entry. Absent means "do not coalesce". */
  session?: string;
}

const TRANSFORM_KEYS = ["x", "y", "w", "h", "rotation", "scaleX", "scaleY"] as const;

const transformCmd: CommandDef<TransformParams> = {
  type: "layer.transform",
  label: (p, doc) => {
    const l = findLayer(activePage(doc), p.layerId);
    return `Transform${l ? ` ${l.name}` : ""}`;
  },
  validate(raw, doc) {
    const p = obj(raw, "layer.transform");
    const layerId = str(p, "layerId", "layer.transform");
    requireLayer(doc, layerId, "layer.transform", { unlocked: true });
    const src = obj(p.patch ?? {}, "layer.transform");
    const patch: Partial<Transform> = {};
    const unknown = Object.keys(src).filter((k) => !(TRANSFORM_KEYS as readonly string[]).includes(k));
    if (unknown.length) {
      throw new CommandError(
        `layer.transform: unknown patch field(s) ${unknown.map((k) => `"${k}"`).join(", ")}. It takes: ${TRANSFORM_KEYS.join(", ")}`,
      );
    }
    const x = num(src, "x", "layer.transform", COORD);
    const y = num(src, "y", "layer.transform", COORD);
    const w = num(src, "w", "layer.transform", { gt: 0, max: COORD.max });
    const h = num(src, "h", "layer.transform", { gt: 0, max: COORD.max });
    const rotation = num(src, "rotation", "layer.transform", { min: -3600, max: 3600 });
    const scaleX = num(src, "scaleX", "layer.transform", SCALE);
    const scaleY = num(src, "scaleY", "layer.transform", SCALE);
    if (scaleX === 0 || scaleY === 0) {
      throw new CommandError(`layer.transform: a scale of 0 is non-invertible and would break hit-testing; hide the layer instead`);
    }
    if (x !== undefined) patch.x = x;
    if (y !== undefined) patch.y = y;
    if (w !== undefined) patch.w = w;
    if (h !== undefined) patch.h = h;
    if (rotation !== undefined) patch.rotation = rotation;
    if (scaleX !== undefined) patch.scaleX = scaleX;
    if (scaleY !== undefined) patch.scaleY = scaleY;
    if (!Object.keys(patch).length) {
      throw new CommandError(`layer.transform: give at least one of ${TRANSFORM_KEYS.join(", ")}`);
    }
    const session = typeof p.session === "string" && p.session ? p.session : undefined;
    return { layerId, patch, ...(session ? { session } : {}) };
  },
  affects: (p) => [p.layerId],
  invert(p, doc) {
    const t = requireLayer(doc, p.layerId, "layer.transform").transform;
    // Invert only the fields this command actually writes, so undo does not
    // resurrect values the user changed by some other means in between.
    const patch: Partial<Transform> = {};
    for (const k of TRANSFORM_KEYS) {
      if (p.patch[k] !== undefined) patch[k] = k === "scaleX" || k === "scaleY" ? (t[k] ?? 1) : t[k];
    }
    return { type: "layer.transform", params: { layerId: p.layerId, patch } };
  },
  apply: (p, doc) => ({ doc: setLayerTransform(doc, p.layerId, p.patch) }),
  coalesceKey: (p) => (p.session ? `layer.transform:${p.layerId}:${p.session}` : null),
};

// ── image.fit ────────────────────────────────────────────────────────────────

export interface FitParams {
  layerId: string;
  fit: ImageFit;
}

const FITS: ImageFit[] = ["cover", "contain", "stretch"];

const fitCmd: CommandDef<FitParams> = {
  type: "image.fit",
  label: (p) => `Fit ${p.fit}`,
  validate(raw, doc) {
    const p = obj(raw, "image.fit");
    const layerId = str(p, "layerId", "image.fit");
    requireLayer(doc, layerId, "image.fit", { kind: "image-frame", unlocked: true });
    const fit = p.fit;
    if (typeof fit !== "string" || !FITS.includes(fit as ImageFit)) {
      throw new CommandError(`image.fit: "fit" must be one of ${FITS.join(" | ")}, got ${JSON.stringify(fit)}`);
    }
    return { layerId, fit: fit as ImageFit };
  },
  affects: (p) => [p.layerId],
  invert(p, doc) {
    const layer = requireLayer(doc, p.layerId, "image.fit", { kind: "image-frame" });
    const fit = layer.kind === "image-frame" ? layer.fit : "stretch";
    return { type: "image.fit", params: { layerId: p.layerId, fit } };
  },
  apply: (p, doc) => ({ doc: setImageFit(doc, p.layerId, p.fit) }),
};

// ── image.focal ──────────────────────────────────────────────────────────────

export interface FocalParams {
  layerId: string;
  x: number;
  y: number;
  session?: string;
}

const focalCmd: CommandDef<FocalParams> = {
  type: "image.focal",
  label: () => "Focal point",
  validate(raw, doc) {
    const p = obj(raw, "image.focal");
    const layerId = str(p, "layerId", "image.focal");
    requireLayer(doc, layerId, "image.focal", { kind: "image-frame", unlocked: true });
    const x = num(p, "x", "image.focal", { min: 0, max: 1 });
    const y = num(p, "y", "image.focal", { min: 0, max: 1 });
    if (x === undefined || y === undefined) {
      throw new CommandError(`image.focal: both "x" and "y" are required, each a fraction 0-1 of the frame`);
    }
    const session = typeof p.session === "string" && p.session ? p.session : undefined;
    return { layerId, x, y, ...(session ? { session } : {}) };
  },
  affects: (p) => [p.layerId],
  invert(p, doc) {
    const layer = requireLayer(doc, p.layerId, "image.focal", { kind: "image-frame" });
    const f = layer.kind === "image-frame" ? layer.focal : { x: 0.5, y: 0.5 };
    return { type: "image.focal", params: { layerId: p.layerId, x: f.x, y: f.y } };
  },
  apply: (p, doc) => ({ doc: setImageFocal(doc, p.layerId, p.x, p.y) }),
  coalesceKey: (p) => (p.session ? `image.focal:${p.layerId}:${p.session}` : null),
};

// ── image.crop ───────────────────────────────────────────────────────────────

export interface CropParams {
  layerId: string;
  /** Source-pixel window, or null to clear the crop. */
  crop: { x: number; y: number; w: number; h: number } | null;
  session?: string;
}

const cropCmd: CommandDef<CropParams> = {
  type: "image.crop",
  label: (p) => (p.crop ? "Crop" : "Clear crop"),
  validate(raw, doc) {
    const p = obj(raw, "image.crop");
    const layerId = str(p, "layerId", "image.crop");
    requireLayer(doc, layerId, "image.crop", { kind: "image-frame", unlocked: true });
    const session = typeof p.session === "string" && p.session ? p.session : undefined;
    if (p.crop === null) return { layerId, crop: null, ...(session ? { session } : {}) };
    const c = obj(p.crop, "image.crop");
    const x = num(c, "x", "image.crop", { min: 0 });
    const y = num(c, "y", "image.crop", { min: 0 });
    const w = num(c, "w", "image.crop", { gt: 0 });
    const h = num(c, "h", "image.crop", { gt: 0 });
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      throw new CommandError(`image.crop: "crop" needs x, y, w and h in SOURCE pixels, or pass crop: null to clear it`);
    }
    return { layerId, crop: { x, y, w, h }, ...(session ? { session } : {}) };
  },
  affects: (p) => [p.layerId],
  invert(p, doc) {
    const layer = requireLayer(doc, p.layerId, "image.crop", { kind: "image-frame" });
    const crop = layer.kind === "image-frame" && layer.crop ? { ...layer.crop } : null;
    return { type: "image.crop", params: { layerId: p.layerId, crop } };
  },
  apply: (p, doc) => ({ doc: setImageCrop(doc, p.layerId, p.crop) }),
  coalesceKey: (p) => (p.session ? `image.crop:${p.layerId}:${p.session}` : null),
};

// ── doc.restore ──────────────────────────────────────────────────────────────

export interface RestoreParams {
  patch: DocPatch;
  /** Layer ids the original change touched, carried so undo can report a dirty region. */
  affected: string[];
}

/**
 * The generic inverse. Any change that patch.ts can express is undone by one of
 * these, carrying only what actually differs rather than a document clone.
 */
const restoreCmd: CommandDef<RestoreParams> = {
  type: "doc.restore",
  label: () => "Restore",
  validate(raw) {
    const p = obj(raw, "doc.restore");
    if (!p.patch || typeof p.patch !== "object" || Array.isArray(p.patch)) {
      throw new CommandError(`doc.restore: "patch" is required and must be an object`);
    }
    return {
      patch: p.patch as DocPatch,
      affected: Array.isArray(p.affected) ? (p.affected as string[]) : [],
    };
  },
  affects: (p) => p.affected,
  // Restoring is itself a change, so its inverse is the diff back the other way.
  invertAfter: (p, before, after) => {
    const { patch, affected } = diffDocuments(before, after);
    return { type: "doc.restore", params: { patch: patch ?? {}, affected } };
  },
  apply: (p, doc) => ({ doc: applyPatch(doc, p.patch) }),
};

// ── registry ─────────────────────────────────────────────────────────────────

const DEFS: Record<string, CommandDef<never>> = {};

/**
 * Register a command. Exported so layers ABOVE the document model — Anchor, and
 * later import/automation — can contribute commands without this module having
 * to depend on them. The dependency arrow stays pointing inwards.
 */
export function registerCommand<P>(def: CommandDef<P>): void {
  if (DEFS[def.type]) throw new CommandError(`command "${def.type}" is already registered`);
  const hasInvert = typeof def.invert === "function";
  const hasInvertAfter = typeof def.invertAfter === "function";
  if (hasInvert === hasInvertAfter) {
    throw new CommandError(
      `command "${def.type}" must define exactly one of invert() or invertAfter(), not ${hasInvert ? "both" : "neither"}`,
    );
  }
  DEFS[def.type] = def as unknown as CommandDef<never>;
}

for (const def of [transformCmd, fitCmd, focalCmd, cropCmd, restoreCmd]) {
  registerCommand(def as CommandDef<never>);
}

export const COMMAND_TYPES: string[] = Object.keys(DEFS);

export function commandTypes(): string[] {
  return Object.keys(DEFS);
}

export function getCommandDef(type: string): CommandDef<unknown> {
  const def = DEFS[type];
  if (!def) {
    throw new CommandError(`unknown command "${type}". Known commands: ${commandTypes().join(", ")}`);
  }
  return def as unknown as CommandDef<unknown>;
}
