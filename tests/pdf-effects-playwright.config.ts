import { defineConfig } from "@playwright/test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VIRO-0146 — the test:chrome suite on THIS machine's designated port.
 *
 * playwright.config.ts (repo root) pins the webServer to 127.0.0.1:5173 with
 * `reuseExistingServer: true`. On this machine 5173 is currently occupied by
 * ANOTHER worktree's dev server, so the stock entry point would silently run
 * the whole chrome suite against foreign code. This config is byte-for-byte
 * the stock behaviour except the port: 5203, the port this worktree was
 * assigned. Run with:
 *
 *   npx playwright test --config tests/pdf-effects-playwright.config.ts
 *
 * The config file itself lives under the packet's tests/pdf-effects-* lease.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".pw-browsers");

export default defineConfig({
  testDir: root,
  testMatch: "**/*.spec.ts",
  timeout: 240_000,
  fullyParallel: false,
  retries: 2,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5203",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: [
        "--no-proxy-server",
        "--proxy-bypass-list=*",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: {
    command: "npx vite --mode web --host 127.0.0.1 --port 5203 --strictPort",
    url: "http://127.0.0.1:5203",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
