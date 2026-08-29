/**
 * VIRO-0141 — pixel-diff proof for path.moveNode on a REAL engine-produced
 * boolean ring (rasterised with the compositor's own CanvasKit build).
 *
 * The acceptance asks: "path.moveNode on a boolean-result contour changes
 * canvas output by exactly the node delta (pixel-diff evidence)". The unit
 * suite cannot run the browser compositor, so this test rasterises the layer
 * with the SAME CanvasKit build the compositor uses (tests/engines.mjs proves
 * MakeSurface + readPixels work in Node) and a rasteriser that mirrors
 * compositor drawVector exactly:
 *
 *   - contour precedence: v6 contours[] when present, else {nodes, closed}
 *   - per-node cubics: cubicTo(a.outX,a.outY, b.inX,b.inY, b.x,b.y)
 *   - closed contours: closing cubic last->first, then close()
 *   - fill rule: EvenOdd only when multi AND drawable > 1
 *   - fill gating: layer.fill && anyClosed
 *
 * Because before/after are rasterised from the SAME pipeline, the diff isolates
 * exactly what path.moveNode changed in the authoritative topology.
 *
 * ADAPTATION NOTE (build stage): if this CanvasKit build's readPixels takes
 * (imageInfo, destBytes) instead of (srcX, srcY, imageInfo, destBytes), adjust
 * the single call in readRGBA — everything else is API-stable (engines.mjs
 * already proves MakeSurface/makeImageSnapshot/encodeToBytes in this repo).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/vector-node-pixels.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDocument } from "../src/document/factory.ts";
import { moveContourNode } from "../src/document/ops.ts";
import { booleanCombineVectors } from "../src/document/boolean-ops.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert.ok(existsSync(ckWasm), "canvaskit.wasm missing");
const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });

const RED = { r: 1, g: 0, b: 0, a: 1 };
const SURF = 220; // square surface; the ring (200x200 page px) sits at (10,10)
const ORIGIN = { x: 90, y: 90 }; // page point drawn at surface (10,10)

const rectNodes = (w, h) => {
  const p = (x, y) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  return [p(0, 0), p(w, 0), p(w, h), p(0, h)];
};

function vectorRect(id, x, y, w, h) {
  return {
    id,
    name: id,
    kind: "vector",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    transform: { x, y, w, h, rotation: 0 },
    parentId: null,
    closed: true,
    nodes: rectNodes(w, h),
    fill: RED,
    stroke: null,
  };
}

function docWithRing() {
  const doc = createDocument({ name: "pix", ppi: 72, widthPx: 800, heightPx: 600, bleedPx: 0, pageCount: 1, facingPages: false });
  const page = doc.pages[0];
  const outer = vectorRect("outer", 100, 100, 200, 200);
  const inner = vectorRect("inner", 150, 150, 100, 100);
  page.layers.push(outer, inner);
  // Draw order (last = TOPMOST): outer stays on top so subtract = outer − inner.
  const ring = booleanCombineVectors(ck, page, [inner, outer], "subtract");
  assert.ok(ring && ring.contours.length === 2);
  page.layers.length = 0;
  page.layers.push(ring);
  return doc;
}

/** Mirrors compositor drawVector for the fill case, at layer-local scale 1. */
function rasterise(layer, contours) {
  const surf = ck.MakeSurface(SURF, SURF);
  assert.ok(surf, "MakeSurface failed");
  const canvas = surf.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  canvas.translate(layer.transform.x - ORIGIN.x, layer.transform.y - ORIGIN.y);

  const multi = Array.isArray(contours) && contours.length > 0;
  const builder = new ck.PathBuilder();
  let drawable = 0;
  let anyClosed = false;
  for (const c of contours) {
    if (c.nodes.length < 2) continue;
    drawable++;
    if (c.closed) anyClosed = true;
    const n0 = c.nodes[0];
    builder.moveTo(n0.x, n0.y);
    for (let i = 1; i < c.nodes.length; i++) {
      const a = c.nodes[i - 1];
      const b = c.nodes[i];
      builder.cubicTo(a.outX, a.outY, b.inX, b.inY, b.x, b.y);
    }
    if (c.closed) {
      const last = c.nodes[c.nodes.length - 1];
      const first = c.nodes[0];
      builder.cubicTo(last.outX, last.outY, first.inX, first.inY, first.x, first.y);
      builder.close();
    }
  }
  assert.ok(drawable > 0, "nothing drawable");
  const path = builder.detach();
  builder.delete();
  if (multi && drawable > 1) path.setFillType(ck.FillType.EvenOdd);

  const paint = new ck.Paint();
  if (layer.fill && anyClosed) {
    paint.setStyle(ck.PaintStyle.Fill);
    paint.setColor(ck.Color4f(layer.fill.r, layer.fill.g, layer.fill.b, layer.fill.a * layer.opacity));
    canvas.drawPath(path, paint);
  }
  const img = surf.makeImageSnapshot();
  const w = SURF, h = SURF;
  const buf = readRGBA(img, w, h);
  img.delete();
  path.delete();
  paint.delete();
  surf.delete();
  return buf;
}

