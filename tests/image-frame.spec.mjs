/**
 * Acceptance test for image-frame clipping and fit semantics (slice 2).
 *
 * The setup is deliberately hostile: a 100x200 (1:2) asset in a 1200x600 (2:1)
 * frame. `cover` scales it x12 to 1200x2400, so 900px hangs off the top and
 * another 900px off the bottom. Before the fix nothing clipped that to the
 * frame and it painted across the page.
 *
 *   node tests/image-frame.spec.mjs
 */
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureServer } from "./server.mjs";
import { exportPdf } from "./pdf-download.mjs";

const require_ = createRequire("file:///C:/viro%20studio/package.json");
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "C:/viro studio/.pw-browsers";

const OUT = join("C:/viro studio", "tests", "qa-shots", "image-frame");
mkdirSync(OUT, { recursive: true });

const results = [];
let failed = 0;
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
};

function pdfStreamText(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    let d = s + 6;
    if (buf[d] === 0x0d) d++;
    if (buf[d] === 0x0a) d++;
    const e = buf.indexOf("endstream", d);
    if (e < 0) break;
    const chunk = buf.subarray(d, e);
    try {
      out.push(inflateSync(chunk).toString("latin1"));
    } catch {
      out.push(chunk.toString("latin1"));
    }
    i = e + 9;
  }
  return out.join("\n");
}

// Frame geometry, in page px on the default A4 300ppi page.
const FRAME = { x: 600, y: 1200, w: 1200, h: 600 };

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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("gone") === true, null, {
  timeout: 60_000,
});

await page.evaluate(() => {
  window.__probe = async (dataUrl, pts) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = dataUrl;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return pts.map(([fx, fy]) => {
      const x = Math.min(Math.round(fx * img.width), img.width - 1);
      const y = Math.min(Math.round(fy * img.height), img.height - 1);
      const d = g.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });
  };
  // The asset is pure magenta; nothing else on the page is.
  window.__isMagenta = ([r, g, b]) => r > 170 && g < 90 && b > 170;
});

// ------------------------------------------------------------- place asset

const placed = await page.evaluate(async (FRAME) => {
  // 100x200 magenta asset - deliberately the inverse aspect of the frame.
  const c = document.createElement("canvas");
  c.width = 100;
  c.height = 200;
  const g = c.getContext("2d");
  g.fillStyle = "#ff00ff";
  g.fillRect(0, 0, 100, 200);
  // A stripe near the TOP, not the centre. At focal 0.5 with cover it is
  // clipped away, so the centre probe reads pure magenta; at focal 0 it slides
  // into view, which is what makes the focal assertions meaningful.
  g.fillStyle = "#ffffff";
  g.fillRect(0, 10, 100, 20);
  const dataUrl = c.toDataURL("image/png");

  const a = window.viroAnchor;
  const P = window.__press;
  a.apply([{ op: "press.place_image", params: { dataUrl, name: "probe.png", x: FRAME.x, y: FRAME.y, width: 100, height: 200 }, reason: "asset under test" }]);
  const layer = P.doc.pages[0].layers.find((l) => l.kind === "image-frame");
  a.apply([
    {
      op: "press.set_transform",
      params: { layerId: layer.id, x: FRAME.x, y: FRAME.y, w: FRAME.w, h: FRAME.h },
      reason: "force a 2:1 frame around a 1:2 asset",
    },
  ]);
  const pg = P.doc.pages[0];
  return { layerId: layer.id, pageW: pg.widthPx, pageH: pg.heightPx, assetKeys: Object.keys(P.doc.assets).length };
}, FRAME);

check("image placed into a mismatched-aspect frame", Boolean(placed.layerId), `asset(s)=${placed.assetKeys}`);

// Page-space probe points -> thumbnail fractions.
const fx = (px) => px / placed.pageW;
const fy = (py) => py / placed.pageH;
const PTS = {
  aboveFrame: [fx(FRAME.x + FRAME.w / 2), fy(FRAME.y - 500)], // inside cover's unclipped rect, OUTSIDE the frame
  belowFrame: [fx(FRAME.x + FRAME.w / 2), fy(FRAME.y + FRAME.h + 500)],
  frameCentre: [fx(FRAME.x + FRAME.w / 2), fy(FRAME.y + FRAME.h / 2)],
  frameLeftEdge: [fx(FRAME.x + 30), fy(FRAME.y + FRAME.h / 2)], // pillarbox zone for contain
};

