/**
 * Acceptance test for RFC-6: multi-select transform & smart guides.
 *
 * Drives the REAL drag path through synthesised pointer events on the canvas —
 * not the anchor API — so it proves the pointerdown/move/up state machine, the
 * command-bus coalescing, and the overlay-drawn smart guides end to end:
 *
 *   1. Select two top-level layers, drag the union frame's body -> BOTH layers
 *      translate by the same delta (a group move, not a single-layer move).
 *   2. ONE undo restores BOTH layers to their exact start transforms.
 *   3. Dragging a corner handle scales BOTH layers together about the anchor.
 *   4. Moving a selection until an edge aligns with another layer lights a
 *      smart guide (compositor.view.smartGuides), which clears on release.
 *
 *   node tests/multi-transform.spec.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureServer } from "./server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");

const OUT = join(ROOT, "tests", "qa-shots", "multi-transform");
mkdirSync(OUT, { recursive: true });
const URL = process.env.VIRO_URL || "http://127.0.0.1:5173";

const results = [];
let failed = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
}
const near = (a, b, eps = 1.5) => Math.abs(a - b) <= eps;

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

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("gone") === true, null, {
  timeout: 60_000,
});

const canvas = await page.$("#skia");
async function shot(tag) {
  await canvas.screenshot({ path: join(OUT, `${tag}.png`) });
}

// Page-space point -> viewport client coordinates, via the live view transform.
async function toClient(px, py) {
  return page.evaluate(
    ({ px, py }) => {
      const P = window.__press;
      const s = P.compositor.pageToScreen(px, py);
      const r = P.compositor.canvas.getBoundingClientRect();
      return { x: r.left + s.x, y: r.top + s.y };
    },
    { px, py },
  );
}

// A real pointer drag from one page point to another, in `steps` moves. `alt`
// suspends smart-guide snapping for the gesture. `hold` runs mid-drag (before
// pointerup) so a test can inspect the live overlay state.
async function drag(from, to, { alt = false, steps = 6, hold = null } = {}) {
  const a = await toClient(from.x, from.y);
  const b = await toClient(to.x, to.y);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  let held = null;
  if (hold) held = await hold();
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
  return held;
}

const state = () =>
  page.evaluate(() => {
    const P = window.__press;
    const pg = P.doc.pages[0];
    return {
      pageW: pg.widthPx,
      pageH: pg.heightPx,
      layers: pg.layers
        .filter((l) => l.kind === "vector")
        .map((l) => ({ id: l.id, t: { ...l.transform } })),
      selected: [...P.doc.activeLayerIds],
    };
  });

// ---------------------------------------------------------------- build A, B, C

const built = await page.evaluate(() => {
  const a = window.viroAnchor;
  const P = window.__press;
  a.apply([
    { op: "press.add_rect", params: { x: 200, y: 200, w: 200, h: 150, fill: "#E01B1B" }, reason: "layer A — group-move witness" },
    { op: "press.add_rect", params: { x: 500, y: 200, w: 200, h: 150, fill: "#1B5BE0" }, reason: "layer B — proves both move together" },
    { op: "press.add_rect", params: { x: 463, y: 600, w: 150, h: 150, fill: "#12A150" }, reason: "layer C — the smart-guide alignment target" },
  ]);
  const pg = P.doc.pages[0];
  const [A, B, C] = pg.layers.filter((l) => l.kind === "vector");
  // Select A and B only; C is the alignment target and stays unselected.
  a.apply([{ op: "press.select", params: { layerIds: [A.id, B.id] }, reason: "select A+B" }]);
  return { aId: A.id, bId: B.id, cId: C.id };
});

await shot("00-built");
const s0 = await state();
const A0 = s0.layers.find((l) => l.id === built.aId).t;
const B0 = s0.layers.find((l) => l.id === built.bId).t;
check("two layers selected for a group gesture", s0.selected.length === 2, `selected=${s0.selected.length}`);
// Union frame of A(200,200,200,150) + B(500,200,200,150) = x200 y200 w500 h150.
const union0 = { x: 200, y: 200, w: 500, h: 150 };
const centre0 = { x: union0.x + union0.w / 2, y: union0.y + union0.h / 2 };

// ---------------------------------------------------------------- 1. group move

// Drag the frame body by (+150, +100) page px, Alt held so snapping does not
// nudge the delta — we are asserting BOTH move by the SAME amount.
await drag(centre0, { x: centre0.x + 150, y: centre0.y + 100 }, { alt: true });
await shot("10-group-moved");

const s1 = await state();
const A1 = s1.layers.find((l) => l.id === built.aId).t;
const B1 = s1.layers.find((l) => l.id === built.bId).t;
const adx = A1.x - A0.x;
const ady = A1.y - A0.y;
const bdx = B1.x - B0.x;
const bdy = B1.y - B0.y;
check("group move translated layer A", near(adx, 150) && near(ady, 100), `A moved by (${adx.toFixed(1)}, ${ady.toFixed(1)})`);
check("group move translated layer B by the SAME delta", near(bdx, adx) && near(bdy, ady), `B moved by (${bdx.toFixed(1)}, ${bdy.toFixed(1)})`);

// ---------------------------------------------------------------- 2. one undo

await page.evaluate(() => window.__press.undo());
await shot("20-undone");
const s2 = await state();
const A2 = s2.layers.find((l) => l.id === built.aId).t;
const B2 = s2.layers.find((l) => l.id === built.bId).t;
check(
  "a SINGLE undo restored BOTH layers to their start transforms",
  near(A2.x, A0.x, 0.001) && near(A2.y, A0.y, 0.001) && near(B2.x, B0.x, 0.001) && near(B2.y, B0.y, 0.001),
  `A=(${A2.x},${A2.y}) B=(${B2.x},${B2.y})`,
);

// ---------------------------------------------------------------- 3. group scale

// Re-select A+B (undo left selection intact, but be explicit) then drag the SE
// corner of the union frame outward. Both layers must grow and the NW anchor
// (union top-left at 200,200) must stay put.
await page.evaluate(
  ({ aId, bId }) => window.viroAnchor.apply([{ op: "press.select", params: { layerIds: [aId, bId] }, reason: "re-select A+B" }]),
  built,
);
const seCorner = { x: union0.x + union0.w, y: union0.y + union0.h }; // (700, 350)
await drag(seCorner, { x: union0.x + union0.w * 2, y: union0.y + union0.h * 2 }, { alt: true });
await shot("30-group-scaled");
const s3 = await state();
const A3 = s3.layers.find((l) => l.id === built.aId).t;
const B3 = s3.layers.find((l) => l.id === built.bId).t;
check("group scale grew layer A", A3.w > A0.w + 1 && A3.h > A0.h + 1, `A ${A0.w}x${A0.h} -> ${A3.w.toFixed(0)}x${A3.h.toFixed(0)}`);
check("group scale grew layer B", B3.w > B0.w + 1 && B3.h > B0.h + 1, `B ${B0.w}x${B0.h} -> ${B3.w.toFixed(0)}x${B3.h.toFixed(0)}`);
check("NW anchor held: A's top-left stayed at the union origin", near(A3.x, 200) && near(A3.y, 200), `A at (${A3.x.toFixed(1)}, ${A3.y.toFixed(1)})`);

// restore for the guide test
await page.evaluate(() => window.__press.undo());
await page.evaluate(
  ({ aId, bId }) => window.viroAnchor.apply([{ op: "press.select", params: { layerIds: [aId, bId] }, reason: "re-select A+B" }]),
  built,
);

// ---------------------------------------------------------------- 4. smart guide

// Drag the union right so its LEFT edge lands ~on C's left edge (463). Snap is
// ON (no Alt). Capture the live overlay state mid-drag, before pointerup.
const guide = await drag(
  centre0,
  { x: centre0.x + 265, y: centre0.y }, // union.left 200 -> ~465, within snap tol of C.left=463
  {
    hold: async () => {
      const sg = await page.evaluate(() => {
        const s = window.__press.compositor.view.smartGuides;
        if (!s) return { present: false };
        return { present: true, xn: s.xn, yn: s.yn, xs: Array.from(s.xs).slice(0, s.xn) };
      });
      // Capture the overlay WHILE the guide is live (it clears on release).
      await shot("40-smart-guide");
      return sg;
    },
  },
);

check("a smart guide is shown mid-drag", guide?.present === true && guide.xn >= 1, JSON.stringify(guide));
check(
  "the guide lands on C's left edge (an alignment), snapping the selection to it",
  !!guide?.xs?.some((x) => near(x, 463, 1)),
  `guide xs = ${JSON.stringify(guide?.xs)}`,
);
const afterUp = await page.evaluate(() => window.__press.compositor.view.smartGuides);
check("smart guides clear on pointer release", afterUp === null);
const sG = await state();
const Ag = sG.layers.find((l) => l.id === built.aId).t;
check("snapping put A's left edge exactly on C's left edge (463)", near(Ag.x, 463, 0.5), `A.x=${Ag.x}`);

// ---------------------------------------------------------------- summary

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log("shots ->", OUT);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
