import { loadFace, type FacePack } from "./type";
import { publicAsset } from "./public-url";
import { listUserFonts, putUserFont, type UserFont } from "../library/store";

/**
 * Typed rejection for hostile or malformed font uploads (VIRO-0014).
 * Raised strictly before HarfBuzz decoding and before any IndexedDB
 * persistence; `undecodable` also wraps `loadFace` failures with their cause.
 */
export type FontImportErrorCode = "too-small" | "bad-magic" | "too-large" | "undecodable";

export class FontImportError extends Error {
  readonly code: FontImportErrorCode;

  constructor(code: FontImportErrorCode, message: string, cause?: unknown) {
    super(`Font import rejected (${code}): ${message}`, cause === undefined ? undefined : { cause });
    this.name = "FontImportError";
    this.code = code;
  }
}

/** Below this a blob cannot even hold a container header plus one table directory entry. */
export const MIN_FONT_BYTES = 64;
/** Upload cap — every shipping face is far below this; a larger "font" is a hostile payload. */
export const MAX_FONT_BYTES = 20 * 1024 * 1024;

export type FontSource = "bundled" | "user" | "system";

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

/** The container family claimed by the leading magic bytes, or null. */
export type FontContainer = "ttf" | "otf" | "ttc" | "woff" | "woff2";

export function fontContainer(u: Uint8Array): FontContainer | null {
  if (u.length < 4) return null;
  if (u[0] === 0 && u[1] === 1 && u[2] === 0 && u[3] === 0) return "ttf";
  const head = String.fromCharCode(u[0], u[1], u[2], u[3]);
  if (head === "OTTO") return "otf";
  if (head === "true") return "ttf";
  if (head === "ttcf") return "ttc";
  if (head === "wOFF") return "woff";
  if (head === "wOF2") return "woff2";
  return null;
}

/**
 * sfnt integrity gate: the claimed table directory must be fully present and
 * every table must live inside the blob. HarfBuzz tolerates violations
 * silently, so this runs before decode (VIRO-0014 prep evidence: a 50%-cut
 * real TTF still "loads" without it).
 */
function sfntDirectoryInBounds(u: Uint8Array): boolean {
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const numTables = v.getUint16(4);
  if (numTables === 0) return false;
  if (12 + numTables * 16 > u.byteLength) return false;
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const off = v.getUint32(at + 8);
    const len = v.getUint32(at + 12);
    if (off > u.byteLength || len > u.byteLength - off) return false;
  }
  return true;
}

/**
 * The font trust boundary. Throws FontImportError before any decode or
 * persistence; cheap size checks first, then magic, then structure.
 */
export function validateFontBytes(bytes: ArrayBuffer): void {
  const u = new Uint8Array(bytes);
  if (u.byteLength === 0) throw new FontImportError("too-small", "file is empty");
  if (u.byteLength > MAX_FONT_BYTES) {
    throw new FontImportError("too-large", `${u.byteLength} bytes exceeds the ${MAX_FONT_BYTES}-byte font cap`);
  }
  const container = fontContainer(u);
  if (!container) {
    throw new FontImportError("bad-magic", "no sfnt/OTTO/true/ttcf/wOFF/wOF2 magic");
  }
  if (u.byteLength < MIN_FONT_BYTES) {
    throw new FontImportError("too-small", `${u.byteLength} bytes cannot hold a font container`);
  }
  if ((container === "ttf" || container === "otf") && !sfntDirectoryInBounds(u)) {
    throw new FontImportError("undecodable", "sfnt table directory is truncated or points outside the blob");
  }
}

/**
 * Strip anything dangerous out of an untrusted upload filename before it can
 * reach family names, ids, or the UI: path separators (traversal), NUL and
 * control bytes, and absurd length.
 */
function sanitizeFileName(raw: string): string {
  const leaf = raw.split(/[\\/]+/).pop() ?? "";
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "font").slice(0, 120);
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
        validateFontBytes(bytes); // tripwire: a bundled face must always pass
        const face = await loadFace(spec.id, `${spec.family} ${spec.style}`, bytes);
        this.upsert({ id: spec.id, family: spec.family, style: spec.style, name: `${spec.family} ${spec.style}`, source: "bundled", face });
        if (!this.get(this.fallbackId)?.face) this.fallbackId = spec.id;
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
        validateFontBytes(row.bytes); // rows persisted before VIRO-0014 may hold hostile bytes
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
        const packed = await window.viroPress?.readFont(rec.path);
        if (!packed) return this.resolve(undefined);
        validateFontBytes(packed.bytes); // system picker hands us arbitrary files
        rec.face = await loadFace(rec.id, rec.name, packed.bytes);
        return rec.face;
      } catch (err) {
        console.warn("[fonts] system face failed", rec.path, err);
        return this.resolve(undefined);
      }
    }
    return this.resolve(undefined);
  }

  install(rec: FontRecord): void {
    this.upsert(rec);
  }

  async importBytes(fileName: string, bytes: ArrayBuffer, persist = true): Promise<FontRecord> {
    // Sanitize the hostile filename first so id/family/name never carry path
    // separators, NULs, or 300-character junk (VIRO-0014 prep evidence).
    const safe = sanitizeFileName(fileName);
    const base = safe.replace(/\.(ttf|otf|woff2?|ttc)$/i, "");
    // Trust boundary: reject hostile bytes before decode and before any
    // IndexedDB write can capture them.
    validateFontBytes(bytes);
    const id = `user-${slug(base)}-${Math.abs(hash32(bytes)).toString(36)}`;
    const family = prettyFamily(base);
    const style = guessStyle(base);
    const name = style === "Regular" ? family : `${family} ${style}`;
    let face: FacePack;
    try {
      face = await loadFace(id, name, bytes);
    } catch (err) {
      throw new FontImportError("undecodable", `HarfBuzz could not decode "${safe}"`, err);
    }
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
