// VERIFIER-ONLY Playwright override (zcode-verify-pc6, VIRO-0140 gate d).
// Mirrors ../playwright.config.ts but serves THIS worktree on port 5196:
// 5173 is occupied by another agent's dev server, and the stock config's
// reuseExistingServer would silently test the wrong code. Remove after use.
import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".pw-browsers");

export default defineConfig({
  testDir: join(root, "tests"),
  testMatch: "**/*.spec.ts",
  timeout: 240_000,
  fullyParallel: false,
  retries: 2,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5196",
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
    command: "npx vite --mode web --host 127.0.0.1 --port 5196 --strictPort",
    url: "http://127.0.0.1:5196",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
