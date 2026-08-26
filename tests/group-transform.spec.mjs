/**
 * Acceptance test for the v2 hierarchical group transform (foundation slice 1).
 *
 * The central proof: move/rotate a GROUP, confirm each child's own LOCAL
 * transform is byte-for-byte unchanged, and confirm the RENDERED PIXELS moved
 * anyway. Before v2 that was impossible -- drawTree never composed the group's
 * transform, so the record changed and the canvas did not.
 *
 *   node tests/group-transform.spec.mjs
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

const OUT = join(ROOT, "tests", "qa-shots", "group");
mkdirSync(OUT, { recursive: true });
const URL = process.env.VIRO_URL || "http://127.0.0.1:5173";

const results = [];
let failed = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${detail ? " -- " + detail : ""}`);
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

// Pixel probing runs in the page: decode a thumbnail data URL onto an offscreen
// canvas and read it back. Keeps the assertions on real rendered output without
// pulling a PNG decoder into node.
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
      const x = Math.round(fx * (img.width - 1));
      const y = Math.round(fy * (img.height - 1));
      const d = g.getImageData(x, y, 1, 1).data;
      return { fx, fy, rgba: [d[0], d[1], d[2], d[3]] };
    });
  };
  window.__isRed = (p) => p.rgba[0] > 180 && p.rgba[1] < 90 && p.rgba[2] < 90;
});

const THUMB = 256;

async function snapshot(tag) {
  return page.evaluate(
    async ({ tag, THUMB }) => {
      const P = window.__press;
      const pg = P.doc.pages[0];
      const url = P.compositor.pageThumb(P.doc, pg.id, THUMB);
      // Quarter points: the rect starts top-left and is moved to centre-right.
      const pts = [
        [0.12, 0.08], // where the rect starts
        [0.62, 0.45], // where it lands after the group move
      ];
      const probes = url ? await window.__probe(url, pts) : [];
      // A coarse grid of "is there red here" cells. Any real change to the
      // rendered geometry changes this string, so rotate/scale can be asserted
      // objectively rather than by eye.
      const grid = [];
      for (let gy = 0; gy < 16; gy++) {
        for (let gx = 0; gx < 12; gx++) grid.push([(gx + 0.5) / 12, (gy + 0.5) / 16]);
      }
      const gridProbes = url ? await window.__probe(url, grid) : [];
      const signature = gridProbes.map((p) => (window.__isRed(p) ? "1" : "0")).join("");
      return {
        tag,
        url,
        probes,
        signature,
        red: probes.map((p) => window.__isRed(p)),
        layers: pg.layers.map((l) => ({
          id: l.id,
          kind: l.kind,
          parentId: l.parentId,
          t: { ...l.transform },
        })),
      };
    },
    { tag, THUMB },
  );
}

function save(snap) {
  if (snap.url) {
    writeFileSync(join(OUT, `${snap.tag}.png`), Buffer.from(snap.url.split(",")[1], "base64"));
  }
}

// ---------------------------------------------------------------- build

const built = await page.evaluate(() => {
  const a = window.viroAnchor;
  const P = window.__press;
  a.apply([
    {
      op: "press.add_rect",
      params: { x: 200, y: 200, w: 600, h: 400, fill: "#E01B1B" },
      reason: "child A - the pixel witness for group transforms",
    },
    {
      op: "press.add_rect",
      params: { x: 900, y: 200, w: 300, h: 400, fill: "#1B5BE0" },
      reason: "child B - proves the whole group moves, not one layer",
    },
  ]);
  const pg = P.doc.pages[0];
  const ids = pg.layers.filter((l) => l.kind === "vector").map((l) => l.id);
  a.apply([{ op: "press.select", params: { layerIds: ids }, reason: "select both children to group them" }]);
  a.apply([{ op: "press.group", params: { layerIds: ids }, reason: "group them - the subject of this test" }]);
  const g = P.doc.pages[0].layers.find((l) => l.kind === "group");
  return {
    groupId: g?.id,
    groupT: { ...g.transform },
    children: P.doc.pages[0].layers
      .filter((l) => l.parentId === g.id)
      .map((l) => ({ id: l.id, t: { ...l.transform } })),
  };
});

check("group created with two children", built.children.length === 2, `groupId=${built.groupId}`);
// The group's transform is the children's bounding box, so after rebasing the
// leftmost/topmost child must sit at local 0,0 and the others at their offset
// from it. (Children were authored at x=200 and x=900 -> local 0 and 700.)
const localXs = built.children.map((c) => c.t.x);
const localYs = built.children.map((c) => c.t.y);
check(
  "groupSelected rebased children into LOCAL space",
  Math.min(...localXs) === 0 && Math.min(...localYs) === 0,
  `local xs = [${localXs.join(", ")}], ys = [${localYs.join(", ")}], group at (${built.groupT.x}, ${built.groupT.y})`,
);

const base = await snapshot("10-baseline");
save(base);
check("baseline renders the red child at its start position", base.red[0] === true);
check("baseline has nothing at the destination", base.red[1] === false);

const childLocalsBefore = JSON.stringify(
  base.layers.filter((l) => l.parentId === built.groupId).map((l) => l.t),
);

// ---------------------------------------------------------------- move

await page.evaluate(
  ({ groupId }) =>
    window.viroAnchor.apply([
      {
        op: "press.set_transform",
        params: { layerId: groupId, x: 1150, y: 1450 },
        reason: "move the group - children must follow without being rewritten",
      },
    ]),
  { groupId: built.groupId },
);

const moved = await snapshot("20-group-moved");
save(moved);

const childLocalsAfter = JSON.stringify(
  moved.layers.filter((l) => l.parentId === built.groupId).map((l) => l.t),
);

check("THE FIX: moving the group moved the rendered pixels", moved.red[1] === true);
check("THE FIX: the old position is now empty", moved.red[0] === false);
check(
  "children's own transforms were NOT rewritten (true hierarchy, not a fan-out)",
  childLocalsBefore === childLocalsAfter,
  childLocalsBefore === childLocalsAfter ? "identical" : `${childLocalsBefore} -> ${childLocalsAfter}`,
);

// ---------------------------------------------------------------- undo

await page.evaluate(() => window.__press.undo());
const undone = await snapshot("30-undone");
save(undone);
check("undo restores the original render", undone.red[0] === true && undone.red[1] === false);
check(
  "undo restores the exact group transform",
  Math.abs(undone.layers.find((l) => l.id === built.groupId).t.x - built.groupT.x) < 0.001,
);

// ------------------------------------------------------- rotate and scale

const localsOf = (snap) =>
  JSON.stringify(snap.layers.filter((l) => l.parentId === built.groupId).map((l) => l.t));

await page.evaluate(
  ({ groupId }) =>
    window.viroAnchor.apply([
      {
        op: "press.set_transform",
        params: { layerId: groupId, rotation: 90 },
        reason: "rotate the group - children must sweep with it",
      },
    ]),
  { groupId: built.groupId },
);
const rotated = await snapshot("40-group-rotated");
save(rotated);
check("ROTATE: the rendered geometry changed", rotated.signature !== base.signature);
check("ROTATE: children's own transforms were NOT rewritten", localsOf(rotated) === childLocalsBefore);

await page.evaluate(
  ({ groupId }) =>
    window.viroAnchor.apply([
      {
        op: "press.set_transform",
        params: { layerId: groupId, rotation: 0, scaleX: 2, scaleY: 2 },
        reason: "scale the group - a group resizes by scale, it has no geometry of its own",
      },
    ]),
  { groupId: built.groupId },
);
const scaled = await snapshot("50-group-scaled");
save(scaled);
check("SCALE: the rendered geometry changed", scaled.signature !== base.signature);
check(
  "SCALE: the group covers more of the page than at 1x",
  scaled.signature.split("1").length > base.signature.split("1").length,
  `${base.signature.split("1").length - 1} red cells -> ${scaled.signature.split("1").length - 1}`,
);
check("SCALE: children's own transforms were NOT rewritten", localsOf(scaled) === childLocalsBefore);

await page.evaluate(() => {
  window.__press.undo();
  window.__press.undo();
});
const restored = await snapshot("60-restored");
save(restored);
check("undo through rotate and scale restores the exact original render", restored.signature === base.signature);

// ---------------------------------------------------------------- nested

const nested = await page.evaluate(
  async ({ groupId, THUMB }) => {
    const a = window.viroAnchor;
    const P = window.__press;
    a.apply([
      {
        op: "press.add_rect",
        params: { x: 200, y: 2600, w: 300, h: 300, fill: "#12A150" },
        reason: "sibling for the outer group",
      },
    ]);
    const pg = P.doc.pages[0];
    const sibling = pg.layers.find((l) => l.kind === "vector" && !l.parentId);
    a.apply([
      { op: "press.select", params: { layerIds: [groupId, sibling.id] }, reason: "select group + sibling" },
      {
        op: "press.group",
        params: { layerIds: [groupId, sibling.id] },
        reason: "nest the existing group inside an outer group",
      },
    ]);
    const outer = P.doc.pages[0].layers.find((l) => l.kind === "group" && !l.parentId);
    const innerBefore = { ...P.doc.pages[0].layers.find((l) => l.id === groupId).transform };
    a.apply([
      {
        op: "press.set_transform",
        params: { layerId: outer.id, x: outer.transform.x + 500, y: outer.transform.y + 700 },
        reason: "move the OUTER group - inner group and its children must all follow",
      },
    ]);
    const innerAfter = { ...P.doc.pages[0].layers.find((l) => l.id === groupId).transform };
    const url = P.compositor.pageThumb(P.doc, P.doc.pages[0].id, THUMB);
    return {
      outerId: outer.id,
      depth: P.doc.pages[0].layers.filter((l) => l.parentId === outer.id).length,
      innerUnchanged: JSON.stringify(innerBefore) === JSON.stringify(innerAfter),
      url,
    };
  },
  { groupId: built.groupId, THUMB },
);
if (nested.url) writeFileSync(join(OUT, "40-nested-outer-moved.png"), Buffer.from(nested.url.split(",")[1], "base64"));

check("nested group built (group inside group)", nested.depth === 2, `outer has ${nested.depth} children`);
check(
  "NESTED: moving the outer group left the inner group's local transform untouched",
  nested.innerUnchanged,
);

// ---------------------------------------------------------------- hit-testing

const hit = await page.evaluate(() => {
  const P = window.__press;
  const pg = P.doc.pages[0];
  const red = pg.layers.find((l) => l.kind === "vector" && l.fill && l.fill.r > 0.7 && l.fill.g < 0.3);
  // Walk the chain by hand to get the child's true world origin.
  let x = red.transform.x;
  let y = red.transform.y;
  let cur = red;
  const byId = new Map(pg.layers.map((l) => [l.id, l]));
  while (cur.parentId) {
    const p = byId.get(cur.parentId);
    if (!p) break;
    x += p.transform.x;
    y += p.transform.y;
    cur = p;
  }
  const inside = window.__pressHit
    ? null
    : { x: x + red.transform.w / 2, y: y + red.transform.h / 2 };
  return { redId: red.id, worldOrigin: { x, y }, probe: inside, localX: red.transform.x, localY: red.transform.y };
});

const hitResult = await page.evaluate(
  ({ probe, redId }) => {
    const P = window.__press;
    // hitTest is not on window; drive the real selection path through the app.
    const before = [...P.doc.activeLayerIds];
    P.selectAt ? P.selectAt(probe.x, probe.y) : null;
    return { supported: typeof P.selectAt === "function", before, after: [...P.doc.activeLayerIds], redId };
  },
  { probe: hit.probe, redId: hit.redId },
);

check(
  "child's local coords differ from its world coords (it really is nested)",
  Math.abs(hit.localX - hit.worldOrigin.x) > 1 || Math.abs(hit.localY - hit.worldOrigin.y) > 1,
  `local (${hit.localX}, ${hit.localY}) vs world (${hit.worldOrigin.x}, ${hit.worldOrigin.y})`,
);

// ---------------------------------------------------------------- summary

console.log("\npage errors:", pageErrors.length ? pageErrors : "none");
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log("shots ->", OUT);
if (!hitResult.supported) {
  console.log("note: PressApp exposes no direct selectAt(); hit-testing is covered by tests/hit-test.spec.mjs");
}
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
