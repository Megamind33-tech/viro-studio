import { readPsd, type Layer as PsdLayer } from "ag-psd";
import type { PressDocument, Rgba } from "../document/types";
import { addImageFrame, createDocument, uid } from "../document/factory";

function canvasToAsset(canvas: HTMLCanvasElement, name: string) {
  return {
    name,
    mime: "image/png",
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

function walk(doc: PressDocument, layers: PsdLayer[] | undefined, parentId: string | null, ox: number, oy: number): PressDocument {
  if (!layers) return doc;
  let next = doc;
  for (const layer of layers) {
    if (layer.hidden && !layer.children) continue;
    if (layer.children?.length) {
      const page = next.pages[0]!;
      const gid = uid("ly");
      page.layers.push({
        id: gid,
        name: layer.name || "Group",
        kind: "group",
        visible: !layer.hidden,
        locked: !!layer.protected?.transparency,
        opacity: (layer.opacity ?? 1) > 1 ? (layer.opacity ?? 1) / 255 : (layer.opacity ?? 1),
        blend: "srcOver",
        transform: {
          x: (layer.left ?? 0) + ox,
          y: (layer.top ?? 0) + oy,
          w: Math.max(1, (layer.right ?? 0) - (layer.left ?? 0)),
          h: Math.max(1, (layer.bottom ?? 0) - (layer.top ?? 0)),
          rotation: 0,
        },
        parentId,
      });
      next = walk(next, layer.children, gid, ox, oy);
      continue;
    }
    const canvas = layer.canvas as HTMLCanvasElement | undefined;
    if (!canvas || !canvas.width) continue;
    next = addImageFrame(next, canvasToAsset(canvas, layer.name || "Layer"), (layer.left ?? 0) + ox, (layer.top ?? 0) + oy);
    const placed = next.pages[0]!.layers[next.pages[0]!.layers.length - 1]!;
    placed.parentId = parentId;
    placed.visible = !layer.hidden;
    placed.opacity = (layer.opacity ?? 1) > 1 ? (layer.opacity ?? 1) / 255 : (layer.opacity ?? 1);
    placed.transform.w = canvas.width;
    placed.transform.h = canvas.height;
  }
  return next;
}

/** PSD → Press. ag-psd converts supported colour modes to RGB. Text/smart objects without bitmaps are skipped. */
export function documentFromPsd(buffer: ArrayBuffer, name: string): PressDocument {
  const psd = readPsd(buffer, { skipCompositeImageData: false, skipLayerImageData: false, skipThumbnail: true });
  const w = psd.width || 1;
  const h = psd.height || 1;
  let doc = createDocument({
    name: name.replace(/\.psd$/i, "") || "PSD",
    ppi: psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72,
    widthPx: w,
    heightPx: h,
    bleedPx: 0,
    pageCount: 1,
    facingPages: false,
  });
  doc.color.iccProfileName = "PSD import — RGB as decoded by ag-psd; not PDF/X";
  if (psd.children?.length) doc = walk(doc, psd.children, null, 0, 0);
  else if (psd.canvas) {
    const canvas = psd.canvas as HTMLCanvasElement;
    doc = addImageFrame(doc, canvasToAsset(canvas, "Composite"), 0, 0);
    const layer = doc.pages[0]!.layers[0]!;
    layer.transform.w = w;
    layer.transform.h = h;
  }
  doc.activeLayerIds = doc.pages[0]?.layers.slice(-1).map((l) => l.id) ?? [];
  void (0 as unknown as Rgba);
  return doc;
}
