// Drives the transform handles with real pointer input and asserts on the
// document graph. Handles that paint but do not act are the exact failure this
// guards against.
import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".pw-browsers");

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("gone") === true, null, { timeout: 90000 });
await page.waitForTimeout(600);

const box = await page.locator("#skia").first().boundingBox();
const mk = () => page.evaluate(() => {
  const a = window.viroAnchor;
  a.apply([{ id: "r", op: "press.add_rect", params: { x: 400, y: 400, w: 1000, h: 800, fill: { r: .88, g: .48, b: .18, a: 1 }, name: "Box" }, reason: "resize test" }]);
  const app = window.__press;
  app.setTool("move");
  const d = app.doc, pg = d.pages.find(p => p.id === d.activePageId);
  const l = pg.layers[pg.layers.length - 1];
  app.selectLayer(l.id);
  return { id: l.id, t: { ...l.transform } };
});
const tOf = (id) => page.evaluate((lid) => {
  const d = window.__press.doc, pg = d.pages.find(p => p.id === d.activePageId);
  const l = pg.layers.find(x => x.id === lid);
  return { x: Math.round(l.transform.x), y: Math.round(l.transform.y), w: Math.round(l.transform.w), h: Math.round(l.transform.h), rot: Math.round(l.transform.rotation) };
}, id);
// page point -> css point on canvas
const toScreen = (x, y) => page.evaluate(([px, py]) => {
  const s = window.__press.compositor.pageToScreen(px, py);
  return [s.x, s.y];
}, [x, y]);

const out = { errors, cases: [] };
const drag = async (fromCss, toCss, shift) => {
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(box.x + fromCss[0], box.y + fromCss[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (fromCss[0] + toCss[0]) / 2, box.y + (fromCss[1] + toCss[1]) / 2, { steps: 6 });
  await page.mouse.move(box.x + toCss[0], box.y + toCss[1], { steps: 6 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(250);
};

// 1. SE corner drag must grow the box, anchored at its top-left.
let m = await mk();
let se = await toScreen(m.t.x + m.t.w, m.t.y + m.t.h);
let before = await tOf(m.id);
await drag(se, [se[0] + 120, se[1] + 90]);
let after = await tOf(m.id);
out.cases.push({ label: "SE handle grows box, NW anchored", before, after,
  ok: after.w > before.w + 50 && after.h > before.h + 50 && after.x === before.x && after.y === before.y });

// 2. Cursor must advertise the handle before you press.
const cur = await page.evaluate(async ([sx, sy]) => {
  const c = document.querySelector("#skia"); const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + sx, clientY: r.top + sy, bubbles: true }));
  return c.style.cursor;
}, se);
out.cursorOverHandle = cur;

// 3. W handle must move the left edge and hold the right edge.
m = await mk();
let w = await toScreen(m.t.x, m.t.y + m.t.h / 2);
before = await tOf(m.id);
await drag(w, [w[0] - 100, w[1]]);
after = await tOf(m.id);
out.cases.push({ label: "W handle moves left edge, right edge held", before, after,
  ok: after.x < before.x - 20 && after.w > before.w + 20 && (before.x + before.w) === (after.x + after.w) });

// 4. Shift on a corner must preserve aspect ratio.
m = await mk();
se = await toScreen(m.t.x + m.t.w, m.t.y + m.t.h);
before = await tOf(m.id);
await drag(se, [se[0] + 160, se[1] + 20], true);
after = await tOf(m.id);
const r0 = before.w / before.h, r1 = after.w / after.h;
out.cases.push({ label: "Shift+corner keeps aspect", before, after, ratio: [r0.toFixed(3), r1.toFixed(3)],
  ok: Math.abs(r0 - r1) < 0.02 && after.w > before.w });

// 5. Rotate handle must rotate.
m = await mk();
const rot = await toScreen(m.t.x - 40, m.t.y - 40);
before = await tOf(m.id);
await drag(rot, [rot[0] + 90, rot[1] + 30]);
after = await tOf(m.id);
out.cases.push({ label: "rotate handle rotates", before, after, ok: after.rot !== before.rot });

// 6. Undo must restore exactly.
m = await mk();
se = await toScreen(m.t.x + m.t.w, m.t.y + m.t.h);
before = await tOf(m.id);
await drag(se, [se[0] + 100, se[1] + 100]);
const scaled = await tOf(m.id);
await page.evaluate(() => window.__press.undo());
await page.waitForTimeout(200);
const undone = await tOf(m.id);
out.cases.push({ label: "undo restores pre-drag transform", before, scaled, undone,
  ok: undone.w === before.w && undone.h === before.h && undone.x === before.x });

console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(0);
