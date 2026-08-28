/**
 * Boolean path operations (ADR 0005 — Phase A destructive Pathfinder).
 *
 * Pure module: no state, no DOM. Takes CanvasKit (the compositor's Skia engine)
 * plus vector operands on a page and returns a new multi-contour `VectorLayer`, or
 * null when the result is empty/degenerate. Every intermediate Skia `Path` is
 * deleted before returning so repeated combines do not churn the WASM heap.
 *
 * Operands are read in PAGE space via `worldMatrix`, combined with Skia's
 * `Path.MakeFromOp`, converted back into editor-native `contours[]`, then
 * re-localised to an axis-aligned result box.
 */
import { cloneStroke, uid } from "./factory";
import { applyPt, worldMatrix } from "./transform";
import type { CanvasKit, Path } from "canvaskit-wasm";
import type { Contour, Page, PathNode, VectorLayer } from "./types";

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

const OP_LABEL: Record<BooleanOp, string> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
  exclude: "Exclude",
};

let engineProvider: (() => CanvasKit | null) | null = null;

/** App boot wires the live compositor's CanvasKit instance for command-bus paths. */
export function setBooleanEngineProvider(fn: () => CanvasKit | null): void {
  engineProvider = fn;
}

/** Used by UI commands and Anchor ops when the compositor is not ready. */
export function requireBooleanEngine(): CanvasKit {
  const ck = engineProvider?.() ?? null;
  if (!ck) throw new Error("Boolean ops need the compositor to be ready");
  return ck;
}

/**
 * The contours a layer contributes: its v6 list, or its single legacy contour.
 * This IS the v6 precedence read — the compositor's `drawVector`, the
 * validator and the hash all agree with it — so contour-addressed editing
 * resolves its target through this one function rather than restating the rule.
 */
export function layerContours(layer: VectorLayer): Contour[] {
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

function skiaPathOp(ck: CanvasKit, op: BooleanOp) {
  switch (op) {
    case "union":
      return ck.PathOp.Union;
    case "subtract":
      return ck.PathOp.Difference;
    case "intersect":
      return ck.PathOp.Intersect;
    case "exclude":
      return ck.PathOp.XOR;
  }
}

/** Fold operand paths in draw order (last = topmost). Caller owns the result. */
function combinePagePaths(ck: CanvasKit, page: Page, layers: VectorLayer[], op: BooleanOp): Path | null {
  if (layers.length < 2) return null;
  const paths = layers.map((layer) => buildPageSpacePath(ck, page, layer));
  const dropAll = () => {
    for (const p of paths) p.delete();
  };

  try {
    if (op === "subtract") {
      const topIdx = paths.length - 1;
      if (paths.length === 2) {
        const result = ck.Path.MakeFromOp(paths[topIdx]!, paths[0]!, ck.PathOp.Difference);
        dropAll();
        return result;
      }
      let beneath = ck.Path.MakeFromOp(paths[0]!, paths[1]!, ck.PathOp.Union);
      if (!beneath) {
        dropAll();
        return null;
      }
      for (let i = 2; i < topIdx; i++) {
        const next = ck.Path.MakeFromOp(beneath, paths[i]!, ck.PathOp.Union);
        beneath.delete();
        if (!next) {
          dropAll();
          return null;
        }
        beneath = next;
      }
      const result = ck.Path.MakeFromOp(paths[topIdx]!, beneath, ck.PathOp.Difference);
      beneath.delete();
      dropAll();
      return result;
    }

    const pathOp = skiaPathOp(ck, op);
    let acc = ck.Path.MakeFromOp(paths[0]!, paths[1]!, pathOp);
    if (!acc) {
      dropAll();
      return null;
    }
    for (let i = 2; i < paths.length; i++) {
      const next = ck.Path.MakeFromOp(acc, paths[i]!, pathOp);
      acc.delete();
      if (!next) {
        dropAll();
        return null;
      }
      acc = next;
    }
    dropAll();
    return acc;
  } catch {
    dropAll();
    return null;
  }
}

function straightNode(x: number, y: number): PathNode {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

/**
 * Convert a combined Skia `Path` back into the editor's per-anchor bezier
 * contours by walking its verb stream (`toCmds`).
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
        prev.outX = prev.x + (2 / 3) * (cx - prev.x);
        prev.outY = prev.y + (2 / 3) * (cy - prev.y);
        cur.push({ x, y, inX: x + (2 / 3) * (cx - x), inY: y + (2 / 3) * (cy - y), outX: x, outY: y });
      }
    } else if (verb === ck.CONIC_VERB) {
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

function resultName(op: BooleanOp, layers: VectorLayer[]): string {
  if (op === "subtract" && layers.length >= 2) {
    const top = layers[layers.length - 1]!;
    const bottom = layers[layers.length - 2]!;
    return `${top.name} − ${bottom.name}`;
  }
  if (layers.length === 2) {
    return `${layers[0]!.name} ${OP_LABEL[op]} ${layers[layers.length - 1]!.name}`;
  }
  return `${OP_LABEL[op]} (${layers.length} shapes)`;
}

/**
 * Combine 2+ vector layers with the given Pathfinder op. Operands must be in
 * draw order (last = topmost). Returns a page-level compound-path layer, or
 * null when the result is empty. Operands are left untouched — the caller
 * consumes them as one history step.
 */
export function booleanCombineVectors(
  ck: CanvasKit,
  page: Page,
  layers: VectorLayer[],
  op: BooleanOp,
): VectorLayer | null {
  if (layers.length < 2) return null;
  const combined = combinePagePaths(ck, page, layers, op);
  if (!combined) return null;

  const pageContours = pathToContours(ck, combined);
  combined.delete();
  if (!pageContours.length) return null;

  const bounds = contoursBounds(pageContours);
  if (!bounds) return null;

  const top = layers[layers.length - 1]!;
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
    name: resultName(op, layers),
    kind: "vector",
    visible: true,
    locked: false,
    opacity: top.opacity,
    blend: top.blend,
    transform: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: [],
    fill: top.fill ? { ...top.fill } : null,
    stroke: cloneStroke(top.stroke),
    contours,
  };
}

/** Phase-0 alias: topmost minus the one beneath. */
export function subtractVectors(
  ck: CanvasKit,
  page: Page,
  topLayer: VectorLayer,
  bottomLayer: VectorLayer,
): VectorLayer | null {
  return booleanCombineVectors(ck, page, [bottomLayer, topLayer], "subtract");
}
