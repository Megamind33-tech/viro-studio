/**
 * Boolean path operations (ADR 0005 — Phase-0 proof-of-model spike).
 *
 * ONE real destructive op is implemented here — `subtract` — to prove the
 * multi-contour (`contours[]`) model end-to-end: two vector layers are combined
 * with Skia's `Path.makeCombined(other, PathOp.Difference)` and the result is
 * stored as a v6 compound path whose subpaths render as an outer ring with the
 * subtracted region punched out as a hole.
 *
 * PURE: this module holds no state and touches no DOM. It takes a CanvasKit
 * instance (already the compositor's engine) plus the operands and the page they
 * live on, and returns a new `VectorLayer` (or null when the result is empty).
 * Every intermediate Skia `Path` is deleted before returning, so repeated
 * combines do not churn the WASM heap (ADR 0005 perf note; compositor treats an
 * undeleted Skia object as an `Aborted()` risk).
 *
 * Operands are read in PAGE space (via `worldMatrix`, so a boolean is computed
 * where the shapes actually overlap on the page), combined, then the result is
 * re-localised to its own bounds and placed at page level with an axis-aligned,
 * unrotated, unscaled box — so `worldMatrix(result)` is exactly the translation
 * that maps its local geometry back to where it was computed.
 */
import { cloneStroke, uid } from "./factory";
import { applyPt, worldMatrix } from "./transform";
import type { CanvasKit, Path } from "canvaskit-wasm";
import type { Contour, Page, PathNode, VectorLayer } from "./types";

/** The contours a layer contributes: its v6 list, or its single legacy contour. */
function layerContours(layer: VectorLayer): Contour[] {
  return layer.contours && layer.contours.length
    ? layer.contours
    : [{ nodes: layer.nodes, closed: layer.closed }];
}

/**
 * Build a Skia `Path` for a vector layer with every control point mapped into
 * page space by the layer's world matrix. Mirrors `drawVector`'s per-node cubic
 * build so the boolean sees exactly the geometry the compositor draws. Caller
 * owns the returned `Path` and must delete it.
 */
function buildPageSpacePath(ck: CanvasKit, page: Page, layer: VectorLayer): Path {
  const m = worldMatrix(page, layer);
  const builder = new ck.PathBuilder();
  for (const c of layerContours(layer)) {
    if (c.nodes.length < 2) continue;
    const p0 = applyPt(m, c.nodes[0]!.x, c.nodes[0]!.y);
    builder.moveTo(p0.x, p0.y);
    for (let i = 1; i < c.nodes.length; i++) {
      const a = c.nodes[i - 1]!;
      const b = c.nodes[i]!;
      const ao = applyPt(m, a.outX, a.outY);
      const bi = applyPt(m, b.inX, b.inY);
      const bp = applyPt(m, b.x, b.y);
      builder.cubicTo(ao.x, ao.y, bi.x, bi.y, bp.x, bp.y);
    }
    if (c.closed) {
      const last = c.nodes[c.nodes.length - 1]!;
      const first = c.nodes[0]!;
      const lo = applyPt(m, last.outX, last.outY);
      const fi = applyPt(m, first.inX, first.inY);
      const fp = applyPt(m, first.x, first.y);
      builder.cubicTo(lo.x, lo.y, fi.x, fi.y, fp.x, fp.y);
      builder.close();
    }
  }
  const path = builder.detach();
  builder.delete();
  return path;
}

