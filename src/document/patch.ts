/**
 * Document diffing — the generic inverse.
 *
 * Slice 3 gave every command an `invert`. Hand-writing an inverse for each of
 * Anchor's 33 ops would mean 33 more chances to get undo subtly wrong, and the
 * ops already know how to *do* things — they just do not know how to undo them.
 *
 * So the inverse is derived instead: run the op, diff the document, and keep
 * only what actually differs. The result is PROPORTIONAL TO THE CHANGE. Moving
 * one layer stores one layer record, not a clone of the document (defect #10).
 *
 * The ordering trick that makes this small: a patch stores the PRIOR ID ORDER
 * plus only the records that differ. A layer the forward op created simply is
 * not in the prior order, so it disappears on restore with no delete list. A
 * layer the forward op deleted is missing from the "after" document, so its
 * record is carried and reinserted by the order. One mechanism covers create,
 * delete, reorder and edit.
 *
 * `diffDocuments` returns `null` when nothing changed, and a patch otherwise.
 * It never returns a partial answer: anything it cannot express is reported by
 * `outOfScope`, and the caller falls back to a snapshot rather than shipping an
 * undo that silently loses data.
 */
import type { Asset, Layer, Page, PressDocument, Spread, Story, Swatch } from "./types";

export interface PagePatch {
  pageId: string;
  /** Prior ordering of layer ids on this page. */
  order: string[];
  /** Prior records for layers that differ from the after-state, or are gone from it. */
  layers: Layer[];
  /** Prior page scalars, when any of them changed. */
  fields?: Partial<Omit<Page, "layers" | "guides">>;
  /** Prior guides, when they changed. */
  guides?: Page["guides"];
}

