/**
 * Catalog of real, licensed Google Fonts (via Fontsource CDN).
 *
 * Faces are NOT listed until they can actually load. The JSON in
 * `public/fonts/catalog.json` is a metadata index (~2k families). A family is
 * registered in FontRegistry only after its TTF bytes have been fetched and
 * handed to HarfBuzz — the same path as a user-imported face. No decorative
 * names, no Bebas Neue unless the file arrives.
 */
import { publicAsset } from "./public-url";

export interface CatalogFamily {
  id: string;
  family: string;
  category: string;
  subset: string;
  weights: number[];
  italic: boolean;
}

const CDN = "https://cdn.jsdelivr.net/fontsource/fonts";

let cached: CatalogFamily[] | null = null;

export async function loadFontCatalog(): Promise<CatalogFamily[]> {
  if (cached) return cached;
  const res = await fetch(publicAsset("fonts/catalog.json"));
  if (!res.ok) throw new Error(`font catalog ${res.status}`);
  const list = (await res.json()) as CatalogFamily[];
  if (!Array.isArray(list)) throw new Error("font catalog is not an array");
  cached = list.filter((f) => f && typeof f.id === "string" && typeof f.family === "string");
  return cached;
}

export function catalogFaceUrl(family: CatalogFamily, weight: number, italic: boolean): string {
  const style = italic && family.italic ? "italic" : "normal";
  const w = family.weights.includes(weight) ? weight : closestWeight(family.weights, weight);
  const subset = family.subset || "latin";
  return `${CDN}/${encodeURIComponent(family.id)}@latest/${subset}-${w}-${style}.ttf`;
}

export function catalogRecordId(family: CatalogFamily, weight: number, italic: boolean): string {
  const style = italic && family.italic ? "i" : "n";
  return `gf-${family.id}-${weight}-${style}`;
}

function closestWeight(weights: number[], want: number): number {
  let best = weights[0] ?? 400;
  let dist = Math.abs(best - want);
  for (const w of weights) {
    const d = Math.abs(w - want);
    if (d < dist) {
      best = w;
      dist = d;
    }
  }
  return best;
}

export function searchCatalog(list: CatalogFamily[], query: string, limit = 80): CatalogFamily[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const hits: CatalogFamily[] = [];
  for (const f of list) {
    if (f.family.toLowerCase().includes(q) || f.id.includes(q) || f.category.includes(q)) {
      hits.push(f);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
