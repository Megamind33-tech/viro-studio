# npm view record — 2026-08-24

Rule from `19-ENGINE-RESEARCH.md`: do not invent package names. Every name below printed a version from the npm registry.

Node `v24.18.0` · npm `11.16.0` · `NODE_OPTIONS=--use-system-ca` (this machine’s TLS intercept).

## Installed (view proved)

| Package | npm view |
|---|---|
| canvaskit-wasm | 0.42.0 |
| harfbuzzjs | 1.6.0 |
| fontkit | 2.0.4 |
| opentype.js | 2.0.0 |
| lcms-wasm | 1.0.5 |
| pdfkit | 0.20.1 |
| pdf-lib | 1.17.1 |
| @pdf-lib/fontkit | 1.1.1 |
| paper | 0.12.18 |
| clipper2-wasm | 0.4.0 |
| ag-psd | 31.0.2 |
| jszip | 3.10.1 |
| idb | 8.0.3 |
| vite | 8.2.2 |
| electron | 43.4.1 |
| typescript | 7.0.2 |
| vite-plugin-electron | 1.1.1 |
| playwright | 1.62.1 |
| @playwright/test | 1.62.1 |
| buffer | 6.0.3 |
| @types/node | 26.2.0 |
| onnxruntime-web | 1.27.0 |

## Verified, not default-locked

| Package | npm view | Notes |
|---|---|---|
| @kittl/little-cms | 1.0.3 | Alternate lcms2 bindings. Primary is `lcms-wasm`. |
| clipper2-ts | 2.0.1-18 | Skia PathOp is first boolean path. |
| idmlkit | 0.1.0 | IDML later. Not `.indd`. |

pdfkit 0.20.1 superseded the 0.19.1 figure in the 2026-08-24 research note.
