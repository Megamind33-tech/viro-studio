import { expect, test, type Page } from "@playwright/test";

/**
 * Wait for the desk to be GENUINELY ready.
 *
 * The old gate asserted #stat-engine matched /Skia|HarfBuzz|LittleCMS/, which
 * the LOADING message "Loading CanvasKit (Skia)…" also satisfies. It therefore
 * passed while the compositor was still null, and every later canvas click was
 * a silent no-op. Boot is only complete when the overlay is dismissed AND the
 * compositor exists.
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

test.describe("VIRO Press chrome", () => {
  test("Photoshop-class desk, no Canva product strings", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#desk")).toBeVisible();
    await expect(page.locator("#menubar")).toContainText("File");
    await expect(page.locator("#menubar")).toContainText("Edit");
    await expect(page.locator("#menubar")).toContainText("Image");
    await expect(page.locator("#menubar")).toContainText("Layer");
    await expect(page.locator("#menubar")).toContainText("Type");
    await expect(page.locator("#menubar")).toContainText("Select");
    await expect(page.locator("#menubar")).toContainText("Filter");
    await expect(page.locator("#menubar")).toContainText("View");
    await expect(page.locator("#menubar")).toContainText("Window");

    await expect(page.locator("#toolbox")).toBeVisible();
    await expect(page.getByRole("button", { name: "Move" })).toBeVisible();
    await expect(page.locator("[data-tool=pen]")).toHaveCount(1);
    await expect(page.locator("[data-tool=crop]")).toHaveCount(1);
    await expect(page.locator("[data-tool=brush]")).toHaveCount(0);

    const chrome = await page.locator("#desk").innerText();
    expect(chrome).not.toMatch(/Animate/);
    expect(chrome).not.toMatch(/Looks/);
    expect(chrome).not.toMatch(/Edit image/);
    expect(chrome).not.toMatch(/\bGenerate\b/);

    const ff = await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(ff.toLowerCase()).not.toContain("inter");
    expect(ff.toLowerCase()).toMatch(/segoe/);

    const opt = await page.locator("#optionsbar").boundingBox();
    expect(opt?.height).toBeGreaterThanOrEqual(28);
    expect(opt?.height).toBeLessThanOrEqual(32);
    const tools = await page.locator("#toolbox").boundingBox();
    expect(tools?.width).toBeGreaterThanOrEqual(28);
    expect(tools?.width).toBeLessThanOrEqual(36);
  });

  test("options bar follows the tool", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-tool=type]").click();
    await expect(page.locator("#opt-size")).toBeVisible();
    await expect(page.locator("#opt-lead")).toBeVisible();
    await expect(page.locator("#opt-track")).toBeVisible();
    await page.locator("[data-tool=marquee]").click();
    await expect(page.locator("#opt-feather")).toBeVisible();
    await expect(page.getByText("Anti-alias")).toBeVisible();
    await page.locator("[data-tool=move]").click();
    await expect(page.locator("#opt-x")).toBeVisible();
    await expect(page.locator("#opt-r")).toBeVisible();
  });

  test("Image Size dialog has width, height, ppi, constrain, resample", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-menu=image]").click();
    await page.locator("[data-cmd=image-size]").click();
    await expect(page.locator("#dlg-image")).toBeVisible();
    await expect(page.locator("#img-w")).toBeVisible();
    await expect(page.locator("#img-h")).toBeVisible();
    await expect(page.locator("#img-ppi")).toBeVisible();
    await expect(page.locator("#img-constrain")).toBeVisible();
    await expect(page.locator("#img-resample")).toBeVisible();
    await expect(page.locator("#img-algo")).toContainText("Nearest Neighbor");
    await expect(page.locator("#img-algo")).toContainText("Bilinear");
    await expect(page.locator("#img-algo")).toContainText("Bicubic");
    await page.locator("[data-dlg=image-cancel]").click();
    await expect(page.locator("#dlg-image")).toBeHidden();
  });

  test("studios include Color, Layers, Channels, Paths, Pages, History, Anchor dock", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Color" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Swatches" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Character" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Paragraph" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stroke" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Transform" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Layers" })).toBeVisible();
    await page.locator("#g-layers [data-tab=channels]").click();
    await expect(page.locator("#channel-list")).toContainText("RGB");
    await expect(page.locator("#channel-list")).toContainText("Red");
    await page.locator("#g-layers [data-tab=paths]").click();
    await expect(page.locator("#path-list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pages" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Navigator" })).toBeVisible();
    await page.locator("#g-nav [data-tab=history]").click();
    await expect(page.locator("#history-list")).toBeVisible();
    await expect(page.locator("#g-anchor")).toBeHidden();
    await page.locator("[data-menu=window]").click();
    await page.locator("[data-cmd=win-anchor]").click();
    await expect(page.locator("#g-anchor")).toBeVisible();
    await expect(page.locator("#g-anchor")).toContainText("Op queue");
  });

  test("first working loop: New, type, image, transform, Image Size, export, undo", async ({ page }) => {
    await page.goto("/");
    await bootReady(page);

    await page.locator("[data-menu=file]").click();
    await page.locator("[data-cmd=new]").click();
    await page.locator("[data-preset=print-a3]").click();
    await page.locator("[data-dlg=new-ok]").click();
    await expect(page.locator("#dlg-new")).toBeHidden();

    await page.locator("[data-tool=type]").click();
    const canvas = page.locator("#skia");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas box");
    await page.mouse.click(box.x + 220, box.y + 180);

    await page.locator("[data-tool=move]").click();
    await page.locator("#tr-x").fill("80");
    await page.locator("#tr-x").press("Enter");
    await page.locator("#tr-y").fill("60");
    await page.locator("#tr-y").press("Enter");

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

    await page.locator("[data-menu=image]").click();
    await page.locator("[data-cmd=image-size]").click();
    await expect(page.locator("#dlg-image")).toBeVisible();
    await page.locator("#img-w").fill("800");
    await page.locator("[data-dlg=image-ok]").click();
    await expect(page.locator("#dlg-image")).toBeHidden();

    await page.locator("[data-menu=file]").click();
    await page.locator("[data-cmd=export-png]").click();
    await page.locator("[data-menu=file]").click();
    await page.locator("[data-cmd=export-pdf]").click();

    await page.locator("[data-menu=edit]").click();
    await page.locator("[data-cmd=undo]").click();
  });
});
