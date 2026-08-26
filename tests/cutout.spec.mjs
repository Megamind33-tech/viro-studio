/**
 * Background-removal cutout — proves the U²-Netp ONNX session loads from the
 * NON-JSEP CPU wasm runtime and produces a real per-pixel mask.
 *
 * Why this test exists: the deploy was blocked by ort-wasm-simd-threaded.jsep.wasm
 * (~25.6 MiB, WebGPU/JSEP build) exceeding Cloudflare's 25 MiB per-asset cap. The
 * app only ever uses executionProviders:["wasm"], so cutout.ts now imports
 * onnxruntime-web/wasm, which references the smaller ort-wasm-simd-threaded.wasm
 * (~13.5 MiB). This test asserts, from real network traffic, that the non-jsep
 * binary is the one fetched and the jsep binary is never requested — then runs a
 * genuine inference on a small synthetic image and asserts the alpha mask varies
 * (a decorative / faked passthrough would leave alpha constant).
 *
 *   node tests/cutout.spec.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureServer } from "./server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");

const URL = process.env.VIRO_URL || "http://127.0.0.1:5173";

const results = [];
let failed = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
}

async function bootReady(page) {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean(window.__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

const server = await ensureServer();
const browser = await chromium.launch({
  args: ["--no-proxy-server", "--proxy-bypass-list=*", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

// Capture every onnxruntime wasm binary the runtime actually fetches. This is the
// truthful signal for which build shipped: the code path resolves the wasm name and
// the browser fetches it from /wasm/ort/.
const ortWasmRequests = [];
page.on("request", (r) => {
  const u = r.url();
  if (/ort-wasm.*\.wasm(\?|$)/.test(u)) ortWasmRequests.push(u);
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await bootReady(page);

// Availability gate: the model must be reachable for cutout to be offered at all.
const available = await page.evaluate(async () => {
  const mod = await import("/src/engine/cutout.ts");
  return mod.cutoutAvailable();
});
check("cutoutAvailable() is true (u2netp model served)", available === true);

// Real inference on a small synthetic image (a dark disc on white — a salient
// subject u2netp can score). Returns mask statistics computed from the decoded
// output alpha channel so we can prove a genuine, varying mask was produced.
const out = await page.evaluate(async () => {
  const mod = await import("/src/engine/cutout.ts");

  const W = 96;
  const H = 72;
  const src = document.createElement("canvas");
  src.width = W;
  src.height = H;
  const sg = src.getContext("2d");
  sg.fillStyle = "#ffffff";
  sg.fillRect(0, 0, W, H);
  sg.fillStyle = "#141414";
  sg.beginPath();
  sg.arc(W / 2, H / 2, Math.min(W, H) * 0.32, 0, Math.PI * 2);
  sg.fill();
  const inputDataUrl = src.toDataURL("image/png");

  const res = await mod.cutoutDataUrl(inputDataUrl);

  // Decode the cutout output and read its alpha channel.
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("output decode failed"));
    img.src = res.dataUrl;
  });
  const oc = document.createElement("canvas");
  oc.width = res.width;
  oc.height = res.height;
  const og = oc.getContext("2d", { willReadFrequently: true });
  og.drawImage(img, 0, 0);
  const data = og.getImageData(0, 0, res.width, res.height).data;

  let minA = 255;
  let maxA = 0;
  const distinct = new Set();
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    distinct.add(a);
  }
  return {
    model: res.model,
    width: res.width,
    height: res.height,
    minA,
    maxA,
    distinctAlpha: distinct.size,
    isPng: typeof res.dataUrl === "string" && res.dataUrl.startsWith("data:image/png"),
  };
});

check("cutout ran the u2netp model", out.model === "u2netp");
check("cutout preserved source dimensions", out.width === 96 && out.height === 72, `${out.width}x${out.height}`);
check("cutout output is a PNG data URL", out.isPng === true);
check(
  "cutout produced a real per-pixel mask (alpha varies, not a passthrough)",
  out.maxA - out.minA > 20 && out.distinctAlpha > 8,
  `alpha ${out.minA}..${out.maxA}, ${out.distinctAlpha} distinct values`,
);

// The whole point of the change: the non-jsep binary is what actually loads.
const usedNonJsep = ortWasmRequests.some((u) => /ort-wasm-simd-threaded\.wasm(\?|$)/.test(u));
const usedJsep = ortWasmRequests.some((u) => /ort-wasm-simd-threaded\.jsep\.wasm(\?|$)/.test(u));
check(
  "loaded the non-JSEP CPU runtime (ort-wasm-simd-threaded.wasm)",
  usedNonJsep === true,
  ortWasmRequests.join(" | ") || "no ort wasm request captured",
);
check("did NOT load the oversized jsep runtime (ort-wasm-simd-threaded.jsep.wasm)", usedJsep === false);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
