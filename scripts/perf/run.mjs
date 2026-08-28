#!/usr/bin/env node
/**
 * VIRO-0012 frame-time harness.
 *
 * Boots the real editor (vite web build + Playwright Chromium/SwiftShader —
 * the same canvas path the CI suite exercises) and measures:
 *
 *   1. idle composite cost — rAF-aligned `Compositor.draw()` ms on a fixed
 *      document (starter, 30 plain layers, 30 drop-shadowed layers). Fixed
 *      work per sample, so runs compare cleanly across commits.
 *   2. live gesture frame times — real Playwright pointer/wheel input through
 *      the app's own gesture handlers (move, resize, pan, zoom), recording
 *      rAF deltas and per-frame draw cost inside the gesture window.
 *
 * Usage:
 *   node scripts/perf/run.mjs --label baseline
 *   node scripts/perf/run.mjs --label after-fix --only idle/shadow30,g/shadow30
 *   node scripts/perf/run.mjs --help
 *
 * Output: a JSON file under scripts/perf/results/ and a markdown table on
 * stdout. Numbers are wall-clock on the measuring machine; comparisons are
 * only valid within the same machine and browser build.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePerfServer } from "./lib/server.mjs";
import { launchBrowser, openEditor, stats, VIEWPORT } from "./lib/session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { label: "run", idle: 15, steps: 24, zoomSteps: 12, only: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/perf/run.mjs --label <name> [--idle N] [--steps S] [--zoomSteps Z] [--only scen1,scen2] [--out file.json]",
      );
      process.exit(0);
    } else if (a === "--label") opts.label = argv[++i];
    else if (a === "--idle") opts.idle = Number(argv[++i]);
    else if (a === "--steps") opts.steps = Number(argv[++i]);
    else if (a === "--zoomSteps") opts.zoomSteps = Number(argv[++i]);
    else if (a === "--only") opts.only = String(argv[++i]).split(",").map((s) => s.trim());
    else if (a === "--out") opts.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build (or skip to) a scenario document, then run one idle-composite measurement. */
async function idleScenario(page, name, docKind, idleN) {
  if (docKind) {
    await page.evaluate((k) => window.__viroPerf.buildDoc(k), docKind);
  } else {
    await page.evaluate(() => window.__viroPerf.app().compositor.fitToView(window.__press.doc));
  }
  const samples = await page.evaluate(async (n) => window.__viroPerf.idleDraws(n), idleN);
  return {
    name,
    kind: "idle-draw",
    doc: docKind ?? "starter",
    drawMs: stats(samples),
    samples,
    backend: await page.evaluate(() => window.__viroPerf.backend()),
  };
}
/**
 * Live gesture: real pointer/wheel input through the app's handlers, with the
 * probe recording rAF deltas and every draw inside the gesture window.
 */
async function gestureScenario(page, name, docKind, gesture, steps, zoomSteps) {
  let center;
  let corner = null;
  if (docKind) {
    const info = await page.evaluate((k) => window.__viroPerf.buildDoc(k), docKind);
    const layerId = info.layerIds[0];
    // Layer 0 sits top-left in the grid; its centre is on the fitted page.
    center = await page.evaluate((id) => window.__viroPerf.layerCenterClient(id), layerId);
    corner = await page.evaluate((id) => window.__viroPerf.layerCornerClient(id), layerId);
  } else {
    // Starter document: nothing to pick, gestures run on the empty page.
    await page.evaluate(() => window.__viroPerf.app().compositor.fitToView(window.__press.doc));
    center = await page.evaluate(() => window.__viroPerf.canvasCenterClient());
  }

  const t0 = await page.evaluate(() => {
    const p = window.__viroPerf;
    p.reset();
    p.startFrames();
    return p.now();
  });

  if (gesture === "move") {
    await drag(page, center, offset(center, 140, 90), steps);
  } else if (gesture === "resize") {
    // Handles exist only on a live selection, so select the layer with one
    // click (a zero-delta move commit through the real path) before grabbing
    // its south-east handle.
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(100);
    await drag(page, corner, offset(corner, 120, 90), steps);
  } else if (gesture === "pan") {
    await page.evaluate(() => window.__viroPerf.setTool("hand"));
    const a = await page.evaluate(() => window.__viroPerf.canvasCenterClient());
    await drag(page, a, offset(a, -160, 120), steps);
    await page.evaluate(() => window.__viroPerf.setTool("move"));
  } else if (gesture === "zoom") {
    const c = await page.evaluate(() => window.__viroPerf.canvasCenterClient());
    await page.mouse.move(c.x, c.y);
    for (let i = 0; i < zoomSteps; i++) {
      await page.mouse.wheel(0, -120);
      await sleep(30);
    }
  } else {
    throw new Error(`unknown gesture: ${gesture}`);
  }

  // Let the coalesced rAF repaint land so the window closes on a painted frame.
  await page.evaluate(async () => {
    await window.__viroPerf.nextFrame();
    await window.__viroPerf.nextFrame();
  });
  const t1 = await page.evaluate(() => {
    window.__viroPerf.stopFrames();
    return window.__viroPerf.now();
  });
  const drawMs = await page.evaluate((t) => window.__viroPerf.drawsSince(t), t0);
  const frames = await page.evaluate(() => window.__viroPerf.frameDeltas());

  return {
    name,
    kind: `gesture/${gesture}`,
    doc: docKind,
    gestureInput: { steps, zoomSteps },
    windowMs: t1 - t0,
    drawMs: stats(drawMs),
    frameMs: stats(frames),
    samplesDraw: drawMs,
    samplesFrame: frames,
    backend: await page.evaluate(() => window.__viroPerf.backend()),
  };
}

