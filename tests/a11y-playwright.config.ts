import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VIRO-0016 runner for tests/a11y-keyboard.spec.ts.
 *
 * Identical to the root playwright.config.ts except for the port: the root
 * config pins 127.0.0.1:5173 with `reuseExistingServer: true`, so on a machine
 * where a stale dev server (e.g. another checkout's) already answers on 5173,
 * every spec silently runs against code that is not the worktree under test.
 * This config pins the a11y suite to 5177 and always starts its own server,
 * so the spec can only ever exercise this worktree's desk.
 */
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(dirname(fileURLToPath(import.meta.url)), "..", ".pw-browsers");

const config: PlaywrightTestConfig = {
  ...{
    testDir: ".",
    testMatch: "a11y-*.spec.ts",
    timeout: 240_000,
    fullyParallel: false,
    retries: 2,
    reporter: [["list"]],
  },
  use: {
    baseURL: "http://127.0.0.1:5177",
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
    // Playwright defaults a webServer's cwd to the directory of THIS config
    // file (tests/), which would serve the wrong vite root. Pin the repo root.
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    command: "npx vite --mode web --host 127.0.0.1 --port 5177 --strictPort",
    url: "http://127.0.0.1:5177",
    reuseExistingServer: false,
    timeout: 120_000,
  },
};

export default defineConfig(config);
