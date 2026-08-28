import { expect, test, type Page } from "@playwright/test";
import { PDFArray, PDFDocument, decodePDFRawStream } from "pdf-lib";

/**
 * VIRO-0005 — compound boolean geometry must survive vector PDF export.
 *
 * Before the fix, `src/export/pdf.ts` emitVector() walked only the legacy
 * `layer.nodes` array. A boolean-op result carries `nodes: []` with all of its
 * geometry in `contours[]`, so every compound layer was silently absent from
 * the exported PDF: report.vectorPaths stayed 0 and no rasterFallback was
 * recorded either — the geometry simply vanished.
 *
 * These tests drive the real editor in a real browser (rects in via the anchor
 * op queue, `subtractSelected`/`booleanSelected` for the booleans, exactly the
 * pattern tests/booleans.spec.mjs established), export through the SAME
 * module and arguments src/app.ts exportPdf() uses (`await import(
 * "/src/export/pdf.ts")` with doc/face/fonts/rasterise), then hand the saved
 * bytes to Node, reload them with pdf-lib, inflate the page content stream and
 * assert the actual path operators that landed in the file:
 *
 *   1. subtract ring      → 2 `m`, both subpaths closed (`h`), even-odd `f*`
 *                           (NOT `f`), vectorPaths 1, no raster fallback.
 *   2. disjoint union     → both contours emitted (2 `m`), `f*`, vectorPaths 1,
 *                           no raster fallback.
 *   3. legacy single rect → exactly 1 `m`, 4 `c`, 1 `h`, plain nonzero `f`
 *                           (NOT `f*`) — topology identical to pre-change.
 *   4. fill+stroke ring   → `B*` (even-odd fill-and-stroke), never `B`.
 *      stroke-only ring   → `S` with no fill op, stroke RGB + width preserved.
 *
 * NOTE ON THE FILENAME: the delivery manifest named this file
 * `tests/pdf-compound.spec.mjs`, but the playwright config's testMatch only
 * collects `*.spec.ts` files — a `.spec.mjs` is NOT collected by
 * `npx playwright test`. The config is outside this worker's tests/ lease, so
 * the spec is a `.ts` file to stay auto-discovered (package.json equally
 * untouched). The node-side sibling of this coverage lives in
 * tests/pdf-compound.test.mjs (run directly with the node CLI).
 */

/* ------------------------------------------------------------------ *
 * In-page shapes (compile-time only; the callbacks are serialized)
 * ------------------------------------------------------------------ */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Stroke {
  color: Rgba;
  width: number;
}

interface Layerish {
  id: string;
  contours?: Array<{ nodes: unknown[]; closed: boolean }>;
  nodes: unknown[];
  fill: Rgba | null;
  stroke: Stroke | null;
}

interface Press {
  doc: {
    pages: Array<{ widthPx: number; heightPx: number; background: Rgba; layers: Layerish[] }>;
    activeLayerIds: string[];
  };
  fonts: { resolve(id?: string | undefined): unknown };
  face: unknown;
  compositor: { snapshotPagePng(doc: unknown): Uint8Array } | null;
  subtractSelected(): boolean;
  booleanSelected(op: string): boolean;
}

interface Report {
  pagePt: { w: number; h: number };
  vectorPaths: number;
  textRuns: number;
  glyphs: number;
  images: number;
  rasterFallbacks: string[];
  notes: string[];
}

interface ScenarioOut {
  b64: string;
  report: Report;
  geo: {
    /** The boolean op reported success (trivially true for the legacy case). */
    ok: boolean;
    /** contour count on the result layer, or null when `contours` is absent. */
    contours: number | null;
    /** true when the layer is legacy single-contour (no `contours[]` at all). */
    legacySingle: boolean;
    /** length of the legacy `nodes` array on the result layer. */
    nodes: number;
    fillNull: boolean;
    strokeWidth: number | null;
  };
}

type Scenario = "ring" | "union" | "legacy" | "ring-fill-stroke" | "ring-stroke-only";

