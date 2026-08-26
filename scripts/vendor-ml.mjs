import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "ml", "u2netp.onnx");
mkdirSync(dirname(dest), { recursive: true });

const local = [
  "C:\\VIRO DESIGN\\app\\vendor\\ml\\u2netp.onnx",
  "C:\\VIRO DESIGN\\app\\vendor\\u2netp.onnx",
];

for (const p of local) {
  if (existsSync(p)) {
    copyFileSync(p, dest);
    console.log("[ml] copied", p);
    process.exit(0);
  }
}

const urls = [
  "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
  "https://huggingface.co/onnx-community/u2netp-ONNX/resolve/main/onnx/model.onnx",
];

for (const url of urls) {
  try {
    console.log("[ml] GET", url);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      console.log("[ml] status", res.status);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 100_000) {
      writeFileSync(dest, buf);
      console.log("[ml] saved", dest, buf.length);
      process.exit(0);
    }
    console.log("[ml] skipped", buf.length);
  } catch (e) {
    console.log("[ml]", e instanceof Error ? e.message : e);
  }
}

console.warn("[ml] U²-Netp not vendored — Filter > Remove Background stays hidden until public/ml/u2netp.onnx exists");
