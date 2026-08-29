import { expect, test, type Page } from "@playwright/test";

/**
 * Acceptance 3 (VIRO-0144): the painted selection highlight covers exactly
 * the selected glyphs — proven on the real desk canvas at two ranges, one of
 * which crosses a character-style boundary (VIRO-0142 runs) and one of which
 * is an ffi ligature that must highlight as one full span, never truncated at
 * a phantom mid-glyph caret.
 *
 * Method (self-calibrating): the overlay transform (rulers, pan, zoom, device
 * pixels) is whatever the desk has live, so the spec does not predict screen
 * positions from page math. It calibrates instead: a zero-length selection
 * paints the caret line exactly at the focus stop, which yields the painted
 * screen x of two known stops. The selection highlight must then span
 * precisely between those calibrated positions — and change nothing else on
 * the canvas.
 */

async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean((window as unknown as { __press?: { compositor?: unknown } }).__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

interface DiffCell {
  x: number;
  y: number;
}

/** Whole-canvas diff of two screenshots. Step 1: the caret is a device-snapped hairline a coarse grid can miss. */
async function diffShots(page: Page, a: string, b: string, step = 1): Promise<DiffCell[]> {
  return page.evaluate(async ({ a, b, step }) => {
    const load = (d: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = d;
      });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = ia.width;
    const h = ia.height;
    const ca = document.createElement("canvas");
    ca.width = w;
    ca.height = h;
    const ga = ca.getContext("2d", { willReadFrequently: true })!;
    ga.drawImage(ia, 0, 0);
    const cb = document.createElement("canvas");
    cb.width = w;
    cb.height = h;
    const gb = cb.getContext("2d", { willReadFrequently: true })!;
    gb.drawImage(ib, 0, 0);
    const da = ga.getImageData(0, 0, w, h).data;
    const db = gb.getImageData(0, 0, w, h).data;
    const hits: { x: number; y: number }[] = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const d =
          Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 12) hits.push({ x, y });
      }
    }
    return hits;
  }, { a, b, step });
}

