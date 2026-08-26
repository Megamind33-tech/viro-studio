import type { BlendMode, PressDocument, Rgba } from "../document/types";
import { addImageFrame, addTypeFrame, addVectorRect, createDocument } from "../document/factory";
import { setCharacter, setParagraphAlign, setStoryText } from "../document/ops";

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

function hexToRgba(hex: string | undefined, fallback: Rgba): Rgba {
  if (!hex || !hex.startsWith("#")) return fallback;
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

function ingestLayers(doc: PressDocument, layers: VdjLayer[]): PressDocument {
  let next = doc;
  const paper: Rgba = { r: 1, g: 1, b: 1, a: 1 };
  for (const layer of layers) {
    const x = layer.x ?? 0;
    const y = layer.y ?? 0;
    const w = layer.w ?? 100;
    const h = layer.h ?? 100;
    if (layer.type === "text") {
      next = addTypeFrame(next, "noto-sans", x, y);
      const id = next.activeLayerIds[0]!;
      const placed = next.pages[0]!.layers.find((l) => l.id === id)!;
      placed.name = layer.name || "Type";
      placed.transform = { x, y, w, h, rotation: layer.rot ?? 0 };
      placed.opacity = layer.opacity ?? 1;
      placed.visible = layer.visible !== false;
      placed.locked = !!layer.locked;
      placed.blend = vdjBlend(layer.blend);
      next = setStoryText(next, id, layer.text?.value ?? "Type");
      next = setCharacter(next, id, {
        size: layer.text?.size ?? 24,
        leading: (layer.text?.leading ?? 1.2) * (layer.text?.size ?? 24),
        tracking: layer.text?.tracking ?? 0,
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
      placed.transform = { x, y, w, h, rotation: layer.rot ?? 0 };
      placed.opacity = layer.opacity ?? 1;
      placed.visible = layer.visible !== false;
      placed.locked = !!layer.locked;
      placed.blend = vdjBlend(layer.blend);
      if (placed.kind === "image-frame" && layer.image.focal) placed.focal = layer.image.focal;
    } else if (layer.type === "rect" || layer.type === "ellipse") {
      next = addVectorRect(next, x, y, w, h, hexToRgba(layer.style?.fill, paper));
      const placed = next.pages[0]!.layers.find((l) => l.id === next.activeLayerIds[0])!;
      placed.name = layer.name || "Rectangle";
      placed.opacity = layer.opacity ?? 1;
      placed.visible = layer.visible !== false;
      placed.locked = !!layer.locked;
      placed.blend = vdjBlend(layer.blend);
      placed.transform.rotation = layer.rot ?? 0;
    }
  }
  return next;
}

export function documentFromVdj(json: unknown, name: string): PressDocument {
  const v = json as VdjDoc;
  const w = v.canvas?.w ?? 1080;
  const h = v.canvas?.h ?? 1350;
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
  if (v.pages?.length) {
    const first = v.pages[0]!;
    doc.pages[0]!.name = first.name || "Page 1";
    doc = ingestLayers(doc, first.layers ?? []);
  } else {
    doc = ingestLayers(doc, v.layers ?? []);
  }
  return doc;
}
