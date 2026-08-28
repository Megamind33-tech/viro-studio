import { defineConfig, type Config } from "@playwright/test";
import baseConfig from "../playwright.config";

/**
 * VIRO-0017 seat-local gate runner.
 *
 * The canonical `npm run test:chrome` (playwright.config.ts) boots its own dev
 * server on 127.0.0.1:5173 with reuseExistingServer — correct on a clean
 * machine, but on a shared build box another packet's worktree may already
 * hold 5173, and Playwright would then run this suite against FOREIGN code.
 *
 * This config runs the identical suite against this worktree on the
 * coordinator-assigned seat port 5184 instead:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<shared ms-playwright cache> \
 *     npx playwright test --config=tests/visual-polish.playwright.config.ts
 *
 * It changes nothing about the product; it only re-points webServer/baseURL.
 * reuseExistingServer stays false so a foreign server on the seat port fails
 * loudly instead of silently testing the wrong tree.
 *
 * (Playwright 1.62 removed mergeConfig, so the base config is spread instead.
 * Note: relative fields like testDir resolve against THIS file's directory,
 * which is tests/ — hence testDir ".".)
 */
const base = baseConfig as Config;

export default defineConfig({
  ...base,
  testDir: ".",
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:5184",
  },
  webServer: {
    ...base.webServer,
    command:
      "node node_modules/vite/bin/vite.js --mode web --host 127.0.0.1 --port 5184 --strictPort",
    // webServer processes default to the config file's directory (tests/);
    // the vite module path and the serve root both need the worktree root.
    cwd: "..",
    url: "http://127.0.0.1:5184",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
