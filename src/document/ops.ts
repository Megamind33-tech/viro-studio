import type {
  ImageFit,
  Align,
  BlendMode,
  DropShadowEffect,
  GradientOverlayEffect,
  LayerEffect,
  Layer,
  OuterGlowEffect,
  Page,
  PressDocument,
  Rgba,
  StrokeEffect,
  Transform,
} from "./types";
import { replaceStoryRange } from "./text-model";
import { applyPt, decompose, localMatrix, mul, worldBounds } from "./transform";
import { activePage, cloneDoc, findLayer, selectedLayers, uid } from "./factory";

export function setActiveLayers(doc: PressDocument, ids: string[]): PressDocument {
  const next = cloneDoc(doc);
  next.activeLayerIds = ids;
  return next;
}

export function setLayerVisible(doc: PressDocument, id: string, visible: boolean): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (layer) layer.visible = visible;
  return next;
}

export function setLayerLocked(doc: PressDocument, id: string, locked: boolean): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (layer) layer.locked = locked;
  return next;
}

export function setLayerOpacity(doc: PressDocument, id: string, opacity: number): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (layer) layer.opacity = Math.min(1, Math.max(0, opacity));
  return next;
}

export function setLayerBlend(doc: PressDocument, id: string, blend: BlendMode): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (layer) layer.blend = blend;
  return next;
}

export function setLayerName(doc: PressDocument, id: string, name: string): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (layer) layer.name = name;
  return next;
}

export type AlignMode = "left" | "center-h" | "right" | "top" | "center-v" | "bottom";

/**
 * Align the selected top-level layers to their shared selection bounds, in page
 * space. Nested layers are skipped (their local axes differ from the page), so
 * alignment stays geometrically correct. No-op below two eligible layers.
 */
export function alignLayers(doc: PressDocument, ids: string[], mode: AlignMode): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const items = ids
    .map((id) => findLayer(page, id))
    .filter((l): l is Layer => !!l && l.parentId === null && !l.locked)
    .map((l) => ({ l, b: worldBounds(page, l) }));
  if (items.length < 2) return next;
  const minX = Math.min(...items.map((i) => i.b.x));
  const maxR = Math.max(...items.map((i) => i.b.x + i.b.w));
  const minY = Math.min(...items.map((i) => i.b.y));
  const maxB = Math.max(...items.map((i) => i.b.y + i.b.h));
  for (const { l, b } of items) {
    if (mode === "left") l.transform.x += minX - b.x;
    else if (mode === "right") l.transform.x += maxR - (b.x + b.w);
    else if (mode === "center-h") l.transform.x += (minX + maxR) / 2 - (b.x + b.w / 2);
    else if (mode === "top") l.transform.y += minY - b.y;
    else if (mode === "bottom") l.transform.y += maxB - (b.y + b.h);
    else if (mode === "center-v") l.transform.y += (minY + maxB) / 2 - (b.y + b.h / 2);
  }
  return next;
}

/**
 * Evenly distribute the selected top-level layers' centres between the two
 * outermost, along the given axis. No-op below three eligible layers.
 */
export function distributeLayers(doc: PressDocument, ids: string[], axis: "h" | "v"): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const items = ids
    .map((id) => findLayer(page, id))
    .filter((l): l is Layer => !!l && l.parentId === null && !l.locked)
    .map((l) => ({ l, b: worldBounds(page, l) }));
  if (items.length < 3) return next;
  const center = (b: { x: number; y: number; w: number; h: number }) =>
    axis === "h" ? b.x + b.w / 2 : b.y + b.h / 2;
  items.sort((a, z) => center(a.b) - center(z.b));
  const first = center(items[0]!.b);
  const last = center(items[items.length - 1]!.b);
  const step = (last - first) / (items.length - 1);
  items.forEach((it, i) => {
    const target = first + step * i;
    const delta = target - center(it.b);
    if (axis === "h") it.l.transform.x += delta;
    else it.l.transform.y += delta;
  });
  return next;
}

/**
 * Set (or clear, with null) a layer's drop-shadow effect. Effects are stored as
 * a list so future styles (glow, stroke, gradient overlay) coexist; this
 * replaces only the drop-shadow entry.
 */
