/**
 * HarfBuzz composeFrame honours story-level indents and paragraph spacing.
 *
 *   node --experimental-strip-types --import ./tests/ts-register.mjs --test tests/type-compose.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeFrame, loadFace } from "../src/engine/type.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONT = join(ROOT, "public", "fonts", "NotoSans-Regular.ttf");
assert.ok(existsSync(FONT), "NotoSans-Regular.ttf missing");

const bytes = readFileSync(FONT);
const face = await loadFace(
  "noto-sans",
  "Noto Sans",
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
);

const black = { r: 0, g: 0, b: 0, a: 1 };

function story(text, paragraph = {}) {
  return {
    id: "st",
    text,
    runs: [],
    paragraphRuns: [],
    character: {
      fontId: "noto-sans",
      size: 48,
      leading: 58,
      tracking: 0,
      fill: black,
      otFeatures: ["kern", "liga"],
    },
    paragraph: { align: "left", firstLineIndent: 0, spaceAfter: 0, ...paragraph },
  };
}

test("startIndent shifts every glyph right by that many page px", () => {
  const a = composeFrame(face, story("Hello"), 800, 200);
  const b = composeFrame(face, story("Hello", { startIndent: 80 }), 800, 200);
  assert.ok(a.glyphs.length && b.glyphs.length);
  assert.ok(Math.abs(b.glyphs[0].x - a.glyphs[0].x - 80) < 1, `dx=${b.glyphs[0].x - a.glyphs[0].x}`);
});

test("spaceBefore lowers the first baseline", () => {
  const a = composeFrame(face, story("Hello"), 800, 200);
  const b = composeFrame(face, story("Hello", { spaceBefore: 24 }), 800, 200);
  assert.ok(Math.abs(b.glyphs[0].y - a.glyphs[0].y - 24) < 1, `dy=${b.glyphs[0].y - a.glyphs[0].y}`);
});

test("endIndent shrinks the wrap measure so a long line breaks sooner", () => {
  const text = "The quick brown fox jumps over the lazy dog again and again.";
  const wide = composeFrame(face, story(text), 420, 800);
  const inset = composeFrame(face, story(text, { endIndent: 220 }), 420, 800);
  assert.ok(inset.lineCount > wide.lineCount, `wide=${wide.lineCount} inset=${inset.lineCount}`);
});

test("negative firstLineIndent hanging off startIndent sits the first line further left", () => {
  const text = "Word word word word word word word word word word";
  const composed = composeFrame(
    face,
    story(text, { startIndent: 60, firstLineIndent: -60 }),
    280,
    800,
  );
  assert.ok(composed.lineCount >= 2, `need a wrap, got ${composed.lineCount} lines`);
  const firstX = composed.glyphs[0].x;
  const rest = composed.lines[1];
  assert.ok(rest, "second line metrics missing");
  assert.ok(firstX < 8, `first line should hang near 0, got ${firstX}`);
  assert.ok(rest.x > 40, `rest lines should keep left indent, got ${rest.x}`);
});
