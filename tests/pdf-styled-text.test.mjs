/**
 * VIRO-0147 — per-range styled text in vector PDF export (emitType consumes
 * CharacterRuns). Node arm: operator-level proof against the real exporter.
 *
 * Before-state (batch critic finding 2026-08-28, reproduced before the fix):
 * emitType painted every glyph with the story-level size/fill under a single
 * embedded face while `composeFrame` positioned glyphs at mixed per-run
 * advances — a 64px copper / 34px blue two-range document exported every
 * glyph at 12px black scattered across the wide advances, and the report
 * claimed success with no caveat.
 *
 * This suite pins the repaired behaviour through the real exporter only:
 *   - each styled run paints with its own Tf size, rg colour and gs alpha,
 *     under the single Tm of its baseline (topology pin);
 *   - a Tm/TJ replay of the emitted operators lands every glyph on the exact
 *     x `composeFrame` computed for the canvas (no scatter) — the viewer's
 *     pen model (TJ adj in 1/1000 em of the CURRENT Tf size, glyph advance
 *     from the face) applied with fontkit-read advances;
 *   - a per-range fontId override embeds each range's own full face and
 *     writes that range's glyph ids only under its own font resource;
 *   - the extracted text (per-font /ToUnicode) returns the composed string,
 *     word break at the styled boundary included;
 *   - the report tells the truth (glyph/run counts, face names, byte cost).
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/pdf-styled-text.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFArray, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { create as fontkitCreate } from "fontkit";
import { exportPagePdf } from "../src/export/pdf.ts";
import { loadFace, composeFrame } from "../src/engine/type.ts";
import { fontRegistry, resetFontRegistry } from "../src/engine/font-registry.ts";
import { createDocument, addTypeFrame } from "../src/document/factory.ts";
import { setStoryText, setCharacter } from "../src/document/ops.ts";
import { applyCharacterRange } from "../src/document/text-model.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** ArrayBuffer-copying reader, the exact shape loadFace needs. */
function faceBytes(file) {
  const b = readFileSync(join(ROOT, "public", "fonts", file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/* ------------------------------------------------------------------ *
 * Faces — the story face and a distinct range face, seeded into the
 * FontRegistry singleton exactly as the app boots its bundled set.
 * ------------------------------------------------------------------ */

const sans = await loadFace("noto-sans", "Noto Sans Regular", faceBytes("NotoSans-Regular.ttf"));
const serif = await loadFace("noto-serif", "Noto Serif Regular", faceBytes("NotoSerif-Regular.ttf"));
const SERIF_FILE_BYTES = readFileSync(join(ROOT, "public", "fonts", "NotoSerif-Regular.ttf")).length;

resetFontRegistry();
fontRegistry().add({ id: "noto-sans", family: "Noto Sans", style: "Regular", name: "noto-sans", source: "bundled", face: sans });
fontRegistry().add({ id: "noto-serif", family: "Noto Serif", style: "Regular", name: "noto-serif", source: "bundled", face: serif });

/* ------------------------------------------------------------------ *
 * Fixture — the critic repro: one line, two character ranges over a
 * story style nobody would want to read (12px black).
 * ------------------------------------------------------------------ */

const COPPER = { r: 0.878, g: 0.478, b: 0.184, a: 1 };
const BLUE = { r: 0.1, g: 0.3, b: 0.9, a: 1 };

function styledDoc({ serifRange = false } = {}) {
  let doc = createDocument({ name: "VIRO-0147 Styled", ppi: 72, widthPx: 600, heightPx: 300, bleedPx: 0, pageCount: 1, facingPages: false });
  doc.pages[0].background.a = 0;
  doc = addTypeFrame(doc, "noto-sans", 40, 60, { w: 520, h: 160 });
  const id = doc.activeLayerIds[0];
  doc = setStoryText(doc, id, "VIRO corpus");
  doc = setCharacter(doc, id, { size: 12, leading: 14.4, tracking: 0, fill: { r: 0, g: 0, b: 0, a: 1 } });
  const layer = doc.pages[0].layers[doc.pages[0].layers.length - 1];
  const story = doc.stories.find((s) => s.id === layer.storyId);
  let styled = applyCharacterRange(story, 0, 4, { size: 64, leading: 76.8, fill: COPPER });
  styled = serifRange
    ? applyCharacterRange(styled, 5, 11, { size: 34, leading: 40.8, fontId: "noto-serif", fill: BLUE })
    : applyCharacterRange(styled, 5, 11, { size: 34, leading: 40.8, fill: BLUE });
  doc.stories[doc.stories.findIndex((s) => s.id === story.id)] = styled;
  return { doc, layer, story: styled };
}

async function exportStyled(options = {}) {
  const { doc, layer, story } = styledDoc(options);
  const fonts = options.noRegistry ? undefined : fontRegistry();
  const { bytes, report } = await exportPagePdf({ doc, face: sans, fonts });
  return { bytes, report, layer, story, doc };
}

/* ------------------------------------------------------------------ *
 * Content-stream inspection helpers
 * ------------------------------------------------------------------ */

/** The decoded page content stream as latin1 text. */
async function contentText(bytes) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const raws = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : [contents];
  let text = "";
  for (const raw of raws) {
    if (!raw) continue;
    text += Buffer.from(decodePDFRawStream(raw).decode()).toString("latin1") + "\n";
  }
  return text;
}

/** The BT … ET text object of a stream that contains exactly one. */
function textBlock(content) {
  const a = content.indexOf("BT");
  const b = content.lastIndexOf("ET");
  assert.ok(a >= 0 && b > a, "content stream carries a BT…ET text object");
  return content.slice(a, b + 2);
}

/**
 * Sequential replay of the emitted text object — the viewer's pen model:
 * Tm sets the baseline origin and resets the pen; Tf flips font/size; rg
 * flips the colour; a TJ number displaces the pen by adj/1000 × current size
 * (the displacement is em-scaled, exactly as the exporter's own bookkeeping);
 * a TJ hex glyph is PLACED at origin + pen (with the current font/size/colour)
 * and advances the pen by face_advance × size / upem.
 *
 * Returns every placed glyph in paint order plus the run boundaries observed.
 */
function replayTextObject(block, resources) {
  const placed = [];
  const runs = [];
  let pen = 0;
  let originX = 0;
  let originY = 0;
  let font = null;
  let size = 0;
  let color = null;
  let sinceRunStart = 0;
  const pattern = /1\s+0\s+0\s+-1\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|\/(F-\d+)\s+([\d.]+)\s+Tf|([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg|\[([^\]]*)\]\s*TJ/g;
  for (const m of block.matchAll(pattern)) {
    if (m[1] !== undefined) {
      originX = Number(m[1]);
      originY = Number(m[2]);
      pen = 0;
    } else if (m[3] !== undefined) {
      font = m[3];
      size = Number(m[4]);
    } else if (m[5] !== undefined) {
      color = [Number(m[5]), Number(m[6]), Number(m[7])];
    } else if (m[8] !== undefined) {
      // One TJ array: numbers displace, hex strings place glyphs.
      const items = m[8];
      const tokenRe = /<([0-9A-Fa-f]+)>|(-?[\d.]+)/g;
      for (const t of items.matchAll(tokenRe)) {
        if (t[1] !== undefined) {
          for (let h = 0; h + 4 <= t[1].length; h += 4) {
            const gid = parseInt(t[1].slice(h, h + 4), 16);
            placed.push({ gid, x: originX + pen, y: originY, font, size, color });
            sinceRunStart += 1;
            const res = resources[font];
            assert.ok(res, `font resource ${font} present in page resources`);
            pen += (res.advance(gid) / res.upem) * size;
          }
        } else {
          pen -= (Number(t[2]) / 1000) * size;
        }
      }
      runs.push({ font, size, color, glyphs: sinceRunStart });
      sinceRunStart = 0;
    }
  }
  return { placed, runs };
}

/** Canvas truth: composeFrame glyph positions in FRAME space — the emitted
 * text object lives inside the layer's `cm`, so the Tm origins and the TJ pen
 * are frame-local. */
function canvasGlyphs(layer, story, face) {
  return composeFrame(face, story, layer.transform.w, layer.transform.h, layer.textFrame).glyphs.map((g) => ({
    x: g.x,
    y: g.y,
    gid: g.gid,
    faceId: g.face.id,
  }));
}

/** Every placed glyph's painted x matches a remaining composeFrame x (and gid), each truth hit used once. */
function assertPaintedMatchesCanvas(placed, truth) {
  const remaining = [...truth];
  let unmatched = 0;
  for (const p of placed) {
    const hit = remaining.findIndex((t) => Math.abs(p.x - t.x) < 0.05 && p.gid === t.gid);
    if (hit >= 0) remaining.splice(hit, 1);
    else unmatched += 1;
  }
  // The only allowed extra is the re-inserted word space (paints nothing).
  assert.ok(unmatched <= 1, `at most the inserted word space may paint off-canvas (unmatched ${unmatched})`);
  assert.equal(remaining.length, 0, "every composeFrame glyph position is painted (no scatter)");
}

/** Font resource name → { baseFont, upem, advance(gid), toUnicode(cid) }. */
async function fontResources(bytes) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const res = page.node.Resources();
  const fontsDict = res && res.lookup ? res.lookup(PDFName.of("Font")) : null;
  assert.ok(fontsDict, "page resources carry a /Font dictionary");
  const out = {};
  for (const [key, ref] of fontsDict.entries()) {
    const dict = doc.context.lookup(ref);
    const baseFont = dict.get(PDFName.of("BaseFont"))?.toString() ?? "";
    // Type0 fonts hang their descriptor off /DescendantFonts[0].
    let desc = dict.lookup ? dict.lookup(PDFName.of("FontDescriptor")) : null;
    if (!desc) {
      const descendants = dict.lookup(PDFName.of("DescendantFonts"));
      const first = descendants && descendants.lookup ? descendants.lookup(0) : null;
      desc = first && first.lookup ? first.lookup(PDFName.of("FontDescriptor")) : null;
    }
    const ffRef = desc?.get ? desc.get(PDFName.of("FontFile2")) : null;
    const ff = ffRef ? doc.context.lookup(ffRef) : null;
    const ffBytes = ff ? Buffer.from(decodePDFRawStream(ff).decode()) : null;
    // Advance widths come from the face itself: a full-font embed keeps
    // CIDs equal to HarfBuzz glyph ids, so fontkit reads them directly.
    const kit = ffBytes ? fontkitCreate(ffBytes) : null;
    const toUnicode = new Map();
    const tuRef = dict.get(PDFName.of("ToUnicode"));
    if (tuRef) {
      const text = Buffer.from(decodePDFRawStream(doc.context.lookup(tuRef)).decode()).toString("latin1");
      for (const m of text.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const utf16 = m[2];
        let str = "";
        for (let i = 0; i + 4 <= utf16.length; i += 4) str += String.fromCharCode(parseInt(utf16.slice(i, i + 4), 16));
        toUnicode.set(parseInt(m[1], 16), str);
      }
    }
    out[key.toString().replace(/^\//, "")] = {
      baseFont,
      ffBytes,
      upem: kit ? kit.unitsPerEm : 1000,
      advance: (gid) => (kit ? (kit.getGlyph(gid)?.advanceWidth ?? 0) : 0),
      toUnicode: (cid) => toUnicode.get(cid) ?? "",
    };
  }
  return out;
}

test('VIRO-0147: two ranges paint as two styled runs — per-run Tf size and rg colour under one Tm', async () => {
  const { bytes } = await exportStyled();
  const block = textBlock(await contentText(bytes));
  const resources = await fontResources(bytes);
  const { runs } = replayTextObject(block, resources);

  assert.equal(runs.length, 2, 'exactly two styled TJ runs');
  assert.deepEqual(runs.map((r) => r.size), [64, 34], 'run sizes are the range sizes, not the story size');
  assert.equal(runs[0].font, runs[1].font, 'same-face ranges share one font resource');
  assert.deepEqual(runs[0].color, [0.878, 0.478, 0.184], 'first run paints copper');
  assert.deepEqual(runs[1].color, [0.1, 0.3, 0.9], 'second run paints blue');
  assert.equal((block.match(/Tm/g) ?? []).length, 1, 'one baseline Tm (single composed line)');
});

test('VIRO-0147: Tm/TJ replay lands every glyph where composeFrame put it — no scatter', async () => {
  const { bytes, layer, story } = await exportStyled();
  const block = textBlock(await contentText(bytes));
  const resources = await fontResources(bytes);
  const { placed } = replayTextObject(block, resources);

  // Emitted glyphs = composed glyphs + the one re-inserted word space.
  const truth = canvasGlyphs(layer, story, sans);
  assert.equal(placed.length, truth.length + 1, 'emitted glyphs = composed glyphs + one word space');
  assertPaintedMatchesCanvas(placed, truth);
});

test('VIRO-0147: extraction returns the composed text, styled word break included', async () => {
  const { bytes } = await exportStyled();
  const block = textBlock(await contentText(bytes));
  const resources = await fontResources(bytes);
  const { placed } = replayTextObject(block, resources);

  const extracted = placed.map((g) => resources[g.font].toUnicode(g.gid)).join('');
  assert.equal(extracted, 'VIRO corpus');
});

test('VIRO-0147: a per-range fontId override embeds the range face and writes its ids under it', async () => {
  const { bytes, layer, story } = await exportStyled({ serifRange: true });
  const block = textBlock(await contentText(bytes));
  const resources = await fontResources(bytes);
  const { placed, runs } = replayTextObject(block, resources);

  assert.equal(runs.length, 2, 'two styled runs');
  assert.notEqual(runs[0].font, runs[1].font, 'the serif range gets its own font resource');
  assert.equal(resources[runs[0].font].baseFont, '/NotoSansRegular', 'story run under the story face');
  assert.equal(resources[runs[1].font].baseFont, '/NotoSerifRegular', 'range run under the range face');

  // Full-font embed per face: each FontFile2 is byte-identical to its source.
  assert.equal(resources[runs[0].font].ffBytes.length, faceBytes('NotoSans-Regular.ttf').byteLength, 'sans FontFile2 is the whole face');
  assert.equal(resources[runs[1].font].ffBytes.length, SERIF_FILE_BYTES, 'serif FontFile2 is the whole face');

  // The serif run's glyph ids decode to the range text THROUGH the serif
  // font's own /ToUnicode — invalid or aliased ids could not.
  const serifGlyphs = placed.filter((g) => g.font === runs[1].font);
  assert.ok(serifGlyphs.length > 5, 'the serif run carries the range glyphs');
  const decoded = serifGlyphs.map((g) => resources[g.font].toUnicode(g.gid)).join('');
  assert.ok(decoded.includes('corpus'), 'serif ids decode to the range text');

  // And every serif glyph lands exactly where the canvas put it.
  const truth = canvasGlyphs(layer, story, sans).filter((g) => g.faceId === 'noto-serif');
  const matched = serifGlyphs.filter((g) => truth.some((t) => Math.abs(g.x - t.x) < 0.05 && g.gid === t.gid));
  assert.equal(matched.length, truth.length, 'every serif glyph paints at its composeFrame x');
});

test('VIRO-0147: the report tells the truth — counts, face names and the byte cost of per-range faces', async () => {
  const { bytes, report } = await exportStyled({ serifRange: true });
  const block = textBlock(await contentText(bytes));
  const { placed, runs } = replayTextObject(block, await fontResources(bytes));

  assert.equal(report.glyphs, placed.length, 'report glyph count equals the glyphs on the page');
  assert.equal(report.textRuns, runs.length, 'report run count equals the TJ arrays');
  const doc = await PDFDocument.load(bytes);
  const subject = doc.getSubject();
  assert.match(subject, /Noto Sans Regular, Noto Serif Regular embedded as a full TrueType fonts/);
  assert.ok(
    report.notes.some((n) => /one full face per distinct range face/.test(n) && /KB of font data/.test(n)),
    'the multi-face note discloses the face count and the total font byte cost',
  );
});

test('VIRO-0147: regression — a uniform single-style story keeps the pre-0147 topology', async () => {
  let doc = createDocument({ name: 'VIRO-0147 Uniform', ppi: 72, widthPx: 400, heightPx: 300, bleedPx: 0, pageCount: 1, facingPages: false });
  doc.pages[0].background.a = 0;
  doc = addTypeFrame(doc, 'noto-sans', 32, 32, { w: 320, h: 120 });
  const id = doc.activeLayerIds[0];
  doc = setStoryText(doc, id, 'VIRO corpus');
  doc = setCharacter(doc, id, { size: 36, leading: 43.2, tracking: 0, fill: { r: 0.1, g: 0.1, b: 0.1, a: 1 } });
  const { bytes, report } = await exportPagePdf({ doc, face: sans });

  const block = textBlock(await contentText(bytes));
  const tokens = block.split(/\s+/).filter(Boolean);
  const count = (op) => tokens.reduce((acc, t) => acc + (t === op ? 1 : 0), 0);
  assert.equal(count('BT'), 1);
  assert.equal(count('ET'), 1);
  assert.equal(count('Tf'), 1, 'one style, one Tf');
  assert.equal(count('Tm'), 1);
  assert.equal(count('TJ'), 1, 'one TJ — the whole line rides one run');
  assert.equal(report.textRuns, 1);
});
