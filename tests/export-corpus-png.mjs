/**
 * VIRO-0015 — PNG arm of the export corpus: real compositor fingerprints.
 *
 * The compositor is Skia in the browser, so the PNG pixels can only come from
 * a real app session. This harness (pattern: tests/image-frame.spec.mjs —
 * plain node + playwright driving the vite dev server via tests/server.mjs,
 * same SwiftShader launch args as playwright.config.ts) opens each corpus
 * document in the live editor with the app's own open path (`openBytes`, the
 * exact entry the .press.json Open menu uses), then asks the REAL compositor
 * for `snapshotPagePng` and hands the bytes back to Node.
 *
 * Fingerprints (decoded-IDAT SHA-256 — see export-corpus-verify.mjs) are
 * pinned in tests/export-corpus-png.json. Regenerate deliberately with:
 *
 *   CORPUS_PIN=1 node ... tests/export-corpus.test.mjs
 *
 * and inspect the diff — a pin change means pixels changed, and must have a
 * named reason. The pinned SwiftShader software raster is deterministic
 * machine-to-machine; a red fingerprint here is a real pixel delta, not
 * hardware noise.
 *
 * FLAKE CLASS (observed once on pc-cloud1): under heavy concurrent browser
 * load chromium can die between launch and newPage ("Target page, context or
 * browser has been closed"). Same class as the timing variance
 * playwright.config.ts documents; a plain re-run of the suite is the
 * remedy, which is also why the playwright config carries retries.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureServer } from "./server.mjs";
import { pngFingerprint } from "./export-corpus-verify.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PNG_PINS_PATH = join(ROOT, "tests", "export-corpus-png.json");

/**
 * Open one serialized document in the live app and snapshot the page with the
 * real compositor. Serialized into the page like every other evaluate callback.
 */
async function snapshotInPage(page, json, expectedName) {
  const out = await page.evaluate(
    async ({ json, expectedName }) => {
      const P = window.__press;
      if (!P || !P.compositor) throw new Error("app not booted / compositor missing");
      const bytes = new TextEncoder().encode(json);
      // The same entry point the File > Open menu drives for .press.json.
      await P.openBytes(`${expectedName}.press.json`, bytes.buffer);
      if (P.doc.name !== expectedName) {
        throw new Error(`open failed: doc is "${P.doc.name}", expected "${expectedName}"`);
      }
      const png = P.compositor.snapshotPagePng(P.doc);
      let bin = "";
      for (let i = 0; i < png.length; i += 0x8000) {
        bin += String.fromCharCode(...Array.from(png.subarray(i, i + 0x8000)));
      }
      return { b64: btoa(bin) };
    },
    { json, expectedName },
  );
  return Buffer.from(out.b64, "base64");
}

/**
 * Snapshot every corpus document. `docs` is [{ id, name, doc }]. Returns
 * Map<id, fingerprint { width, height, sha256 }>. When CORPUS_PIN=1 the map
 * is also written to tests/export-corpus-png.json.
 */
export async function pagePngFingerprints(docs) {
  const server = await ensureServer();
  const require_ = createRequire(import.meta.url);
  const { chromium } = require_("playwright");
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");
  const browser = await chromium.launch({
    proxy: { server: "direct://" },
    args: [
      "--no-proxy-server",
      "--proxy-bypass-list=*",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const pageErrors = [];
  const fingerprints = new Map();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(m.text());
    });
    await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document.getElementById("boot")?.classList.contains("gone") === true &&
        Boolean(window.__press?.compositor),
      null,
      { timeout: 90_000 },
    );

    for (const { id, name, doc } of docs) {
      const png = await snapshotInPage(page, JSON.stringify(doc), name);
      fingerprints.set(id, pngFingerprint(png));
    }
  } finally {
    await browser.close();
    server.stop();
  }
  if (pageErrors.length) {
    throw new Error(`page errors during PNG capture: ${pageErrors.join(" | ")}`);
  }

  if (process.env.CORPUS_PIN === "1") {
    const pinned = {};
    for (const [id, fp] of fingerprints) pinned[id] = { width: fp.width, height: fp.height, sha256: fp.sha256 };
    writeFileSync(PNG_PINS_PATH, `${JSON.stringify(pinned, null, 2)}\n`);
  }
  return fingerprints;
}

/** The checked-in pins, or null when the pin file has not been generated yet. */
export function loadPngPins() {
  try {
    return JSON.parse(readFileSync(PNG_PINS_PATH, "utf8"));
  } catch {
    return null;
  }
}
