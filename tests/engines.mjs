import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ckWasm = join(root, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.wasm");
const ckJs = join(root, "node_modules", "canvaskit-wasm", "bin", "full", "canvaskit.js");
assert(existsSync(ckWasm), "canvaskit.wasm missing");

const CanvasKitInit = (await import(pathToFileURL(ckJs).href)).default;
const ck = await CanvasKitInit({ locateFile: (f) => (f.endsWith(".wasm") ? ckWasm : f) });
const surf = ck.MakeSurface(32, 32);
assert(surf, "MakeSurface failed");
const paint = new ck.Paint();
paint.setColor(ck.Color4f(0.878, 0.478, 0.184, 1));
surf.getCanvas().drawRect(ck.XYWHRect(4, 4, 24, 24), paint);
const img = surf.makeImageSnapshot();
const png = img.encodeToBytes(ck.ImageFormat.PNG, 100);
assert(png && png.length > 80, "Skia PNG encode failed");
img.delete();
surf.delete();
paint.delete();
console.log("ok canvaskit-wasm Skia surface", png.length, "bytes");

const { instantiate } = await import("lcms-wasm");
const { INTENT_RELATIVE_COLORIMETRIC, TYPE_Lab_16, TYPE_RGB_8 } = await import("lcms-wasm/lib/constants.js");
const lcmsWasm = join(root, "node_modules", "lcms-wasm", "dist", "lcms.wasm");
const lcms = await instantiate({ locateFile: () => pathToFileURL(lcmsWasm).href });
const srgb = lcms.cmsCreate_sRGBProfile();
const lab = lcms.cmsCreateLab4Profile();
const xform = lcms.cmsCreateTransform(srgb, TYPE_RGB_8, lab, TYPE_Lab_16, INTENT_RELATIVE_COLORIMETRIC, 0);
const out = lcms.cmsDoTransform(xform, new Uint8Array([224, 122, 47]), 1);
lcms.cmsDeleteTransform(xform);
lcms.cmsCloseProfile(srgb);
lcms.cmsCloseProfile(lab);
const L = (Number(out[0]) / 65535) * 100;
assert(L > 40 && L < 80, `unexpected L* ${L} from ${out[0]}`);
console.log("ok lcms-wasm sRGB→Lab16", L.toFixed(2));

const { Blob, Face, Font, Buffer, shape } = await import("harfbuzzjs");
const fontPath = join(root, "public", "fonts", "NotoSans-Regular.ttf");
assert(existsSync(fontPath), "NotoSans-Regular.ttf missing — copy an OFL face into public/fonts");
const fontBytes = readFileSync(fontPath);
const blob = new Blob(new Uint8Array(fontBytes));
const face = new Face(blob, 0);
const font = new Font(face);
font.setScale(48, 48);
const buffer = new Buffer();
buffer.addText("VIRO");
buffer.guessSegmentProperties();
shape(font, buffer);
const infos = buffer.getGlyphInfos();
assert(infos.length >= 4, `HarfBuzz shaped ${infos.length} glyphs for VIRO`);
console.log("ok harfbuzzjs shape VIRO", infos.length, "glyphs, upem", face.upem);

void require;
console.log("engines smoke passed");