/** Boot is only complete when the overlay is gone AND the compositor exists. */
async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean((window as unknown as { __press?: { compositor?: unknown } }).__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

/**
 * Build one scenario in the live app, then export via the module and arguments
 * src/app.ts exportPdf() itself uses. `applyDetailed` and each boolean replace
 * `P.doc`, so layer references are re-read fresh after every mutation (the
 * staleness trap tests/booleans.spec.mjs documents).
 */
async function runScenario(page: Page, scenario: Scenario): Promise<ScenarioOut> {
  return page.evaluate(
    async (name: string): Promise<ScenarioOut> => {
      const P = (window as unknown as { __press?: Press }).__press;
      const anchor = (window as unknown as { viroAnchor?: { applyDetailed(ops: unknown): unknown } })
        .viroAnchor;
      if (!P || !anchor) throw new Error("app not booted");
      if (!P.compositor) throw new Error("compositor not ready");

      const pg = P.doc.pages[0];
      const W = pg.widthPx;
      const H = pg.heightPx;
      const M = Math.min(W, H);
      const layers = (): Layerish[] => P.doc.pages[0].layers;
      const addRect = (params: Record<string, unknown>): void => {
        anchor.applyDetailed([{ op: "press.add_rect", params, reason: `pdf-compound ${name}` }]);
      };
      // The boolean consumes the top two layers: select both, run the op.
      const booleanTopTwo = (op: "subtract" | "union"): boolean => {
        const ls = layers();
        P.doc.activeLayerIds = [ls[ls.length - 2]!.id, ls[ls.length - 1]!.id];
        return op === "subtract" ? P.subtractSelected() : P.booleanSelected("union");
      };

      let ok = true;
      if (name === "ring" || name === "ring-fill-stroke" || name === "ring-stroke-only") {
        // Inner (hole) operand drawn BENEATH, outer operand on TOP; subtract =
        // topmost minus beneath → a centred ring. The result clones the TOP
        // operand's fill/stroke, so the top rect carries the style under test.
        const S = M * 0.6; // outer edge
        const I = M * 0.25; // hole edge
        addRect({ x: W / 2 - I / 2, y: H / 2 - I / 2, w: I, h: I, fill: "#2266cc" });
        if (name === "ring") {
          addRect({ x: W / 2 - S / 2, y: H / 2 - S / 2, w: S, h: S, fill: "#E07A2F" });
        } else if (name === "ring-fill-stroke") {
          addRect({
            x: W / 2 - S / 2,
            y: H / 2 - S / 2,
            w: S,
            h: S,
            fill: "#E07A2F",
            stroke: { color: "#1133CC", width: 5 },
          });
        } else {
          addRect({ x: W / 2 - S / 2, y: H / 2 - S / 2, w: S, h: S, stroke: { color: "#7A2FE0", width: 5 } });
        }
        ok = booleanTopTwo("subtract");
      } else if (name === "union") {
        // Two disjoint rects; union of disjoints is a two-contour compound.
        addRect({ x: W * 0.15, y: H * 0.2, w: W * 0.12, h: W * 0.12, fill: "#E07A2F" });
        addRect({ x: W * 0.65, y: H * 0.2, w: W * 0.12, h: W * 0.12, fill: "#E07A2F" });
        ok = booleanTopTwo("union");
      } else if (name === "legacy") {
        // An ordinary single-contour closed rect with a fill — the pre-change
        // output topology this file must prove unchanged.
        addRect({ x: W * 0.4, y: H * 0.4, w: W * 0.2, h: H * 0.2, fill: "#33aa55" });
      } else {
        throw new Error(`unknown scenario ${name}`);
      }

      const result = layers()[layers().length - 1]!;
      const geo = {
        ok: ok === true,
        contours: Array.isArray(result.contours) ? result.contours.length : null,
        legacySingle: result.contours === undefined,
        nodes: result.nodes.length,
        fillNull: result.fill === null,
        strokeWidth: result.stroke ? result.stroke.width : null,
      };

      // Drop the paper background so the ONLY fill/stroke operators in the
      // content stream are the layer's own (the background would contribute
      // an extra `re … f` and blur the f-vs-f* / S assertions). Purely a data
      // mutation on the doc object the exporter walks.
      P.doc.pages[0].background.a = 0;

      // The exact module and argument shape src/app.ts exportPdf() uses.
      const moduleUrl = "/src/export/pdf.ts";
      const mod = (await import(moduleUrl)) as unknown as {
        exportPagePdf(o: {
          doc: unknown;
          face: unknown;
          fonts?: unknown;
          rasterise?: (doc: unknown) => Uint8Array;
        }): Promise<{ bytes: Uint8Array; report: Report }>;
      };
      const { bytes, report } = await mod.exportPagePdf({
        doc: P.doc,
        face: P.fonts.resolve(undefined) ?? P.face,
        fonts: P.fonts,
        rasterise: (doc: unknown) => P.compositor!.snapshotPagePng(doc),
      });

      // Chunked base64 — the bytes array can exceed the spread limit.
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
      }
      return { b64: btoa(bin), report, geo };
    },
    scenario,
  );
}

