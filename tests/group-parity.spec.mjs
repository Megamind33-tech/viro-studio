/**
 * Slice-1 exit gates beyond the canvas: PDF parity, save/reopen round-trip and
 * v1 fixture migration.
 *
 * PDF parity matters because the exporter is a SECOND renderer. If it does not
 * compose group transforms the same way the canvas does, grouped artwork
 * exports in the wrong place while the screen looks right.
 *
 *   node tests/group-parity.spec.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureServer } from "./server.mjs";
import { exportPdf } from "./pdf-download.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);
const { chromium } = require_("playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(ROOT, ".pw-browsers");

const OUT = join(ROOT, "tests", "qa-shots", "group");
mkdirSync(OUT, { recursive: true });

const results = [];
let failed = 0;
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
};

/** Inflate every FlateDecode stream in a PDF and return the concatenated text. */
function pdfStreamText(buf) {
  const out = [];
  let i = 0;
  while (true) {
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
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("boot")?.classList.contains("gone") === true, null, {
  timeout: 60_000,
});

// A new document is stamped with the current DOC_VERSION, so read it from the
// app rather than hard-coding a number that goes stale on every migration.
const CURRENT_VERSION = await page.evaluate(() => window.__press.doc.version);

// ------------------------------------------------- build a grouped document

const GROUP_X = 1300;
const GROUP_Y = 1700;

const built = await page.evaluate(
  ({ GROUP_X, GROUP_Y }) => {
    const a = window.viroAnchor;
    const P = window.__press;
    a.apply([
      { op: "press.add_rect", params: { x: 100, y: 100, w: 500, h: 300, fill: "#E01B1B" }, reason: "child A" },
      { op: "press.add_rect", params: { x: 700, y: 100, w: 200, h: 300, fill: "#1B5BE0" }, reason: "child B" },
    ]);
    const ids = P.doc.pages[0].layers.filter((l) => l.kind === "vector").map((l) => l.id);
    a.apply([
      { op: "press.select", params: { layerIds: ids }, reason: "select for grouping" },
      { op: "press.group", params: { layerIds: ids }, reason: "group them" },
    ]);
    const g = P.doc.pages[0].layers.find((l) => l.kind === "group");
    a.apply([
      {
        op: "press.set_transform",
        params: { layerId: g.id, x: GROUP_X, y: GROUP_Y },
        reason: "move the group somewhere unmistakable",
      },
    ]);
    const pg = P.doc.pages[0];
    return {
      groupId: g.id,
      groupT: { ...pg.layers.find((l) => l.id === g.id).transform },
      children: pg.layers.filter((l) => l.parentId === g.id).map((l) => ({ id: l.id, t: { ...l.transform } })),
      pageH: pg.heightPx,
    };
  },
  { GROUP_X, GROUP_Y },
);

check("group positioned for the parity test", built.groupT.x === GROUP_X && built.groupT.y === GROUP_Y);

// ------------------------------------------------- PDF parity

const dl = await exportPdf(page, pageErrors);
const pdfPath = join(OUT, "group-parity.pdf");
await dl.saveAs(pdfPath);
const pdfBuf = require_("node:fs").readFileSync(pdfPath);
const text = pdfStreamText(pdfBuf);

check("PDF is a valid file", pdfBuf.subarray(0, 5).toString("latin1") === "%PDF-", `${pdfBuf.length} bytes`);

// The group's translation must appear as a concatenated matrix (cm) operator.
const cmOps = [...text.matchAll(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm/g)].map(
  (m) => m.slice(1).map(Number),
);
check("PDF content stream contains cm matrices", cmOps.length > 0, `${cmOps.length} found`);

// Page space is y-down; PDF is y-up, so the exporter flips. Accept either sense
// for the y translate, but the x translate must be the group's.
const groupMatrix = cmOps.find(
  (m) =>
    Math.abs(m[4] - GROUP_X) < 2 &&
    (Math.abs(m[5] - GROUP_Y) < 2 || Math.abs(m[5] - (built.pageH - GROUP_Y)) < 2 || Math.abs(Math.abs(m[5]) - GROUP_Y) < 2),
);
check(
  "PDF PARITY: the group's own transform is emitted as a matrix",
  Boolean(groupMatrix),
  groupMatrix ? `cm = ${groupMatrix.join(" ")}` : `no cm matched x=${GROUP_X}; saw ${JSON.stringify(cmOps.slice(0, 6))}`,
);

// ------------------------------------------------- save / reopen round-trip

const roundTrip = await page.evaluate(async () => {
  const P = window.__press;
  const before = JSON.parse(JSON.stringify(P.doc));
  const bytes = new TextEncoder().encode(JSON.stringify(before));
  await P.openBytes("roundtrip.json", bytes);
  const after = P.doc;
  const norm = (d) =>
    d.pages[0].layers.map((l) => ({ id: l.id, parentId: l.parentId, t: l.transform }));
  return {
    version: after.version,
    same: JSON.stringify(norm(before)) === JSON.stringify(norm(after)),
    beforeN: norm(before),
    afterN: norm(after),
  };
});

check(
  `save/reopen keeps the document at v${CURRENT_VERSION}`,
  roundTrip.version === CURRENT_VERSION,
  `version=${roundTrip.version}`,
);
check(
  "save/reopen preserves every transform exactly (no double-rebase)",
  roundTrip.same,
  roundTrip.same ? "" : `${JSON.stringify(roundTrip.beforeN)} -> ${JSON.stringify(roundTrip.afterN)}`,
);

// ------------------------------------------------- v1 fixture migration

const v1 = await page.evaluate(async () => {
  const P = window.__press;
  // A genuine v1 document: children hold ABSOLUTE coordinates and the group is
  // an inert bounding box, which is what pre-v2 files on disk look like.
  const doc = JSON.parse(JSON.stringify(P.doc));
  doc.version = 1;
  const pg = doc.pages[0];
  const g = pg.layers.find((l) => l.kind === "group");
  g.transform = { x: 400, y: 500, w: 800, h: 300, rotation: 0 };
  const kids = pg.layers.filter((l) => l.parentId === g.id);
  // absolute positions as v1 would have stored them
  kids[0].transform = { ...kids[0].transform, x: 400, y: 500 };
  if (kids[1]) kids[1].transform = { ...kids[1].transform, x: 1000, y: 500 };
  const expected = kids.map((k) => ({ id: k.id, x: k.transform.x, y: k.transform.y }));

  await P.openBytes("legacy-v1.json", new TextEncoder().encode(JSON.stringify(doc)));

  const after = P.doc.pages[0];
  const ga = after.layers.find((l) => l.kind === "group");
  const world = after.layers
    .filter((l) => l.parentId === ga.id)
    .map((l) => ({ id: l.id, x: l.transform.x + ga.transform.x, y: l.transform.y + ga.transform.y }));
  return { version: P.doc.version, expected, world, status: P.status };
});

check(
  `v1 fixture is migrated to v${CURRENT_VERSION} on open`,
  v1.version === CURRENT_VERSION,
  `version=${v1.version}`,
);
check(
  "MIGRATION INVARIANT in the live app: v1 absolute positions become identical world positions",
  JSON.stringify(v1.expected) === JSON.stringify(v1.world),
  `expected ${JSON.stringify(v1.expected)} got ${JSON.stringify(v1.world)}`,
);
check("migration is reported to the user, not silent", /migrated v1/.test(v1.status || ""), v1.status);

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
