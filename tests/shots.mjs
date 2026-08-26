// VIRO Press — visual QA capture harness.
// Boots the desk in Chromium with SwiftShader (real WebGL for Skia, headless),
// drives a genuine click-through, and writes PNGs for critic review.
// Every scene records whether it actually happened: a scene that could not be
// driven is reported as failed, never silently skipped, and a failed scene or a
// console error exits non-zero.
import { chromium } from "playwright";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREATE_OPS,
  EXPECTED_LAYER_NAMES,
  ZONES,
  assemblyOps,
} from "./cover-composition.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".pw-browsers");

const OUT = join(root, "tests", "qa-shots");
const URL = process.env.VIRO_URL || "http://127.0.0.1:5173";
mkdirSync(OUT, { recursive: true });

// Shots are staged outside the project and copied in at the end. Writing PNGs
// straight into tests/qa-shots trips the dev server's file watcher, which
// full-reloads the page mid-run and wipes the document the later scenes are
// asserting against — an intermittent failure that looks like a rendering bug.
const STAGE = mkdtempSync(join(tmpdir(), "viro-shots-"));

const browser = await chromium.launch({
  proxy: { server: "direct://" },
  args: [
    "--no-proxy-server",
    "--proxy-bypass-list=*",
    "--host-resolver-rules=MAP localhost 127.0.0.1",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("gone") === true,
  null,
  { timeout: 60_000 },
);
await page.waitForTimeout(500);

// Anything that reloads the page after boot (a dev-server HMR full reload,
// say) throws away the composed document. Record it rather than let the run
// report a mysteriously empty page.
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) {
    errors.push("page reloaded after boot — the composed document was discarded");
  }
});

const status = await page.evaluate(() => document.getElementById("bootStatus")?.textContent ?? "");
const scenes = [];

/**
 * Capture one scene. `fn` may return a detail object, which is recorded next to
 * the pass/fail so the run says what the scene proved, not just that it drew.
 * `clip` narrows the shot to a selector (used for the page and the Layers panel).
 */
async function scene(name, fn, { clip } = {}) {
  try {
    const detail = fn ? await fn() : undefined;
    await page.waitForTimeout(300);
    const target = clip ? page.locator(clip).first() : null;
    if (target) await target.screenshot({ path: join(STAGE, `${name}.png`) });
    else await page.screenshot({ path: join(STAGE, `${name}.png`) });
    scenes.push(detail ? { name, ok: true, detail } : { name, ok: true });
  } catch (err) {
    scenes.push({ name, ok: false, error: String(err).split("\n")[0] });
  }
}

const openMenu = async (menu, cmd) => {
  await page.click(`[data-menu="${menu}"]`);
  await page.waitForTimeout(120);
  if (cmd) {
    await page.click(`[data-flyout="${menu}"] [data-cmd="${cmd}"]`);
    await page.waitForTimeout(200);
  }
};

await scene("10-desk");

await scene("20-new-dialog", async () => {
  await openMenu("file", "new");
});
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(150);

/**
 * Real content, composed through the Anchor op API rather than by clicking the
 * tools at pixel offsets. This is the harness dogfooding the product's headline
 * capability: a batch of `{ id, op, params, reason }` envelopes goes in, real
 * editable layers come out. The two batches are joined by the audit trail —
 * applyDetailed() reports the ids each op created, and the second batch groups
 * and names them.
 *
 * The scene asserts the composition actually landed (every op produced its
 * layer, every zone became a named group) and throws if it did not, so a silent
 * regression in the op layer shows up as a failed scene rather than a blank page.
 */
const applyBatch = (ops) =>
  page.evaluate((batch) => {
    const results = window.viroAnchor.applyDetailed(batch);
    return results.map((r) => ({
      id: r.id, op: r.op, summary: r.summary, reason: r.reason, created: r.created,
    }));
  }, ops);

/** The layer tree as the Layers panel walks it, for the scene's assertions. */
const readTree = () =>
  page.evaluate(() => {
    const pg = window.viroAnchor.document().pages[0];
    const walk = (layers, depth, out) => {
      for (const l of layers) {
        out.push({ name: l.name, kind: l.kind, depth });
        const kids = pg.layers.filter((k) => k.parentId === l.id);
        if (kids.length) walk(kids, depth + 1, out);
      }
      return out;
    };
    return { tree: walk(pg.layers.filter((l) => !l.parentId), 0, []), guides: pg.guides.length };
  });

let composed = null;

