/**
 * U²-Netp subject cutout via onnxruntime-web.
 * Port of C:\VIRO DESIGN\app\js\segment.js (same tensor layout, ImageNet norm, 320 side).
 * Preprocess canvas is ML I/O only — not the document compositor.
 */

const SIDE = 320;
const MODEL_URL = "/ml/u2netp.onnx";
const WASM_PATHS = "/wasm/ort/";

type OrtSession = {
  inputNames: string[];
  outputNames: string[];
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims?: number[] }>>;
};

let session: OrtSession | null = null;
let failed = false;
let loading: Promise<OrtSession> | null = null;

export function cutoutModelUrl(): string {
  return MODEL_URL;
}

export async function cutoutAvailable(): Promise<boolean> {
  try {
    const res = await fetch(MODEL_URL, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadOrt(): Promise<typeof import("onnxruntime-web")> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.wasmPaths = WASM_PATHS;
  ort.env.wasm.numThreads = 1;
  return ort;
}

export async function loadCutout(): Promise<OrtSession> {
  if (session) return session;
  if (failed) throw new Error("The U²-Netp cutout model is not available.");
  if (loading) return loading;
  loading = (async () => {
    const ort = await loadOrt();
    const s = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    session = s as unknown as OrtSession;
    loading = null;
    return session;
  })().catch((err) => {
    loading = null;
    failed = true;
    throw err;
  });
  if (!loading) throw new Error("cutout session load failed");
  return loading;
}

function imageToCanvas(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("cutout preprocess surface failed");
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, w, h);
  return c;
}

async function decodeDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("cutout source decode failed"));
    img.src = dataUrl;
  });
  return img;
}

export async function cutoutDataUrl(dataUrl: string): Promise<{ dataUrl: string; width: number; height: number; model: string }> {
  const ort = await loadOrt();
  const s = await loadCutout();
  const img = await decodeDataUrl(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const small = imageToCanvas(img, SIDE, SIDE);
  const g = small.getContext("2d", { willReadFrequently: true })!;
  const d = g.getImageData(0, 0, SIDE, SIDE).data;
  const n = SIDE * SIDE;
  const f = new Float32Array(3 * n);
  let hi = 1;
  for (let i = 0; i < n * 4; i += 4) {
    if (d[i]! > hi) hi = d[i]!;
    if (d[i + 1]! > hi) hi = d[i + 1]!;
    if (d[i + 2]! > hi) hi = d[i + 2]!;
  }
  const inv = 1 / hi;
  for (let i = 0; i < n; i++) {
    f[i] = (d[i * 4]! * inv - 0.485) / 0.229;
    f[n + i] = (d[i * 4 + 1]! * inv - 0.456) / 0.224;
    f[2 * n + i] = (d[i * 4 + 2]! * inv - 0.406) / 0.225;
  }
  const inName = s.inputNames[0] || "input.1";
  const feeds: Record<string, unknown> = {
    [inName]: new ort.Tensor("float32", f, [1, 3, SIDE, SIDE]),
  };
  const out = await s.run(feeds);
  const tensor = out[s.outputNames[0]!];
  const raw = tensor.data as Float32Array;
  let plane = n;
  if (tensor.dims && tensor.dims.length === 4 && tensor.dims[1]! > 1) {
    plane = tensor.dims[2]! * tensor.dims[3]!;
  }
  let lo = Infinity;
  let hi2 = -Infinity;
  for (let i = 0; i < plane; i++) {
    const v = raw[i]!;
    if (v < lo) lo = v;
    if (v > hi2) hi2 = v;
  }
  const span = hi2 - lo || 1;
  const mask = g.createImageData(SIDE, SIDE);
  for (let i = 0; i < plane; i++) {
    mask.data[i * 4] = 255;
    mask.data[i * 4 + 1] = 255;
    mask.data[i * 4 + 2] = 255;
    mask.data[i * 4 + 3] = Math.round(((raw[i]! - lo) / span) * 255);
  }
  g.putImageData(mask, 0, 0);

  const full = imageToCanvas(img, w, h);
  const fg = full.getContext("2d", { willReadFrequently: true })!;
  const pixels = fg.getImageData(0, 0, w, h);
  const alpha = imageToCanvas(small, w, h).getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    pixels.data[i * 4 + 3] = alpha.data[i * 4 + 3]!;
  }
  fg.putImageData(pixels, 0, 0);
  return { dataUrl: full.toDataURL("image/png"), width: w, height: h, model: "u2netp" };
}
