import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VIRO-0148 — the statusbar's aria-live region must actually announce.
 *
 * Before this packet, desk.ts overwrote #stat-engine (the aria-live=polite
 * cell) with the `Doc:` size label whenever the engines were up, so a save's
 * "Saved …" message never reached anyone: sighted users saw the size readout
 * and screen readers had nothing new to announce. The acceptance contract:
 *
 *  1. after boot, Ctrl+S renders the truthful status message AND the
 *     aria-live element is the SAME node announcing it (text updated in
 *     place — no element swap);
 *  2. the Doc: size label lives in its own NON-live slot (#stat-docsize) and
 *     the render path can no longer clobber the live region;
 *  3. VIRO-0016/0017 surfaces stay intact (this suite runs alongside them in
 *     the shared chrome gate on this seat port).
 */

/** Same genuine-ready gate as chrome.spec.ts: overlay gone AND compositor up. */
async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean((window as unknown as { __press?: { compositor?: unknown } }).__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "a11y-status-shots");

test.describe("VIRO-0148 status live-region", () => {
  test("post-boot Ctrl+S announces the save in the SAME aria-live node", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);

    const live = page.locator("#stat-engine");
    await expect(live).toHaveAttribute("aria-live", "polite");

    // Pin the exact element instance BEFORE the save. If any later write
    // swapped or rebuilt this element, the identity check below fails even
    // though the markup would look identical.
    await page.evaluate(() => {
      (window as unknown as { __viro0148Live?: Element | null }).__viro0148Live =
        document.getElementById("stat-engine");
    });

    await page.keyboard.press("Control+s");
    // The truthful status lands in the live region itself.
    await expect(live).toContainText("Saved", { timeout: 30_000 });
    await expect(live).toContainText("to Projects");

    // Node identity: the announcing node IS the pre-save node, still live and
    // still connected — textContent changed in place, nothing was rebuilt.
    const identity = await page.evaluate(() => {
      const w = window as unknown as { __viro0148Live?: Element | null };
      const now = document.getElementById("stat-engine");
      return {
        same: Boolean(w.__viro0148Live && w.__viro0148Live === now),
        connected: Boolean(w.__viro0148Live?.isConnected),
        live: now?.getAttribute("aria-live") ?? null,
        text: now?.textContent ?? "",
      };
    });
    expect(identity.same).toBe(true);
    expect(identity.connected).toBe(true);
    expect(identity.live).toBe("polite");
    expect(identity.text).toMatch(/Saved .* to Projects/);
  });

  test("the save announcement survives later render churn", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);

    const live = page.locator("#stat-engine");
    await page.keyboard.press("Control+s");
    await expect(live).toContainText("Saved", { timeout: 30_000 });

    // Zoom commands re-run the full chrome render — the exact path that used
    // to overwrite the live region with the Doc: label after every paint.
    await page.keyboard.press("Control+-");
    await expect(live).toContainText("Saved");
    await page.keyboard.press("Control+0");
    await expect(live).toContainText("Saved");

    // The size readout sits in its own NON-live cell, never in the region.
    const docsize = page.locator("#stat-docsize");
    await expect(docsize).toBeVisible();
    expect(await docsize.getAttribute("aria-live")).toBeNull();
    await expect(docsize).toContainText(/Doc: .+\/.+/);
    await expect(live).not.toContainText("Doc:");
  });

  test("statusbar post-boot shows doc-size slot plus live status (screenshot evidence)", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);

    const live = page.locator("#stat-engine");
    const docsize = page.locator("#stat-docsize");

    // Post-boot: the size readout is visible in its own cell without any
    // aria-live semantics; the live region carries the engine status summary.
    await expect(docsize).toBeVisible();
    await expect(docsize).toContainText(/Doc: .+\/.+/);
    expect(await docsize.getAttribute("aria-live")).toBeNull();
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).not.toContainText("Doc:");
    expect((await live.textContent())?.trim()).not.toBe("");

    // And a save still announces through that same node afterwards.
    await page.keyboard.press("Control+s");
    await expect(live).toContainText("Saved", { timeout: 30_000 });

    // Visual evidence for the handoff: corrected status content only.
    mkdirSync(SHOTS, { recursive: true });
    await page.locator("#statusbar").screenshot({ path: join(SHOTS, "statusbar-after-save.png") });
    await page.screenshot({ path: join(SHOTS, "desk-after-save.png") });
  });
});
