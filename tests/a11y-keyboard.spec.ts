import { expect, test, type Page } from "@playwright/test";

/**
 * VIRO-0016 — keyboard-only walkthrough of the core editor chrome.
 *
 * Every journey here is driven the way a keyboard-only operator would drive
 * it: shortcut keys, Enter/Space/Escape, and Tab. `locator.focus()` is used
 * only to place the caret where Tab would take too long to count up to (the
 * New dialog holds ~50 tab stops before Create); the journey step itself is
 * always a keypress. Visible focus is asserted, not assumed.
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

async function activeElement(page: Page): Promise<{ tag: string; id: string; cls: string; inDialog: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return {
      tag: el?.tagName ?? "NONE",
      id: el?.id ?? "",
      cls: el?.className ?? "",
      inDialog: el?.closest(".dialog-back")?.id ?? null,
    };
  });
}

async function blurToBody(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Create a document through the real New dialog, keys only. The Enter that
 *  commits is pressed from the Name field (the dialog deliberately ignores
 *  Enter on buttons, so focus is parked on a field first). */
async function createDocumentByKeyboard(page: Page): Promise<void> {
  await page.keyboard.press("Control+n");
  await expect(page.locator("#dlg-new")).toBeVisible();
  await page.locator("#nd-name").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dlg-new")).toBeHidden();
}

/** Setup helper (OS file picking cannot be keyboard-driven headless): place a
 *  real 10x10 PNG through the File menu so the desk has a layer to work with. */
async function placePng(page: Page): Promise<void> {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADufNsyyqAAAAAElFTkSuQmCC",
    "base64",
  );
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("[data-menu=file]").click().then(() => page.locator("[data-flyout=file] [data-cmd=place]").click()),
  ]);
  await chooser.setFiles({ name: "swatch.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#layer-list")).toContainText("swatch.png");
}

