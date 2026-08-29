import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VIRO-0147 — isolated runner for the styled-text pdf.js parity spec.
 *
 * Identical semantics to playwright.config.ts (same SwiftShader launch args,
 * same retries), but bound to port 5208 with its own vite webServer so this
 * packet's gate can run while another packet's chrome session holds 5173.
 * The spec also matches the main config's spec glob, so it runs as part of
 * the full chrome suite once merged.
 */

process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(dirname(fileURLToPath(import.meta.url)), "..", ".pw-browsers");

export default defineConfig({
  // This config lives inside tests/, so "." IS the tests directory.
  testDir: ".",
  testMatch: "pdf-styled-text-parity.spec.ts",
  timeout: 240_000,
  fullyParallel: false,
  retries: 2,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5208",
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
    command: "npx vite --mode web --host 127.0.0.1 --port 5208 --strictPort",
    url: "http://127.0.0.1:5208",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
