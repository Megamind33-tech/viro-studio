/**
 * Copy engine binaries next to the app. Electron cannot assume node_modules URLs.
 * Installed names (npm view): canvaskit-wasm, lcms-wasm, harfbuzzjs, onnxruntime-web.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "wasm");
mkdirSync(dest, { recursive: true });

function copy(from, name, into = dest) {
  if (!existsSync(from)) {
    console.warn(`[copy-wasm] missing ${from}`);
    return false;
  }
  mkdirSync(into, { recursive: true });
  copyFileSync(from, join(into, name));
  console.log(`[copy-wasm] ${name}`);
  return true;
}

const ckDir = join(root, "node_modules", "canvaskit-wasm", "bin", "full");
copy(join(ckDir, "canvaskit.wasm"), "canvaskit.wasm");
copy(join(ckDir, "canvaskit.js"), "canvaskit.js");

copy(join(root, "node_modules", "lcms-wasm", "dist", "lcms.wasm"), "lcms.wasm");

const hbWasm = join(root, "node_modules", "harfbuzzjs", "dist", "harfbuzz.wasm");
if (existsSync(hbWasm)) copy(hbWasm, "harfbuzz.wasm");

const ortDir = join(root, "node_modules", "onnxruntime-web", "dist");
const ortDest = join(dest, "ort");
if (existsSync(ortDir)) {
  mkdirSync(ortDest, { recursive: true });
  for (const name of readdirSync(ortDir)) {
    if (name.endsWith(".wasm") || /^ort-wasm.*\.(mjs|js)$/.test(name)) {
      copy(join(ortDir, name), name, ortDest);
    }
  }
} else {
  console.warn("[copy-wasm] onnxruntime-web not installed yet");
}
