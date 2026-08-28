/**
 * Typed import-boundary errors and hostile-input guards (VIRO-0013).
 *
 * The import parsers are the trust boundary between untrusted files on disk
 * and the document model. Every failure crossing that boundary must be an
 * `ImportParseError` — never a raw TypeError/RangeError escaping from deep
 * inside a third-party reader (ag-psd) or a JSON walk. The fuzz/negative
 * corpus in `tests/import-corpus.mjs` proves this guarantee.
 */

export type ImportFormat = "psd" | "vdj" | "press-json";

/**
 * Photoshop's documented hard limit for a .psd (non-PSB) canvas edge. A file
 * claiming beyond this is malformed or is a PSB mislabelled as .psd; either
 * way the importer refuses it instead of attempting an impossible raster.
 */
export const MAX_IMPORT_DIMENSION = 30_000;

/** Refusal threshold for hostile layer/count fields that would only burn time. */
export const MAX_IMPORT_CHILD_COUNT = 100_000;

export class ImportParseError extends Error {
  readonly format: ImportFormat;
  readonly code: string;

  constructor(format: ImportFormat, code: string, message: string, cause?: unknown) {
    super(`Import rejected (${format}/${code}): ${message}`, cause === undefined ? undefined : { cause });
    this.name = "ImportParseError";
    this.format = format;
    this.code = code;
  }
}

/** Object (not null, not an array requirement) usable as a record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The value when it is a record, otherwise `null` — callers fall back safely. */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** The array itself when it really is an array, otherwise `[]`. */
export function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Finite number passthrough with fallback. Zero and negatives are preserved so
 * existing downstream clamps (e.g. `createDocument`) keep their exact
 * behaviour on previously non-crashing inputs; only non-finite junk — which
 * used to poison the document with NaN geometry — falls back.
 */
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Canvas-edge validation for JSON imports. Non-finite falls back to the format
 * default (previously NaN page geometry); a finite claim beyond
 * `MAX_IMPORT_DIMENSION` is a typed rejection rather than a silent
 * impossible document.
 */
export function canvasDimensionOr(value: unknown, fallback: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value > MAX_IMPORT_DIMENSION) {
    throw new ImportParseError(
      "vdj",
      "canvas-dimension-out-of-range",
      `${label} ${value} exceeds the ${MAX_IMPORT_DIMENSION}px import limit`,
    );
  }
  return value;
}

/** Typed rejection when a repeated-child field claims more than the import cap. */
export function rejectOversizedCount(count: number, label: string): void {
  if (count > MAX_IMPORT_CHILD_COUNT) {
    throw new ImportParseError(
      "vdj",
      "child-count-out-of-range",
      `${label} declares ${count} entries, above the ${MAX_IMPORT_CHILD_COUNT} import limit`,
    );
  }
}