await scene("30-content", async () => {
  const created = await applyBatch(CREATE_OPS);

  // envelope id -> the layer that op brought into existence
  const byEnvelope = new Map();
  for (const r of created) if (r.id && r.created.length) byEnvelope.set(r.id, r.created[0]);

  const assembled = await applyBatch(assemblyOps((id) => byEnvelope.get(id)));
  const { tree, guides } = await readTree();

  const names = tree.map((n) => n.name);
  const groups = tree.filter((n) => n.kind === "group").map((n) => n.name);

  const missing = EXPECTED_LAYER_NAMES.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`layers never made it into the document: ${missing.join(", ")}`);
  const missingGroups = ZONES.map((z) => z.name).filter((n) => !groups.includes(n));
  if (missingGroups.length) throw new Error(`zones never became groups: ${missingGroups.join(", ")}`);
  if (names.includes("Type")) throw new Error('a type frame kept the placeholder name "Type"');

  composed = { trail: [...created, ...assembled], tree, groups, guides };
  return { opsApplied: created.length + assembled.length, layers: tree.length, groups, guides };
});

// The composed page on its own, with the grid guides switched off, so the
// layout can be judged as a printed sheet rather than as a working file.
await scene("31-cover-page", async () => {
  await openMenu("view", "view-guides");
  // The View menu writes "✓" into [data-check] for whatever is currently on.
  const stillOn = await page.evaluate(
    () => (document.querySelector('[data-check="guides"]')?.textContent ?? "").includes("✓"),
  );
  if (stillOn) throw new Error("View → Guides did not switch the grid guides off");
  return { guidesVisible: false };
}, { clip: "#skia, canvas" });

// The evidence that the result is a document and not a picture of one: the
// Layers panel, populated with the named zones and their children.
await scene("35-layers-panel", async () => {
  await page.evaluate(() => {
    const g = document.getElementById("g-layers");
    if (g?.hidden) document.querySelector('[data-cmd="win-layers"]')?.click();
  });
  await page.waitForTimeout(150);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#layer-list .ly")].map((n) => n.querySelector(".nm")?.textContent ?? ""),
  );
  if (rows.length < 15) throw new Error(`Layers panel shows only ${rows.length} rows`);
  if (!rows.includes("Display")) throw new Error(`Layers panel is missing the named groups`);
  return { rows: rows.length, names: rows };
}, { clip: "#g-layers" });

await scene("40-image-size", async () => {
  await openMenu("image", "image-size");
});
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(150);

await scene("50-anchor", async () => {
  await openMenu("window", "win-anchor");
});

const layerCount = await page.evaluate(
  () => document.querySelectorAll("#layer-list .ly").length,
);
const zoomAgreement = await page.evaluate(() => ({
  tab: document.getElementById("doc-zoom")?.textContent,
  nav: document.getElementById("nav-zoom-lbl")?.textContent,
  status: document.getElementById("stat-zoom")?.value,
}));

const colorHonesty = await page.evaluate(() => ({
  status: document.getElementById("stat-color")?.textContent,
  documentSpace: window.__press?.doc.color.workingSpace,
  newDocumentLabel: document.getElementById("nd-cs")?.textContent?.trim(),
  offersCmyk: Boolean(document.querySelector('#nd-cs option[value="cmyk"]')),
  offersUnusedIntent: Boolean(document.getElementById("nd-intent")),
}));
if (
  colorHonesty.status !== "RGB/8" ||
  colorHonesty.documentSpace !== "rgb" ||
  colorHonesty.newDocumentLabel !== "RGB Color · 8 bit" ||
  colorHonesty.offersCmyk ||
  colorHonesty.offersUnusedIntent
) {
  errors.push(`colour capability is overstated: ${JSON.stringify(colorHonesty)}`);
}

const opsUsed = composed
  ? [...new Set(composed.trail.map((t) => t.op))].sort()
  : [];

await browser.close();

// Now that nothing is watching the page, land the shots in the reviewed folder.
for (const file of readdirSync(STAGE)) copyFileSync(join(STAGE, file), join(OUT, file));
rmSync(STAGE, { recursive: true, force: true });

console.log(JSON.stringify({ status, errors, layerCount, zoomAgreement, colorHonesty, opsUsed, scenes }, null, 2));

const failed = scenes.filter((s) => !s.ok);
if (failed.length || errors.length) {
  console.error(
    `FAIL — ${failed.length} scene(s) did not happen, ${errors.length} console error(s).`,
  );
  process.exit(1);
}
