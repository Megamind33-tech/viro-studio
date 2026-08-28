/**
 * VIRO-0145 — the vector PDF text export must embed a VALID TrueType face.
 *
 * Before-state (critic finding 2026-08-28, reproduced here as test 1):
 * pdf-lib's `embedFont(bytes, { subset: true })` — the subsetter is the
 * fontkit fork bundled inside pdf-lib — emitted a FontFile2 whose glyf/loca
 * drift: for Noto Sans Regular, glyph outlines read out of bounds ("Offset is
 * outside the bounds of the DataView" in fontkit, "Trying to access beyond
 * buffer length" in pdf-lib's vendored fork). Viewers painted only
 * fragmentary glyphs. The exporter now embeds the full face (subset: false)
 * and this suite pins the repaired behaviour through the real exporter:
 *
 *   - the embedded FontFile2 parses with fontkit and carries the whole face;
 *   - every glyph id placed on the page renders an outline from that face;
 *   - the /ToUnicode CMap extracts the composed text back out;
 *   - the export report tells the truth about the embed.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/pdf-font-embed.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFArray, PDFName, decodePDFRawStream } from "pdf-lib";
import { create as fontkitCreate } from "fontkit";
import { exportPagePdf } from "../src/export/pdf.ts";
import { loadFace } from "../src/engine/type.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_BYTES = readFileSync(join(ROOT, "public", "fonts", "NotoSans-Regular.ttf"));
const FONT_AB = () => FONT_BYTES.buffer.slice(FONT_BYTES.byteOffset, FONT_BYTES.byteOffset + FONT_BYTES.byteLength);
const TEXT = "VIRO typographic";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeDoc() {
  return {
    version: 6,
    name: "VIRO-0145 fixture",
    ppi: 72,
    color: { workingSpace: "sRGB", intent: "perceptual", iccProfileName: null },
    pages: [
      {
        id: "p1",
        name: "Page 1",
        widthPx: 400,
        heightPx: 400,
        bleedPx: 0,
        columnCount: 1,
        columnGutter: 0,
        background: { r: 1, g: 1, b: 1, a: 0 },
        layers: [
          {
            id: "t1",
            kind: "type-frame",
            name: "Type",
            visible: true,
            locked: false,
            opacity: 1,
            blend: "srcOver",
            parentId: null,
            transform: { x: 40, y: 120, w: 320, h: 120, rotation: 0 },
            storyId: "s1",
            nextFrameId: null,
          },
        ],
      },
    ],
    spreads: [],
    stories: [
      {
        id: "s1",
        text: TEXT,
        character: {
          fontId: "noto-sans",
          // 24px keeps "VIRO typographic" (~230px) inside the 320px frame so
          // the paragraph composes as ONE line — the word space then exercises
          // the exporter's space-glyph re-insertion instead of a line break.
          size: 24,
          leading: 28.8,
          tracking: 0,
          fill: { r: 0, g: 0, b: 0, a: 1 },
          otFeatures: [],
        },
        paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0 },
      },
    ],
    swatches: [],
    activePageId: "p1",
    activeLayerIds: [],
    assets: {},
  };
}

/* ------------------------------------------------------------------ *
 * Extraction helpers
 * ------------------------------------------------------------------ */

/** The decoded FontFile2 (or FontFile3) payload of the first embedded face. */
async function embeddedFontFile(bytes, key = "FontFile2") {
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj && obj.dict ? obj.dict : obj;
    if (!dict || !dict.get) continue;
    const type = dict.get(PDFName.of("Type"));
    if (!type || type.toString() !== "/FontDescriptor") continue;
    const ref = dict.get(PDFName.of(key));
    if (!ref) continue;
    const stream = doc.context.lookup(ref);
    return Buffer.from(decodePDFRawStream(stream).decode());
  }
  return null;
}

/** The decoded page content stream(s) as latin1 text. */
async function contentText(bytes) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const raws =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i))
      : [contents];
  let text = "";
  for (const raw of raws) {
    if (!raw) continue;
    text += Buffer.from(decodePDFRawStream(raw).decode()).toString("latin1") + "\n";
  }
  return text;
}

/** Every glyph id written into a `TJ` array, in placement order. */
function tjGlyphIds(content) {
  const ids = [];
  for (const m of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    for (const h of m[1].matchAll(/<([0-9A-Fa-f]+)>/g)) {
      const hex = h[1];
      for (let i = 0; i + 4 <= hex.length; i += 4) ids.push(parseInt(hex.slice(i, i + 4), 16));
    }
  }
  return ids;
}

/** CID → unicode string, decoded from the face's /ToUnicode CMap. */
async function toUnicodeMap(bytes) {
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj && obj.dict ? obj.dict : obj;
    if (!dict || !dict.get) continue;
    const ref = dict.get(PDFName.of("ToUnicode"));
    if (!ref) continue;
    const text = Buffer.from(decodePDFRawStream(doc.context.lookup(ref)).decode()).toString("latin1");
    const map = new Map();
    for (const m of text.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const cid = parseInt(m[1], 16);
      const utf16 = m[2];
      let str = "";
      for (let i = 0; i + 4 <= utf16.length; i += 4) {
        str += String.fromCharCode(parseInt(utf16.slice(i, i + 4), 16));
      }
      map.set(cid, str);
    }
    return map;
  }
  return null;
}

