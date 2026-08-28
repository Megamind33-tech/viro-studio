#!/usr/bin/env node
/**
 * VIRO-0012 pixel-identity capture.
 *
 * Boots the real editor, builds the representative shadowed document
 * (`shadow30` — 30 vector rects with the desk's default drop shadow), renders
 * the page composite through the shadow path (`snapshotPagePng` →
 * `compositePage`), and records an exact SHA-256 of the raw RGBA pixels plus
 * a PNG for human inspection.
 *
 * Usage:
 *   node scripts/perf/capture.mjs --name before
 *   node scripts/perf/capture.mjs --name after
 *   node scripts/perf/capture.mjs compare before after
 *
 * `compare` exits 0 when the two captures are pixel-identical (same
 * dimensions, same RGBA sha-256) and 1 otherwise.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePerfServer } from "./lib/server.mjs";
import { launchBrowser, openEditor } from "./lib/session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, "artifacts");

function parseArgs(argv) {
  const mode = argv[2] ?? "capture";
  if (mode === "compare") {
    return { mode, a: argv[3], b: argv[4] };
  }
  let name = "capture";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i];
  }
  return { mode: "capture", name };
}

function artifactPaths(name) {
  return {
    json: join(ARTIFACTS, `shadow30-${name}.json`),
    png: join(ARTIFACTS, `shadow30-${name}.png`),
  };
}

async function capture(name) {
  const { url, stop } = await ensurePerfServer();
  const browser = await launchBrowser();
  try {
    const { context, page } = await openEditor(browser, url);
    const info = await page.evaluate(() => window.__viroPerf.buildDoc("shadow30"));
    // One warm draw so first-frame lazily-created Skia objects (checker tile,
    // fonts) cannot leak into the composite, then the exact snapshot.
    await page.evaluate(async () => {
      window.__viroPerf.app().compositor.draw(window.__press.doc);
      await window.__viroPerf.nextFrame();
    });
    const snap = await page.evaluate(() => window.__viroPerf.snapshotPage());
    await context.close();

    const { json, png } = artifactPaths(name);
    await mkdir(ARTIFACTS, { recursive: true });
    await writeFile(
      json,
      JSON.stringify(
        {
          name,
          at: new Date().toISOString(),
          doc: { kind: info.kind, layers: info.layerIds.length, pageW: info.pageW, pageH: info.pageH },
          width: snap.width,
          height: snap.height,
          rgbaBytes: snap.rgbaBytes,
          rgbaSha256: snap.rgbaSha256,
        },
        null,
        2,
      ),
    );
    await writeFile(png, Buffer.from(snap.pngBase64, "base64"));
    console.log(`captured ${name}: ${snap.width}x${snap.height} rgbaSha256=${snap.rgbaSha256}`);
    console.log(`  ${json}`);
    console.log(`  ${png}`);
    return { width: snap.width, height: snap.height, rgbaSha256: snap.rgbaSha256 };
  } finally {
    await browser.close();
    stop();
  }
}

async function compare(nameA, nameB) {
  const a = JSON.parse(await readFile(artifactPaths(nameA).json, "utf8"));
  const b = JSON.parse(await readFile(artifactPaths(nameB).json, "utf8"));
  const same =
    a.width === b.width && a.height === b.height && a.rgbaSha256 === b.rgbaSha256;
  console.log(`before (${nameA}): ${a.width}x${a.height} sha=${a.rgbaSha256}`);
  console.log(`after  (${nameB}): ${b.width}x${b.height} sha=${b.rgbaSha256}`);
  console.log(same ? "PIXEL-IDENTICAL" : "PIXELS DIFFER");
  process.exitCode = same ? 0 : 1;
}

const opts = parseArgs(process.argv);
if (opts.mode === "compare") {
  await compare(opts.a, opts.b);
} else {
  await capture(opts.name);
}
