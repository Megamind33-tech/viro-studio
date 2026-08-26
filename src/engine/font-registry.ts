import { loadFace, type FacePack } from "./type";
import { publicAsset } from "./public-url";
import { listUserFonts, putUserFont, type UserFont } from "../library/store";
import {
  catalogFaceUrl,
  catalogRecordId,
  loadFontCatalog,
  type CatalogFamily,
} from "./font-catalog";

export type FontSource = "bundled" | "user" | "system" | "catalog";

export interface FontRecord {
  id: string;
  family: string;
  style: string;
  name: string;
  source: FontSource;
  /** Absolute filesystem path for a system face — loaded on first use. */
  path?: string;
  face?: FacePack;
}

export interface SystemFontRef {
  id: string;
  family: string;
  style: string;
  name: string;
  path: string;
}

const BUNDLED: { id: string; family: string; style: string; file: string }[] = [
  { id: "noto-sans", family: "Noto Sans", style: "Regular", file: "fonts/NotoSans-Regular.ttf" },
  { id: "noto-sans-bold", family: "Noto Sans", style: "Bold", file: "fonts/NotoSans-Bold.ttf" },
  { id: "noto-sans-italic", family: "Noto Sans", style: "Italic", file: "fonts/NotoSans-Italic.ttf" },
  { id: "noto-serif", family: "Noto Serif", style: "Regular", file: "fonts/NotoSerif-Regular.ttf" },
  { id: "noto-sans-mono", family: "Noto Sans Mono", style: "Regular", file: "fonts/NotoSansMono-Regular.ttf" },
];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "face";
}

export class FontRegistry {
  private records: FontRecord[] = [];
  fallbackId = "noto-sans";

  list(): FontRecord[] {
    return this.records.slice();
  }

  get(id: string): FontRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** The face the compositor and PDF exporter must use. Never throws. */
  resolve(id: string | undefined | null): FacePack | null {
    const wanted = id ? this.get(id) : undefined;
    if (wanted?.face) return wanted.face;
    const fallback = this.get(this.fallbackId) ?? this.records.find((r) => r.face);
    return fallback?.face ?? null;
  }

  defaultId(): string {
    return this.get(this.fallbackId)?.face ? this.fallbackId : this.records.find((r) => r.face)?.id ?? this.fallbackId;
  }

