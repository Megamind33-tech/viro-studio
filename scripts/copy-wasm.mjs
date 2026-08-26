/**
 * Copy engine binaries next to the app. Electron cannot assume node_modules URLs.
 * Installed names (npm view): canvaskit-wasm, lcms-wasm, harfbuzzjs, onnxruntime-web.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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

// Ship ONLY the non-JSEP CPU runtime. The app imports onnxruntime-web/wasm and runs
// executionProviders:["wasm"], so it loads ort-wasm-simd-threaded.{mjs,wasm}. The
// jsep (WebGPU, ~25.6 MiB — over Cloudflare's 25 MiB per-asset cap), jspi and asyncify
// variants are never referenced; copying them would bloat dist/ and re-break the deploy.
const ortDir = join(root, "node_modules", "onnxruntime-web", "dist");
const ortDest = join(dest, "ort");
const ORT_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
if (existsSync(ortDir)) {
  mkdirSync(ortDest, { recursive: true });
  for (const name of ORT_FILES) {
    copy(join(ortDir, name), name, ortDest);
  }
} else {
  console.warn("[copy-wasm] onnxruntime-web not installed yet");
}