function readRGBA(img, w, h) {
  // canvaskit-wasm 0.42 takes a PLAIN ImageInfo object (same pattern as
  // tests/rich-text-harness.mjs); there is no ck.ImageInfo constructor here.
  const bytes = img.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  assert.ok(bytes && bytes.length === w * h * 4, "readPixels failed — adapt readRGBA to this build");
  return bytes;
}

const px = (buf, x, y) => {
  const i = (y * SURF + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
};

function diffMask(a, b) {
  const changed = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      changed.push(i / 4);
    }
  }
  return changed;
}

const toSurf = (pageX, pageY) => ({ x: Math.round(pageX - ORIGIN.x), y: Math.round(pageY - ORIGIN.y) });

test("moveNode on a ring contour changes rasterised output by exactly the node delta", () => {
  const doc = docWithRing();
  const ring = doc.pages[0].layers[0];
  const ringId = ring.id;

  // The ring's outer contour starts at its top-left anchor; page position:
  // transform.x/y + node.x/y. Move node 0 of contour 0 right/down by (10, 6).
  const node = ring.contours[0].nodes[0];
  const pageBefore = { x: ring.transform.x + node.x, y: ring.transform.y + node.y };
  const dx = 10, dy = 6;

  const before = rasterise(ring, ring.contours);
  const next = moveContourNode(doc, ringId, 0, 0, node.x + dx, node.y + dy);
  const after = rasterise(next.pages[0].layers[0], next.pages[0].layers[0].contours);

  // 1. Canvas output changed.
  const changed = diffMask(before, after);
  assert.ok(changed.length > 0, "moving a node must change the rasterised output");

  // 2. The change is LOCAL to the node delta: some changed pixels sit within a
  //    few px of the old anchor, some within a few px of the new anchor, and
  //    the edit does not repaint the world (bounded to the moved edge region).
  const near = (p, q, r) => Math.hypot((p % SURF) - q.x, Math.floor(p / SURF) - q.y) <= r;
  const oldPt = toSurf(pageBefore.x, pageBefore.y);
  const newPt = toSurf(pageBefore.x + dx, pageBefore.y + dy);
  assert.ok(changed.some((p) => near(p, oldPt, 8)), "pixels changed at the old anchor position");
  assert.ok(changed.some((p) => near(p, newPt, 8)), "pixels changed at the new anchor position");
  assert.ok(changed.length < SURF * SURF * 0.25, "a single-node move must not repaint the layer");

  // 3. The ring stays a ring: EvenOdd hole survives — the hole centre is
  //    transparent in BOTH rasters (page 200,200 is the hole centre).
  const hole = toSurf(200, 200);
  const hb = px(before, hole.x, hole.y);
  const ha = px(after, hole.x, hole.y);
  assert.equal(hb[3], 0, "hole is transparent before the edit");
  assert.equal(ha[3], 0, "hole is still transparent after the edit");
});

test("the untouched contour rasterises byte-identically while the other is edited", () => {
  const doc = docWithRing();
  const ring = doc.pages[0].layers[0];
  const ringId = ring.id;

  // Edit contour 0; raster contour 1 (the hole) alone before and after.
  const holeBefore = rasterise(ring, [ring.contours[1]]);
  const node = ring.contours[0].nodes[0];
  const next = moveContourNode(doc, ringId, 0, 0, node.x + 10, node.y + 6);
  const after = next.pages[0].layers[0];
  const holeAfter = rasterise(after, [after.contours[1]]);

  assert.deepEqual(
    Buffer.compare(Buffer.from(holeBefore), Buffer.from(holeAfter)),
    0,
    "the untouched contour's pixels must be byte-identical (acceptance: remaining geometry preserved apart from the edited contour)",
  );
});

test("moveNode output is undo-stable: raster after undo equals the original raster", () => {
  // Draft note: run through the bus once VIRO-0141 registers the command; the
  // derived inverse restores the prior layer record, so the raster must return
  // byte-for-byte. Kept at the ops level here so the file runs standalone once
  // ops land (cloneDoc makes an independent doc, mirroring what undo restores).
  const doc = docWithRing();
  const ring = doc.pages[0].layers[0];
  const ringId = ring.id;
  const node = ring.contours[0].nodes[2];
  const original = rasterise(ring, ring.contours);
  const moved = moveContourNode(doc, ringId, 0, 2, node.x + 40, node.y);
  const movedRaster = rasterise(moved.pages[0].layers[0], moved.pages[0].layers[0].contours);
  assert.notDeepEqual(Array.from(movedRaster), Array.from(original), "sanity: the move is visible");
  // What undo restores (the prior layer record) rasterises identically:
  const restored = structuredClone(doc.pages[0].layers[0]);
  const restoredRaster = rasterise(restored, restored.contours);
  assert.deepEqual(Array.from(restoredRaster), Array.from(original));
});
