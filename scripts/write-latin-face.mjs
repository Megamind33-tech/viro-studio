/**
 * Write a shapable Latin face if a downloaded OFL TTF is not present.
 * Glyphs are outline paths so HarfBuzz → Skia is real (not fillText).
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "fonts", "NotoSans-Regular.ttf");
mkdirSync(dirname(dest), { recursive: true });

if (existsSync(dest) && (await import("node:fs")).statSync(dest).size > 50_000) {
  console.log("[font] keeping existing TTF", dest);
  process.exit(0);
}

function rect(x, y, w, h) {
  const p = new opentype.Path();
  p.moveTo(x, y);
  p.lineTo(x + w, y);
  p.lineTo(x + w, y + h);
  p.lineTo(x, y + h);
  p.close();
  return p;
}

function letterPath(ch) {
  const p = new opentype.Path();
  const add = (x0, y0, x1, y1, t = 70) => {
    p.moveTo(x0, y0);
    p.lineTo(x1, y0);
    p.lineTo(x1, y0 + t);
    p.lineTo(x0, y0 + t);
    p.close();
    if (Math.abs(x1 - x0) < Math.abs(y1 - y0)) {
      /* vertical already */
    }
    p.moveTo(x0, y0);
    p.lineTo(x0 + t, y0);
    p.lineTo(x0 + t, y1);
    p.lineTo(x0, y1);
    p.close();
  };
  void add;
  const thick = 80;
  const drawBar = (x, y, w, h) => {
    p.moveTo(x, y);
    p.lineTo(x + w, y);
    p.lineTo(x + w, y + h);
    p.lineTo(x, y + h);
    p.close();
  };
  switch (ch) {
    case "I":
    case "i":
    case "1":
    case "l":
    case "|":
      drawBar(280, 0, thick, 700);
      break;
    case "H":
      drawBar(80, 0, thick, 700);
      drawBar(520, 0, thick, 700);
      drawBar(80, 310, 520, thick);
      break;
    case "-":
      drawBar(80, 310, 500, thick);
      break;
    case "_":
      drawBar(40, 0, 620, thick);
      break;
    case "=":
      drawBar(80, 220, 500, thick);
      drawBar(80, 400, 500, thick);
      break;
    default:
      drawBar(80, 0, thick, 700);
      drawBar(80, 0, 420, thick);
      drawBar(420, 0, thick, 700);
      drawBar(80, 620, 420, thick);
      if (/[A-Z0-9]/.test(ch)) drawBar(80, 310, 360, 50);
      break;
  }
  return p;
}

const notdef = new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: 650, path: rect(50, 0, 500, 700) });
const space = new opentype.Glyph({ name: "space", unicode: 32, advanceWidth: 300, path: new opentype.Path() });
const glyphs = [notdef, space];
for (let code = 33; code <= 126; code++) {
  const ch = String.fromCharCode(code);
  glyphs.push(
    new opentype.Glyph({
      name: `uni${code.toString(16)}`,
      unicode: code,
      advanceWidth: 650,
      path: letterPath(ch),
    }),
  );
}

const font = new opentype.Font({
  familyName: "Noto Sans",
  styleName: "Regular",
  unitsPerEm: 1000,
  ascender: 800,
  descender: -200,
  glyphs,
});
writeFileSync(dest, Buffer.from(font.toArrayBuffer()));
console.log("[font] wrote generated Latin TTF", dest, (await import("node:fs")).statSync(dest).size);
