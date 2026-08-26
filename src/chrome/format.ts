import type { BlendMode, Layer, Page, Rgba } from "../document/types";

export function rgbaCss(c: Rgba): string {
  return `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)} / ${c.a})`;
}

export function rgbaToHex(c: Rgba): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function hexToRgba(hex: string, a = 1): Rgba {
  const v = hex.replace("#", "").trim();
  const n = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  const x = Number.parseInt(n, 16);
  if (!Number.isFinite(x) || n.length !== 6) return { r: 0, g: 0, b: 0, a };
  return { r: ((x >> 16) & 255) / 255, g: ((x >> 8) & 255) / 255, b: (x & 255) / 255, a };
}

export function rgb8(c: Rgba): { r: number; g: number; b: number } {
  return { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255) };
}

export function fromRgb8(r: number, g: number, b: number, a = 1): Rgba {
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

export function rgbToHsv(c: Rgba): { h: number; s: number; v: number } {
  const r = c.r;
  const g = c.g;
  const b = c.b;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgba(h: number, s: number, v: number, a = 1): Rgba {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: r + m, g: g + m, b: b + m, a };
}

export function fmt(n: number, d = 1): string {
  if (!Number.isFinite(n)) return "";
  const p = 10 ** d;
  return String(Math.round(n * p) / p);
}

export function parseNum(v: string): number | null {
  const n = Number.parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export const BLEND_LABEL: Record<BlendMode, string> = {
  srcOver: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  colorDodge: "Color Dodge",
  colorBurn: "Color Burn",
  hardLight: "Hard Light",
  softLight: "Soft Light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

export function layerKindMark(kind: Layer["kind"]): string {
  switch (kind) {
    case "type-frame":
      return "T";
    case "image-frame":
      return "I";
    case "raster":
      return "Px";
    case "vector":
      // A shape reads as a shape. "P" (for path) was indistinguishable
      // from the lettered marks beside it in the layer list.
      return "◇";
    case "group":
      return "G";
    case "adjustment":
      return "Fx";
    default:
      return "•";
  }
}

export function childrenOf(page: Page, id: string): Layer[] {
  return page.layers.filter((l) => l.parentId === id);
}

export function rootsOf(page: Page): Layer[] {
  return page.layers.filter((l) => !l.parentId);
}

/**
 * Photoshop's `Doc:` readout — flattened size / layered size.
 *
 * Flattened is the page at its channel depth. Layered adds each visible
 * pixel-bearing layer's own footprint, which is why the right-hand number
 * climbs as you build. Both are byte estimates, exactly as Adobe's are;
 * neither pretends to be the size of a saved file.
 */
export function docSizeLabel(page: Page, layers: Layer[], channels: number): string {
  const flat = page.widthPx * page.heightPx * channels;
  let layered = flat;
  for (const l of layers) {
    if (!l.visible || l.kind === "group" || l.kind === "adjustment") continue;
    layered += Math.max(0, Math.round(l.transform.w)) * Math.max(0, Math.round(l.transform.h)) * channels;
  }
  return `Doc: ${bytes(flat)}/${bytes(layered)}`;
}

function bytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(2)}G`;
  if (n >= 1024 * 1024) return `${(n / 1024 ** 2).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}
