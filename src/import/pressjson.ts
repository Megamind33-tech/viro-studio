import { DOC_VERSION, migrateDocument, type MigrationReport } from "../document/migrate";
import type { PressDocument } from "../document/types";
import { ImportParseError, isRecord } from "./errors";
import { documentFromVdj } from "./vdj";

/**
 * The guarded open boundary for everything that arrives as JSON text
 * (`.json` / `.vdj`): parse, recognise the Press format, migrate, or fall back
 * to the VDJ importer. This mirrors the open gate in the desk shell and is the
 * surface the fuzz/negative corpus (VIRO-0013) drives, so the guarantee —
 * every malformed input is a typed `ImportParseError` or a safe document,
 * never an uncaught SyntaxError/TypeError/RangeError — is proven at a single
 * seam inside the import domain.
 */

export type OpenJsonResult =
  | { kind: "press"; doc: PressDocument; report: MigrationReport }
  | { kind: "vdj"; doc: PressDocument };

/** Same shape test the desk applies: a versioned document with pages and stories. */
function looksLikePressDocument(json: unknown): boolean {
  return (
    isRecord(json) &&
    typeof json.version === "number" &&
    json.version >= 1 &&
    json.version <= DOC_VERSION &&
    !!json.pages &&
    !!json.stories
  );
}

export function openJsonDocument(text: string, name: string): OpenJsonResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    // SyntaxError for malformed text, RangeError for pathologically deep
    // nesting — both are folded into the typed rejection here.
    throw new ImportParseError("press-json", "malformed-json", `“${name}” is not valid JSON`, err);
  }
  if (looksLikePressDocument(json)) {
    const doc = json as PressDocument;
    let report: MigrationReport;
    try {
      report = migrateDocument(doc);
    } catch (err) {
      throw new ImportParseError(
        "press-json",
        "migration-failed",
        `“${name}” could not be migrated to v${DOC_VERSION}`,
        err,
      );
    }
    return { kind: "press", doc, report };
  }
  return { kind: "vdj", doc: documentFromVdj(json, name) };
}
