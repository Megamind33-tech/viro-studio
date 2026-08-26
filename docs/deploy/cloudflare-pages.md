# Deploy: Cloudflare (VIRO Press frontend)

VIRO Press is a static, local-first Vite/Skia SPA. Per
[ADR 0004](../adr/0004-platform-architecture.md), Cloudflare is the frontend host
(Supabase + Lenco Pay are added later, behind feature flags). This runbook covers
hosting the static bundle only. It ships **no server code** today — no Worker script,
no Pages Functions, no accounts, no payments.

> **Deploy model: Workers Static Assets** (not Cloudflare Pages). The Cloudflare deploy
> pipeline runs `npx wrangler deploy` — the Workers deploy. That command does **not**
> understand a Pages‑style config (`pages_build_output_dir`); on one it fails with
> _"It seems that you have run `wrangler deploy` on a Pages project"_ and
> _"Missing entry-point to Worker script or to assets directory."_ Because VIRO Press has
> no server code, we deploy it as an **assets‑only Worker**: `assets.directory` in
> `wrangler.jsonc` is the entry point, so `npx wrangler deploy` works with **no dashboard
> or command change**. See [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

> Owner action required: deploying and the initial Cloudflare authentication (OAuth /
> `wrangler login`) can only be done by the account owner. An agent cannot authenticate
> a Cloudflare account or create the project. Everything below is a repo-side, validated
> configuration; the go-live steps are the owner's. **There is also one outstanding
> blocker — the >25 MiB ONNX runtime — see "Known blocker" below.**

## What's in the repo

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Assets‑only Worker config (`name`, `compatibility_date`, `assets.directory: ./dist`, `assets.not_found_handling: single-page-application`). Source of truth for `npx wrangler deploy`. |
| `public/_headers` | MIME (`application/wasm`), immutable caching for hashed/vendored assets, security headers + CSP. Copied into `dist/` by the build; parsed by Workers and applied to asset responses. |

The SPA history fallback is handled by `assets.not_found_handling` (see below), **not** by a
`_redirects` file — so there is no longer a `public/_redirects`.

## Build contract

- **Build command:** `npm run build`
- **Assets directory:** `dist` (set as `assets.directory` in `wrangler.jsonc`)
- **Node version:** 20 or newer (`package.json` `engines.node >= 20`)
- **Install step** runs `postinstall` (`scripts/copy-wasm.mjs` + `scripts/vendor-font.mjs`),
  which vendors the engine wasm runtimes into `public/wasm/` (gitignored) and the bundled
  fonts. `npm run build` then copies `public/{wasm,ml,fonts}` and `_headers`
  into `dist/`. A clean `npm install && npm run build` therefore produces a complete `dist/`.

The build emits `dist/index.html`, hashed `dist/assets/*`, the vendored `dist/wasm/*`,
`dist/ml/*`, `dist/fonts/*`, plus `dist/_headers`.

## Deploy command

The Cloudflare pipeline (Workers Builds / CI) runs, after the build:

```bash
npx wrangler deploy
```

`wrangler deploy` reads `name` and `assets.directory` from `wrangler.jsonc` and uploads
`dist/` as the Worker's static assets. No `main`/Worker script is required for an
assets‑only Worker. A convenience alias is provided:

```bash
npm run deploy   # === npm run build && npx wrangler deploy
```

Deploying requires Cloudflare auth (owner step, once):

```bash
# One-time, interactive, opens a browser for Cloudflare OAuth — OWNER ONLY:
npx wrangler login
```

### Validate the config without deploying (no auth needed)

```bash
npm run build
npx wrangler deploy --dry-run --outdir /tmp/wr-dry
```

A dry run parses `wrangler.jsonc`, reads the assets directory, and reports the upload
**without** contacting Cloudflare or requiring login. Use it in CI/pre-commit to catch
config regressions.

## SPA routing (history fallback)

`assets.not_found_handling: "single-page-application"` tells Workers: when an incoming
request matches no file in `dist/`, serve `/index.html` with `200 OK`. Real files
(`/assets/*`, `/wasm/*`, `/ml/*`, `/fonts/*`, `/favicon.ico`) are matched and served
first, so the fallback only affects client‑side routes with no matching asset. See the
[SPA routing docs](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/).

> **Why not a `_redirects` `/* /index.html 200`?** Under Workers Static Assets,
> `_redirects` rules are _always_ followed **regardless of whether an asset matches the
> request** ([docs](https://developers.cloudflare.com/workers/static-assets/redirects/)),
> so a `/*` catch‑all would shadow every real asset (JS, wasm, fonts). The old Pages
> `_redirects` catch‑all was therefore removed and replaced with `not_found_handling`,
> which is the Cloudflare‑recommended SPA mechanism and preserves the exact same
> behavior (index.html served with 200 for unmatched routes).

## Headers & caching (why)

Workers Static Assets parses `dist/_headers` and applies it to asset responses,
overriding the defaults Cloudflare would otherwise send
([docs](https://developers.cloudflare.com/workers/static-assets/headers/)). Our rules:

- `.wasm` is served as `application/wasm` (`/*.wasm` rule) so streaming WebAssembly
  compilation works for Skia/HarfBuzz/LittleCMS/ONNX.
- `/assets/*` (Vite content-hashed) and the stable vendored `/wasm/*`, `/ml/*`, `/fonts/*`
  get `Cache-Control: public, max-age=31536000, immutable`. `index.html` is left on the
  Workers default (`public, max-age=0, must-revalidate`) so new deploys are picked up
  immediately.
- Security: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`,
  and a same-origin CSP that still allows the app's own wasm (`'wasm-unsafe-eval'`),
  workers (`worker-src blob:`), inline `style="..."` attributes, and its `data:`
  image/PDF pipeline.
- **No COOP/COEP (cross-origin isolation).** The app does not use `SharedArrayBuffer`:
  ONNX runs single-threaded (`ort.env.wasm.numThreads = 1` in `src/engine/cutout.ts`) and
  CanvasKit uses the non-threaded `bin/full` build. Enabling `Cross-Origin-Embedder-Policy`
  would add no capability and risks breaking subresource loads, so it is intentionally not set.

## Known blocker — the ONNX runtime exceeds Cloudflare's 25 MiB file cap

Cloudflare enforces a **maximum static‑asset file size of 25 MiB per file** on **both**
Workers Static Assets ([error: "Asset too large … supports assets with sizes of up to
25 MiB"](https://developers.cloudflare.com/workers/static-assets/)) and Cloudflare Pages
([Pages limits — "The maximum file size for a single Cloudflare Pages site asset is
25 MiB"](https://developers.cloudflare.com/pages/platform/limits/)). This is **independent
of the Pages‑vs‑Workers choice.**

The subject‑cutout feature loads onnxruntime‑web's default (`jsep`) build, which fetches
`/wasm/ort/ort-wasm-simd-threaded.jsep.wasm` — **~25.6 MiB**, just over the cap. `npx
wrangler deploy` therefore fails with `Asset too large` on that file. (Vite also emits a
never‑fetched duplicate under `dist/assets/…jsep-*.wasm`, since the runtime `wasmPaths`
points at `/wasm/ort/`.)

Fixing this needs a decision beyond the deploy config (it touches how ONNX is loaded or
where the binary is hosted) — pick one:

1. **Use the non‑jsep CPU build (recommended).** The app is CPU‑only single‑threaded
   (`executionProviders: ["wasm"]`), so it does not need the WebGPU/WebNN `jsep` binary.
   Switching onnxruntime‑web to `ort-wasm-simd-threaded.wasm` (**~13.5 MiB**, under the
   cap) resolves it. This is a small `src/engine/cutout.ts` change (e.g. import the wasm
   backend entry, or pin `ort.env.wasm.wasmPaths` to the non‑jsep file) plus trimming
   `scripts/copy-wasm.mjs` to vendor only that variant.
2. **Host the large runtime on R2** with a public bucket / custom domain and point
   `ort.env.wasm.wasmPaths` at it, so it is not served as a Worker/Pages static asset.
3. **Request a Cloudflare file‑size limit increase** (Enterprise / limit‑increase form).

Until one of these lands, the deploy will stop at `Asset too large` even though the
entry‑point/config error is fixed.

## Environment variables & secrets (future — ADR 0004)

Today's bundle contains **no secrets** and makes no backend calls. When the Supabase and
Lenco Pay phases land (P1–P3 in ADR 0004):

- Client-safe values (e.g. `SUPABASE_URL`, `SUPABASE_ANON_KEY`) are injected as build‑time
  environment variables. They are public by nature (RLS enforces authorization) — never
  treat them as secrets.
- Server-only secrets (`LENCO_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`) must **never** be
  in the client bundle. They belong in **Supabase Edge Function secrets** or a dedicated
  Worker's secrets (`wrangler secret put`), used only server-side (per GOVERNOR.md
  Security Rules and ADR 0004).

## Owner steps to go live (cannot be done by an agent)

1. Authenticate Cloudflare (OAuth): dashboard sign-in, or `npx wrangler login`.
2. Connect the repo as a **Workers** project (Workers & Pages → Create → **Import a
   repository** → Workers), or deploy manually with `npx wrangler deploy`. The build
   command is `npm run build`; the deploy command `npx wrangler deploy` is already what
   the pipeline runs — no change needed now that `wrangler.jsonc` is an assets‑only
   Worker config.
3. **Resolve the ONNX 25 MiB blocker** (see "Known blocker" above) — otherwise the deploy
   stops at `Asset too large`.
4. (Optional) Confirm/rename the Worker name (default `viro-press`; lowercase,
   alphanumeric + dashes).
5. (Optional) Attach a custom domain to the Worker.
6. Verify the live site loads the editor and that `.wasm`/model/font assets return `200`
   with `application/wasm` and the immutable cache headers.

Deployment and authentication remain the owner's responsibility; this repo provides the
validated, deploy-ready configuration (modulo the ONNX file‑size blocker above).