function straightNode(x: number, y: number): PathNode {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

/**
 * Convert a combined Skia `Path` back into the editor's per-anchor bezier
 * contours by walking its verb stream (`toCmds`). Lines keep handles on the
 * anchor (a straight segment); quads are promoted to cubics; cubics carry their
 * two control handles onto the neighbouring anchors, matching how `drawVector`
 * reads out/in handles per segment.
 */
function pathToContours(ck: CanvasKit, path: Path): Contour[] {
  const cmds = path.toCmds();
  const contours: Contour[] = [];
  let cur: PathNode[] | null = null;
  let start: { x: number; y: number } | null = null;

  const flushOpen = () => {
    if (cur && cur.length >= 2) contours.push({ nodes: cur, closed: false });
    cur = null;
    start = null;
  };

  let i = 0;
  while (i < cmds.length) {
    const verb = cmds[i++]!;
    if (verb === ck.MOVE_VERB) {
      flushOpen();
      const x = cmds[i++]!;
      const y = cmds[i++]!;
      cur = [straightNode(x, y)];
      start = { x, y };
    } else if (verb === ck.LINE_VERB) {
      const x = cmds[i++]!;
      const y = cmds[i++]!;
      if (cur) cur.push(straightNode(x, y));
    } else if (verb === ck.QUAD_VERB) {
      const cx = cmds[i++]!;
      const cy = cmds[i++]!;
      const x = cmds[i++]!;
      const y = cmds[i++]!;
      if (cur && cur.length) {
        const prev = cur[cur.length - 1]!;
        // Quadratic → cubic: raise the single control point to two.
        prev.outX = prev.x + (2 / 3) * (cx - prev.x);
        prev.outY = prev.y + (2 / 3) * (cy - prev.y);
        cur.push({ x, y, inX: x + (2 / 3) * (cx - x), inY: y + (2 / 3) * (cy - y), outX: x, outY: y });
      }
    } else if (verb === ck.CONIC_VERB) {
      // Conics do not arise from rectilinear booleans; approximate by the chord
      // to the endpoint rather than invent handles. (cx,cy,x,y,weight)
      i += 2;
      const x = cmds[i++]!;
      const y = cmds[i++]!;
      i += 1;
      if (cur) cur.push(straightNode(x, y));
    } else if (verb === ck.CUBIC_VERB) {
      const c1x = cmds[i++]!;
      const c1y = cmds[i++]!;
      const c2x = cmds[i++]!;
      const c2y = cmds[i++]!;
      const x = cmds[i++]!;
      const y = cmds[i++]!;
      if (cur && cur.length) {
        const prev = cur[cur.length - 1]!;
        prev.outX = c1x;
        prev.outY = c1y;
        cur.push({ x, y, inX: c2x, inY: c2y, outX: x, outY: y });
      }
    } else if (verb === ck.CLOSE_VERB) {
      if (cur) {
        // Skia may emit an explicit segment back to the start before CLOSE. Fold
        // that segment's incoming handle onto the first anchor and drop the
        // duplicate, so `drawVector`'s closing cubic reproduces it exactly.
        if (cur.length >= 2 && start) {
          const lastNode = cur[cur.length - 1]!;
          if (Math.abs(lastNode.x - start.x) < 1e-6 && Math.abs(lastNode.y - start.y) < 1e-6) {
            const first = cur[0]!;
            first.inX = lastNode.inX;
            first.inY = lastNode.inY;
            cur.pop();
          }
        }
        if (cur.length >= 2) contours.push({ nodes: cur, closed: true });
        cur = null;
        start = null;
      }
    } else {
      // Unknown verb — stop rather than misread the stream.
      break;
    }
  }
  flushOpen();
  return contours;
}

/** Axis-aligned bounds of every anchor and handle across all contours. */
function contoursBounds(contours: Contour[]): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of contours) {
    for (const n of c.nodes) {
      const xs = [n.x, n.inX, n.outX];
      const ys = [n.y, n.inY, n.outY];
      for (const v of xs) {
        if (v < x0) x0 = v;
        if (v > x1) x1 = v;
      }
      for (const v of ys) {
        if (v < y0) y0 = v;
        if (v > y1) y1 = v;
      }
    }
  }
  if (!Number.isFinite(x0) || !(x1 > x0) || !(y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Subtract `bottomLayer` from `topLayer` (topmost minus the one beneath), the
 * proof boolean for the Phase-0 spike. Returns a new page-level `VectorLayer`
 * carrying the multi-contour result, or null when the difference is empty or
 * degenerate. The operands are left untouched — the caller consumes them into
 * this result as one history step.
 */
export function subtractVectors(
  ck: CanvasKit,
  page: Page,
  topLayer: VectorLayer,
  bottomLayer: VectorLayer,
): VectorLayer | null {
  const topPath = buildPageSpacePath(ck, page, topLayer);
  const bottomPath = buildPageSpacePath(ck, page, bottomLayer);
  // topmost minus beneath. `Path.MakeFromOp` is the static form of the boolean
  // engine present in this CanvasKit build (the instance `makeCombined` is not
  // exposed on a detached PathBuilder path).
  const combined = ck.Path.MakeFromOp(topPath, bottomPath, ck.PathOp.Difference);
  topPath.delete();
  bottomPath.delete();
  if (!combined) return null;

  const pageContours = pathToContours(ck, combined);
  combined.delete();
  if (!pageContours.length) return null;

  const bounds = contoursBounds(pageContours);
  if (!bounds) return null;

  // Re-localise page-space geometry to the result's own box origin.
  const contours: Contour[] = pageContours.map((c) => ({
    closed: c.closed,
    nodes: c.nodes.map((n) => ({
      x: n.x - bounds.x,
      y: n.y - bounds.y,
      inX: n.inX - bounds.x,
      inY: n.inY - bounds.y,
      outX: n.outX - bounds.x,
      outY: n.outY - bounds.y,
    })),
  }));

  return {
    id: uid("vec"),
    name: `${topLayer.name} - ${bottomLayer.name}`,
    kind: "vector",
    visible: true,
    locked: false,
    opacity: topLayer.opacity,
    blend: topLayer.blend,
    transform: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, rotation: 0 },
    parentId: null,
    // `contours` is authoritative for a v6 compound path; the legacy single
    // contour is left empty (still a closed vector for fill/validation intent).
    closed: true,
    nodes: [],
    fill: topLayer.fill ? { ...topLayer.fill } : null,
    stroke: cloneStroke(topLayer.stroke),
    contours,
  };
}
