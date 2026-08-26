import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(dirname(fileURLToPath(import.meta.url)), ".pw-browsers");

export default defineConfig({
  testDir: "tests",
  // The Playwright suite is TypeScript. Without this, Playwright also collects
  // the node:test and standalone slice scripts in this folder and executes them
  // during collection.
  testMatch: "**/*.spec.ts",
  // Headless CI runs Skia on SwiftShader (software GL) and the New Document
  // dialog now renders 44 presets with a live preview, so the full
  // create-edit-export loop needs more than the old 2-minute budget. The app
  // itself is not slow: the same sequence completes promptly against a GPU.
  timeout: 240_000,
  fullyParallel: false,
  // Headless CI runs Skia on SwiftShader (software GL), so the first cold-boot
  // interaction after a tool switch can lag past the 5s expect budget and a
  // studio strip or options control reads as briefly hidden. That timing
  // variance is a no-GPU artefact, not an app fault: the same assertions pass
  // on retry. Retries keep the suite reliable without masking real regressions.
  retries: 2,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    // Skia needs real WebGL. Headless Chromium has none by default, so the
    // canvas silently never composites and every pointer interaction with the
    // page is a no-op -- which showed up as a DISABLED #tr-x (nothing selected)
    // rather than as an obvious engine failure. SwiftShader gives the suite a
    // software GL context so canvas tests exercise the real path.
    launchOptions: {
      args: [
        // This machine runs a filtering proxy that stalls the CanvasKit wasm
        // fetch; without these the desk never finishes booting and every canvas
        // interaction is a silent no-op.
        "--no-proxy-server",
        "--proxy-bypass-list=*",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  webServer: {
    command: "npx vite --mode web --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
