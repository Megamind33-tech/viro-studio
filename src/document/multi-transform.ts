/**
 * Multi-selection transform geometry — pure, framework-free, unit-testable.
 *
 * RFC-6. When two or more layers are selected the transform handles act on the
 * axis-aligned union frame, not on any one layer: a move translates every
 * member, a corner resize scales every member proportionally about the opposite
 * anchor, and a rotate turns every member about the selection centre. The math
 * that decides *how far* each member moves/scales lives here so it can be tested
 * without a browser, Skia or the command bus, and so `PressApp` only has to feed
 * it the frame captured at pointer-down and the pointer position.
 *
 * The scale maths runs in the FRAME'S OWN rotated space (single-layer selections
 * keep their rotation; a multi-selection union is always axis-aligned), so a
 * rotated layer scales along its own axes and the opposite handle stays put.
 * This mirrors the single-layer free-transform contract in `transform.ts`.
 *
 * Smart-guide snapping is here too: `resolveMoveSnap` is a pure function of the
 * moving frame, the raw drag delta and the precomputed candidate lines, so the
 * pointer-move loop can call it without allocating (see PressApp.applyMoveDrag).
 */

/** An axis-aligned-or-rotated rectangle in page space. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/** A layer's transform box at pointer-down, the fixed origin every step measures from. */
export interface LayerBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/** Which of the eight resize handles / the rotate ring a drag grabbed. */
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * The group-scale mapping a handle drag produces: two scale factors and the new
 * top-left of the frame, all in page space. Feed it to `scaledLayerBox` for each
 * member. `kx`/`ky` are always finite and clamped away from zero so the result
 * stays invertible (a zero-scale layer is non-invertible and breaks hit-testing).
 */
export interface ScaleMapping {
  kx: number;
  ky: number;
  nx: number;
  ny: number;
}

/**
 * Resolve a corner/edge handle drag into a group-scale mapping.
 *
 * `px`/`py` is the pointer in page space; `frame` is the selection frame at
 * pointer-down. The pointer is un-rotated into the frame's local space, the two
 * edges the handle owns are moved to it, the opposite edges are held, and the
 * resulting box is rotated back out — so the anchored (opposite) handle never
 * moves. With `shift` a corner handle keeps the frame's original aspect ratio.
 */
export function scaleFromHandle(
  frame: Frame,
  handle: ResizeHandle,
  px: number,
  py: number,
  opts: { shift: boolean; minSize: number },
): ScaleMapping {
  const { minSize } = opts;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const rad = (-frame.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  const lx = cx + dx * cos - dy * sin;
  const ly = cy + dx * sin + dy * cos;

  let left = frame.x;
  let top = frame.y;
  let right = frame.x + frame.w;
  let bottom = frame.y + frame.h;
  if (handle.includes("w")) left = Math.min(lx, right - minSize);
  if (handle.includes("e")) right = Math.max(lx, left + minSize);
  if (handle.includes("n")) top = Math.min(ly, bottom - minSize);
  if (handle.includes("s")) bottom = Math.max(ly, top + minSize);

  let w = right - left;
  let hgt = bottom - top;
  const corner = handle.length === 2;
  if (opts.shift && corner && frame.w > 0 && frame.h > 0) {
    const k = Math.max(w / frame.w, hgt / frame.h);
    w = frame.w * k;
    hgt = frame.h * k;
    if (handle.includes("w")) left = right - w;
    else right = left + w;
    if (handle.includes("n")) top = bottom - hgt;
    else bottom = top + hgt;
  }

  // Rotate the new centre back out of local space so the anchored edge holds.
  const lcx = (left + right) / 2;
  const lcy = (top + bottom) / 2;
  const back = (frame.rotation * Math.PI) / 180;
  const bc = Math.cos(back);
  const bs = Math.sin(back);
  const ddx = lcx - cx;
  const ddy = lcy - cy;
  const nx = cx + ddx * bc - ddy * bs - w / 2;
  const ny = cy + ddx * bs + ddy * bc - hgt / 2;

  const kx = frame.w > 0 ? w / frame.w : 1;
  const ky = frame.h > 0 ? hgt / frame.h : 1;
  return { kx, ky, nx, ny };
}

/**
 * Apply a group-scale mapping to one member, measured from its pointer-down box
 * and the frame's pointer-down top-left. Each member's offset within the frame
 * scales by the same factor, so the group scales as one rigid box.
 */
export function scaledLayerBox(
  box: LayerBox,
  frame: Frame,
  s: ScaleMapping,
  minSize: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: s.nx + (box.x - frame.x) * s.kx,
    y: s.ny + (box.y - frame.y) * s.ky,
    w: Math.max(minSize, box.w * s.kx),
    h: Math.max(minSize, box.h * s.ky),
  };
}

