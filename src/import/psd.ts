import { readPsd, type Layer as PsdLayer } from "ag-psd";
import type { PressDocument, Rgba } from "../document/types";
import { addImageFrame, createDocument, uid } from "../document/factory";
import { ImportParseError, MAX_IMPORT_DIMENSION } from "./errors";

function canvasToAsset(canvas: HTMLCanvasElement, name: string) {
  return {
    name,
    mime: "image/png",
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Layer-tree ingest. Deliberately iterative with an explicit stack: a hostile
 * PSD may declare tens of thousands of nested groups, and recursion here would
 * overflow the call stack with an uncatchable-at-this-layer RangeError. The
 * traversal order is identical to the previous recursive walk.
 */
function walk(doc: PressDocument, layers: PsdLayer[] | undefined, parentId: string | null, ox: number, oy: number): PressDocument {
  let next = doc;
  const stack: Array<{ list: PsdLayer[]; parentId: string | null; index: number }> = layers?.length
    ? [{ list: layers, parentId, index: 0 }]
    : [];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.list.length) {
      stack.pop();
      continue;
    }
    const layer = frame.list[frame.index++]!;
    if (layer.hidden && !layer.children) continue;
    // Hostile files cannot make ag-psd hand us a pseudo-array here, but the
    // guard keeps the walk total: only a real array descends.
    const children: PsdLayer[] = Array.isArray(layer.children) ? layer.children : [];
    if (children.length) {
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
        parentId: frame.parentId,
      });
      stack.push({ list: children, parentId: gid, index: 0 });
      continue;
    }
    const canvas = layer.canvas as HTMLCanvasElement | undefined;
    if (!canvas || !canvas.width) continue;
    next = addImageFrame(next, canvasToAsset(canvas, layer.name || "Layer"), (layer.left ?? 0) + ox, (layer.top ?? 0) + oy);
    const placed = next.pages[0]!.layers[next.pages[0]!.layers.length - 1]!;
    placed.parentId = frame.parentId;
    placed.visible = !layer.hidden;
    placed.opacity = (layer.opacity ?? 1) > 1 ? (layer.opacity ?? 1) / 255 : (layer.opacity ?? 1);
    placed.transform.w = canvas.width;
    placed.transform.h = canvas.height;
  }
  return next;
}

/** PSD → Press. ag-psd converts supported colour modes to RGB. Text/smart objects without bitmaps are skipped. */
export function documentFromPsd(buffer: ArrayBuffer, name: string): PressDocument {
  let psd: ReturnType<typeof readPsd>;
  try {
    psd = readPsd(buffer, { skipCompositeImageData: false, skipLayerImageData: false, skipThumbnail: true });
  } catch (err) {
    // ag-psd surfaces malformed files as bare Errors and raw RangeErrors from
    // DataView reads. Neither may escape the import boundary: rethrow as the
    // typed import rejection with the reader failure as cause.
    throw new ImportParseError("psd", "unreadable", `“${name}” is not a readable PSD file`, err);
  }
  if (
    !Number.isFinite(psd.width) || !Number.isFinite(psd.height) ||
    psd.width < 1 || psd.height < 1 ||
    psd.width > MAX_IMPORT_DIMENSION || psd.height > MAX_IMPORT_DIMENSION
  ) {
    throw new ImportParseError(
      "psd",
      "dimensions-out-of-range",
      `“${name}” declares a ${psd.width}×${psd.height} canvas; .psd files are limited to ${MAX_IMPORT_DIMENSION}px per edge`,
    );
  }
  const w = psd.width;
  const h = psd.height;
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
