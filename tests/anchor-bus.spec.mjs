/**
 * Anchor through the command bus, in the running application (slice 4).
 *
 * The unit tests prove the mechanism. This proves the app uses it: an AI batch
 * must land as a COMMAND entry (not a whole-document snapshot), carry its audit
 * trail, be previewable without side effects, and undo in one press.
 *
 *   node tests/anchor-bus.spec.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureServer } from "./server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");

const results = [];
let failed = 0;
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
};

const server = await ensureServer();
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("gone") === true, null, {
  timeout: 60_000,
});

const OPS = [
  { op: "press.add_rect", params: { x: 200, y: 200, w: 1600, h: 500, fill: "#E07A2F" }, reason: "masthead band across the top" },
  { op: "press.add_type_frame", params: { x: 260, y: 300, w: 1400, h: 320, text: "PREVIEWABLE", size: 180 }, reason: "wordmark over the band" },
];

// ── preview ──────────────────────────────────────────────────────────────────

const preview = await page.evaluate((OPS) => {
  const P = window.__press;
  const before = JSON.stringify(P.doc);
  const entriesBefore = P.bus.stats().entries;
  const notes = window.viroAnchor.preview(OPS);
  return {
    notes,
    unchanged: JSON.stringify(P.doc) === before,
    historyUntouched: P.bus.stats().entries === entriesBefore,
    layers: P.doc.pages[0].layers.length,
  };
}, OPS);

check("preview returns one audit line per op", preview.notes.length === 2, JSON.stringify(preview.notes.map((n) => n.summary)));
check("preview does NOT change the document", preview.unchanged && preview.layers === 0, `layers=${preview.layers}`);
check("preview does NOT touch history", preview.historyUntouched);
check(
  "preview reports what it WOULD create",
  preview.notes.every((n) => n.created.length === 1),
  JSON.stringify(preview.notes.map((n) => n.created)),
);
check(
  "preview carries each op's reason — the audit trail",
  preview.notes.map((n) => n.reason).join("|") === "masthead band across the top|wordmark over the band",
  preview.notes.map((n) => n.reason).join(" | "),
);

// ── apply ────────────────────────────────────────────────────────────────────

const applied = await page.evaluate((OPS) => {
  const P = window.__press;
  const results = window.viroAnchor.applyDetailed(OPS);
  return { results, stats: P.bus.stats(), layers: P.doc.pages[0].layers.length, labels: P.bus.labels() };
}, OPS);

check("the batch applied", applied.layers === 2, `layers=${applied.layers}`);
check(
  "an AI batch is ONE history entry",
  applied.stats.entries === 1,
  JSON.stringify(applied.stats),
);
check(
  "THE POINT: it is a COMMAND entry, not a whole-document snapshot",
  applied.stats.commandEntries === 1 && applied.stats.snapshotEntries === 0,
  JSON.stringify(applied.stats),
);
check(
  "the audit trail survives: summaries, reasons and created ids",
  applied.results.length === 2 &&
    applied.results.every((r) => r.summary && r.reason && r.created.length === 1),
  JSON.stringify(applied.results.map((r) => ({ s: r.summary, r: r.reason, c: r.created }))),
);
check(
  "preview and apply produced the same summaries",
  JSON.stringify(preview.notes.map((n) => n.summary.replace(/ly_[a-z0-9_]+/g, "ID"))) ===
    JSON.stringify(applied.results.map((r) => r.summary.replace(/ly_[a-z0-9_]+/g, "ID"))),
);

// ── undo ─────────────────────────────────────────────────────────────────────

const undone = await page.evaluate(() => {
  const P = window.__press;
  P.undo();
  return { layers: P.doc.pages[0].layers.length, stats: P.bus.stats() };
});
check("ONE undo reverts the whole AI batch", undone.layers === 0, `layers=${undone.layers}`);

const redone = await page.evaluate(() => {
  const P = window.__press;
  P.redo();
  return { layers: P.doc.pages[0].layers.length };
});
check("redo re-applies the whole AI batch", redone.layers === 2, `layers=${redone.layers}`);

// ── AI and UI share one stack ────────────────────────────────────────────────

const mixed = await page.evaluate(() => {
  const P = window.__press;
  const id = P.doc.pages[0].layers[0].id;
  // A direct UI-style typed command on top of the AI batch.
  P.run({ type: "layer.transform", params: { layerId: id, patch: { x: 1234 } } });
  const afterUi = P.bus.stats();
  P.undo();
  const x = P.doc.pages[0].layers.find((l) => l.id === id).transform.x;
  return { afterUi, x, layers: P.doc.pages[0].layers.length };
});
check(
  "a UI command stacks on top of an AI batch in the same history",
  mixed.afterUi.entries === 2 && mixed.afterUi.commandEntries === 2 && mixed.afterUi.snapshotEntries === 0,
  JSON.stringify(mixed.afterUi),
);
check(
  "undoing the UI command leaves the AI batch intact",
  mixed.x === 200 && mixed.layers === 2,
  `x=${mixed.x}, layers=${mixed.layers}`,
);

// ── rejection ────────────────────────────────────────────────────────────────

const rejected = await page.evaluate(() => {
  const P = window.__press;
  const before = JSON.stringify(P.doc);
  const entries = P.bus.stats().entries;
  let message = "";
  try {
    window.viroAnchor.applyDetailed([
      { op: "press.set_opacity", params: { layerId: P.doc.pages[0].layers[0].id, opacity: 0.5 }, reason: "valid op" },
      { op: "press.set_opacity", params: { layerId: "ly_nope", opacity: 0.5 }, reason: "invalid target" },
    ]);
  } catch (e) {
    message = String(e.message ?? e);
  }
  return { message, unchanged: JSON.stringify(P.doc) === before, entries: P.bus.stats().entries, before: entries };
});
check(
  "a rejected AI batch is atomic — the valid op is discarded too",
  rejected.unchanged && rejected.entries === rejected.before,
  `unchanged=${rejected.unchanged}, entries ${rejected.before} -> ${rejected.entries}`,
);
check("the rejection names the problem", /ly_nope/.test(rejected.message), rejected.message.slice(0, 140));

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
