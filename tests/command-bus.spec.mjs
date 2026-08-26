/**
 * Command bus in the running application (foundation slice 3).
 *
 * The unit tests prove the bus in isolation. This proves the app actually goes
 * through it: a real pointer drag on the real canvas must produce ONE history
 * entry whose undo returns to where the drag started, and it must interleave
 * correctly with the legacy commit() path that has not migrated yet.
 *
 *   node tests/command-bus.spec.mjs
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

const stats = () => page.evaluate(() => window.__press.bus.stats());

// ── 1. a legacy commit() edit lands as a snapshot entry ──────────────────────

const built = await page.evaluate(() =>
  window.viroAnchor.applyDetailed([
    {
      op: "press.add_rect",
      params: { x: 400, y: 400, w: 800, h: 500, fill: "#E07A2F" },
      reason: "subject for the drag test",
    },
  ]),
);
const afterAnchor = await stats();
// Slice 4 moved Anchor onto the bus, so an AI batch is now a COMMAND entry.
// Before that it went through commit() and cost a whole-document clone.
check(
  "an AI batch records ONE command entry, not a snapshot",
  afterAnchor.entries === 1 && afterAnchor.commandEntries === 1 && afterAnchor.snapshotEntries === 0,
  JSON.stringify(afterAnchor),
);

const layerId = built[0].created[0];

// A panel edit. This used to clone the whole document; it is now a typed
// command, which is the point of the slice.
await page.evaluate(({ layerId }) => {
  const P = window.__press;
  P.doc.activeLayerIds = [layerId];
  P.setOpacity(0.5);
}, { layerId });
const afterPanel = await stats();
check(
  "a panel edit records a COMMAND entry, not a document clone",
  afterPanel.entries === 2 && afterPanel.commandEntries === 2 && afterPanel.snapshotEntries === 0,
  JSON.stringify(afterPanel),
);

// `commit()` remains the honest representation for replacing the whole document
// (New, Open). Drive it directly so the mixed-stack check below still has a real
// snapshot entry to interleave with.
await page.evaluate(() => {
  const P = window.__press;
  const next = JSON.parse(JSON.stringify(P.doc));
  next.pages[0].layers[0].name = "Renamed by the snapshot path";
  P.commit("Legacy edit", next);
});
const afterLegacy = await stats();
check(
  "the snapshot path still records a SNAPSHOT entry",
  afterLegacy.entries === 3 && afterLegacy.snapshotEntries === 1,
  JSON.stringify(afterLegacy),
);

// ── 2. a real pointer drag is ONE command entry ──────────────────────────────

const start = await page.evaluate(
  ({ layerId }) => {
    const P = window.__press;
    P.doc.activeLayerIds = [layerId];
    const t = P.doc.pages[0].layers.find((l) => l.id === layerId).transform;
    // Aim at the middle of the layer, in CSS pixels on the canvas.
    const s = P.compositor.pageToScreen(t.x + t.w / 2, t.y + t.h / 2);
    const r = document.getElementById("skia").getBoundingClientRect();
    return { sx: r.left + s.x, sy: r.top + s.y, x0: t.x, y0: t.y };
  },
  { layerId },
);

const beforeDrag = await stats();
await page.locator("[data-tool=move]").click();
await page.mouse.move(start.sx, start.sy);
await page.mouse.down();
// Many small steps: the whole point is that these must not become many entries.
const STEPS = 40;
for (let i = 1; i <= STEPS; i++) {
  await page.mouse.move(start.sx + i * 3, start.sy + i * 2);
}
await page.mouse.up();
await page.waitForTimeout(300);

const afterDrag = await stats();
const moved = await page.evaluate(
  ({ layerId }) => ({ ...window.__press.doc.pages[0].layers.find((l) => l.id === layerId).transform }),
  { layerId },
);

// Relative, so this stays true as more call sites migrate: the drag must add
// exactly ONE entry however many preceded it.
check(
  `a ${STEPS}-step pointer drag adds exactly ONE history entry, not ${STEPS}`,
  afterDrag.entries === beforeDrag.entries + 1 && afterDrag.commandEntries === beforeDrag.commandEntries + 1,
  `${JSON.stringify(beforeDrag)} -> ${JSON.stringify(afterDrag)}`,
);
check(
  "the drag actually moved the layer",
  Math.abs(moved.x - start.x0) > 20 || Math.abs(moved.y - start.y0) > 20,
  `(${start.x0}, ${start.y0}) -> (${moved.x}, ${moved.y})`,
);
check("the drag reported a dirty region", await page.evaluate(() => window.__press.bus.lastDirty !== null));

// lastDirty is PER OPERATION, not accumulated across a coalesced gesture. A
// repaint after one pointer-move only needs that step's delta; accumulating 40
// steps would repaint far more than necessary. The whole-drag span belongs to
// undo, which really does jump from the end back to the start — asserted below.
const dirty = await page.evaluate(() => window.__press.bus.lastDirty);
check(
  "one drag step reports a dirty region covering that step's new bounds",
  dirty && dirty.x <= moved.x + 1 && dirty.x + dirty.w >= moved.x + 799,
  JSON.stringify(dirty),
);

// ── 3. undo returns to the START of the drag, in one press ───────────────────

await page.evaluate(() => window.__press.undo());
const afterUndo = await page.evaluate(
  ({ layerId }) => ({
    t: { ...window.__press.doc.pages[0].layers.find((l) => l.id === layerId).transform },
    stats: window.__press.bus.stats(),
  }),
  { layerId },
);
check(
  "ONE undo returns the layer to where the drag started",
  Math.abs(afterUndo.t.x - start.x0) < 0.001 && Math.abs(afterUndo.t.y - start.y0) < 0.001,
  `back to (${afterUndo.t.x}, ${afterUndo.t.y}), expected (${start.x0}, ${start.y0})`,
);

// Undo DOES span the whole gesture, because it is a single jump from the end of
// the drag back to its start.
const undoDirty = await page.evaluate(() => window.__press.bus.lastDirty);
check(
  "the undo's dirty region spans the WHOLE drag, start to finish",
  undoDirty &&
    undoDirty.x <= Math.min(start.x0, moved.x) + 1 &&
    undoDirty.x + undoDirty.w >= Math.max(start.x0, moved.x) + 799,
  JSON.stringify(undoDirty),
);

// ── 4. redo re-applies it ────────────────────────────────────────────────────

await page.evaluate(() => window.__press.redo());
const afterRedo = await page.evaluate(
  ({ layerId }) => ({ ...window.__press.doc.pages[0].layers.find((l) => l.id === layerId).transform }),
  { layerId },
);
check(
  "redo re-applies the whole drag",
  Math.abs(afterRedo.x - moved.x) < 0.001 && Math.abs(afterRedo.y - moved.y) < 0.001,
);

// ── 5. mixed stack unwinds in the right order ────────────────────────────────

// Unwind the WHOLE stack rather than a fixed count, so this stays honest as
// more call sites migrate and the entry count changes. The stack interleaves
// command entries (AI batch, panel edit, drag) with a snapshot entry, and every
// one of them must reverse in order.
const unwoundSteps = await page.evaluate(() => {
  const P = window.__press;
  let n = 0;
  while (P.bus.canUndo && n < 50) {
    P.undo();
    n++;
  }
  return n;
});
check("the stack unwound every entry", unwoundSteps >= 4, `${unwoundSteps} undos`);
const unwound = await page.evaluate(() => ({
  layers: window.__press.doc.pages[0].layers.length,
  stats: window.__press.bus.stats(),
}));
check(
  "MIXED STACK: command, snapshot and command entries unwind in the right order",
  unwound.layers === 0,
  `layers=${unwound.layers}, ${JSON.stringify(unwound.stats)}`,
);

// ── 6. a rejected command surfaces its reason and changes nothing ────────────

const rejected = await page.evaluate(() => {
  const P = window.__press;
  const before = JSON.stringify(P.doc);
  const ok = P.run({ type: "layer.transform", params: { layerId: "ly_nope", patch: { x: 1 } } });
  return { ok, unchanged: JSON.stringify(P.doc) === before, status: P.status };
});
check("a rejected command returns false and leaves the document untouched", rejected.ok === false && rejected.unchanged);
check("the rejection reason is surfaced verbatim, not swallowed", /no layer "ly_nope"/.test(rejected.status), rejected.status);

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
