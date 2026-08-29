import { defineConfig, type Config } from "@playwright/test";
import baseConfig from "../playwright.config";

/**
 * VIRO-0148 seat-local gate runner (zcode-status-pc1, port 5211).
 *
 * The canonical `npm run test:chrome` (playwright.config.ts) boots its own dev
 * server on 127.0.0.1:5173 with `reuseExistingServer: true`. On a shared build
 * box another worktree may already hold 5173, and Playwright would then run
 * this packet's gate against FOREIGN code. Same seat-port pattern VIRO-0017
 * established with tests/visual-polish.playwright.config.ts (5184).
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<shared ms-playwright cache> \
 *     npx playwright test --config=tests/a11y-status-playwright.config.ts
 *
 * Runs the identical chrome suite (every spec.ts target under tests/) against
 * THIS worktree on seat port 5211. `reuseExistingServer: false` makes a
 * foreign server on the seat port fail loudly instead of silently testing the
 * wrong tree.
 *
 * (Playwright 1.62 removed mergeConfig, so the base config is spread instead.
 * Relative fields like testDir resolve against THIS file's directory, which
 * is tests/ — hence testDir ".".)
 */
const base = baseConfig as Config;

export default defineConfig({
  ...base,
  testDir: ".",
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:5211",
  },
  webServer: {
    ...base.webServer,
    command:
      "node node_modules/vite/bin/vite.js --mode web --host 127.0.0.1 --port 5211 --strictPort",
    // webServer processes default to the config file's directory (tests/);
    // the vite module path and the serve root both need the worktree root.
    cwd: "..",
    url: "http://127.0.0.1:5211",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