/* ------------------------------------------------------------------ *
 * PDF side — reload the bytes, inflate the page content stream
 * ------------------------------------------------------------------ */

/** Decode page 0's content stream(s) back to operator text. */
async function contentText(bytes: Buffer): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  if (!contents) throw new Error("page has no content stream");
  type Raw = Parameters<typeof decodePDFRawStream>[0];
  const raws: Raw[] =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i) as unknown as Raw)
      : [contents as unknown as Raw];
  let text = "";
  for (const raw of raws) {
    if (!raw) continue;
    text += `${Buffer.from(decodePDFRawStream(raw).decode()).toString("latin1")}\n`;
  }
  return text;
}

/** Exact-token operator count — a number can never equal an operator name. */
function countOp(text: string, op: string): number {
  return text.split(/\s+/).filter((t) => t === op).length;
}

/** Numeric operands of every `op` run, e.g. "0.07 0.2 0.8 RG" → [[0.07,0.2,0.8]]. */
function opArgs(text: string, op: string): number[][] {
  const toks = text.split(/\s+/).filter(Boolean);
  const out: number[][] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== op) continue;
    const args: number[] = [];
    let j = i - 1;
    while (j >= 0 && args.length < 6 && /^-?\d+(\.\d+)?$/.test(toks[j]!)) {
      args.unshift(parseFloat(toks[j]!));
      j--;
    }
    out.push(args);
  }
  return out;
}

const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) <= eps;
const hex = (n: number): number => n / 255;

/** The full operator signature of one scenario's exported page. */
async function analyse(b64: string): Promise<string> {
  return contentText(Buffer.from(b64, "base64"));
}