export function setLayerDropShadow(
  doc: PressDocument,
  id: string,
  shadow: DropShadowEffect | null,
): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer) return next;
  const effects: LayerEffect[] = (layer.effects ?? []).filter((e) => e.type !== "drop-shadow");
  if (shadow) effects.push(shadow);
  layer.effects = effects;
  return next;
}

/** Set (or clear, with null) a layer's gradient-overlay effect. */
export function setLayerGradientOverlay(
  doc: PressDocument,
  id: string,
  overlay: GradientOverlayEffect | null,
): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer) return next;
  const effects: LayerEffect[] = (layer.effects ?? []).filter((e) => e.type !== "gradient-overlay");
  if (overlay) effects.push(overlay);
  layer.effects = effects;
  return next;
}

/** Set (or clear, with null) a layer's stroke/outline effect. */
export function setLayerStrokeEffect(
  doc: PressDocument,
  id: string,
  stroke: StrokeEffect | null,
): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer) return next;
  const effects: LayerEffect[] = (layer.effects ?? []).filter((e) => e.type !== "stroke");
  if (stroke) effects.push(stroke);
  layer.effects = effects;
  return next;
}

/** Set (or clear, with null) a layer's outer-glow effect. */
export function setLayerOuterGlow(
  doc: PressDocument,
  id: string,
  glow: OuterGlowEffect | null,
): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer) return next;
  const effects: LayerEffect[] = (layer.effects ?? []).filter((e) => e.type !== "outer-glow");
  if (glow) effects.push(glow);
  layer.effects = effects;
  return next;
}

export function setLayerTransform(doc: PressDocument, id: string, patch: Partial<Transform>): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer || layer.locked) return next;
  const t = layer.transform;
  if (patch.x != null) t.x = patch.x;
  if (patch.y != null) t.y = patch.y;
  if (patch.w != null) t.w = patch.w;
  if (patch.h != null) t.h = patch.h;
  if (patch.rotation != null) t.rotation = patch.rotation;
  // v2: scale is how a GROUP resizes (it has no geometry of its own). A leaf
  // resizes through w/h. See document/transform.ts.
  if (patch.scaleX != null) t.scaleX = patch.scaleX;
  if (patch.scaleY != null) t.scaleY = patch.scaleY;
  return next;
}

export function setImageCrop(
  doc: PressDocument,
  id: string,
  crop: { x: number; y: number; w: number; h: number } | null,
): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer || layer.kind !== "image-frame" || layer.locked) return next;
  layer.crop = crop;
  return next;
}

export function setImageFit(doc: PressDocument, id: string, fit: ImageFit): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer || layer.kind !== "image-frame" || layer.locked) return next;
  layer.fit = fit;
  return next;
}

export function setImageFocal(doc: PressDocument, id: string, x: number, y: number): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), id);
  if (!layer || layer.kind !== "image-frame" || layer.locked) return next;
  layer.focal = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  return next;
}

export function setStoryText(doc: PressDocument, layerId: string, text: string): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), layerId);
  if (!layer || layer.kind !== "type-frame") return next;
  const index = next.stories.findIndex((s) => s.id === layer.storyId);
  if (index >= 0) {
    const story = next.stories[index]!;
    next.stories[index] = replaceStoryRange(story, 0, story.text.length, text, "forward");
  }
  return next;
}

export function setCharacter(
  doc: PressDocument,
  layerId: string,
  patch: { size?: number; leading?: number; tracking?: number; fill?: Rgba; fontId?: string },
): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), layerId);
  if (!layer || layer.kind !== "type-frame") return next;
  const story = next.stories.find((s) => s.id === layer.storyId);
  if (!story) return next;
  if (patch.size != null) story.character.size = patch.size;
  if (patch.leading != null) story.character.leading = patch.leading;
  if (patch.tracking != null) story.character.tracking = patch.tracking;
  if (patch.fill) story.character.fill = patch.fill;
  if (patch.fontId) story.character.fontId = patch.fontId;
  return next;
}

export function setParagraphAlign(doc: PressDocument, layerId: string, align: Align): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), layerId);
  if (!layer || layer.kind !== "type-frame") return next;
  const story = next.stories.find((s) => s.id === layer.storyId);
  if (story) story.paragraph.align = align;
  return next;
}

