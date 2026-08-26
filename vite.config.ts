import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const webOnly = mode === "web";
  return {
    base: "./",
    publicDir: "public",
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    optimizeDeps: {
      exclude: ["canvaskit-wasm", "lcms-wasm", "harfbuzzjs", "onnxruntime-web"],
    },
    build: {
      target: "esnext",
    },
    assetsInclude: ["**/*.wasm", "**/*.onnx"],
    server: {
      port: 5173,
      strictPort: true,
      host: "127.0.0.1",
      watch: {
        ignored: ["**/public/ml/**", "**/*.onnx"],
      },
    },
    preview: {
      port: 5173,
      strictPort: true,
      host: "127.0.0.1",
    },
    plugins: webOnly
      ? []
      : [
          electron({
            main: { entry: "electron/main.ts" },
            preload: { input: "electron/preload.ts" },
          }),
        ],
  };
});