async function exportFixture() {
  const face = await loadFace("noto-sans", "Noto Sans Regular", FONT_AB());
  const { bytes, report } = await exportPagePdf({ doc: makeDoc(), face });
  return { bytes, report, face };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("VIRO-0145 before-state: pdf-lib's embedFont subset output is an unparseable font (recorded defect)", async () => {
  const { PDFDocument: PD } = await import("pdf-lib");
  const kit = (await import("@pdf-lib/fontkit")).default ?? (await import("@pdf-lib/fontkit"));
  const pdf = await PD.create();
  pdf.registerFontkit(kit);
  const f = await pdf.embedFont(new Uint8Array(FONT_BYTES), { subset: true });
  const emb = f.embedder;
  for (const g of emb.font.layout(TEXT).glyphs) {
    const code = emb.subset.includeGlyph(g);
    emb.glyphs[code - 1] = g;
    emb.glyphIdMap.set(g.id, code);
  }
  emb.glyphCache.invalidate();
  const page = pdf.addPage([400, 400]);
  page.drawText(TEXT, { x: 40, y: 200, size: 48, font: f });
  const saved = await pdf.save();

  const ff2 = await embeddedFontFile(saved);
  assert.ok(ff2, "no FontFile2 in the subset seam PDF");
  assert.ok(ff2.length < FONT_BYTES.length / 10, "expected a subset-sized font file");

  const sub = fontkitCreate(ff2);
  const errors = [];
  for (let gid = 0; gid < sub.numGlyphs; gid++) {
    try {
      sub.getGlyph(gid).path;
    } catch (err) {
      errors.push(`gid ${gid}: ${err.message}`);
    }
  }
  assert.ok(
    errors.length > 0,
    `expected the pdf-lib subset to have unreadable glyph outlines, got none; errors were ${errors}`,
  );
});

test("VIRO-0145: the exported FontFile2 is the complete valid face — fontkit parses it", async () => {
  const { bytes } = await exportFixture();
  const ff2 = await embeddedFontFile(bytes);
  assert.ok(ff2, "no FontFile2 in the exported PDF");

  // The fix embeds the face whole, so the stream is the original font.
  assert.equal(ff2.length, FONT_BYTES.length, "FontFile2 is not the full face");

  const embedded = fontkitCreate(ff2);
  const original = fontkitCreate(Buffer.from(FONT_BYTES));
  assert.equal(embedded.numGlyphs, original.numGlyphs, "embedded face lost glyphs");
  const layout = embedded.layout(TEXT);
  assert.ok(layout.glyphs.length >= TEXT.length, "embedded face cannot lay out the story text");
  assert.ok(layout.glyphs.every((g) => g.id > 0), "layout produced unmapped glyphs");
});

test("VIRO-0145: every glyph placed on the page renders an outline from the embedded face", async () => {
  const { bytes, face } = await exportFixture();
  const content = await contentText(bytes);
  const ids = tjGlyphIds(content);
  assert.ok(ids.length > 0, "no TJ glyph ids found in the content stream");

  const ff2 = await embeddedFontFile(bytes);
  const embedded = fontkitCreate(ff2);

  let outlined = 0;
  for (const gid of ids) {
    const glyph = embedded.getGlyph(gid); // throws if the face cannot resolve the glyph
    assert.ok(glyph, `glyph ${gid} missing from the embedded face`);
    if (gid !== face.spaceGid) {
      assert.ok(glyph.path.commands.length > 0, `glyph ${gid} has an empty outline`);
      outlined++;
    }
  }
  assert.ok(outlined > 0, "no glyph on the page had a real outline");
});

test("VIRO-0145: the exported text layer extracts back to the composed string", async () => {
  const { bytes } = await exportFixture();
  const content = await contentText(bytes);
  const ids = tjGlyphIds(content);
  const map = await toUnicodeMap(bytes);
  assert.ok(map, "no /ToUnicode CMap on the embedded font");

  const extracted = ids.map((cid) => map.get(cid) ?? "").join("");
  assert.equal(extracted, TEXT);
});

test("VIRO-0145: the export report tells the truth about the embed", async () => {
  const { bytes, report } = await exportFixture();
  const content = await contentText(bytes);
  const ids = tjGlyphIds(content);

  assert.equal(report.glyphs, ids.length, "report glyph count does not match the page");
  assert.equal(report.textRuns, 1, "fixture should compose as exactly one set line");

  const doc = await PDFDocument.load(bytes);
  const subject = doc.getSubject();
  assert.match(subject, /full TrueType font/);
  assert.doesNotMatch(subject, /TrueType subset/);
});
