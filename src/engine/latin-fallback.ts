/**
 * Last-resort Latin face so the desk still boots when the bundled TTF is
 * missing. Glyphs are geometric, not a revival of Noto — they exist so HarfBuzz
 * has something to shape and the Type tool is not a dead click.
 */
import opentype from "opentype.js";
import { loadFace, type FacePack } from "./type";

type OtPath = InstanceType<(typeof opentype)["Path"]>;

function bar(p: OtPath, x: number, y: number, w: number, h: number): void {
  p.moveTo(x, y);
  p.lineTo(x + w, y);
  p.lineTo(x + w, y + h);
  p.lineTo(x, y + h);
  p.close();
}

function letter(ch: string): OtPath {
  const p = new opentype.Path();
  const t = 70;
  if (ch === "I" || ch === "i" || ch === "l" || ch === "1" || ch === "|") {
    bar(p, 280, 0, t, 700);
    return p;
  }
  if (ch === "-" || ch === "–") {
    bar(p, 80, 310, 500, t);
    return p;
  }
  if (ch === "=") {
    bar(p, 80, 220, 500, t);
    bar(p, 80, 400, 500, t);
    return p;
  }
  bar(p, 80, 0, t, 700);
  bar(p, 80, 0, 420, t);
  bar(p, 420, 0, t, 700);
  bar(p, 80, 620, 420, t);
  if (/[A-HJK-Z0-9]/.test(ch) && ch !== "C" && ch !== "O") bar(p, 80, 310, 360, 48);
  return p;
}

export async function makeFallbackFace(): Promise<FacePack> {
  const notdef = new opentype.Glyph({
    name: ".notdef",
    unicode: 0,
    advanceWidth: 650,
    path: letter("O"),
  });
  const space = new opentype.Glyph({
    name: "space",
    unicode: 32,
    advanceWidth: 300,
    path: new opentype.Path(),
  });
  const glyphs = [notdef, space];
  for (let code = 33; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    glyphs.push(
      new opentype.Glyph({
        name: `uni${code.toString(16)}`,
        unicode: code,
        advanceWidth: 650,
        path: letter(ch),
      }),
    );
  }
  const font = new opentype.Font({
    familyName: "Viro Fallback",
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs,
  });
  return loadFace("viro-fallback", "Viro Fallback", font.toArrayBuffer());
}
