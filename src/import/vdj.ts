import type { BlendMode, PressDocument, Rgba } from "../document/types";
import { addImageFrame, addTypeFrame, addVectorRect, createDocument } from "../document/factory";
import { setCharacter, setParagraphAlign, setStoryText } from "../document/ops";
import {
  arrayOrEmpty,
  canvasDimensionOr,
  finiteOr,
  isRecord,
  recordOrNull,
  rejectOversizedCount,
} from "./errors";

interface VdjLayer {
  id?: string;
  name?: string;
  type?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  blend?: string;
  text?: { value?: string; size?: number; align?: string; color?: string; leading?: number; tracking?: number };
  style?: { fill?: string };
  image?: { src?: string; fit?: string; focal?: { x: number; y: number } };
}

interface VdjDoc {
  version?: string;
  meta?: { template?: string };
  canvas?: { w?: number; h?: number; dpi?: number; bleed?: number; background?: string };
  layers?: VdjLayer[];
  pages?: Array<{ id?: string; name?: string; layers?: VdjLayer[]; w?: number; h?: number }>;
}

function hexToRgba(hex: unknown, fallback: Rgba): Rgba {
  if (typeof hex !== "string" || !hex.startsWith("#")) return fallback;
  const h = hex.slice(1);
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (n.length < 6) return fallback;
  return {
    r: parseInt(n.slice(0, 2), 16) / 255,
    g: parseInt(n.slice(2, 4), 16) / 255,
    b: parseInt(n.slice(4, 6), 16) / 255,
    a: 1,
  };
}

function vdjBlend(b: string | undefined): BlendMode {
  const map: Record<string, BlendMode> = {
    normal: "srcOver",
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
  };
  return map[b ?? ""] ?? "srcOver";
}

function ingestLayers(doc: PressDocument, rawLayers: unknown[]): PressDocument {
  let next = doc;
  const paper: Rgba = { r: 1, g: 1, b: 1, a: 1 };
  rejectOversizedCount(rawLayers.length, "layer list");
  for (const entry of rawLayers) {
    // A hostile list may carry null/primitive entries; they carry no layer
    // fields, so they are skipped rather than crashed on.
    if (!isRecord(entry)) continue;
    const layer = entry as VdjLayer;
    const x = finiteOr(layer.x, 0);
    const y = finiteOr(layer.y, 0);
    const w = finiteOr(layer.w, 100);
    const h = finiteOr(layer.h, 100);
    if (layer.type === "text") {
      next = addTypeFrame(next, "noto-sans", x, y);
      const id = next.activeLayerIds[0]!;
      const placed = next.pages[0]!.layers.find((l) => l.id === id)!;
      placed.name = layer.name || "Type";
      placed.transform = { x, y, w, h, rotation: finiteOr(layer.rot, 0) };
      placed.opacity = finiteOr(layer.opacity, 1);
      placed.visible = layer.visible !== false;
      placed.locked = !!layer.locked;
      placed.blend = vdjBlend(layer.blend);
      next = setStoryText(next, id, layer.text?.value ?? "Type");
      next = setCharacter(next, id, {
        size: finiteOr(layer.text?.size, 24),
        leading: finiteOr(layer.text?.leading, 1.2) * finiteOr(layer.text?.size, 24),
        tracking: finiteOr(layer.text?.tracking, 0),
        fill: hexToRgba(layer.text?.color, { r: 0.12, g: 0.12, b: 0.12, a: 1 }),
      });
      const align = layer.text?.align;
      if (align === "left" || align === "center" || align === "right" || align === "justify") {
        next = setParagraphAlign(next, id, align);
      }
    } else if (layer.type === "image" && layer.image?.src) {
      next = addImageFrame(
        next,
        { name: layer.name || "Image", mime: "image/png", dataUrl: layer.image.src, width: w, height: h },
        x,
        y,
      );
      const placed = next.pages[0]!.layers.find((l) => l.id === next.activeLayerIds[0])!;
      placed.transform = { x, y, w, h, rotation: finiteOr(layer.rot, 0) };
      placed.opacity = finiteOr(layer.opacity, 1);
      placed.visible = layer.visible !== false;
      placed.locked = !!layer.locked;
      placed.blend = vdjBlend(layer.blend);
      if (placed.kind === "image-frame" && layer.image.focal) placed.focal = layer.image.focal;
    } else if (layer.type === "rect" || layer.type === "ellipse") {
      next = addVectorRect(next, x, y, w, h, hexToRgba(layer.style?.fill, paper));
      const placed = next.pages[0]!.layers.find((l) => l.id === next.activeLayerIds[0])!;
      placed.name = layer.name || "Rectangle";
      placed.opacity = finiteOr(layer.opacity, 1);
      placed.visible = layer.visible !== false;
      placed.locked = !!layer.locked;
      placed.blend = vdjBlend(layer.blend);
      placed.transform.rotation = finiteOr(layer.rot, 0);
    }
  }
  return next;
}

export function documentFromVdj(json: unknown, name: string): PressDocument {
  // The root may be any JSON value — `null`, a scalar, an array. Only a real
  // object can carry VDJ fields; everything else imports as the default
  // document instead of crashing on property access.
  const v = (recordOrNull(json) ?? {}) as VdjDoc;
  const w = canvasDimensionOr(v.canvas?.w, 1080, "canvas width");
  const h = canvasDimensionOr(v.canvas?.h, 1350, "canvas height");
  const ppi = v.canvas?.dpi ?? 72;
  let doc = createDocument({
    name: v.meta?.template || name.replace(/\.vdj$/i, "") || "VDJ",
    ppi,
    widthPx: w,
    heightPx: h,
    bleedPx: v.canvas?.bleed ?? 0,
    pageCount: 1,
    facingPages: false,
  });
  if (v.canvas?.background) {
    doc.pages[0]!.background = hexToRgba(v.canvas.background, doc.pages[0]!.background);
  }
  // `pages` must be a real array to be indexed; pseudo-array objects
  // (`{"length":1}`) fall through to the single-page root-layers path.
  const pages = arrayOrEmpty(v.pages);
  if (pages.length) {
    const first = (recordOrNull(pages[0]) ?? {}) as { name?: string; layers?: VdjLayer[] };
    doc.pages[0]!.name = first.name || "Page 1";
    doc = ingestLayers(doc, arrayOrEmpty(first.layers));
  } else {
    doc = ingestLayers(doc, arrayOrEmpty(v.layers));
  }
  return doc;
}
