/**
 * Trigger File > Export PDF and wait for the download.
 *
 * Exists because a bare `waitForEvent("download")` failure is a 60-second
 * silence followed by `TimeoutError` with an empty log — which says nothing
 * about why. The real cause the first time was a stale Vite dependency cache
 * returning `504 (Outdated Optimize Dep)` for the dynamic import of
 * `src/export/pdf.ts`, and that message was sitting uncollected in the page
 * console the whole time. Surfacing it turns a mystery into a one-line
 * diagnosis.
 */
export async function exportPdf(page, pageErrors, timeout = 60_000) {
  try {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout }),
      page.evaluate(() => {
        document.querySelector('[data-menu="file"]')?.click();
        document.querySelector('[data-cmd="export-pdf"]')?.click();
      }),
    ]);
    return dl;
  } catch (err) {
    const seen = pageErrors.length ? pageErrors.join("\n    ") : "(none captured)";
    const hint = /Outdated Optimize Dep|dynamically imported module/.test(seen)
      ? "\n  HINT: stale Vite dep cache. Stop the dev server, delete node_modules/.vite, restart."
      : "";
    throw new Error(`PDF export produced no download within ${timeout}ms.\n  page errors:\n    ${seen}${hint}`);
  }
}
