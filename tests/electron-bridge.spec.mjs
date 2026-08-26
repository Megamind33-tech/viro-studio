/**
 * The browser cannot launch Electron's native dialogs, so install the exact
 * preload contract before boot and prove that the File menu uses it. This
 * catches the previous failure mode: working IPC handlers with zero callers.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureServer } from "./server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");

let failed = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
};

const server = await ensureServer();
const browser = await chromium.launch({
  proxy: { server: "direct://" },
  args: ["--no-proxy-server", "--proxy-bypass-list=*", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

await page.addInitScript(() => {
  const source = {
    meta: { template: "Native Open" },
    canvas: { w: 640, h: 360, dpi: 72 },
    layers: [{ type: "rect", name: "Bridge rectangle", x: 10, y: 20, w: 100, h: 50, style: { fill: "#E07A2F" } }],
  };
  window.__bridgeLog = { openFilters: null, save: null };
  window.viroPress = {
    openFile: async (filters) => {
      window.__bridgeLog.openFilters = filters;
      return {
        path: "C:\\Designs\\native-open.vdj",
        bytes: new TextEncoder().encode(JSON.stringify(source)).buffer,
      };
    },
    saveFile: async (opts) => {
      const savedDoc = JSON.parse(new TextDecoder().decode(new Uint8Array(opts.bytes)));
      window.__bridgeLog.save = {
        defaultPath: opts.defaultPath,
        name: savedDoc.name,
        width: savedDoc.pages?.[0]?.widthPx,
      };
      return "C:\\Designs\\native-open.press.json";
    },
  };
});

await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("gone") === true, null, { timeout: 120_000 });

await page.evaluate(() => document.querySelector('[data-cmd="open"]')?.click());
await page.waitForFunction(() => window.__press?.doc.name === "Native Open");
const opened = await page.evaluate(() => ({
  name: window.__press.doc.name,
  width: window.__press.doc.pages[0].widthPx,
  height: window.__press.doc.pages[0].heightPx,
  layers: window.__press.doc.pages[0].layers.length,
  filters: window.__bridgeLog.openFilters,
}));
check("File > Open calls the preload bridge", Array.isArray(opened.filters) && opened.filters.length === 2, JSON.stringify(opened.filters));
check("the returned native bytes are opened", opened.name === "Native Open" && opened.width === 640 && opened.height === 360 && opened.layers === 1, JSON.stringify(opened));

await page.evaluate(() => document.querySelector('[data-cmd="save-json"]')?.click());
await page.waitForFunction(() => window.__bridgeLog.save !== null);
const saved = await page.evaluate(() => ({ ...window.__bridgeLog.save, status: window.__press.status }));
check("File > Save sends the current document through the preload bridge", saved.name === "Native Open" && saved.width === 640, JSON.stringify(saved));
check("native Save receives a useful default filename", saved.defaultPath === "Native Open.press.json", saved.defaultPath);
check("successful native Save is reported", saved.status === "Saved native-open.press.json", saved.status);
check("the bridge flow emits no page errors", pageErrors.length === 0, JSON.stringify(pageErrors));

console.log(`\n${6 - failed}/6 checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