test.describe("VIRO-0016 keyboard accessibility", () => {
  test("New: dialog takes focus, Enter commits from a field, Escape cancels, focus returns to the trigger", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    await page.locator("[data-tool=move]").focus();

    await page.keyboard.press("Control+n");
    await expect(page.locator("#dlg-new")).toBeVisible();
    // Focus moved INTO the modal, not left on the covered desk.
    expect((await activeElement(page)).inDialog).toBe("dlg-new");
    // The focused control shows a visible focus indicator.
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as Element);
      return { style: cs.outlineStyle, width: cs.outlineWidth };
    });
    expect(ring.style).not.toBe("none");

    // Tab cycles inside the modal: backwards from the first stop wraps to the
    // last, forwards from the last wraps to the first — never out of the box.
    await page.keyboard.press("Shift+Tab");
    expect((await activeElement(page)).inDialog).toBe("dlg-new");
    await page.keyboard.press("Tab");
    expect((await activeElement(page)).inDialog).toBe("dlg-new");

    // Escape cancels and hands focus back to the trigger.
    await page.keyboard.press("Escape");
    await expect(page.locator("#dlg-new")).toBeHidden();
    expect((await activeElement(page)).cls).toContain("tool");

    // Escape works from inside a text field too (the global typing guard no
    // longer strands the modal).
    await page.keyboard.press("Control+n");
    await expect(page.locator("#dlg-new")).toBeVisible();
    await page.locator("#nd-name").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#dlg-new")).toBeHidden();

    // Enter commits the dialog from a field and lands in history.
    await page.keyboard.press("Control+n");
    await expect(page.locator("#dlg-new")).toBeVisible();
    const revisionBefore = await page.evaluate(
      () => (window as unknown as { __press?: { bus?: { revision(): number } } }).__press?.bus?.revision() ?? -1,
    );
    await page.locator("#nd-name").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#dlg-new")).toBeHidden();
    const after = await page.evaluate(
      () =>
        ({
          revision: (window as unknown as { __press?: { bus?: { revision(): number } } }).__press?.bus?.revision() ?? -1,
          labels: (window as unknown as { __press?: { bus?: { labels(): string[] } } }).__press?.bus?.labels() ?? [],
        }),
    );
    expect(after.revision).toBeGreaterThan(revisionBefore);
    expect(after.labels).toContain("New document");
  });

  test("Open and Save: Projects dialog by keyboard stores and re-lists the document", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    await createDocumentByKeyboard(page);

    // Ctrl+S saves into the local Projects library. The write is async, so
    // wait until the library really lists a project before opening the dialog.
    await page.keyboard.press("Control+s");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as {
                __press?: { listProjects(): Promise<{ name: string }[]> };
              }
            ).__press
              ? (window as unknown as { __press: { listProjects(): Promise<{ name: string }[]> } }).__press.listProjects().then((l) => l.length)
              : 0,
          ),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // Ctrl+O opens the Projects dialog, focus travels inside, and the saved
    // project is really listed — persistence, not decoration.
    await page.keyboard.press("Control+o");
    await expect(page.locator("#dlg-projects")).toBeVisible();
    expect((await activeElement(page)).inDialog).toBe("dlg-projects");
    await expect(page.locator("#projects-grid")).toContainText("Untitled", { timeout: 20_000 });

    // Escape dismisses the dialog.
    await page.keyboard.press("Escape");
    await expect(page.locator("#dlg-projects")).toBeHidden();
  });

  test("Undo/Redo: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z walk a real change back and forth", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    await createDocumentByKeyboard(page);
    await placePng(page);

    await blurToBody(page);
    await page.keyboard.press("Control+z");
    await expect(page.locator("#layer-list")).not.toContainText("swatch.png");
    await page.keyboard.press("Control+y");
    await expect(page.locator("#layer-list")).toContainText("swatch.png");
    await page.keyboard.press("Control+z");
    await expect(page.locator("#layer-list")).not.toContainText("swatch.png");
    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator("#layer-list")).toContainText("swatch.png");
  });

  test("Tools and Zoom: letter shortcuts, shortcut zoom, and visible focus rings", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    const fitZoom = (await page.locator("#doc-zoom").textContent()) ?? "";

    await blurToBody(page);
    await page.keyboard.press("m");
    await expect(page.locator("[data-tool=marquee]")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-tool=move]")).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("t");
    await expect(page.locator("[data-tool=type]")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("v");
    await expect(page.locator("[data-tool=move]")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Control+1");
    await expect(page.locator("#doc-zoom")).toHaveText("100%");
    await page.keyboard.press("Control+="); // zoom in
    await expect(page.locator("#doc-zoom")).not.toHaveText("100%");
    await page.keyboard.press("Control+-"); // and back out
    await expect(page.locator("#doc-zoom")).toHaveText("100%");
    await page.keyboard.press("Control+0"); // fit
    await expect(page.locator("#doc-zoom")).toHaveText(fitZoom);

    // Visible focus: menu buttons get a rendered outline; text fields get the
    // copper focus border the chrome reserves for keyboard focus.
    await page.locator("[data-menu=view]").focus();
    const menuRing = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    expect(menuRing).not.toBe("none");
    await page.locator("#hex").focus();
    const fieldBorder = await page.evaluate(() => getComputedStyle(document.activeElement as Element).borderColor);
    expect(fieldBorder).toBe("rgb(224, 122, 47)");
  });

  test("Menus: expanded state is exposed, Escape dismisses back to the trigger, focusout closes", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    const fileBtn = page.locator("[data-menu=file]");
    const flyout = page.locator("[data-flyout=file]");

    await fileBtn.focus();
    await page.keyboard.press("Enter");
    await expect(flyout).toBeVisible();
    await expect(fileBtn).toHaveAttribute("aria-expanded", "true");

    // A flyout item reached by Tab activates with Enter and closes its menu.
    await page.keyboard.press("Tab"); // first stop after the trigger is "New…"
    const tabStop = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent ?? "",
    }));
    expect(tabStop.tag).toBe("BUTTON");
    expect(tabStop.text).toContain("New");
    await page.keyboard.press("Enter");
    await expect(page.locator("#dlg-new")).toBeVisible();
    await expect(fileBtn).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator("#dlg-new")).toBeHidden();

    // Escape dismisses the open flyout and refocuses its menu button.
    await fileBtn.focus();
    await page.keyboard.press("Enter"); // file menu open again
    await expect(flyout).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(flyout).toBeHidden();
    await expect(fileBtn).toHaveAttribute("aria-expanded", "false");
    expect((await activeElement(page)).cls).toContain("menu-btn");

    // Tabbing focus out of the menubar never strands a flyout open.
    await page.keyboard.press("Enter");
    await expect(flyout).toBeVisible();
    await page.locator("#hex").focus();
    await expect(flyout).toBeHidden();
    await expect(fileBtn).toHaveAttribute("aria-expanded", "false");
  });

  test("Layers: rows are keyboard-selectable and their toggles report state", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);
    await createDocumentByKeyboard(page);
    await placePng(page);

    // Start from no selection so the selection is provably made by keyboard.
    await blurToBody(page);
    await page.keyboard.press("Control+d"); // deselect
    await expect(page.locator("#tr-x")).toBeDisabled();

    // The row name is a real button — Enter selects the layer, and the
    // Transform panel unlocks because there is a selection.
    const nameBtn = page.locator("#layer-list .ly .nm").first();
    await nameBtn.focus();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BUTTON");
    await page.keyboard.press("Enter");
    await expect(nameBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#tr-x")).toBeEnabled();

    // The visibility toggle on the same row flips by keyboard and reports it.
    const eye = page.locator("#layer-list .ly .eye").first();
    const before = await eye.getAttribute("aria-pressed");
    await eye.focus();
    await page.keyboard.press("Enter");
    await expect(eye).not.toHaveAttribute("aria-pressed", before ?? "");
    // Row geometry is untouched by the button change: the row keeps its height.
    const rowBox = await page.locator("#layer-list .ly").first().boundingBox();
    expect(rowBox?.height).toBe(38);
  });
});
