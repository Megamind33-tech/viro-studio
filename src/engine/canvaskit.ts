import type { CanvasKit } from "canvaskit-wasm";

type InitFn = (opts?: { locateFile?: (file: string) => string }) => Promise<CanvasKit>;

function unwrapInit(mod: unknown): InitFn | null {
  let cur: unknown = mod;
  for (let i = 0; i < 6; i++) {
    if (typeof cur === "function") return cur as InitFn;
    if (!cur || typeof cur !== "object") return null;
    const rec = cur as Record<string, unknown>;
    if (typeof rec.CanvasKitInit === "function") return rec.CanvasKitInit as InitFn;
    if ("default" in rec) {
      cur = rec.default;
      continue;
    }
    return null;
  }
  return null;
}

function loadClassicScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-ck-src="${src}"]`);
    if (existing) {
      if (existing.dataset.ckReady === "1") resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.dataset.ckSrc = src;
    s.onload = () => {
      s.dataset.ckReady = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * CanvasKit's Emscripten glue is a UMD factory (`var CanvasKitInit = …`).
 * Vite ESM import of that file yields a module namespace, not a function —
 * which produced `TypeError: init is not a function` on the boot splash.
 * Browser path: classic script from /wasm (copied from canvaskit-wasm/bin/full).
 */
export async function loadCanvasKit(): Promise<{ ck: CanvasKit; source: string }> {
  const wasmUrl = "/wasm/canvaskit.wasm";
  const jsUrl = "/wasm/canvaskit.js";
  const locate = (file: string) => (file.endsWith(".wasm") ? wasmUrl : file);

  if (typeof document !== "undefined") {
    const w = window as unknown as { CanvasKitInit?: InitFn };
    if (typeof w.CanvasKitInit !== "function") {
      await loadClassicScript(jsUrl);
    }
    if (typeof w.CanvasKitInit === "function") {
      const ck = await w.CanvasKitInit({ locateFile: locate });
      return { ck, source: "public-script-full" };
    }
  }

  const mod = await import("canvaskit-wasm/bin/full/canvaskit.js");
  const init = unwrapInit(mod);
  if (!init) {
    throw new Error(`CanvasKitInit is not a function (got ${typeof (mod as { default?: unknown }).default})`);
  }
  const ck = await init({ locateFile: locate });
  return { ck, source: "esm-unwrapped" };
}

export function makeSurface(ck: CanvasKit, canvas: HTMLCanvasElement) {
  const gpu = ck.MakeWebGLCanvasSurface(canvas);
  if (gpu) return { surface: gpu, backend: "webgl" as const };
  const sw = ck.MakeSWCanvasSurface(canvas);
  if (sw) return { surface: sw, backend: "skia-cpu" as const };
  throw new Error("CanvasKit could not create a Skia surface (WebGL and software both failed)");
}