export interface DocPatch {
  /** Prior ordering of page ids, when pages were added, removed or reordered. */
  pageOrder?: string[];
  /** Whole prior records for pages missing from the after-state. */
  restorePages?: Page[];
  pagePatches?: PagePatch[];
  storyOrder?: string[];
  stories?: Story[];
  /** Prior records for assets that differ or are gone. */
  assets?: Record<string, Asset>;
  /** Asset ids the forward change created. */
  removeAssets?: string[];
  activePageId?: string;
  activeLayerIds?: string[];
  name?: string;
  ppi?: number;
  /** Small whole-array fields, carried entire because they are cheap. */
  spreads?: Spread[];
  swatches?: Swatch[];
  color?: PressDocument["color"];
  version?: PressDocument["version"];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Fields this module cannot express. Empty today: everything a document holds is
 * covered, either proportionally (pages, layers, stories, assets) or carried
 * whole where it is small (spreads, swatches, colour). The mechanism stays
 * because a future field must fail loudly rather than be silently dropped from
 * an undo. See `outOfScope`.
 */
const UNSUPPORTED: (keyof PressDocument)[] = [];

export interface DiffResult {
  patch: DocPatch | null;
  /**
   * Document fields that changed but cannot be expressed. When non-empty the
   * caller MUST fall back to a snapshot — a patch would silently lose them.
   */
  outOfScope: string[];
  /** Layer ids created, removed or edited. Feeds dirty-region reporting. */
  affected: string[];
}

function diffPage(before: Page, after: Page): PagePatch | null {
  const afterById = new Map(after.layers.map((l) => [l.id, l]));
  const layers: Layer[] = [];
  for (const l of before.layers) {
    const now = afterById.get(l.id);
    // Carried when the record changed, or when the forward op deleted it.
    if (!now || !same(now, l)) layers.push(l);
  }
  const order = before.layers.map((l) => l.id);
  const orderChanged = !same(order, after.layers.map((l) => l.id));

  const fields: Partial<Omit<Page, "layers" | "guides">> = {};
  const scalarKeys = [
    "name",
    "widthPx",
    "heightPx",
    "bleedPx",
    "slugPx",
    "margin",
    "columns",
    "columnGutter",
    "background",
  ] as const;
  for (const k of scalarKeys) {
    if (!same(before[k], after[k])) (fields as Record<string, unknown>)[k] = before[k];
  }
  const guidesChanged = !same(before.guides, after.guides);

  if (!layers.length && !orderChanged && !Object.keys(fields).length && !guidesChanged) return null;
  return {
    pageId: before.id,
    order,
    layers,
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(guidesChanged ? { guides: before.guides } : {}),
  };
}

/** Build the patch that turns `after` back into `before`. */
export function diffDocuments(before: PressDocument, after: PressDocument): DiffResult {
  const outOfScope: string[] = [];
  for (const k of UNSUPPORTED) {
    if (!same(before[k], after[k])) outOfScope.push(k);
  }

  const patch: DocPatch = {};
  const affected = new Set<string>();

  // ── pages ──
  const beforePageIds = before.pages.map((p) => p.id);
  const afterById = new Map(after.pages.map((p) => [p.id, p]));
  if (!same(beforePageIds, after.pages.map((p) => p.id))) patch.pageOrder = beforePageIds;
  const restorePages: Page[] = [];
  const pagePatches: PagePatch[] = [];
  for (const bp of before.pages) {
    const ap = afterById.get(bp.id);
    if (!ap) {
      // The forward change removed this page; carry it whole.
      restorePages.push(bp);
      for (const l of bp.layers) affected.add(l.id);
      continue;
    }
    const pp = diffPage(bp, ap);
    if (pp) {
      pagePatches.push(pp);
      const afterIds = new Set(ap.layers.map((l) => l.id));
      const beforeIds = new Set(bp.layers.map((l) => l.id));
      for (const l of pp.layers) affected.add(l.id);
      for (const id of afterIds) if (!beforeIds.has(id)) affected.add(id);
    }
  }
  if (restorePages.length) patch.restorePages = restorePages;
  if (pagePatches.length) patch.pagePatches = pagePatches;

  // ── stories ──
  if (!same(before.stories, after.stories)) {
    patch.storyOrder = before.stories.map((s) => s.id);
    const afterStories = new Map(after.stories.map((s) => [s.id, s]));
    patch.stories = before.stories.filter((s) => {
      const now = afterStories.get(s.id);
      return !now || !same(now, s);
    });
  }

  // ── assets ──
  if (!same(Object.keys(before.assets).sort(), Object.keys(after.assets).sort()) || !same(before.assets, after.assets)) {
    const restore: Record<string, Asset> = {};
    for (const [id, asset] of Object.entries(before.assets)) {
      if (!same(after.assets[id], asset)) restore[id] = asset;
    }
    const remove = Object.keys(after.assets).filter((id) => !(id in before.assets));
    if (Object.keys(restore).length) patch.assets = restore;
    if (remove.length) patch.removeAssets = remove;
  }

  // ── document scalars ──
  if (before.activePageId !== after.activePageId) patch.activePageId = before.activePageId;
  if (!same(before.activeLayerIds, after.activeLayerIds)) patch.activeLayerIds = [...before.activeLayerIds];
  if (before.name !== after.name) patch.name = before.name;
  if (before.ppi !== after.ppi) patch.ppi = before.ppi;
  if (!same(before.spreads, after.spreads)) patch.spreads = before.spreads;
  if (!same(before.swatches, after.swatches)) patch.swatches = before.swatches;
  if (!same(before.color, after.color)) patch.color = before.color;
  if (before.version !== after.version) patch.version = before.version;

  const empty = !Object.keys(patch).length;
  return { patch: empty ? null : patch, outOfScope, affected: [...affected] };
}

/**
 * Apply a patch. The document is copied shallowly down the paths the patch
 * touches; untouched pages and layers keep their existing object identity,
 * which is what keeps this cheap.
 */
export function applyPatch(doc: PressDocument, patch: DocPatch): PressDocument {
  const next: PressDocument = { ...doc };

  if (patch.pagePatches?.length || patch.restorePages?.length || patch.pageOrder) {
    const byId = new Map(doc.pages.map((p) => [p.id, p]));
    for (const rp of patch.restorePages ?? []) byId.set(rp.id, rp);

    for (const pp of patch.pagePatches ?? []) {
      const current = byId.get(pp.pageId);
      if (!current) continue;
      const layerById = new Map(current.layers.map((l) => [l.id, l]));
      for (const l of pp.layers) layerById.set(l.id, l);
      // The prior order both restores position and drops anything the forward
      // change created, because created ids are not in it.
      const layers = pp.order.map((id) => layerById.get(id)).filter((l): l is Layer => Boolean(l));
      byId.set(pp.pageId, {
        ...current,
        ...(pp.fields ?? {}),
        ...(pp.guides ? { guides: pp.guides } : {}),
        layers,
      });
    }

    const order = patch.pageOrder ?? doc.pages.map((p) => p.id);
    next.pages = order.map((id) => byId.get(id)).filter((p): p is Page => Boolean(p));
  }

  if (patch.storyOrder) {
    const byId = new Map(doc.stories.map((s) => [s.id, s]));
    for (const s of patch.stories ?? []) byId.set(s.id, s);
    next.stories = patch.storyOrder.map((id) => byId.get(id)).filter((s): s is Story => Boolean(s));
  }

  if (patch.assets || patch.removeAssets) {
    const assets = { ...doc.assets };
    for (const id of patch.removeAssets ?? []) delete assets[id];
    Object.assign(assets, patch.assets ?? {});
    next.assets = assets;
  }

  if (patch.activePageId !== undefined) next.activePageId = patch.activePageId;
  if (patch.activeLayerIds !== undefined) next.activeLayerIds = [...patch.activeLayerIds];
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.ppi !== undefined) next.ppi = patch.ppi;
  if (patch.spreads !== undefined) next.spreads = patch.spreads;
  if (patch.swatches !== undefined) next.swatches = patch.swatches;
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.version !== undefined) next.version = patch.version;

  return next;
}

/** Rough size of a patch, for reporting how much cheaper it is than a clone. */
export function patchWeight(patch: DocPatch): number {
  return JSON.stringify(patch).length;
}
