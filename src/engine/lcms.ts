/**
 * LittleCMS (lcms-wasm). Built-in sRGB + Lab.
 * Does not ship FOGRA/SWOP. A licensed ICC may be loaded later.
 *
 * lcms-wasm's cmsDoTransform does not support Float64 (TYPE_Lab_DBL).
 * TYPE_Lab_16 is the supported encoded Lab path in this package.
 */
import { instantiate } from "lcms-wasm";
import {
  INTENT_RELATIVE_COLORIMETRIC,
  TYPE_Lab_16,
  TYPE_RGB_8,
} from "lcms-wasm/lib/constants.js";

export type Lcms = Awaited<ReturnType<typeof instantiate>>;

let cached: Lcms | null = null;

export async function loadLcms(): Promise<Lcms> {
  if (cached) return cached;
  let wasmUrl = "/wasm/lcms.wasm";
  try {
    const mod = await import("lcms-wasm/dist/lcms.wasm?url");
    wasmUrl = (mod as { default: string }).default;
  } catch {
    /* public copy from copy-wasm */
  }
  cached = await instantiate({ locateFile: () => wasmUrl });
  return cached;
}

export function rgb8ToLab(lcms: Lcms, r: number, g: number, b: number): { L: number; a: number; b: number } {
  const srgb = lcms.cmsCreate_sRGBProfile();
  const lab = lcms.cmsCreateLab4Profile();
  if (!srgb || !lab) throw new Error("LittleCMS could not create built-in sRGB/Lab profiles");
  const xform = lcms.cmsCreateTransform(srgb, TYPE_RGB_8, lab, TYPE_Lab_16, INTENT_RELATIVE_COLORIMETRIC, 0);
  if (!xform) throw new Error("LittleCMS could not create sRGB→Lab transform");
  const out = lcms.cmsDoTransform(xform, new Uint8Array([r, g, b]), 1) as Uint16Array;
  lcms.cmsDeleteTransform(xform);
  lcms.cmsCloseProfile(srgb);
  lcms.cmsCloseProfile(lab);
  return {
    L: (Number(out[0]) / 65535) * 100,
    a: (Number(out[1]) / 65535) * 255 - 128,
    b: (Number(out[2]) / 65535) * 255 - 128,
  };
}

export function colourStackLabel(): string {
  // Engine identification for the boot line only. The transform enum and the
  // certification caveat are true but belong in the docs, not in product
  // chrome — a status bar is for what the designer is working on.
  return "LittleCMS · sRGB";
}
