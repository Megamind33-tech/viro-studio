import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VIRO-0017 — accent-state gates (GOVERNOR.md UX rules).
 *
 * Copper #E07A2F may paint ONLY on (a) the active tool, (b) a selection state
 * (selected row/tab/preset/option, checked control, active view region), and
 * (c) keyboard :focus/:focus-visible indicators — (c) is the accessibility
 * selection indicator shipped and verified by VIRO-0016, so removing it would
 * regress a shipped gate (tests/a11y-keyboard.spec.ts asserts it).
 *
 * These tests enforce the negative half on the surfaces this packet fixed:
 *   - no stylesheet may paint the accent inside any :hover rule;
 *   - the Anchor default-action buttons carry no persistent accent ring;
 *   - the recovery primary button uses the raised-button treatment, not a
 *     copper CTA fill;
 *   - the dead governance prose stays out of the Anchor static markup.
 * And the positive half so the fix cannot over-remove:
 *   - the active-tool marker and the selected-layer-row marker stay copper;
 *   - #hex keyboard-focus border stays copper (VIRO-0016 boundary).
 *
 * Deliberately NOT asserted here: a global "no accent at rest" — dialog
 * `.btn.default` rings (src/styles/desk.css, D5) and the New-Document preview
 * guide strokes (D6) are recorded, out-of-lease findings returned to the
 * Governor in docs/reviews/0017-visual-polish-sweep.md.
 */

const ACCENT = "rgb(224, 122, 47)";

async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getElementById("boot")?.classList.contains("gone") === true &&
      Boolean((window as unknown as { __press?: { compositor?: unknown } }).__press?.compositor),
    null,
    { timeout: 90_000 },
  );
}

