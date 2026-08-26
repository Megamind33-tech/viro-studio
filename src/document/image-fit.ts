/**
 * Image-frame geometry — the single source of truth for how a picture sits
 * inside its frame.
 *
 * Like `transform.ts`, this exists because more than one renderer needs the
 * answer and they must not compute it separately. The canvas compositor and the
 * PDF exporter both call in here; a third renderer must too. See
 * `docs/RENDERING-CONTRACT.md`.
 *
 * THE FRAME AND THE CONTENT ARE TWO DIFFERENT RECTANGLES.
 *
 *   frame   = the layer's own box, `[0, 0, transform.w, transform.h]` in local
 *             space. This is what the user drags, what snaps, and what clips.
 *   content = where the picture is drawn. Depends on `fit` and may be LARGER
 *             than the frame (`cover`) or SMALLER (`contain`).
 *
 * Because content can exceed the frame, **every renderer must clip content to
 * the frame**. Omitting that was defect #2: a `cover` image drew at its full
 * oversized rect and spilled across neighbouring layers, bounded only by the
 * page edge.
 *
 * `focal` moves the CONTENT inside the frame. It never changes the frame.
 */
import type { ImageFit, Layer } from "./types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The region of the source asset to draw, in source pixels.
 *
 * A crop is a window on the SOURCE. Re-framing (changing `transform.w/h`) and
 * cropping are deliberately different operations on different rectangles.
 */
export function sourceWindow(layer: Layer, assetW: number, assetH: number): Box {
  if (layer.kind === "image-frame" && layer.crop) {
    const c = layer.crop;
    // A crop from a corrupt file must not produce a negative or out-of-range
    // window: Skia and PDF both draw garbage from one.
    const x = Math.min(Math.max(c.x, 0), assetW);
    const y = Math.min(Math.max(c.y, 0), assetH);
    return {
      x,
      y,
      w: Math.min(Math.max(c.w, 1), assetW - x),
      h: Math.min(Math.max(c.h, 1), assetH - y),
    };
  }
  return { x: 0, y: 0, w: assetW, h: assetH };
}

/** Focal defaults to centre and is clamped: values outside 0..1 are meaningless. */
function focalOf(layer: Layer): { x: number; y: number } {
  if (layer.kind !== "image-frame") return { x: 0.5, y: 0.5 };
  const clamp = (n: number) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0.5);
  return { x: clamp(layer.focal.x), y: clamp(layer.focal.y) };
}

/**
 * Where the picture is drawn, in the layer's LOCAL space.
 *
 * The three modes are genuinely distinct — there is no fourth mode and no two
 * of these produce the same rectangle for a mismatched aspect ratio:
 *
 *   cover    fills the frame, preserves aspect, OVERFLOWS on one axis.
 *            Result is >= frame on both axes. Must be clipped.
 *   contain  fits entirely inside, preserves aspect, LETTERBOXES on one axis.
 *            Result is <= frame on both axes.
 *   stretch  exactly the frame. Aspect is NOT preserved; the picture distorts.
 *
 * `stretch` already equals the frame, so `focal` has no effect on it — there is
 * no slack to move the content within.
 */
export function destWindow(layer: Layer, src: Box, frameW: number, frameH: number): Box {
  const fit: ImageFit = layer.kind === "image-frame" ? layer.fit : "stretch";
  if (fit === "stretch" || src.w <= 0 || src.h <= 0) {
    return { x: 0, y: 0, w: frameW, h: frameH };
  }
  const sx = frameW / src.w;
  const sy = frameH / src.h;
  const scale = fit === "contain" ? Math.min(sx, sy) : Math.max(sx, sy);
  const w = src.w * scale;
  const h = src.h * scale;
  const f = focalOf(layer);
  // For `contain` the slack is positive (letterbox padding); for `cover` it is
  // negative (the overflow being cropped). The same expression covers both, and
  // 0.5 centres either way.
  return { x: (frameW - w) * f.x, y: (frameH - h) * f.y, w, h };
}

/** True when the content rect exceeds the frame, i.e. clipping actually bites. */
export function overflowsFrame(dest: Box, frameW: number, frameH: number): boolean {
  return dest.x < -0.01 || dest.y < -0.01 || dest.x + dest.w > frameW + 0.01 || dest.y + dest.h > frameH + 0.01;
}
