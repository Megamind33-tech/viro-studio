/**
 * Document migration. See FILE-FORMAT.md.
 *
 * v1 -> v2: `Layer.transform` changes meaning from ABSOLUTE page coordinates to
 * LOCAL-to-parent coordinates.
 *
 * In v1 a group's transform was inert: `drawTree` composed opacity and blend for
 * a group but never its transform, so a group was a bounding-box record plus a
 * `parentId` link. Children carried absolute coordinates and drew at them
 * regardless of the group.
 *
 * In v2 the group's transform composes into its children. Migrating therefore
 * has to subtract each ancestor's origin from its descendants, or every grouped
 * document would jump by the group's origin the first time it was opened.
 *
 * MIGRATION INVARIANT: a migrated document renders pixel-identically to the v1
 * document it came from. `tests/transform.test.mjs` asserts this.
 *
 * One value is deliberately discarded: a v1 group's `rotation`. It was never
 * composed, so it was never visible; carrying it into v2 would rotate children
 * that the user never saw rotated. Discarding it preserves the pixels, which is
 * the invariant that matters. The count is reported so the change is not silent.
 */
import { defaultTextFrameProperties, emptyTextStyles } from "./text-model";
import type { Layer, PressDocument } from "./types";

export interface MigrationReport {
  from: number;
  to: number;
  pagesTouched: number;
  layersRebased: number;
  groupRotationsDiscarded: number;
  /** v2 -> v3: image frames whose fit was the removed "fill" alias. */
  imageFitsNormalised: number;
  /** v3 -> v4: stories given explicit sparse character/paragraph ranges. */
  textStoriesInitialised: number;
  /** v3 -> v4: legacy type frames given explicit container semantics. */
  textFramesInitialised: number;
  /** v3 -> v4: document-level style/font maps created. */
  textRegistriesInitialised: number;
  notes: string[];
}

export const DOC_VERSION = 4 as const;

/**
 * Rebase one page's layers from absolute to local coordinates.
 *
 * Every layer's ORIGINAL absolute origin is captured before anything is
 * written, so the result does not depend on visiting parents before children.
 */
function rebasePage(layers: Layer[], report: MigrationReport): void {
  const origin = new Map<string, { x: number; y: number }>();
  for (const l of layers) origin.set(l.id, { x: l.transform.x, y: l.transform.y });

  for (const layer of layers) {
    if (layer.kind === "group" && layer.transform.rotation !== 0) {
      layer.transform.rotation = 0;
      report.groupRotationsDiscarded++;
    }
    if (!layer.parentId) continue;
    const parent = origin.get(layer.parentId);
    // A dangling parentId is a corrupt link, not a coordinate space. Leaving the
    // layer at its absolute position keeps it visible and reviewable instead of
    // silently teleporting it to the page origin.
    if (!parent) {
      report.notes.push(
        `layer ${layer.id} references missing parent ${layer.parentId}; left at absolute position`,
      );
      continue;
    }
    layer.transform.x -= parent.x;
    layer.transform.y -= parent.y;
    report.layersRebased++;
  }
}

/**
 * v2 -> v3. "fill" and "stretch" produced identical rectangles in the
 * compositor and the exporter alike, so the duplicate was removed and the UI
 * no longer offers it. Rewriting it keeps old files rendering exactly as they
 * did rather than falling through to a default.
 */
function normaliseImageFits(layers: Layer[], report: MigrationReport): void {
  for (const layer of layers) {
    if (layer.kind !== "image-frame") continue;
    if ((layer.fit as string) === "fill") {
      layer.fit = "stretch";
      report.imageFitsNormalised++;
    }
  }
}

/**
 * v3 -> v4. This migration is additive: current rendering continues to use the
 * story defaults while later typography slices can author sparse ranges and
 * explicit point/area/path semantics without guessing at file-open time.
 */
function initialiseTextModel(doc: PressDocument, report: MigrationReport): void {
  if (!doc.textStyles) {
    doc.textStyles = emptyTextStyles();
    report.textRegistriesInitialised++;
  }
  if (!doc.fontSubstitutions) {
    doc.fontSubstitutions = {};
    report.textRegistriesInitialised++;
  }
  for (const story of doc.stories ?? []) {
    let changed = false;
    if (!Array.isArray(story.runs)) {
      story.runs = [];
      changed = true;
    }
    if (!Array.isArray(story.paragraphRuns)) {
      story.paragraphRuns = [];
      changed = true;
    }
    if (changed) report.textStoriesInitialised++;
  }
  for (const page of doc.pages) {
    for (const layer of page.layers) {
      if (layer.kind === "type-frame" && !layer.textFrame) {
        layer.textFrame = defaultTextFrameProperties("area");
        report.textFramesInitialised++;
      }
    }
  }
}

/** True when `doc` needs migrating before the current renderer may touch it. */
export function needsMigration(doc: { version?: number }): boolean {
  return (doc.version ?? 1) < DOC_VERSION;
}

/**
 * Migrate in place and return what changed. Safe to call on a v2 document — it
 * reports a no-op rather than rebasing twice, which would move everything.
 */
export function migrateDocument(doc: PressDocument): MigrationReport {
  const from = doc.version ?? 1;
  const report: MigrationReport = {
    from,
    to: DOC_VERSION,
    pagesTouched: 0,
    layersRebased: 0,
    groupRotationsDiscarded: 0,
    imageFitsNormalised: 0,
    textStoriesInitialised: 0,
    textFramesInitialised: 0,
    textRegistriesInitialised: 0,
    notes: [],
  };
  if (from >= DOC_VERSION) {
    report.to = from;
    report.notes.push(`already version ${from}; nothing to do`);
    return report;
  }
  for (const page of doc.pages) {
    // v1 -> v2: absolute child coordinates become local to the parent.
    if (from < 2) rebasePage(page.layers, report);
    // v2 -> v3: the "fill" ImageFit was byte-identical to "stretch" in every
    // renderer, so it was removed. A file on disk can still carry it, and the
    // union no longer accepts it.
    if (from < 3) normaliseImageFits(page.layers, report);
    report.pagesTouched++;
  }
  if (from < 4) initialiseTextModel(doc, report);
  doc.version = DOC_VERSION;
  return report;
}
