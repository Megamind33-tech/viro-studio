/** Magic-byte sniffing so Place / drop / paste still work when `File.type` is empty. */

export type SniffKind = "image" | "font" | "document" | "unknown";

export interface SniffedFile {
  kind: SniffKind;
  mime: string;
  ext: string;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
const DOC_EXT = /\.(psd|vdj|json|press\.json)$/i;

export function sniffBytes(name: string, bytes: ArrayBuffer): SniffedFile {
  const u = new Uint8Array(bytes);
  const head = String.fromCharCode(...u.subarray(0, 4));
  const lower = name.toLowerCase();

  if (u[0] === 0x89 && head.slice(1) === "PNG") return { kind: "image", mime: "image/png", ext: "png" };
  if (u[0] === 0xff && u[1] === 0xd8) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (head === "RIFF" && String.fromCharCode(...u.subarray(8, 12)) === "WEBP") {
    return { kind: "image", mime: "image/webp", ext: "webp" };
  }
  if (head === "GIF8") return { kind: "image", mime: "image/gif", ext: "gif" };
  if (head === "BM\0" || (u[0] === 0x42 && u[1] === 0x4d)) return { kind: "image", mime: "image/bmp", ext: "bmp" };

  if (head === "OTTO") return { kind: "font", mime: "font/otf", ext: "otf" };
  if (head === "wOFF") return { kind: "font", mime: "font/woff", ext: "woff" };
  if (head === "wOF2") return { kind: "font", mime: "font/woff2", ext: "woff2" };
  if (u[0] === 0x00 && u[1] === 0x01 && u[2] === 0x00 && u[3] === 0x00) {
    return { kind: "font", mime: "font/ttf", ext: "ttf" };
  }
  if (head === "true") return { kind: "font", mime: "font/ttf", ext: "ttf" };
  if (head === "ttcf") return { kind: "font", mime: "font/collection", ext: "ttc" };

  if (IMAGE_EXT.test(lower)) {
    const ext = lower.match(IMAGE_EXT)![1]!.replace("jpeg", "jpg");
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext === "jpg" ? "jpeg" : ext}`;
    return { kind: "image", mime, ext };
  }
  if (FONT_EXT.test(lower)) return { kind: "font", mime: "font/ttf", ext: lower.replace(/.*\./, "") };
  if (DOC_EXT.test(lower) || lower.endsWith(".psd")) {
    return { kind: "document", mime: "application/octet-stream", ext: lower.replace(/.*\./, "") };
  }
  return { kind: "unknown", mime: "application/octet-stream", ext: "" };
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
