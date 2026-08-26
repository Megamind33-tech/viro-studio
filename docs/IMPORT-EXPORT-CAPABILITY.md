# Import / export capability

An honesty ledger. Every row is verified against source or against an inspected
output file. Nothing here is aspirational; where something does not work, the row
says so and names the evidence.

Last verified: 2026-08-25, foundation slice 2.

## Export

| Format | State | Evidence / limits |
|---|---|---|
| PNG | **Works** | Verified by download and pixel inspection. Composited page at document pixel size. |
| PDF — vector shapes | **Works** | `emitVector` writes real path operators. Content stream inspected for `re` / `m` / `l` / `c`. |
| PDF — text | **Works, embedded + subset** | `@pdf-lib/fontkit` embeds `NotoSans-Regular.ttf`; `FontFile2` present. Text is selectable, not raster. |
| PDF — group transforms | **Works** | `cm = 1 0 0 1 1300 1700` found in the content stream for a group at (1300,1700). Asserted by `tests/group-parity.spec.mjs`. |
| PDF — images | Raster, by nature | Embedded raster honouring frame fit/crop, **clipped to the frame** (`frame ∩ dest`). Verified by inspecting the content stream for `0 0 1200 600 re W n` on a `cover` frame whose content rect is 1200×2400. |
| **PDF — multi-page** | **NOT IMPLEMENTED** | `src/export/pdf.ts` takes `doc.pages.find(p => p.id === doc.activePageId)`. Only the active page is exported. Defect #7. |
| **PDF — colour** | **Untagged DeviceRGB** | No output intent, no ICC profile, no CMYK separation. Producer string states this. |
| **PDF/X** | **NO** | Not claimed anywhere in the product. Requires ICC output intent, bleed boxes, marks and validation — none present. |
| JPEG / WebP export | **NOT IMPLEMENTED** | Foundation deliverable E. |
| SVG export | **NOT IMPLEMENTED** | Do not claim vector-asset output. |
| Export report | **NOT IMPLEMENTED** | No listing of rasterised layers, unsupported features or missing assets. |

### PDF group opacity — a known divergence, deliberately reported

The canvas composites a group into its own layer, then applies group opacity and
blend. The exporter folds group opacity into each child and drops group-level
blend. Overlapping children inside a semi-transparent group therefore show
through one another in the PDF where the canvas would not.

This is surfaced in the export report notes at run time rather than hidden.

## Import

| Source | State | Evidence / limits |
|---|---|---|
| PSD — raster layers | Works | `ag-psd`, converted to RGB. |
| **PSD — live text** | **SKIPPED** | `src/import/psd.ts:56` states it: text and smart objects without bitmaps are skipped. Defect #8. |
| **PSD — smart objects** | **SKIPPED** | As above. Not editable, not preserved. |
| **PSD — adjustment / effects** | **NOT IMPORTED** | No layer-style or adjustment mapping. |
| VDJ (`.vdj` / `.json`) | Works | Own format. v1 migrated on open, reported in the status line. See `FILE-FORMAT.md`. |
| PNG / JPEG / WebP place | Works | Placed as an image frame. |
| SVG import | **NOT IMPLEMENTED** | |
| Electron Open / Save | **Works** | The File menu uses `viroPress.openFile` / `saveFile` when the preload bridge exists. Browser builds retain the file-input and download fallbacks. |

## Colour management — read this before claiming anything

LittleCMS is loaded and real, but it is used for **one thing**: a single
sRGB→Lab sample (`rgb8ToLab`, `src/engine/lcms.ts:32`).

There is **no CMYK pipeline**: no CMYK profile, no separation, no soft proof, no
output intent.

The previous `CMYK/8` status claim and selectable CMYK New Document option have
been removed. New documents, including print-preset documents, are normalised
to RGB; the status bar reports `RGB/8`. CMYK may return only with a real profile,
separation, proofing and export pipeline. Existing files that carry historical
`cmyk` metadata are still rendered and exported through the RGB pipeline. The
rendering-intent selector was also removed from New Document because the stored
value does not yet drive a colour transform.
