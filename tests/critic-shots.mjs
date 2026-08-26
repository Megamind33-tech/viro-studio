// VIRO Press — critic evidence harness.
// shots.mjs proves the app *works*. This proves it looks *premium*: it opens the
// chrome that only exists in interaction (menus, dropdown popups, hover states)
// and cuts tight 2x crops of the regions where 11px finish lives or dies.
// A region it could not capture is reported failed, never silently skipped.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".pw-browsers");

const OUT = join(root, "tests", "critic-shots");
const URL = process.env.VIRO_URL || "http://127.0.0.1:5173";
mkdirSync(OUT, { recursive: true });

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
await page.waitForTimeout(600);

const shots = [];

/** Full-viewport scene. */
async function scene(name, fn) {
  try {
    if (fn) await fn();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    shots.push({ name, ok: true });
  } catch (err) {
    shots.push({ name, ok: false, error: String(err).split("\n")[0] });
  }
}

/**
 * Tight crop around a selector, padded, so the critic can judge hairlines and
 * 11px type instead of a downscaled full frame.
 */
async function crop(name, selector, pad = 8, fn) {
  try {
    if (fn) await fn();
    await page.waitForTimeout(250);
    const el = page.locator(selector).first();
    const b = await el.boundingBox();
    if (!b) throw new Error(`no box for ${selector}`);
    const clip = {
      x: Math.max(0, b.x - pad),
      y: Math.max(0, b.y - pad),
      width: Math.min(1600 - Math.max(0, b.x - pad), b.width + pad * 2),
      height: Math.min(1000 - Math.max(0, b.y - pad), b.height + pad * 2),
    };
    if (clip.width < 2 || clip.height < 2) throw new Error(`degenerate clip for ${selector}`);
    await page.screenshot({ path: join(OUT, `${name}.png`), clip });
    shots.push({ name, ok: true, of: selector });
  } catch (err) {
    shots.push({ name, ok: false, of: selector, error: String(err).split("\n")[0] });
  }
}

const closeAll = async () => {
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(800, 520).catch(() => {});
  await page.waitForTimeout(120);
};

// ---- Resting chrome, cropped tight -----------------------------------------
await crop("c10-menubar", "#menubar", 4);
await crop("c11-optionsbar", "#optionsbar", 4);
await crop("c12-toolbox", "#toolbox", 6);
await crop("c13-statusbar", "#statusbar", 4);
await crop("c14-color-panel", "#g-color", 6);
await crop("c15-layers-panel", "#g-layers", 6);
await crop("c16-navigator", "#g-nav", 6);

// ---- Chrome that only exists while open ------------------------------------
await scene("c20-menu-open", async () => {
  await page.click('[data-menu="file"]');
});
await crop("c21-menu-flyout", '[data-flyout="file"]', 10);
await closeAll();

// A styled dropdown popup is the single clearest premium/native tell.
await scene("c30-select-open", async () => {
  const facade = page.locator('.combo-btn, .combo, [data-combo]').first();
  if (await facade.count() > 0 && await facade.isVisible()) {
    await facade.click();
  } else {
    // No facade built yet — record the native control as-is for the critic.
    await page.locator("#opt-fit").first().click({ force: true });
  }
});
await closeAll();

// ---- Selection + real content, where copper and handles are judged ---------
await scene("c40-content", async () => {
  const b = await page.locator("#skia, canvas").first().boundingBox();
  const cx = b.x + b.width * 0.32;
  const cy = b.y + b.height * 0.42;
  await page.click('[data-tool="rect"]');
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 70, cy + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.click('[data-tool="type"]');
  await page.mouse.click(cx - 55, cy + 90);
  await page.waitForTimeout(150);
  await page.click('[data-tool="move"]');
  await page.mouse.click(cx, cy);
});
await crop("c41-selection", "#skia, canvas", 0);
await crop("c42-layers-filled", "#g-layers", 6);
await crop("c43-color-filled", "#g-color", 6);

// ---- Ruler corner and page edge, at true 2x --------------------------------
try {
  await page.screenshot({
    path: join(OUT, "c50-ruler-corner.png"),
    clip: { x: 30, y: 92, width: 420, height: 300 },
  });
  shots.push({ name: "c50-ruler-corner", ok: true });
} catch (err) {
  shots.push({ name: "c50-ruler-corner", ok: false, error: String(err).split(String.fromCharCode(10))[0] });
}

console.log(JSON.stringify({ errors, shots }, null, 2));
await browser.close();