  async loadBundled(): Promise<void> {
    for (const spec of BUNDLED) {
      try {
        const url = publicAsset(spec.file);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength < 1000) throw new Error(`font too small (${bytes.byteLength} b)`);
        const face = await loadFace(spec.id, `${spec.family} ${spec.style}`, bytes);
        this.upsert({ id: spec.id, family: spec.family, style: spec.style, name: `${spec.family} ${spec.style}`, source: "bundled", face });
        this.fallbackId = spec.id;
      } catch (err) {
        console.warn("[fonts] bundled face failed", spec.id, err);
      }
    }
  }

  async loadUserFonts(): Promise<void> {
    let rows: UserFont[] = [];
    try {
      rows = await listUserFonts();
    } catch {
      return;
    }
    for (const row of rows) {
      try {
        const face = await loadFace(row.id, row.name, row.bytes);
        this.upsert({
          id: row.id,
          family: row.family,
          style: row.style,
          name: row.name,
          source: "user",
          face,
        });
      } catch (err) {
        console.warn("[fonts] stored face failed", row.id, err);
      }
    }
  }

  registerSystem(refs: SystemFontRef[]): void {
    for (const ref of refs) {
      if (this.get(ref.id)) continue;
      this.upsert({ ...ref, source: "system" });
    }
  }

  async ensureLoaded(id: string): Promise<FacePack | null> {
    const rec = this.get(id);
    if (!rec) return this.resolve(undefined);
    if (rec.face) return rec.face;
    if (rec.source === "system" && rec.path && window.viroPress?.readFont) {
      try {
        const packed = await window.viroPress.readFont(rec.path);
        if (!packed) return this.resolve(undefined);
        rec.face = await loadFace(rec.id, rec.name, packed.bytes);
        return rec.face;
      } catch (err) {
        console.warn("[fonts] system face failed", rec.path, err);
        return this.resolve(undefined);
      }
    }
    return this.resolve(undefined);
  }

  /**
   * Fetch a catalog family from Fontsource (TTF), register it, and persist as a
   * user font so the next session does not re-download. Returns the registry id.
   */
  async installCatalogFamily(family: CatalogFamily, weight = 400, italic = false): Promise<FontRecord> {
    const id = catalogRecordId(family, weight, italic);
    const existing = this.get(id);
    if (existing?.face) return existing;
    const url = catalogFaceUrl(family, weight, italic);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${family.family} (${res.status})`);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength < 1000) throw new Error(`${family.family} file too small`);
    const style = italic && family.italic ? (weight >= 600 ? "Bold Italic" : "Italic") : weight >= 600 ? "Bold" : "Regular";
    const name = style === "Regular" ? family.family : `${family.family} ${style}`;
    const face = await loadFace(id, name, bytes);
    const rec: FontRecord = { id, family: family.family, style, name, source: "catalog", face };
    this.upsert(rec);
    try {
      await putUserFont({ id, name, family: family.family, style, bytes, addedAt: Date.now() });
    } catch {
      /* session-only if IndexedDB is blocked */
    }
    return rec;
  }

  async catalog(): Promise<CatalogFamily[]> {
    return loadFontCatalog();
  }

  install(rec: FontRecord): void {
    this.upsert(rec);
  }

  async importBytes(fileName: string, bytes: ArrayBuffer, persist = true): Promise<FontRecord> {
    const base = fileName.replace(/\.(ttf|otf|woff2?|ttc)$/i, "");
    const id = `user-${slug(base)}-${Math.abs(hash32(bytes)).toString(36)}`;
    const family = prettyFamily(base);
    const style = guessStyle(base);
    const name = style === "Regular" ? family : `${family} ${style}`;
    const face = await loadFace(id, name, bytes);
    const rec: FontRecord = { id, family, style, name, source: "user", face };
    this.upsert(rec);
    if (persist) {
      try {
        await putUserFont({
          id,
          name,
          family,
          style,
          bytes,
          addedAt: Date.now(),
        });
      } catch {
        // Private mode / blocked IndexedDB — the face still lives for this session.
      }
    }
    return rec;
  }

  private upsert(rec: FontRecord): void {
    const i = this.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) this.records[i] = { ...this.records[i], ...rec };
    else this.records.push(rec);
    this.records.sort((a, b) => a.name.localeCompare(b.name) || a.style.localeCompare(b.style));
  }

  add(rec: FontRecord): void {
    this.upsert(rec);
  }
}

function prettyFamily(fileBase: string): string {
  return fileBase
    .replace(/[-_]+/g, " ")
    .replace(/\b(regular|bold|italic|oblique|light|medium|semibold|black|thin|condensed)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || fileBase;
}

function guessStyle(fileBase: string): string {
  const s = fileBase.toLowerCase();
  const bold = /\bbold\b|bd$|[-_]b$/.test(s);
  const italic = /\bitalic\b|\boblique\b|i$|[-_]i$/.test(s);
  if (bold && italic) return "Bold Italic";
  if (bold) return "Bold";
  if (italic) return "Italic";
  return "Regular";
}

function hash32(bytes: ArrayBuffer): number {
  const u = new Uint8Array(bytes);
  let h = 2166136261;
  const step = Math.max(1, Math.floor(u.length / 256));
  for (let i = 0; i < u.length; i += step) {
    h ^= u[i]!;
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

let singleton: FontRegistry | null = null;

export function fontRegistry(): FontRegistry {
  if (!singleton) singleton = new FontRegistry();
  return singleton;
}

/** Test hook. */
export function resetFontRegistry(): void {
  singleton = new FontRegistry();
}