test.describe("VIRO-0005 compound boolean geometry in vector PDF export", () => {
  test("subtract ring: both contours emitted, even-odd f* fill, one vector path, no raster fallback", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    const out = await runScenario(page, "ring");
    const text = await analyse(out.b64);

    // The editor-side facts: a v6 compound result with empty legacy nodes.
    expect(out.geo.ok).toBe(true);
    expect(out.geo.contours).toBe(2);
    expect(out.geo.nodes).toBe(0);

    // The report: the layer counts as a vector path and fabricated no fallback.
    expect(out.report.vectorPaths).toBe(1);
    expect(out.report.rasterFallbacks).toEqual([]);

    // The file: both subpaths present and closed, even-odd fill, never `f`.
    expect(countOp(text, "m")).toBe(2);
    expect(countOp(text, "h")).toBe(2);
    expect(countOp(text, "f*")).toBe(1);
    expect(countOp(text, "f")).toBe(0);
    expect(countOp(text, "B")).toBe(0);
    expect(countOp(text, "B*")).toBe(0);
    expect(countOp(text, "S")).toBe(0);
    // Only the trim clip `re` — no background fill rect (determinism guard).
    expect(countOp(text, "re")).toBe(1);
    // The fill colour operator carries the top operand's copper fill.
    const rg = opArgs(text, "rg");
    expect(rg).toHaveLength(1);
    expect(near(rg[0]![0]!, hex(0xe0))).toBe(true);
    expect(near(rg[0]![1]!, hex(0x7a))).toBe(true);
    expect(near(rg[0]![2]!, hex(0x2f))).toBe(true);
  });

  test("disjoint union: every contour emitted with f*, one vector path, no raster fallback", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    const out = await runScenario(page, "union");
    const text = await analyse(out.b64);

    expect(out.geo.ok).toBe(true);
    expect(out.geo.contours).toBe(2);
    expect(out.geo.nodes).toBe(0);

    expect(out.report.vectorPaths).toBe(1);
    expect(out.report.rasterFallbacks).toEqual([]);

    expect(countOp(text, "m")).toBe(2);
    expect(countOp(text, "f*")).toBe(1);
    expect(countOp(text, "f")).toBe(0);
    expect(countOp(text, "S")).toBe(0);
    expect(countOp(text, "re")).toBe(1);
  });

  test("legacy single-contour rect: unchanged topology — 1 m, 4 c, 1 h, plain nonzero f", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    const out = await runScenario(page, "legacy");
    const text = await analyse(out.b64);

    expect(out.geo.legacySingle).toBe(true);
    expect(out.geo.ok).toBe(true);

    expect(out.report.vectorPaths).toBe(1);
    expect(out.report.rasterFallbacks).toEqual([]);

    // Identical to the pre-change single-contour output.
    expect(countOp(text, "m")).toBe(1);
    expect(countOp(text, "c")).toBe(4);
    expect(countOp(text, "h")).toBe(1);
    expect(countOp(text, "f")).toBe(1);
    expect(countOp(text, "f*")).toBe(0);
    expect(countOp(text, "re")).toBe(1);
  });

  test("fill+stroke compound ring: B* even-odd fill-and-stroke, stroke colour and width preserved", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    const out = await runScenario(page, "ring-fill-stroke");
    const text = await analyse(out.b64);

    expect(out.geo.ok).toBe(true);
    expect(out.geo.contours).toBe(2);
    expect(out.geo.strokeWidth).toBe(5);

    expect(out.report.vectorPaths).toBe(1);
    expect(out.report.rasterFallbacks).toEqual([]);

    expect(countOp(text, "m")).toBe(2);
    expect(countOp(text, "h")).toBe(2);
    expect(countOp(text, "B*")).toBe(1);
    expect(countOp(text, "B")).toBe(0);
    expect(countOp(text, "f")).toBe(0);
    expect(countOp(text, "f*")).toBe(0);
    expect(countOp(text, "S")).toBe(0);

    // The stroke survived into the stream: width 5 and the #1133CC RGB.
    const widths = opArgs(text, "w");
    expect(widths).toHaveLength(1);
    expect(near(widths[0]![0]!, 5)).toBe(true);
    const rgbs = opArgs(text, "RG");
    expect(rgbs).toHaveLength(1);
    expect(near(rgbs[0]![0]!, hex(0x11))).toBe(true);
    expect(near(rgbs[0]![1]!, hex(0x33))).toBe(true);
    expect(near(rgbs[0]![2]!, hex(0xcc))).toBe(true);
  });

  test("stroke-only compound ring: S with no fill op, stroke colour and width preserved", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    const out = await runScenario(page, "ring-stroke-only");
    const text = await analyse(out.b64);

    expect(out.geo.ok).toBe(true);
    expect(out.geo.contours).toBe(2);
    expect(out.geo.fillNull).toBe(true);
    expect(out.geo.strokeWidth).toBe(5);

    expect(out.report.vectorPaths).toBe(1);
    expect(out.report.rasterFallbacks).toEqual([]);

    expect(countOp(text, "m")).toBe(2);
    expect(countOp(text, "h")).toBe(2);
    expect(countOp(text, "S")).toBe(1);
    expect(countOp(text, "f")).toBe(0);
    expect(countOp(text, "f*")).toBe(0);
    expect(countOp(text, "B")).toBe(0);
    expect(countOp(text, "B*")).toBe(0);

    const widths = opArgs(text, "w");
    expect(widths).toHaveLength(1);
    expect(near(widths[0]![0]!, 5)).toBe(true);
    const rgbs = opArgs(text, "RG");
    expect(rgbs).toHaveLength(1);
    expect(near(rgbs[0]![0]!, hex(0x7a))).toBe(true);
    expect(near(rgbs[0]![1]!, hex(0x2f))).toBe(true);
    expect(near(rgbs[0]![2]!, hex(0xe0))).toBe(true);
    // No fill colour operator either — the layer has none.
    expect(opArgs(text, "rg")).toHaveLength(0);
  });
});
