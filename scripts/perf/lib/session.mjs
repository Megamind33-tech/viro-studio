/**
 * Browser session for the perf harness: launches the same Chromium build the
 * Playwright suite uses (SwiftShader software GL — the suite's documented
 * CI-equivalent canvas path), boots the real editor, and installs the probe.
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installViroPerf } from "./probe.js";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// CI vendors browsers into tests/.pw-browsers; a dev machine uses Playwright's
// default cache. Only pin the vendored path when it is actually there, so the
// harness never points a launch at an empty directory.
const vendored = join(ROOT, "tests", ".pw-browsers");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(vendored)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = vendored;
}

const LAUNCH_ARGS = [
  // Same flags as playwright.config.ts: this machine's proxy stalls the
  // CanvasKit wasm fetch, and headless Chromium needs SwiftShader for Skia.
  "--no-proxy-server",
  "--proxy-bypass-list=*",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

export const VIEWPORT = { width: 1440, height: 900 };

export async function launchBrowser() {
  return chromium.launch({ headless: true, args: LAUNCH_ARGS });
}

/**
 * One editor page: fresh context (clean storage), fixed viewport and dpr 1,
 * booted desk, probe installed. Fresh context per scenario keeps documents and
 * IndexedDB state from leaking between measurements.
 */
export async function openEditor(browser, url) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  // The desk mounts after CanvasKit + fonts boot; `#boot.gone` + `__press` is
  // the same ready signal main.ts produces.
  await page.waitForFunction(
    () => Boolean(window.__press?.compositor) && document.getElementById("boot")?.classList.contains("gone"),
    null,
    { timeout: 120_000 },
  );
  await page.evaluate(installViroPerf);
  return { context, page };
}

export function stats(values) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    median: pick(0.5),
    p95: pick(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
