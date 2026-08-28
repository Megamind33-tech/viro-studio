/** Magic-byte sniffing so Place / drop / paste still work when `File.type` is empty. */
import { MAX_IMPORT_DIMENSION } from "../import/errors";

export type SniffKind = "image" | "font" | "document" | "unknown";

export interface SniffedFile {
  kind: SniffKind;
  mime: string;
  ext: string;
  /**
   * The container family matched by leading magic bytes ("png", "jpeg",
   * "webp", "gif", "bmp", "ttf", "otf", "ttc", "woff", "woff2"), or null when
   * classification did not come from magic. Since VIRO-0014 an image/font
   * kind is only ever produced by a real magic match — an extension over
   * contradicting bytes classifies as "unknown" instead of reaching a decoder.
   */
  magic: string | null;
}

/**
 * Typed rejection for hostile or malformed image uploads (VIRO-0014).
 * `validateImageBytes` runs before any decode attempt; the DOM decode itself
 * stays browser-side (app.ts imageSize), so Node tests can exercise this
 * boundary without a canvas.
 */
export type ImageImportErrorCode = "empty" | "too-large" | "wrong-magic" | "truncated" | "bad-dimensions";

export class ImageImportError extends Error {
  readonly code: ImageImportErrorCode;

  constructor(code: ImageImportErrorCode, message: string) {
    super(`Image import rejected (${code}): ${message}`);
    this.name = "ImageImportError";
    this.code = code;
  }
}

/** Upload cap — data URLs inflate by ~4/3 before IndexedDB persistence, so keep the source bounded. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type ImageContainer = "png" | "jpeg" | "webp" | "gif" | "bmp";

function imageMagic(u: Uint8Array): ImageContainer | null {
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "png";
  if (u[0] === 0xff && u[1] === 0xd8) return "jpeg";
  if (
    u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 &&
    u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50
  ) {
    return "webp";
  }
  if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) return "gif";
  if (u[0] === 0x42 && u[1] === 0x4d) return "bmp";
  return null;
}

const IMAGE_MAGIC_MIME: Record<ImageContainer, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
  gif: { mime: "image/gif", ext: "gif" },
  bmp: { mime: "image/bmp", ext: "bmp" },
};

const FONT_MAGIC_MIME: Record<string, { mime: string; ext: string }> = {
  ttf: { mime: "font/ttf", ext: "ttf" },
  otf: { mime: "font/otf", ext: "otf" },
  ttc: { mime: "font/collection", ext: "ttc" },
  woff: { mime: "font/woff", ext: "woff" },
  woff2: { mime: "font/woff2", ext: "woff2" },
};

const DOC_EXT = /\.(psd|vdj|json|press\.json)$/i;

export function sniffBytes(name: string, bytes: ArrayBuffer): SniffedFile {
  const u = new Uint8Array(bytes);
  const lower = name.toLowerCase();

  const image = imageMagic(u);
  if (image) {
    const m = IMAGE_MAGIC_MIME[image];
    return { kind: "image", mime: m.mime, ext: m.ext, magic: image };
  }
  const font = fontContainerOf(u);
  if (font) {
    const m = FONT_MAGIC_MIME[font];
    return { kind: "font", mime: m.mime, ext: m.ext, magic: font };
  }

  // Extension fallback is only honoured for documents, where no enforced
  // magic exists. An image/font extension over bytes without the matching
  // container magic is a lie (text named .ttf/.png) and used to reach the
  // font importer or image decoder — refuse it (VIRO-0014).
  if (DOC_EXT.test(lower) || lower.endsWith(".psd")) {
    return { kind: "document", mime: "application/octet-stream", ext: lower.replace(/.*\./, ""), magic: null };
  }
  return { kind: "unknown", mime: "application/octet-stream", ext: "", magic: null };
}

/** Leading font-container magic ("ttf" sfnt variants, "otf", "ttc", "woff", "woff2"), or null. */
function fontContainerOf(u: Uint8Array): string | null {
  if (u.length < 4) return null;
  if (u[0] === 0x00 && u[1] === 0x01 && u[2] === 0x00 && u[3] === 0x00) return "ttf";
  const head = String.fromCharCode(u[0], u[1], u[2], u[3]);
  if (head === "OTTO") return "otf";
  if (head === "true") return "ttf";
  if (head === "ttcf") return "ttc";
  if (head === "wOFF") return "woff";
  if (head === "wOF2") return "woff2";
  return null;
}