export function applyFill(doc: PressDocument, color: Rgba): PressDocument {
  const next = cloneDoc(doc);
  for (const layer of selectedLayers(next)) {
    if (layer.locked) continue;
    if (layer.kind === "vector") layer.fill = { ...color };
    if (layer.kind === "type-frame") {
      const story = next.stories.find((s) => s.id === layer.storyId);
      if (story) story.character.fill = { ...color };
    }
  }
  return next;
}

export function groupSelected(doc: PressDocument): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const ids = next.activeLayerIds.filter((id) => page.layers.some((l) => l.id === id && !l.parentId));
  if (ids.length < 1) return next;
  const members = page.layers.filter((l) => ids.includes(l.id));
  const xs = members.map((l) => l.transform.x);
  const ys = members.map((l) => l.transform.y);
  const x2 = members.map((l) => l.transform.x + l.transform.w);
  const y2 = members.map((l) => l.transform.y + l.transform.h);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const group: Layer = {
    id: uid("ly"),
    name: "Group",
    kind: "group",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w: Math.max(...x2) - x, h: Math.max(...y2) - y, rotation: 0 },
    parentId: null,
  };
  const insertAt = Math.min(...ids.map((id) => page.layers.findIndex((l) => l.id === id)).filter((i) => i >= 0));
  // v2: children are LOCAL to the group. Rebase them out of page space, or the
  // group origin would be applied twice the moment the group transform composes.
  for (const layer of members) {
    layer.parentId = group.id;
    layer.transform.x -= x;
    layer.transform.y -= y;
  }
  page.layers.splice(insertAt, 0, group);
  next.activeLayerIds = [group.id];
  return next;
}

export function ungroupSelected(doc: PressDocument): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const groups = selectedLayers(next).filter((l) => l.kind === "group");
  const released: string[] = [];
  for (const g of groups) {
    // v2: the group is about to disappear, so bake its transform into each
    // child. newChildLocal = groupLocal . childLocal, decomposed back into the
    // record. Without this the children would snap to the group origin.
    const gm = localMatrix(g.transform);
    for (const child of page.layers) {
      if (child.parentId === g.id) {
        const { transform: t, sheared } = decompose(
          mul(gm, localMatrix(child.transform)),
          child.transform.w,
          child.transform.h,
        );
        if (!sheared) {
          child.transform = { ...child.transform, ...t };
        } else {
          // A rotated group with non-uniform scale shears its children, and a
          // {x,y,w,h,rotation,scale} record cannot hold shear. Keep the child
          // visually anchored at its world origin rather than writing a wrong
          // rectangle, and leave the rotation/scale it already had.
          const world = applyPt(gm, child.transform.x, child.transform.y);
          child.transform = { ...child.transform, x: world.x, y: world.y };
        }
        child.parentId = g.parentId;
        released.push(child.id);
      }
    }
    const i = page.layers.findIndex((l) => l.id === g.id);
    if (i >= 0) page.layers.splice(i, 1);
  }
  next.activeLayerIds = released.length ? released : next.activeLayerIds;
  return next;
}

export function deleteSelected(doc: PressDocument): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const ids = new Set(next.activeLayerIds);
  const extra = page.layers.filter((l) => l.parentId && ids.has(l.parentId)).map((l) => l.id);
  for (const id of extra) ids.add(id);
  page.layers = page.layers.filter((l) => !ids.has(l.id));
  next.activeLayerIds = [];
  return next;
}

export function duplicateSelected(doc: PressDocument): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const copies: string[] = [];
  for (const layer of selectedLayers(next)) {
    const copy = structuredClone(layer);
    copy.id = uid("ly");
    copy.name = `${layer.name} copy`;
    copy.transform.x += 16;
    copy.transform.y += 16;
    if (copy.kind === "type-frame") {
      const story = next.stories.find((s) => s.id === copy.storyId);
      if (story) {
        const ns = structuredClone(story);
        ns.id = uid("st");
        next.stories.push(ns);
        copy.storyId = ns.id;
      }
    }
    page.layers.push(copy);
    copies.push(copy.id);
  }
  next.activeLayerIds = copies;
  return next;
}

export function reorderLayer(doc: PressDocument, id: string, dir: 1 | -1): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const i = page.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= page.layers.length) return next;
  const [item] = page.layers.splice(i, 1);
  page.layers.splice(j, 0, item);
  return next;
}

