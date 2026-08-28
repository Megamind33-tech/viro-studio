/**
 * Shared harness for the text-frame property tests (VIRO-0143).
 *
 * Boots CanvasKit through the rich-text harness, renders type frames WITH a
 * `textFrame` contract through the real drawTypeFrame path, and gives tests
 * pixel tools: raw RGBA, ink bounding box, PNG screenshots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ck as _ck, loadFaces, makeCharacter, makeParagraph } from "./rich-text-harness.mjs";

export const ck = _ck;
export { loadFaces, makeCharacter, makeParagraph };

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SHOTS = join(ROOT, "tests", "text-frame-shots");

export function makeStory(text, { character = {}, paragraph = {}, id = "st_tf" } = {}) {
  return {
    id,
    text,
    character: makeCharacter(character),
    paragraph: makeParagraph(paragraph),
    runs: [],
    paragraphRuns: [],
  };
}

export function makeTextFrame(overrides = {}) {
  return {
    kind: "area",
    inset: { top: 0, right: 0, bottom: 0, left: 0 },
    columns: 1,
    columnGutter: 0,
    verticalAlign: "top",
    autoSize: "none",
    ...overrides,
  };
}

/**
 * Render one story through drawTypeFrame on a white surface. `textFrame`
 * omitted = legacy layer shape (no contract object, back-compat path).
 * Returns the ComposeResult, raw RGBA bytes and PNG bytes.
 */
export function renderFrame(story, face, w, h, textFrame = undefined) {
  const surf = ck.MakeSurface(w, h);
  const sk = surf.getCanvas();
  sk.clear(ck.Color4f(1, 1, 1, 1));
  const layer = {
    id: "ly_tf",
    name: "Frame",
    kind: "type-frame",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "srcOver",
    parentId: null,
    storyId: story.id,
    nextFrameId: null,
    ...(textFrame ? { textFrame } : {}),
    transform: { x: 0, y: 0, w, h, rotation: 0 },
  };
  const composed = drawTypeFrame(ck, sk, layer, story, face);
  const img = surf.makeImageSnapshot();
  const png = img.encodeToBytes(ck.ImageFormat.PNG, 100);
  const raw = img.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  img.delete();
  surf.delete();
  if (!raw) throw new Error("readPixels returned no bytes");
  return { composed, raw, png };
}

/** Save PNG bytes under tests/text-frame-shots/ and return the file name. */
export function saveShot(name, png) {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), png);
  return name;
}

/** Bounding box of non-white pixels (antialiasing threshold 240). Null when blank. */
export function inkBox(raw, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (raw[i] < 240 || raw[i + 1] < 240 || raw[i + 2] < 240) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** The zero-inset single-column cases the golden pixel baseline was captured from. */
export const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus luctus urna sed urna ultricies, " +
  "eget tristique felis gravida. Aliquam erat volutpat.";

export const BASELINE_CASES = [
  { name: "area-left-multiline", w: 420, h: 300, text: LOREM, paragraph: {} },
  { name: "area-center-wrap", w: 360, h: 240, text: LOREM, paragraph: { align: "center" } },
  { name: "area-justify-wrap", w: 500, h: 360, text: LOREM, paragraph: { align: "justify" } },
  {
    name: "area-right-narrow",
    w: 180,
    h: 400,
    text: "Narrow measure wraps hard even on short words.",
    paragraph: { align: "right" },
  },
  { name: "area-empty", w: 300, h: 120, text: "", paragraph: {} },
  { name: "area-multiline-breaks", w: 420, h: 300, text: "First line\n\nThird after blank", paragraph: {} },
];

export function baselineStory(c) {
  return makeStory(c.text, { paragraph: c.paragraph, id: "st_base" });
}

const { drawTypeFrame } = await import("../src/engine/type.ts");
export { drawTypeFrame };
