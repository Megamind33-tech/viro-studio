import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "fonts", "NotoSans-Regular.ttf");
mkdirSync(dirname(dest), { recursive: true });

const URLS = [
  "https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf",
  "https://github.com/google/fonts/raw/main/ofl/liberation-sans/LiberationSans-Regular.ttf",
  "https://github.com/liberationfonts/liberation-fonts/raw/main/src/LiberationSans-Regular.ttf",
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/liberation-sans/LiberationSans-Regular.ttf",
];

async function download() {
  for (const url of URLS) {
    try {
      console.log("[font] GET", url);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        console.log("[font] status", res.status);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 20_000) {
        const tag = buf.toString("ascii", 0, 4);
        const ttf = buf[0] === 0x00 && buf[1] === 0x01;
        if (ttf || tag === "OTTO" || tag === "true" || tag === "wOFF") {
          writeFileSync(dest, buf);
          console.log("[font] saved", dest, buf.length, tag);
          return true;
        }
      }
      console.log("[font] skipped bytes", buf.length, "head", buf.subarray(0, 8).toString("hex"));
    } catch (e) {
      console.log("[font]", e instanceof Error ? e.message : e);
    }
  }
  return false;
}

function generate() {
  const require = createRequire(import.meta.url);
  const opentype = require("opentype.js");
  function drawBar(p, x, y, w, h) {
    p.moveTo(x, y);
    p.lineTo(x + w, y);
    p.lineTo(x + w, y + h);
    p.lineTo(x, y + h);
    p.close();
  }
  function letterPath(ch) {
    const p = new opentype.Path();
    const t = 80;
    drawBar(p, 80, 0, t, 700);
    drawBar(p, 80, 0, 420, t);
    drawBar(p, 420, 0, t, 700);
    drawBar(p, 80, 620, 420, t);
    if (/[A-HJK-Z0-9]/.test(ch) && ch !== "C" && ch !== "O") drawBar(p, 80, 310, 360, 50);
    if (ch === "I" || ch === "i" || ch === "l" || ch === "1") {
      const q = new opentype.Path();
      drawBar(q, 280, 0, t, 700);
      return q;
    }
    void ch;
    return p;
  }
  const notdef = new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: 650, path: letterPath("O") });
  const space = new opentype.Glyph({ name: "space", unicode: 32, advanceWidth: 300, path: new opentype.Path() });
  const glyphs = [notdef, space];
  for (let code = 33; code <= 126; code++) {
    glyphs.push(new opentype.Glyph({ name: `u${code}`, unicode: code, advanceWidth: 650, path: letterPath(String.fromCharCode(code)) }));
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
  console.log("[font] generated fallback TTF", statSync(dest).size);
}

if (existsSync(dest) && statSync(dest).size > 50_000) {
  console.log("[font] existing", statSync(dest).size);
} else if (!(await download())) {
  generate();
}