/**
 * Rotate one member about the selection centre by `deg` degrees, measured from
 * its pointer-down transform. A group rotate turns each member's own rotation by
 * the same delta AND swings its position around the pivot, so the whole set turns
 * rigidly rather than each layer spinning in place. Returns the new x/y/rotation.
 */
export function rotatedLayerBox(
  box: LayerBox,
  frame: Frame,
  deg: number,
): { x: number; y: number; rotation: number } {
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // A layer's transform.x/y is the top-left of its box in its own space; the
  // point that must swing about the pivot is the layer centre.
  const lcx = box.x + box.w / 2;
  const lcy = box.y + box.h / 2;
  const ddx = lcx - cx;
  const ddy = lcy - cy;
  const rcx = cx + ddx * cos - ddy * sin;
  const rcy = cy + ddx * sin + ddy * cos;
  return {
    x: rcx - box.w / 2,
    y: rcy - box.h / 2,
    rotation: box.rotation + deg,
  };
}

/** Translate one member by a delta measured from its pointer-down box. */
export function movedLayerBox(box: LayerBox, dx: number, dy: number): { x: number; y: number } {
  return { x: box.x + dx, y: box.y + dy };
}

/**
 * The outcome of resolving smart-guide snapping for one move step: the snap
 * offset to add to the raw drag delta, and the page-space positions of the two
 * guide lines (null when that axis did not snap). Pure — no view or DOM.
 */
export interface SnapResult {
  ox: number;
  oy: number;
  guideX: number | null;
  guideY: number | null;
}

/**
 * Nudge the raw drag delta so a moving edge/centre lands on the nearest
 * candidate line within `tol` page px.
 *
 * The three moving X edges (left, centre, right) are each tested against every
 * candidate vertical line; the closest match within tolerance wins and its
 * offset is added so that edge sits exactly on the line. Y is independent.
 * Snapping only applies to an axis-aligned frame (`rotation === 0`); a rotated
 * single-layer selection moves freely, since its edges are not axis-aligned.
 */
export function resolveMoveSnap(
  frame: Frame,
  dx: number,
  dy: number,
  xs: readonly number[],
  ys: readonly number[],
  tol: number,
): SnapResult {
  const result: SnapResult = { ox: 0, oy: 0, guideX: null, guideY: null };
  if (frame.rotation !== 0 || !(tol > 0)) return result;

  // The three moving edges after the raw delta. Unrolled below rather than
  // stored in an array, so the pointer-move hot path allocates nothing.
  const l = frame.x + dx;
  const midX = l + frame.w / 2;
  const r = l + frame.w;
  const t = frame.y + dy;
  const midY = t + frame.h / 2;
  const b = t + frame.h;

  let bestX = tol + 1;
  for (let i = 0; i < xs.length; i++) {
    const c = xs[i]!;
    let dist = c - l;
    let ad = dist < 0 ? -dist : dist;
    if (ad <= tol && ad < bestX) {
      bestX = ad;
      result.ox = dist;
      result.guideX = c;
    }
    dist = c - midX;
    ad = dist < 0 ? -dist : dist;
    if (ad <= tol && ad < bestX) {
      bestX = ad;
      result.ox = dist;
      result.guideX = c;
    }
    dist = c - r;
    ad = dist < 0 ? -dist : dist;
    if (ad <= tol && ad < bestX) {
      bestX = ad;
      result.ox = dist;
      result.guideX = c;
    }
  }
  let bestY = tol + 1;
  for (let i = 0; i < ys.length; i++) {
    const c = ys[i]!;
    let dist = c - t;
    let ad = dist < 0 ? -dist : dist;
    if (ad <= tol && ad < bestY) {
      bestY = ad;
      result.oy = dist;
      result.guideY = c;
    }
    dist = c - midY;
    ad = dist < 0 ? -dist : dist;
    if (ad <= tol && ad < bestY) {
      bestY = ad;
      result.oy = dist;
      result.guideY = c;
    }
    dist = c - b;
    ad = dist < 0 ? -dist : dist;
    if (ad <= tol && ad < bestY) {
      bestY = ad;
      result.oy = dist;
      result.guideY = c;
    }
  }
  return result;
}
