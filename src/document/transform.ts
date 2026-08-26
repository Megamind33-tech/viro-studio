/**
 * Hierarchical transform algebra — the single source of truth for where a layer
 * actually is.
 *
 * DOCUMENT MODEL v2. `Layer.transform` is LOCAL to its parent. A layer with
 * `parentId === null` is local to the page. Before v2 the field held absolute
 * page coordinates and `parentId` was decorative: a group recorded a bounding
 * box that nothing composed, so moving a group changed the record and nothing
 * on screen. `migrateLayerTree` converts v1 documents; see FILE-FORMAT.md.
 *
 * The local matrix is
 *
 *     M = T(x, y) · T(w/2, h/2) · R(rotation) · S(scaleX, scaleY) · T(-w/2, -h/2)
 *
 * so rotation and scale both pivot about the layer's own centre, which is what
 * a transform handle implies. World space is
 *
 *     W(layer) = W(parent) · M(layer)
 *
 * with the page as identity.
 *
 * `w`/`h` are the layer's intrinsic box in ITS OWN local space; leaf geometry is
 * authored in `[0, 0, w, h]`. Resizing a leaf edits `w`/`h`. Resizing a GROUP
 * edits `scaleX`/`scaleY`, because a group has no intrinsic geometry of its own
 * — it only re-frames its children. Keeping those two operations distinct is
 * what stops "scale" from having two meanings.
 *
 * RENDERING CONTRACT: every renderer — canvas, thumbnails, PNG, PDF — and every
 * hit test MUST derive position from `localMatrix`/`worldMatrix` here. No
 * renderer may read `transform.x`/`y` directly for a layer that can be nested.
 */
import type { Layer, Page, Transform } from "./types";

/** Affine 2D matrix, in the same column order Skia and Canvas2D use. */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** m1 · m2 — apply m2 first, then m1. */
export function mul(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function applyPt(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/**
 * Inverse, or null when the matrix is degenerate. A zero-scale layer is not an
 * error — it is invisible — so callers get null rather than an exception and
 * skip hit-testing it.
 */
export function invert(m: Mat): Mat | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** Scale defaults to 1 so v1 documents, which had no scale field, read correctly. */
export function scaleXOf(t: Transform): number {
  return typeof t.scaleX === "number" && Number.isFinite(t.scaleX) ? t.scaleX : 1;
}

export function scaleYOf(t: Transform): number {
  return typeof t.scaleY === "number" && Number.isFinite(t.scaleY) ? t.scaleY : 1;
}

/** The layer's own contribution to world space. See the module contract above. */
export function localMatrix(t: Transform): Mat {
  const sx = scaleXOf(t);
  const sy = scaleYOf(t);
  const cx = t.w / 2;
  const cy = t.h / 2;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // T(x,y) · T(cx,cy) · R · S · T(-cx,-cy), expanded.
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  return {
    a,
    b,
    c,
    d,
    e: t.x + cx - (a * cx + c * cy),
    f: t.y + cy - (b * cx + d * cy),
  };
}

function parentChain(page: Page, layer: Layer): Layer[] {
  const byId = new Map(page.layers.map((l) => [l.id, l]));
  const chain: Layer[] = [];
  const seen = new Set<string>([layer.id]);
  let cur = layer.parentId ? byId.get(layer.parentId) : undefined;
  // `seen` guards a corrupt document whose parentId graph contains a cycle;
  // a malformed file must not hang the renderer.
  while (cur && !seen.has(cur.id)) {
    chain.push(cur);
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/** Page-space matrix for a layer, composing every ancestor. */
export function worldMatrix(page: Page, layer: Layer): Mat {
  let m = IDENTITY;
  const chain = parentChain(page, layer);
  for (let i = chain.length - 1; i >= 0; i--) m = mul(m, localMatrix(chain[i]!.transform));
  return mul(m, localMatrix(layer.transform));
}

/** Matrix of everything above the layer — what a child inherits. */
export function parentWorldMatrix(page: Page, layer: Layer): Mat {
  let m = IDENTITY;
  const chain = parentChain(page, layer);
  for (let i = chain.length - 1; i >= 0; i--) m = mul(m, localMatrix(chain[i]!.transform));
  return m;
}

/** The four corners of a layer's own box in page space, rotation and scale included. */
export function worldCorners(page: Page, layer: Layer): { x: number; y: number }[] {
  const m = worldMatrix(page, layer);
  const { w, h } = layer.transform;
  return [
    applyPt(m, 0, 0),
    applyPt(m, w, 0),
    applyPt(m, w, h),
    applyPt(m, 0, h),
  ];
}

/** Axis-aligned page-space bounds. Used by hit-testing, marquee and align. */
export function worldBounds(page: Page, layer: Layer): { x: number; y: number; w: number; h: number } {
  const pts = worldCorners(page, layer);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Page point → a layer's local space. Null when the layer is degenerate. */
export function pageToLocal(page: Page, layer: Layer, x: number, y: number): { x: number; y: number } | null {
  const inv = invert(worldMatrix(page, layer));
  return inv ? applyPt(inv, x, y) : null;
}

export function childrenOf(page: Page, parentId: string): Layer[] {
  return page.layers.filter((l) => l.parentId === parentId);
}

export function descendantsOf(page: Page, parentId: string): Layer[] {
  const out: Layer[] = [];
  const walk = (id: string) => {
    for (const child of childrenOf(page, id)) {
      out.push(child);
      if (child.kind === "group") walk(child.id);
    }
  };
  walk(parentId);
  return out;
}

/**
 * Decompose a matrix back into a Transform, given the layer's intrinsic box.
 *
 * Exact for any composition of translate, rotate and scale that contains no
 * shear. Shear appears only when a non-uniform scale is combined with rotation
 * (e.g. rotate 45 then scale x by 2), which a `{x,y,w,h,rotation,scale}` record
 * cannot represent. Rather than silently producing a wrong rectangle, the
 * result reports `sheared: true` so the caller can surface it.
 */
export function decompose(
  m: Mat,
  w: number,
  h: number,
): { transform: Omit<Transform, "w" | "h">; sheared: boolean } {
  const scaleX = Math.hypot(m.a, m.b) * (m.a * m.d - m.b * m.c < 0 ? -1 : 1);
  const scaleY = Math.hypot(m.c, m.d);
  const rotation = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  // Columns of a rotation+scale matrix are orthogonal; a non-zero dot product,
  // normalised by the scales, is shear.
  const denom = Math.hypot(m.a, m.b) * Math.hypot(m.c, m.d);
  const sheared = denom > 1e-9 ? Math.abs(m.a * m.c + m.b * m.d) / denom > 1e-6 : false;
  const cx = w / 2;
  const cy = h / 2;
  return {
    transform: {
      x: m.e - cx + (m.a * cx + m.c * cy),
      y: m.f - cy + (m.b * cx + m.d * cy),
      rotation,
      scaleX,
      scaleY,
    },
    sheared,
  };
}
