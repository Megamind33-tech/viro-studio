import { writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "public", "fonts");
mkdirSync(dir, { recursive: true });

const FACES = [
  {
    file: "NotoSans-Regular.ttf",
    urls: [
      "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@5.2.8/latin-400-normal.ttf",
      "https://cdn.jsdelivr.net/gh/notofonts/latin-greek-cyrillic@main/fonts/NotoSans/full/ttf/NotoSans-Regular.ttf",
      "https://github.com/notofonts/latin-greek-cyrillic/raw/main/fonts/NotoSans/full/ttf/NotoSans-Regular.ttf",
      "https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf",
    ],
  },
  {
    file: "NotoSans-Bold.ttf",
    urls: [
      "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@5.2.8/latin-700-normal.ttf",
      "https://cdn.jsdelivr.net/gh/notofonts/latin-greek-cyrillic@main/fonts/NotoSans/full/ttf/NotoSans-Bold.ttf",
    ],
  },
  {
    file: "NotoSans-Italic.ttf",
    urls: [
      "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@5.2.8/latin-400-italic.ttf",
      "https://cdn.jsdelivr.net/gh/notofonts/latin-greek-cyrillic@main/fonts/NotoSans/full/ttf/NotoSans-Italic.ttf",
    ],
  },
  {
    file: "NotoSerif-Regular.ttf",
    urls: [
      "https://cdn.jsdelivr.net/fontsource/fonts/noto-serif@5.2.8/latin-400-normal.ttf",
      "https://cdn.jsdelivr.net/gh/notofonts/latin-greek-cyrillic@main/fonts/NotoSerif/full/ttf/NotoSerif-Regular.ttf",
    ],
  },
  {
    file: "NotoSansMono-Regular.ttf",
    urls: [
      "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-mono@5.2.8/latin-400-normal.ttf",
      "https://cdn.jsdelivr.net/gh/notofonts/latin-greek-cyrillic@main/fonts/NotoSansMono/full/ttf/NotoSansMono-Regular.ttf",
    ],
  },
];

function isFont(buf) {
  if (buf.length < 8) return false;
  const tag = buf.toString("ascii", 0, 4);
  return (buf[0] === 0x00 && buf[1] === 0x01) || tag === "OTTO" || tag === "true" || tag === "wOFF" || tag === "ttcf";
}

async function downloadOne(spec) {
  const dest = join(dir, spec.file);
  if (existsSync(dest) && statSync(dest).size > 20_000) {
    console.log("[font] keep", spec.file, statSync(dest).size);
    return true;
  }
  for (const url of spec.urls) {
    try {
      console.log("[font] GET", spec.file, url);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        console.log("[font] status", res.status);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 8_000 && isFont(buf)) {
        writeFileSync(dest, buf);
        console.log("[font] saved", spec.file, buf.length);
        return true;
      }
      console.log("[font] skipped", spec.file, buf.length, buf.subarray(0, 8).toString("hex"));
    } catch (e) {
      console.log("[font]", spec.file, e instanceof Error ? e.message : e);
    }
  }
  return false;
}

/** Offline Windows machines still get real outlines instead of empty font menus. */
const LOCAL_FACES = {
  "NotoSans-Regular.ttf": ["segoeui.ttf", "arial.ttf", "calibri.ttf", "tahoma.ttf"],
  "NotoSans-Bold.ttf": ["segoeuib.ttf", "arialbd.ttf", "calibrib.ttf", "tahomabd.ttf"],
  "NotoSans-Italic.ttf": ["segoeuii.ttf", "ariali.ttf", "calibrii.ttf"],
  "NotoSerif-Regular.ttf": ["times.ttf", "georgia.ttf", "constan.ttf"],
  "NotoSansMono-Regular.ttf": ["consola.ttf", "cour.ttf", "lucon.ttf"],
};

function copyLocal(file) {
  const dest = join(dir, file);
  if (existsSync(dest) && statSync(dest).size > 20_000) return true;
  const windir = process.env.WINDIR || "C:\\Windows";
  const fontsDir = join(windir, "Fonts");
  for (const name of LOCAL_FACES[file] ?? []) {
    const src = join(fontsDir, name);
    if (!existsSync(src)) continue;
    try {
      copyFileSync(src, dest);
      console.log("[font] copied", name, "→", file, statSync(dest).size);
      return true;
    } catch (e) {
      console.log("[font] copy failed", name, e instanceof Error ? e.message : e);
    }
  }
  return false;
}

function generateRegular() {
  const dest = join(dir, "NotoSans-Regular.ttf");
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
    if (ch === "I" || ch === "i" || ch === "l" || ch === "1" || ch === "|") {
      drawBar(p, 280, 0, t, 700);
      return p;
    }
    drawBar(p, 80, 0, t, 700);
    drawBar(p, 80, 0, 420, t);
    drawBar(p, 420, 0, t, 700);
    drawBar(p, 80, 620, 420, t);
    if (/[A-HJK-Z0-9]/.test(ch) && ch !== "C" && ch !== "O") drawBar(p, 80, 310, 360, 50);
    return p;
  }
  const notdef = new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: 650, path: letterPath("O") });
  const space = new opentype.Glyph({ name: "space", unicode: 32, advanceWidth: 300, path: new opentype.Path() });
  const glyphs = [notdef, space];
  for (let code = 33; code <= 126; code++) {
    glyphs.push(
      new opentype.Glyph({
        name: `u${code}`,
        unicode: code,
        advanceWidth: 650,
        path: letterPath(String.fromCharCode(code)),
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
  console.log("[font] generated fallback TTF", dest, statSync(dest).size);
}

const regular = FACES[0];
const extras = FACES.slice(1);
let gotRegular = await downloadOne(regular);
if (!gotRegular) gotRegular = copyLocal(regular.file);
await Promise.all(
  extras.map(async (spec) => {
    if (await downloadOne(spec)) return;
    copyLocal(spec.file);
  }),
);
if (!gotRegular) generateRegular();
const dest = join(dir, "NotoSans-Regular.ttf");
if (!existsSync(dest) || statSync(dest).size < 1000) {
  generateRegular();
}
