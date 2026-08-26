// Drives the new shape tools through real pointer input and reports what the
// document graph actually contains afterwards. A tool that does not produce a
// correctly-shaped layer is reported failed, never silently passed.
import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".pw-browsers");

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("gone") === true, null, { timeout: 60000 });
await page.waitForTimeout(600);

const box = await page.locator("#skia, canvas").first().boundingBox();
const drag = async (from, to, shift = false) => {
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 12 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(200);
};
const layers = () => page.evaluate(() => {
  const d = window.viroAnchor.document();
  const page = d.pages.find((p) => p.id === d.activePageId) ?? d.pages[0];
  return page.layers.map((l) => ({
    name: l.name, kind: l.kind, closed: l.closed, nodes: l.nodes?.length,
    w: Math.round(l.transform.w), h: Math.round(l.transform.h),
    stroke: l.stroke ? Math.round(l.stroke.width) : null, fill: !!l.fill,
    // The transform box is clamped to a 4px minimum, so a perfectly horizontal
    // line still reports h=4. The nodes carry the true geometry.
    nodeYs: l.nodes?.map((n) => Math.round(n.y)),
  }));
});

const out = { errors, cases: [], errorTrail: [] };
const mark = (w) => out.errorTrail.push(w + ":" + errors.length);
mark("after-boot");
const record = async (label, expect) => {
  const all = await layers();
  const made = all[all.length - 1];
  out.cases.push({ label, made, ok: expect(made) });
};

// Mid-drag preview must exist while the button is down.
await page.click('[data-tool="ellipse"]');
await page.mouse.move(box.x + 500, box.y + 300);
await page.mouse.down();
await page.mouse.move(box.x + 700, box.y + 450, { steps: 8 });
const preview = await page.evaluate(() => {
  const c = window.__press?.compositor ?? null;
  return c ? JSON.parse(JSON.stringify(c.view.shapePreview)) : "no-handle";
});
await page.mouse.up();
await page.waitForTimeout(200);
out.previewDuringDrag = preview;
mark("after-ellipse-drag");
await record("ellipse drag", (l) => l?.kind === "vector" && l.closed === true && l.nodes === 4 && l.w > 100);

await page.click('[data-tool="line"]');
await drag([500, 600], [800, 600]);
mark("after-line-drag");
await record("line drag", (l) => l?.kind === "vector" && l.closed === false && l.nodes === 2 && l.stroke > 0 && !l.fill);

await page.click('[data-tool="ellipse"]');
await drag([500, 700], [700, 760], true);
await record("ellipse + shift = circle", (l) => l?.kind === "vector" && l.w === l.h);

await page.click('[data-tool="line"]');
await drag([900, 300], [1100, 320], true);
await record("line + shift = 45deg snap", (l) => l?.kind === "vector" && l.nodeYs?.[0] === l.nodeYs?.[1]);

// A click with no drag must not drop an artefact layer.
const before = (await layers()).length;
await page.click('[data-tool="rect"]');
await page.mouse.click(box.x + 600, box.y + 900);
await page.waitForTimeout(200);
mark("after-shift-cases");
out.strayClickAddedLayer = (await layers()).length - before;

// Shift+U must cycle the shape group.
await page.mouse.click(box.x + 200, box.y + 200);
const cycle = [];
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("Shift+U");
  await page.waitForTimeout(100);
  cycle.push(await page.evaluate(() => window.__press?.compositor?.view.tool ?? "?"));
}
mark("after-stray-and-cycle");
out.shiftUCycle = cycle;
out.toolbox = await page.$$eval("#toolbox [data-tool]", (b) => b.map((x) => x.dataset.tool));
out.separators = await page.$$eval("#toolbox .tool-sep, #toolbox .tool-gap", (n) => n.length);



console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(0);