async function screenshotDataUrl(page: Page): Promise<string> {
  const buf = await page.locator("#skia").screenshot();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

test.describe("VIRO-0144 caret/selection fidelity on canvas", () => {
  test("selection highlight covers exactly the selected glyphs", async ({ page }) => {
    const base = process.env.VIRO_CARET_BASE_URL ?? "/";
    await page.goto(base);
    await bootReady(page);

    // A fresh document for deterministic page coordinates.
    await page.locator("[data-menu=file]").click();
    await page.locator("[data-flyout=file] [data-cmd=new]").click();
    await page.locator("[data-preset=print-a3]").click();
    await page.locator("[data-dlg=new-ok]").click();
    await expect(page.locator("#dlg-new")).toBeHidden();

    // Load the faces the fixture styles, then build the frame through the bus.
    await page.evaluate(async () => {
      const P = (window as unknown as { __press: any }).__press;
      await P.fonts.ensureLoaded("noto-sans");
      await P.fonts.ensureLoaded("noto-sans-bold");
      P.run({
        type: "type.addFrame",
        params: { fontId: "noto-sans", x: 80, y: 80, w: 380, h: 140, text: "AVATAR office fi" },
      });
    });

    // Kerning + ligatures on, and a character-style boundary after "AVATAR"
    // (VIRO-0142 runs) so the second range crosses it. The bold face carries
    // no liga lookups, so the boundary deliberately sits BEFORE "office fi" —
    // the ligature words must stay in the regular face to ligate at all.
    await page.evaluate(() => {
      const P = (window as unknown as { __press: any }).__press;
      const layer = P.doc.pages[0].layers.find((l: any) => l.kind === "type-frame");
      const story = P.doc.stories.find((s: any) => s.id === layer.storyId);
      story.character.otFeatures = ["kern", "liga"];
      P.run({
        type: "type.characterRange",
        params: { layerId: layer.id, start: 0, end: 7, fontId: "noto-sans-bold", tracking: 10 },
      });
      (window as unknown as { __layerId?: string }).__layerId = layer.id;
      P.enterTypeEdit(layer.id);
      // Zoom in on the frame: at fit-zoom the whole ligature is ~8 screen px,
      // too small to separate the calibration carets. Anchoring on the frame
      // centre keeps it in view.
      const c = P.compositor.pageToScreen(
        layer.transform.x + layer.transform.w / 2,
        layer.transform.y + layer.transform.h / 2,
      );
      P.compositor.setZoom(2, c.x, c.y);
    });
    const layerId = (await page.evaluate(() => (window as unknown as { __layerId?: string }).__layerId))!;

    const geo = await page.evaluate((layerId) => {
      const P = (window as unknown as { __press: any }).__press;
      const stops = P.compositor.typeLayout(P.doc, layerId).stops;
      const at = (o: number) => stops.find((s: any) => s.offset === o);
      return {
        stop8: at(8),
        stop11: at(11),
        stop4: at(4),
        stop13: at(13),
        boundaryStopCount: stops.filter((s: any) => s.offset === 7).length,
        offsets: stops.map((s: any) => s.offset),
      };
    }, layerId);
    expect(geo.boundaryStopCount).toBe(1);
    // Sanity: the fixture really shaped ligatures (ffi merged: no stops at 9/10).
    expect(geo.offsets).not.toContain(9);
    expect(geo.offsets).not.toContain(10);

    /** Render one overlay state and settle two frames. */
    const show = async (anchor: number | null, focus: number | null): Promise<void> => {
      await page.evaluate(({ layerId, anchor, focus }) => {
        const P = (window as unknown as { __press: any }).__press;
        P.compositor.view.textEdit =
          focus === null ? null : { layerId, anchor, focus };
        P.compositor.requestOverlayRepaint();
      }, { layerId, anchor, focus });
      await page.evaluate(
        () =>
          new Promise((res) =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 80))),
          ),
      );
    };

    /**
     * Group changed cells into x clusters separated by gaps > `gap` px.
     */
    const clusters = (cells: DiffCell[], gap: number): DiffCell[][] => {
      const sorted = [...cells].sort((a, b) => a.x - b.x);
      const out: DiffCell[][] = [];
      for (const c of sorted) {
        const last = out[out.length - 1];
        if (!last || c.x - last[last.length - 1]!.x > gap) out.push([c]);
        else last.push(c);
      }
      return out;
    };

    /**
     * Measure one selection range. Every render here carries the frame
     * outline, so baselines are other overlay states, never the bare canvas:
     *
     *   caretA vs caretB  → the two caret clusters calibrate the painted x of
     *                        stop(a) and stop(b);
     *   caretA vs sel     → caret@b and the highlight appear; subtracting the
     *                        two caret columns leaves exactly the highlight.
     */
    const measureRange = async (ao: number, bo: number): Promise<void> => {
      await show(ao, ao);
      const shotA = await screenshotDataUrl(page);
      await show(bo, bo);
      const shotB = await screenshotDataUrl(page);
      await show(ao, bo);
      const shotSel = await screenshotDataUrl(page);

      const pair = await diffShots(page, shotA, shotB);
      expect(pair.length).toBeGreaterThan(0);
      const groups = clusters(pair, 10);
      expect(groups.length).toBe(2); // caret@a added, caret@b removed — nothing else
      const centers = groups.map((g) => g.reduce((s, c) => s + c.x, 0) / g.length);
      const pA = Math.min(...centers);
      const pB = Math.max(...centers);

      const selCells = await diffShots(page, shotA, shotSel);
      expect(selCells.length).toBeGreaterThan(0);
      // The hairline caret cells hug the calibrated centres; the highlight
      // cells reaching those edges blend under the caret and are removed with
      // it, so surviving highlight edges sit within a few px of the boundary.
      const nearCaret = (x: number) => Math.abs(x - pA) <= 3 || Math.abs(x - pB) <= 3;
      const highlight = selCells.filter((c) => !nearCaret(c.x));
      expect(highlight.length).toBeGreaterThan(0);

      const hx = highlight.map((c) => c.x);
      const hMin = Math.min(...hx);
      const hMax = Math.max(...hx);
      // The highlight runs from the first selected cluster's left edge to the
      // last one's right edge (minus the caret-subtracted margins).
      expect(hMin).toBeGreaterThanOrEqual(pA - 6);
      expect(hMin).toBeLessThanOrEqual(pA + 8);
      expect(hMax).toBeGreaterThanOrEqual(pB - 8);
      expect(hMax).toBeLessThanOrEqual(pB + 6);
      // Exactness: no highlight cell beyond either calibrated boundary.
      for (const x of hx) {
        expect(x).toBeGreaterThanOrEqual(pA - 6);
        expect(x).toBeLessThanOrEqual(pB + 6);
      }
    };

    // Range 1 — exactly the ffi ligature: one glyph, offsets 8..11. The
    // pre-cluster engine truncated the highlight at a phantom mid-glyph caret.
    await measureRange(8, 11);

    // Range 2 — [4, 13) crosses the character-style boundary at offset 7.
    await measureRange(4, 13);
  });
});