function offset(p, dx, dy) {
  return { x: p.x + dx, y: p.y + dy };
}

async function drag(page, from, to, steps) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: join(HERE, "..", ".."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function fmt(s) {
  if (!s || !s.n) return "n/a";
  return `median ${s.median.toFixed(1)} · mean ${s.mean.toFixed(1)} · p95 ${s.p95.toFixed(1)} · max ${s.max.toFixed(1)} (n=${s.n})`;
}

async function main() {
  const opts = parseArgs(process.argv);
  const { url, stop } = await ensurePerfServer();
  const browser = await launchBrowser();
  const results = [];

  // Scenario table: idle composite cost + live gestures per document.
  // Shadow-document draws are catastrophically slow at baseline (that IS the
  // finding), so the shadow scenarios take fewer samples/gesture steps — the
  // same reduced settings are used before and after any fix, so comparisons
  // stay apples-to-apples.
  const idlePlan = [
    { name: "idle/starter", doc: null, n: 15 },
    { name: "idle/plain30", doc: "plain30", n: 15 },
    { name: "idle/shadow30", doc: "shadow30", n: 3 },
  ];
  const gesturePlan = [
    { name: "g/starter/pan", doc: null, g: "pan", steps: 24, zoomSteps: 12 },
    { name: "g/starter/zoom", doc: null, g: "zoom", steps: 24, zoomSteps: 12 },
    { name: "g/plain30/move", doc: "plain30", g: "move", steps: 24, zoomSteps: 12 },
    { name: "g/plain30/resize", doc: "plain30", g: "resize", steps: 24, zoomSteps: 12 },
    { name: "g/plain30/pan", doc: "plain30", g: "pan", steps: 24, zoomSteps: 12 },
    { name: "g/plain30/zoom", doc: "plain30", g: "zoom", steps: 24, zoomSteps: 12 },
    { name: "g/shadow30/move", doc: "shadow30", g: "move", steps: 4, zoomSteps: 3 },
    { name: "g/shadow30/resize", doc: "shadow30", g: "resize", steps: 4, zoomSteps: 3 },
    { name: "g/shadow30/pan", doc: "shadow30", g: "pan", steps: 4, zoomSteps: 3 },
    { name: "g/shadow30/zoom", doc: "shadow30", g: "zoom", steps: 4, zoomSteps: 3 },
  ];

  try {
    for (const s of idlePlan) {
      if (opts.only && !opts.only.includes(s.name)) continue;
      const { context, page } = await openEditor(browser, url);
      process.stdout.write(`run ${s.name} … `);
      const r = await idleScenario(page, s.name, s.doc, s.n);
      results.push(r);
      console.log(`drawMs ${fmt(r.drawMs)}`);
      await context.close();
    }
    for (const s of gesturePlan) {
      if (opts.only && !opts.only.includes(s.name)) continue;
      const { context, page } = await openEditor(browser, url);
      process.stdout.write(`run ${s.name} … `);
      const r = await gestureScenario(page, s.name, s.doc, s.g, s.steps, s.zoomSteps);
      results.push(r);
      console.log(`frameMs ${fmt(r.frameMs)} | drawMs ${fmt(r.drawMs)}`);
      await context.close();
    }
  } finally {
    await browser.close();
    stop();
  }

  const meta = {
    label: opts.label,
    at: new Date().toISOString(),
    url,
    gitSha: gitSha(),
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    idleSamples: opts.idle,
    backend: results.find((r) => r.backend)?.backend ?? "unknown",
  };

  const outPath = opts.out ?? join(HERE, "results", `${opts.label}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ meta, results }, null, 2));

  console.log(`\n# ${opts.label} — ${meta.gitSha.slice(0, 12)} (${meta.at})\n`);
  console.log("| scenario | doc | drawMs (median/mean/p95) | frameMs (median/mean/p95) |");
  console.log("|---|---|---|---|");
  for (const r of results) {
    const d = r.drawMs?.n ? `${r.drawMs.median.toFixed(1)} / ${r.drawMs.mean.toFixed(1)} / ${r.drawMs.p95.toFixed(1)}` : "n/a";
    const f = r.frameMs?.n ? `${r.frameMs.median.toFixed(1)} / ${r.frameMs.mean.toFixed(1)} / ${r.frameMs.p95.toFixed(1)}` : "n/a";
    console.log(`| ${r.name} | ${r.doc} | ${d} | ${f} |`);
  }
  console.log(`\nwrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
