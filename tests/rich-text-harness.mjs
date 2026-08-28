/**
 * Shared harness for the rich-text render tests (VIRO-0142).
 *
 * Boots CanvasKit exactly like tests/engines.mjs, loads the bundled Noto faces
 * through the real FontRegistry singleton, and renders type frames to raw
 * RGBA hashes so tests can compare pixels, not just data structures.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ckWasm = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(ROOT, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assertOk(existsSync(ckWasm), "canvaskit.wasm missing");
export const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
export const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });

const type = await import("../src/engine/type.ts");
const registryMod = await import("../src/engine/font-registry.ts");

function assertOk(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** id + file name inside public/fonts. */
const FACES = [
  { id: "noto-sans", file: "NotoSans-Regular.ttf" },
  { id: "noto-sans-bold", file: "NotoSans-Bold.ttf" },
  { id: "noto-serif", file: "NotoSerif-Regular.ttf" },
];

/** Load the bundled faces and seed the FontRegistry singleton with them. */
export async function loadFaces() {
  registryMod.resetFontRegistry();
  const faces = {};
  for (const spec of FACES) {
    const bytes = readFileSync(join(ROOT, "public", "fonts", spec.file));
    const face = await type.loadFace(
      spec.id,
      spec.file,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    registryMod.fontRegistry().add({
      id: spec.id,
      family: "Noto",
      style: "Regular",
      name: spec.id,
      source: "bundled",
      face,
    });
    faces[spec.id] = face;
  }
  return faces;
}

export function makeCharacter(overrides = {}) {
  return {
    fontId: "noto-sans",
    size: 28,
    leading: 34,
    tracking: 0,
    fill: { r: 0, g: 0, b: 0, a: 1 },
    otFeatures: [],
    ...overrides,
  };
}

export function makeParagraph(overrides = {}) {
  return { align: "left", firstLineIndent: 0, spaceAfter: 0, ...overrides };
}

/**
 * Render one story through the real drawTypeFrame path onto a white canvas.
 * Returns raw-RGBA and PNG SHA-256 hashes plus the PNG byte length.
 */
export function renderStoryPixels(story, face, w, h) {
  const surf = ck.MakeSurface(w, h);
  const sk = surf.getCanvas();
  sk.clear(ck.Color4f(1, 1, 1, 1));
  const layer = {
    id: "ly_richtext",
    name: "Rich",
    kind: "type-frame",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    parentId: null,
    storyId: story.id,
    nextFrameId: null,
    transform: { x: 0, y: 0, w, h, rotation: 0 },
  };
  type.drawTypeFrame(ck, sk, layer, story, face);
  const img = surf.makeImageSnapshot();
  const png = img.encodeToBytes(ck.ImageFormat.PNG, 100);
  const raw = img.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  assertOk(raw, "readPixels returned no bytes");
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const out = { pngSha: sha(png), pngLen: png.length, rawSha: sha(raw) };
  img.delete();
  surf.delete();
  return out;
}
