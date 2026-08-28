import { expect, test, type Page } from "@playwright/test";

/**
 * VIRO-0017 — computed-style token gates (GOVERNOR.md UX rules).
 *
 * These tests freeze the structural half of the visual-polish audit: the panel /
 * pasteboard / accent / radius tokens must resolve to the exact spec values, the
 * structural chrome surfaces must paint those tokens, no element may compute a
 * border-radius above 2px, and visible UI text must be Segoe UI (monospace
 * confined to the Anchor studio's machine-data readouts).
 *
 * The accent *state* rules (where copper may appear) live in
 * tests/visual-polish-chrome.spec.ts.
 *
 * Basis: docs/reviews/0017-visual-polish-sweep.md (computed-style audit).
 */

const PANEL = "rgb(43, 43, 43)"; // #2B2B2B
const RAISED = "rgb(50, 50, 50)"; // #323232
const PASTEBOARD = "rgb(31, 31, 31)"; // #1F1F1F

async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean((window as unknown as { __press?: { compositor?: unknown } }).__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

test.describe("VIRO-0017 visual-polish tokens", () => {
  test("root UX tokens resolve to the exact GOVERNOR.md spec values", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const resolved = (decl: string) => {
        const probe = document.createElement("div");
        probe.style.cssText = `position:absolute;${decl}`;
        document.body.appendChild(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return bg;
      };
      return {
        panel: cs.getPropertyValue("--panel").trim(),
        raised: cs.getPropertyValue("--raised").trim(),
        pasteboard: cs.getPropertyValue("--pasteboard").trim(),
        accent: cs.getPropertyValue("--accent").trim(),
        radius: cs.getPropertyValue("--radius").trim(),
        paintedPanel: resolved("background: var(--panel)"),
        paintedRaised: resolved("background: var(--raised)"),
        paintedPasteboard: resolved("background: var(--pasteboard)"),
        paintedAccent: resolved("background: var(--accent)"),
      };
    });
    expect(tokens.panel).toBe("#2b2b2b");
    expect(tokens.raised).toBe("#323232");
    expect(tokens.pasteboard).toBe("#1f1f1f");
    expect(tokens.accent).toBe("#e07a2f");
    expect(Number(parseFloat(tokens.radius))).toBeLessThanOrEqual(2);
    expect(tokens.paintedPanel).toBe(PANEL);
    expect(tokens.paintedRaised).toBe(RAISED);
    expect(tokens.paintedPasteboard).toBe(PASTEBOARD);
    expect(tokens.paintedAccent).toBe("rgb(224, 122, 47)");
  });

  test("structural chrome surfaces paint the panel and pasteboard tokens", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    const surfaces = await page.evaluate(() => {
      const bg = (id: string) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      return {
        menubar: bg("menubar"),
        statusbar: bg("statusbar"),
        optionsbar: bg("optionsbar"),
        toolbox: bg("toolbox"),
        pasteboard: bg("pasteboard"),
      };
    });
    // menubar/statusbar are raised chrome; optionsbar/toolbox are panel chrome;
    // the pasteboard is the #1F1F1F desk behind the page.
    expect(surfaces.menubar).toBe(RAISED);
    expect(surfaces.statusbar).toBe(RAISED);
    expect(surfaces.optionsbar).toBe(PANEL);
    expect(surfaces.toolbox).toBe(PANEL);
    expect(surfaces.pasteboard).toBe(PASTEBOARD);
  });

  test("no element computes a border-radius above 2px", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    const violations = await page.evaluate(() => {
      const bad: { el: string; radius: string }[] = [];
      for (const el of document.body.querySelectorAll("*")) {
        const br = getComputedStyle(el).borderRadius;
        if (!br || br === "0px" || br === "0px 0px 0px 0px") continue;
        for (const part of br.split(" ")) {
          const v = parseFloat(part);
          if (Number.isFinite(v) && v > 2) {
            bad.push({
              el:
                el.tagName.toLowerCase() +
                (el.id ? `#${el.id}` : "") +
                "." +
                String(el.className).split(" ").filter(Boolean).join("."),
              radius: br,
            });
            break;
          }
        }
      }
      return bad;
    });
    expect(violations).toEqual([]);
  });

  test("visible UI text is Segoe UI; monospace is confined to Anchor machine data", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    const census = await page.evaluate(() => {
      const violations: { el: string; fontFamily: string }[] = [];
      const families = new Set<string>();
      const isVisible = (el: Element) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        // The #type-input IME surface sits at opacity 0.01 and never paints a
        // pixel; anything below the paint threshold is not UI text.
        if (parseFloat(cs.opacity) < 0.05) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      for (const el of document.body.querySelectorAll("*")) {
        if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
        const ff = getComputedStyle(el).fontFamily;
        families.add(ff);
        const lower = ff.toLowerCase();
        const isSegoe = lower.includes("segoe");
        const isMono = lower.includes("mono");
        const inAnchor = el.closest("#g-anchor") !== null; // machine-data zone
        if (!isSegoe && !(isMono && inAnchor)) {
          violations.push({
            el: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""),
            fontFamily: ff,
          });
        }
      }
      return { families: [...families], violations };
    });
    expect(census.violations).toEqual([]);
    const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(body.toLowerCase()).toContain("segoe");
  });

  test("empty states are honest (real text, no fake content)", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    // Effects pane at rest: the real empty-state sentence, not placeholder art.
    await expect(page.locator("#fx-empty")).toHaveText("Select a layer to add effects.");
  });
});