/** Walk all same-origin stylesheets, including CSS nested in @media blocks. */
function collectRules(page: Page): Promise<{ selector: string; css: string }[]> {
  return page.evaluate(() => {
    const out: { selector: string; css: string }[] = [];
    const walk = (rules: CSSRuleList | undefined) => {
      if (!rules) return;
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule;
        if (styleRule.selectorText && styleRule.cssText) {
          out.push({ selector: styleRule.selectorText, css: styleRule.cssText });
        }
        if ("cssRules" in rule) walk((rule as CSSMediaRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        /* cross-origin sheet — none in this app, but never fail the audit on it */
      }
    }
    return out;
  });
}

const ACCENT_REF = /--accent|#e07a2f|rgba?\(\s*224\s*,\s*122\s*,\s*47/i;

test.describe("VIRO-0017 visual-polish accent states", () => {
  test("no stylesheet paints the accent inside a :hover rule", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    const rules = await collectRules(page);
    const violations = rules.filter((r) => /:hover/i.test(r.selector) && ACCENT_REF.test(r.css));
    expect(
      violations.map((v) => v.selector),
      "hover is not an active/selection state — copper is reserved",
    ).toEqual([]);
  });

  test("Anchor default-action buttons carry no persistent accent ring", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    // Rule-level guarantee (covers .anc-mini-default, which only paints once a
    // batch is queued, without having to drive a queue).
    const rules = await collectRules(page);
    const violations = rules.filter(
      (r) =>
        (/\.anc-btn-default|\.anc-mini-default/.test(r.selector)) && ACCENT_REF.test(r.css),
    );
    expect(violations.map((v) => v.selector)).toEqual([]);

    // Live computed guarantee on the default buttons. The studio's default view
    // is Catalogue; switch to Chat so the Send default-action is actually laid
    // out (getComputedStyle reads hidden elements too, but the gate should
    // measure a painted surface).
    await page.locator('[data-menu="window"]').click();
    await page.locator('[data-cmd="win-anchor"]').click();
    await expect(page.locator("#g-anchor")).toBeVisible();
    await page.locator('.anc-mode[title*="Ask for a design"]').click();
    await expect(page.locator(".anc-send")).toBeVisible();
    const borders = await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>(".anc-btn-default")];
      return els
        .filter((el) => el.offsetParent !== null)
        .map((el) => getComputedStyle(el).borderTopColor);
    });
    expect(borders.length).toBeGreaterThan(0);
    for (const b of borders) expect(b, "default-action ring must not be copper").not.toBe(ACCENT);
  });

  test("recovery primary uses the raised-button treatment, not a copper CTA", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    await page.evaluate(() =>
      document.getElementById("recover-bar")?.removeAttribute("hidden"),
    );
    await expect(page.locator(".recover-primary")).toBeVisible();
    const paint = await page.evaluate(() => {
      const primary = document.querySelector<HTMLElement>(".recover-primary");
      const discard = document.querySelector<HTMLElement>(".recover-btn:not(.recover-primary)");
      if (!primary || !discard) return null;
      const cs = getComputedStyle(primary);
      return {
        background: cs.backgroundColor,
        border: cs.borderColor,
        color: cs.color,
        discardBackground: getComputedStyle(discard).backgroundColor,
      };
    });
    expect(paint).not.toBeNull();
    // The exact .btn/.anc-btn token set (raised-control treatment).
    expect(paint!.background).toBe("rgb(61, 61, 61)"); // #3d3d3d
    expect(paint!.border).toBe("rgb(26, 26, 26)"); // #1a1a1a
    expect(paint!.color).toBe("rgb(232, 232, 232)"); // --ink
    expect(paint!.background).not.toBe(ACCENT);
    // Still visually distinct from Discard — by fill, not by accent.
    expect(paint!.background).not.toBe(paint!.discardBackground);
  });

  test("hover on a non-stateful button stays neutral (align button, 2+ selected)", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    await page.evaluate(() => {
      const a = (window as unknown as VIRO).viroAnchor;
      const P = (window as unknown as VIRO).__press;
      a.apply([
        { op: "press.add_rect", params: { x: 100, y: 100, w: 300, h: 200, fill: "#E01B1B" }, reason: "polish probe A" },
        { op: "press.add_rect", params: { x: 500, y: 140, w: 260, h: 180, fill: "#1B5BE0" }, reason: "polish probe B" },
      ]);
      const ids = P.doc.pages[0].layers.filter((l: { kind: string }) => l.kind === "vector").map((l: { id: string }) => l.id);
      a.apply([{ op: "press.select", params: { layerIds: ids }, reason: "polish probe selection" }]);
    });
    const btn = page.locator(".align-btn:not(:disabled)").first();
    await expect(btn).toBeEnabled();
    await btn.hover();
    await page.waitForTimeout(120);
    const border = await btn.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(border).toBe("rgb(61, 61, 61)"); // #3d3d3d neutral hover step
    expect(border).not.toBe(ACCENT);
  });

  test("the accent stays stateful: active tool marker + selected row marker", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    // A1: the copper bar belongs to the ACTIVE tool and must move with it.
    const markerOf = (tool: string) =>
      page.evaluate((t) => {
        const el = document.querySelector<HTMLElement>(`[data-tool=${t}]`);
        if (!el) return null;
        return getComputedStyle(el, "::before").backgroundColor;
      }, tool);
    expect(await markerOf("move")).toBe(ACCENT);
    await page.locator("[data-tool=marquee]").click();
    expect(await markerOf("move"), "inactive tool must drop the copper bar").not.toBe(ACCENT);
    expect(await markerOf("marquee")).toBe(ACCENT);

    // A3: a selected layer row keeps its copper selection marker.
    await page.evaluate(() => {
      const a = (window as unknown as VIRO).viroAnchor;
      a.apply([
        { op: "press.add_rect", params: { x: 40, y: 40, w: 120, h: 90, fill: "#4CAF50" }, reason: "selection marker probe" },
      ]);
    });
    await page.waitForTimeout(150);
    const rowMarker = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".ly.is-on");
      return row ? getComputedStyle(row).boxShadow : null;
    });
    expect(rowMarker).toContain(ACCENT);
  });

  test("keyboard focus indicators keep the accent (VIRO-0016 boundary, not regressed)", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    await page.locator("#hex").focus();
    const fieldBorder = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).borderColor,
    );
    expect(fieldBorder).toBe(ACCENT);
  });

  test("toolbox icons are distinct and semantic (no glyph reuse, no placeholders)", async ({
    page,
  }) => {
    await page.goto("/");
    await bootReady(page);
    const tools = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#toolbox [data-tool]")].map((el) => ({
        tool: el.getAttribute("data-tool"),
        label: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        // any painted shape child of the icon svg (path/line/ellipse/rect/…)
        sig: [...el.querySelectorAll("svg *")].map((p) => p.outerHTML).join("|"),
      })),
    );
    expect(tools.length).toBeGreaterThanOrEqual(10);
    const labels = tools.map((t) => t.label ?? "");
    const titles = tools.map((t) => t.title ?? "");
    const sigs = tools.map((t) => t.sig);
    expect(new Set(labels).size).toBe(tools.length);
    expect(new Set(titles).size).toBe(tools.length);
    expect(new Set(sigs).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.label, `${t.tool} needs an aria-label`).toBeTruthy();
      expect(t.title, `${t.tool} needs a title`).toBeTruthy();
      expect(t.sig.length, `${t.tool} needs a non-empty icon`).toBeGreaterThan(0);
    }
  });

  test("no governance prose in the Anchor static markup", async () => {
    // Source-level, not DOM-level: mountAnchorPanel strips static <h2>/<p> at
    // init, so a runtime check would pass even with the prose still shipped.
    // HTML comments are stripped first — they are developer documentation, not
    // painted UI, and the D4 fix deliberately leaves an explanatory comment.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(join(root, "index.html"), "utf8").replace(
      /<!--[\s\S]*?-->/g,
      "",
    );
    expect(src).not.toContain("docked studio, never product chrome");
    expect(src).not.toContain("Anchor applies structured ops");
    // The anchor section itself must not ship a static prose paragraph.
    const anchorSection = src.slice(src.indexOf('id="g-anchor"'), src.indexOf('id="g-anchor"') + 4000);
    expect(anchorSection).not.toMatch(/<p[\s>]/);
  });
});

type VIRO = {
  viroAnchor: {
    apply(ops: { op: string; params: Record<string, unknown>; reason: string }[]): unknown;
  };
  __press: {
    compositor?: unknown;
    doc: { pages: { layers: { id: string; kind: string }[] }[] };
  };
};
