# Deploy: Cloudflare Pages (VIRO Press frontend)

VIRO Press is a static, local-first Vite/Skia SPA. Per
[ADR 0004](../adr/0004-platform-architecture.md), **Cloudflare Pages** is the frontend
host (Supabase + Lenco Pay are added later, behind feature flags). This runbook covers
hosting the static bundle only. It ships **no server code** today — no Pages Functions,
no accounts, no payments.

> Owner action required: deploying and the initial Cloudflare authentication (OAuth /
> `wrangler login`) can only be done by the account owner. An agent cannot authenticate
> a Cloudflare account or create the project. Everything below is a repo-side, validated
> configuration; the go-live steps are the owner's.

## What's in the repo

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Pages project config (`name`, `pages_build_output_dir: ./dist`, `compatibility_date`). Source of truth once deployed via Wrangler. |
| `public/_headers` | MIME (`application/wasm`), immutable caching for hashed/vendored assets, security headers + CSP. Copied into `dist/` by the build. |
| `public/_redirects` | SPA history fallback (`/* /index.html 200`). Copied into `dist/`. |

## Build contract

- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Node version:** 20 or newer (`package.json` `engines.node >= 20`)
- **Install step** runs `postinstall` (`scripts/copy-wasm.mjs` + `scripts/vendor-font.mjs`),
  which vendors the engine wasm runtimes into `public/wasm/` (gitignored) and the bundled
  fonts. `npm run build` then copies `public/{wasm,ml,fonts}`, `_headers`, and `_redirects`
  into `dist/`. A clean `npm install && npm run build` therefore produces a complete `dist/`.

The build emits `dist/index.html`, hashed `dist/assets/*`, and the vendored
`dist/wasm/*`, `dist/ml/*`, `dist/fonts/*`, plus `dist/_headers` and `dist/_redirects`.

## Option A — Dashboard (connect to Git) — recommended for continuous deploys

1. Owner signs in to the Cloudflare dashboard → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**.
2. Select the `Megamind33-tech/viro-studio` repository and the deploy branch.
3. Framework preset: **None / Vite**. Set:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Environment variable:** `NODE_VERSION = 20` (or newer).
4. Save & Deploy. Cloudflare runs the build in its CI and publishes `dist/`.
   Because `wrangler.jsonc` contains `pages_build_output_dir`, it becomes the source of
   truth for project config (see Cloudflare "source of truth" note); manage config here,
   not in the dashboard, going forward.

## Option B — Direct upload with Wrangler (manual / one-off)

Run locally after a build. Requires Cloudflare auth (owner step):

```bash
# One-time, interactive, opens a browser for Cloudflare OAuth — OWNER ONLY:
npx wrangler login

# Build, then deploy the output directory:
npm run build
npx wrangler pages deploy dist            # uses "name" from wrangler.jsonc
# or target the production branch explicitly:
npx wrangler pages deploy dist --branch <PRODUCTION_BRANCH>
```

`wrangler pages deploy` reads `name` and `pages_build_output_dir` from `wrangler.jsonc`.
The Pages project is created on first deploy if it does not exist.

## Headers & caching (why)

- `.wasm` is served as `application/wasm` so streaming WebAssembly compilation works for
  Skia/HarfBuzz/LittleCMS/ONNX.
- `/assets/*` (Vite content-hashed) and the stable vendored `/wasm/*`, `/ml/*`, `/fonts/*`
  get `Cache-Control: public, max-age=31536000, immutable`. `index.html` is left on the
  Pages default so new deploys are picked up immediately.
- Security: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`,
  and a same-origin CSP that still allows the app's own wasm (`'wasm-unsafe-eval'`),
  workers (`worker-src blob:`), inline `style="..."` attributes, and its `data:`
  image/PDF pipeline.
- **No COOP/COEP (cross-origin isolation).** The app does not use `SharedArrayBuffer`:
  ONNX runs single-threaded (`ort.env.wasm.numThreads = 1` in `src/engine/cutout.ts`) and
  CanvasKit uses the non-threaded `bin/full` build. Enabling `Cross-Origin-Embedder-Policy`
  would add no capability and risks breaking subresource loads, so it is intentionally not set.

## Environment variables & secrets (future — ADR 0004)

Today's bundle contains **no secrets** and makes no backend calls. When the Supabase and
Lenco Pay phases land (P1–P3 in ADR 0004):

- Client-safe values (e.g. `SUPABASE_URL`, `SUPABASE_ANON_KEY`) are injected as **Pages
  project environment variables** at build time. They are public by nature (RLS enforces
  authorization) — never treat them as secrets.
- Server-only secrets (`LENCO_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`) must **never** be
  in the client bundle. They belong in **Supabase Edge Function secrets** / Pages
  **Functions** secrets, set via the dashboard or `wrangler pages secret put`, and used
  only server-side (per GOVERNOR.md Security Rules and ADR 0004).

## Owner steps to go live (cannot be done by an agent)

1. Authenticate Cloudflare (OAuth): dashboard sign-in, or `npx wrangler login`.
2. Create/confirm the Pages project name (default `viro-press`; rename in `wrangler.jsonc`
   if desired — lowercase, alphanumeric + dashes).
3. Deploy via **Option A** (connect the repo) or **Option B** (`wrangler pages deploy dist`).
4. (Optional) Attach a custom domain in the Pages project.
5. Verify the live site loads the editor and that `.wasm`/model/font assets return `200`
   with `application/wasm` and the immutable cache headers.

Deployment and authentication remain the owner's responsibility; this repo only provides
the validated, deploy-ready configuration.