async function sample(fit, focal) {
  return page.evaluate(
    async ({ layerId, fit, focal, PTS }) => {
      const a = window.viroAnchor;
      const P = window.__press;
      const ops = [{ op: "press.set_image_fit", params: { layerId, fit }, reason: "fit under test" }];
      if (focal) ops.push({ op: "press.set_image_focal", params: { layerId, x: focal.x, y: focal.y }, reason: "focal under test" });
      a.apply(ops);
      const pg = P.doc.pages[0];
      const url = P.compositor.pageThumb(P.doc, pg.id, 512);
      const keys = Object.keys(PTS);
      const px = await window.__probe(url, keys.map((k) => PTS[k]));
      const out = { url, magenta: {} };
      keys.forEach((k, i) => (out.magenta[k] = window.__isMagenta(px[i])));
      out.frame = { ...pg.layers.find((l) => l.id === layerId).transform };
      return out;
    },
    { layerId: placed.layerId, fit, focal, PTS },
  );
}

// ------------------------------------------------------------- cover

const cover = await sample("cover");
writeFileSync(join(OUT, "10-cover.png"), Buffer.from(cover.url.split(",")[1], "base64"));
check("COVER paints inside the frame", cover.magenta.frameCentre === true);
check(
  "THE FIX: COVER content does NOT escape above the frame",
  cover.magenta.aboveFrame === false,
  "content rect is 1200x2400 in a 1200x600 frame; 900px would spill",
);
check("THE FIX: COVER content does NOT escape below the frame", cover.magenta.belowFrame === false);
check("COVER fills the frame edge to edge", cover.magenta.frameLeftEdge === true);

// ------------------------------------------------------------- contain

const contain = await sample("contain");
writeFileSync(join(OUT, "20-contain.png"), Buffer.from(contain.url.split(",")[1], "base64"));
check("CONTAIN paints inside the frame", contain.magenta.frameCentre === true);
check("CONTAIN does not escape the frame", contain.magenta.aboveFrame === false && contain.magenta.belowFrame === false);
check(
  "CONTAIN letterboxes - the frame edge is empty where COVER filled it",
  contain.magenta.frameLeftEdge === false,
  "1:2 asset in a 2:1 frame must pillarbox",
);

// ------------------------------------------------------------- stretch

const stretch = await sample("stretch");
writeFileSync(join(OUT, "30-stretch.png"), Buffer.from(stretch.url.split(",")[1], "base64"));
check("STRETCH fills the frame exactly, edge included", stretch.magenta.frameCentre === true && stretch.magenta.frameLeftEdge === true);
check("STRETCH does not escape the frame", stretch.magenta.aboveFrame === false && stretch.magenta.belowFrame === false);

check(
  "the three fits are visually distinct (no duplicate mode)",
  cover.url !== contain.url && contain.url !== stretch.url && cover.url !== stretch.url,
);

// ------------------------------------------------------------- focal

const focalA = await sample("cover", { x: 0.5, y: 0 });
const focalB = await sample("cover", { x: 0.5, y: 1 });
writeFileSync(join(OUT, "40-focal-top.png"), Buffer.from(focalA.url.split(",")[1], "base64"));
check("FOCAL moves the content", focalA.url !== focalB.url);
check(
  "FOCAL leaves the frame untouched",
  JSON.stringify(focalA.frame) === JSON.stringify(focalB.frame) &&
    focalA.frame.w === FRAME.w &&
    focalA.frame.h === FRAME.h,
  `frame stayed ${focalA.frame.w}x${focalA.frame.h}`,
);
check(
  "FOCAL never lets content escape the frame",
  focalA.magenta.aboveFrame === false && focalB.magenta.belowFrame === false,
);

// ------------------------------------------------------------- PDF parity

await sample("cover", { x: 0.5, y: 0.5 });
const dl = await exportPdf(page, pageErrors);
const pdfPath = join(OUT, "cover.pdf");
await dl.saveAs(pdfPath);
const text = pdfStreamText(readFileSync(pdfPath));

// The clip must be the frame (0 0 1200 600), not the oversized content rect.
const clips = [...text.matchAll(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re\s*\n?\s*W\s*n/g)].map((m) =>
  m.slice(1).map(Number),
);
const frameClip = clips.find((c) => Math.abs(c[2] - FRAME.w) < 2 && Math.abs(c[3] - FRAME.h) < 2);
check(
  "PDF PARITY: the image is clipped to the FRAME, not to the oversized content rect",
  Boolean(frameClip),
  frameClip ? `re = ${frameClip.join(" ")}` : `clips seen: ${JSON.stringify(clips)}`,
);
check(
  "PDF does not clip to the 2400px-tall content rect",
  !clips.some((c) => Math.abs(c[3] - 2400) < 2),
);

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log("shots ->", OUT);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