export function addAdjustment(doc: PressDocument, brightness: number, contrast: number): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const layer: Layer = {
    id: uid("ly"),
    name: "Brightness/Contrast",
    kind: "adjustment",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x: 0, y: 0, w: page.widthPx, h: page.heightPx, rotation: 0 },
    parentId: null,
    adjustment: { type: "brightness-contrast", brightness, contrast },
  };
  page.layers.push(layer);
  next.activeLayerIds = [layer.id];
  return next;
}

export function addVectorPath(doc: PressDocument, x: number, y: number, fill: Rgba | null): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const layer: Layer = {
    id: uid("ly"),
    name: "Path",
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x: x - 8, y: y - 8, w: 16, h: 16, rotation: 0 },
    parentId: null,
    closed: false,
    nodes: [{ x: 8, y: 8, inX: 8, inY: 8, outX: 8, outY: 8 }],
    fill,
    stroke: { color: fill ?? { r: 0.12, g: 0.12, b: 0.12, a: 1 }, width: 1.5 },
  };
  page.layers.push(layer);
  next.activeLayerIds = [layer.id];
  return next;
}

export function appendPathNode(doc: PressDocument, layerId: string, pageX: number, pageY: number): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), layerId);
  if (!layer || layer.kind !== "vector" || layer.locked) return next;
  const lx = pageX - layer.transform.x;
  const ly = pageY - layer.transform.y;
  layer.nodes.push({ x: lx, y: ly, inX: lx, inY: ly, outX: lx, outY: ly });
  const xs = layer.nodes.map((n) => n.x);
  const ys = layer.nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const dx = minX;
  const dy = minY;
  if (dx !== 0 || dy !== 0) {
    for (const n of layer.nodes) {
      n.x -= dx;
      n.y -= dy;
      n.inX -= dx;
      n.inY -= dy;
      n.outX -= dx;
      n.outY -= dy;
    }
    layer.transform.x += dx;
    layer.transform.y += dy;
  }
  layer.transform.w = Math.max(4, maxX - minX);
  layer.transform.h = Math.max(4, maxY - minY);
  return next;
}

export function closePath(doc: PressDocument, layerId: string): PressDocument {
  const next = cloneDoc(doc);
  const layer = findLayer(activePage(next), layerId);
  if (layer && layer.kind === "vector") layer.closed = true;
  return next;
}

export function addPage(doc: PressDocument): PressDocument {
  const next = cloneDoc(doc);
  const src = activePage(next);
  const page: Page = {
    id: uid("pg"),
    name: `Page ${next.pages.length + 1}`,
    widthPx: src.widthPx,
    heightPx: src.heightPx,
    bleedPx: src.bleedPx,
    slugPx: src.slugPx,
    margin: { ...src.margin },
    columns: src.columns,
    columnGutter: src.columnGutter,
    background: { ...src.background },
    layers: [],
    guides: [],
  };
  next.pages.push(page);
  next.spreads.push({ id: uid("sp"), pageIds: [page.id] });
  next.activePageId = page.id;
  next.activeLayerIds = [];
  return next;
}

export function setActivePage(doc: PressDocument, pageId: string): PressDocument {
  const next = cloneDoc(doc);
  if (!next.pages.some((p) => p.id === pageId)) return next;
  next.activePageId = pageId;
  next.activeLayerIds = [];
  return next;
}

export function selectIntersecting(doc: PressDocument, r: { x: number; y: number; w: number; h: number }): PressDocument {
  const next = cloneDoc(doc);
  const page = activePage(next);
  const ids: string[] = [];
  for (const l of page.layers) {
    if (!l.visible || l.kind === "group" || l.kind === "adjustment") continue;
    // Marquee tests page-space bounds, so nested layers need their world box.
    const b = worldBounds(page, l);
    const hit = b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
    if (hit) ids.push(l.id);
  }
  next.activeLayerIds = ids;
  return next;
}

export function replaceAssetData(doc: PressDocument, assetId: string, dataUrl: string, width: number, height: number): PressDocument {
  const next = cloneDoc(doc);
  const asset = next.assets[assetId];
  if (!asset) return next;
  asset.dataUrl = dataUrl;
  asset.width = width;
  asset.height = height;
  return next;
}