/**
 * Pre-decode image trust boundary: size caps plus a best-effort container
 * integrity walk (declared dimensions and lengths must fit the actual bytes).
 * Throws ImageImportError; returns silently when the container header is
 * plausible and the rest is the decoder's job.
 */
export function validateImageBytes(name: string, bytes: ArrayBuffer): void {
  const u = new Uint8Array(bytes);
  if (u.byteLength === 0) throw new ImageImportError("empty", `${name} is empty`);
  if (u.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageImportError("too-large", `${name} is ${u.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte image cap`);
  }
  const magic = imageMagic(u);
  if (!magic) throw new ImageImportError("wrong-magic", `${name} carries no image container magic`);
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const dimsOutOfBounds = (w: number, h: number) =>
    w > MAX_IMPORT_DIMENSION || h > MAX_IMPORT_DIMENSION;
  const truncated = (what: string) =>
    new ImageImportError("truncated", `${name} ends before its ${magic} ${what} (${u.byteLength} bytes)`);

  switch (magic) {
    case "png": {
      // 8-byte signature + IHDR length/type + width/height. A missing trailing
      // CRC is the decoder's problem; the dims-bomb check needs only the dims.
      if (u.byteLength < 24) throw truncated("IHDR header");
      const w = v.getUint32(16);
      const h = v.getUint32(20);
      if (dimsOutOfBounds(w, h)) {
        throw new ImageImportError("bad-dimensions", `${name} declares ${w}x${h}, above the ${MAX_IMPORT_DIMENSION}px import limit`);
      }
      return;
    }
    case "gif": {
      if (u.byteLength < 10) throw truncated("logical screen descriptor");
      const w = v.getUint16(6, true);
      const h = v.getUint16(8, true);
      if (dimsOutOfBounds(w, h)) {
        throw new ImageImportError("bad-dimensions", `${name} declares ${w}x${h}, above the ${MAX_IMPORT_DIMENSION}px import limit`);
      }
      return;
    }
    case "bmp": {
      if (u.byteLength < 26) throw truncated("DIB header");
      // BITMAPCOREHEADER (12) keeps int16 dims; INFOHEADER+ keeps int32 dims.
      const dibSize = v.getUint32(14, true);
      const w = dibSize === 12 ? v.getUint16(18, true) : Math.abs(v.getInt32(18, true));
      const h = dibSize === 12 ? v.getUint16(20, true) : Math.abs(v.getInt32(22, true));
      if (dimsOutOfBounds(w, h)) {
        throw new ImageImportError("bad-dimensions", `${name} declares ${w}x${h}, above the ${MAX_IMPORT_DIMENSION}px import limit`);
      }
      return;
    }
    case "webp": {
      // A real VP8/VP8L/VP8X frame never fits in a bare RIFF header alone.
      if (u.byteLength < 30) throw truncated("VP8 chunk");
      const declared = v.getUint32(4, true);
      if (declared > u.byteLength - 8) throw truncated("RIFF payload");
      return;
    }
    case "jpeg": {
      // Marker walk until the first SOF carries the dimensions.
      let pos = 2;
      while (pos + 4 <= u.byteLength) {
        if (u[pos] !== 0xff) throw truncated("marker sync");
        const marker = u[pos + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          pos += 2;
          continue;
        }
        const segLen = v.getUint16(pos + 2);
        if (segLen < 2 || pos + 2 + segLen > u.byteLength) throw truncated("segment");
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          if (pos + 9 > u.byteLength) throw truncated("SOF header");
          const h = v.getUint16(pos + 5);
          const w = v.getUint16(pos + 7);
          if (dimsOutOfBounds(w, h)) {
            throw new ImageImportError("bad-dimensions", `${name} declares ${w}x${h}, above the ${MAX_IMPORT_DIMENSION}px import limit`);
          }
          return;
        }
        pos += 2 + segLen;
      }
      throw truncated("SOF marker");
    }
  }
}

export function mimeForImageFile(file: File): string {
  if (file.type && file.type.startsWith("image/")) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return file.type || "image/png";
}
