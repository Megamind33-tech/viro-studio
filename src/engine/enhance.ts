/**
 * Real image enhancement — pixel algorithms, not AI badges.
 *
 * `sharpen` is an unsharp mask (high-frequency boost). `lighting` is an auto-
 * levels stretch on luminance so a flat/underexposed photo opens up. Both
 * operate on 8-bit RGBA buffers the compositor already holds; they never invent
 * pixels they cannot compute.
 */
export type EnhanceKind = "sharpen" | "lighting";

export function enhanceRgba(
  src: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  kind: EnhanceKind,
): Uint8ClampedArray {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const n = w * h * 4;
  if (src.length < n) throw new Error("enhance: buffer shorter than width×height");
  if (kind === "sharpen") return unsharp(src, w, h);
  return autoLevels(src, w, h);
}

/** 3×3 unsharp: amount 0.65, so edges pop without ringing into neon. */
function unsharp(src: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const amount = 0.65;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const yy = y + ky < 0 ? 0 : y + ky >= h ? h - 1 : y + ky;
        for (let kx = -1; kx <= 1; kx++) {
          const xx = x + kx < 0 ? 0 : x + kx >= w ? w - 1 : x + kx;
          const j = (yy * w + xx) * 4;
          const wt = kx === 0 && ky === 0 ? 0 : 1;
          r += src[j]! * wt;
          g += src[j + 1]! * wt;
          b += src[j + 2]! * wt;
        }
      }
      const blurR = r / 8;
      const blurG = g / 8;
      const blurB = b / 8;
      out[i] = clamp8(src[i]! + amount * (src[i]! - blurR));
      out[i + 1] = clamp8(src[i + 1]! + amount * (src[i + 1]! - blurG));
      out[i + 2] = clamp8(src[i + 2]! + amount * (src[i + 2]! - blurB));
      out[i + 3] = src[i + 3]!;
    }
  }
  return out;
}

/**
 * Stretch luminance so the 2nd–98th percentile spans 0–255, then re-apply
 * chroma. Transparent pixels are left untouched.
 */
function autoLevels(src: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8ClampedArray {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (src[o + 3]! < 8) continue;
    const y = lum(src[o]!, src[o + 1]!, src[o + 2]!);
    hist[y]!++;
    count++;
  }
  const out = new Uint8ClampedArray(src.length);
  if (count < 16) {
    out.set(src);
    return out;
  }
  const loN = Math.max(1, Math.floor(count * 0.02));
  const hiN = Math.max(loN + 1, Math.floor(count * 0.98));
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= loN) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]!;
    if (acc >= count - hiN) {
      hi = v;
      break;
    }
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const a = src[o + 3]!;
    out[o + 3] = a;
    if (a < 8) {
      out[o] = src[o]!;
      out[o + 1] = src[o + 1]!;
      out[o + 2] = src[o + 2]!;
      continue;
    }
    const y = lum(src[o]!, src[o + 1]!, src[o + 2]!);
    const ny = ((y - lo) / span) * 255;
    const scale = y < 1 ? 1 : ny / y;
    out[o] = clamp8(src[o]! * scale);
    out[o + 1] = clamp8(src[o + 1]! * scale);
    out[o + 2] = clamp8(src[o + 2]! * scale);
  }
  return out;
}

function lum(r: number, g: number, b: number): number {
  return Math.max(0, Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)));
}

function clamp8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

export async function enhanceDataUrl(
  dataUrl: string,
  kind: EnhanceKind,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("enhance: image failed to decode"));
    el.src = dataUrl;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const g = c.getContext("2d");
  if (!g) throw new Error("enhance: 2d context unavailable");
  g.drawImage(img, 0, 0);
  const pix = g.getImageData(0, 0, c.width, c.height);
  const next = enhanceRgba(pix.data, c.width, c.height, kind);
  pix.data.set(next);
  g.putImageData(pix, 0, 0);
  return { dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height };
}
