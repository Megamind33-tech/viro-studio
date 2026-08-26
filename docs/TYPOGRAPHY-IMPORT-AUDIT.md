# Typography and Editable Import Audit

Verified: 2026-08-25

Scope: the current repository and the running editor at
`http://127.0.0.1:5173/`. This is an evidence ledger, not a roadmap presented as
finished work.

## Executive finding

Viro has useful foundations: CanvasKit rendering, real HarfBuzz shaping,
font-unit glyph outlines, a typed command bus with derived inverses, a versioned
document, PSD raster-layer import, editable VDJ text import, and vector PDF text
export. It does not yet have an interactive text editor or a professional font
system.

The live Type tool creates a default `Type` frame on every click. Typing into
the canvas does not edit its story, double-clicking creates another frame, and
dragging does not create a distinct paragraph-text frame. The source confirms
why: there is no caret, selection, text-edit session, range command, point-text
model, font registry, or cluster map from HarfBuzz back to the source string.

Editable import is also format-specific, not a general layer-recovery feature.
The PSD importer maps raster canvases and groups but explicitly skips live text
or smart objects without a bitmap. PDF, SVG, DOCX, RTF, and TXT imports do not
exist. JPEG/PNG placement stores one image asset and performs no OCR or layer
reconstruction.

## Evidence collected

- Inspected `src/document/types.ts`, `factory.ts`, `ops.ts`, `migrate.ts`,
  `commands.ts`, `ui-commands.ts`, and `command-bus.ts`.
- Inspected `src/engine/type.ts` and the compositor type-frame call sites.
- Inspected PSD/VDJ import, PDF export, Electron file filters, and the editor UI.
- Tested the open editor with real pointer and keyboard actions.
- Ran 219 unit tests: all passed.
- Ran CanvasKit, HarfBuzz, and LittleCMS engine smoke tests: all passed.
- Ran five browser tests: all five assertions passed. The runner did not exit
  after reporting them and was stopped after an extended idle period.
- Built production successfully in about 2 minutes 8 seconds. The build reports
  browser-externalized Node modules and chunks above 500 kB.

The current tests establish command inverses, transforms, image-fit behavior,
basic chrome presence, and engine loading. They do not establish interactive
text editing, rich text, font selection, Unicode caret behavior, editable
imports, or type export round trips.

## Capability matrix

Legend: **Works**, **Partial**, **UI-only**, **Broken**, **Missing**, or
**Architecture blocker**.

| Feature | UI | Model | Engine | Save/reopen | Undo/redo | Export | Evidence | Status |
|---|---|---|---|---|---|---|---|---|
| Font family | One Noto Sans option | `fontId` string | One hardcoded face | ID persists | No font-change command | One embedded Noto face | `app.ts` loads only `/fonts/NotoSans-Regular.ttf`; both pickers contain one option | **Architecture blocker** |
| Font style/weight | None | None | None | No | No | No | No face/instance distinction | **Missing** |
| Font size | Character and options fields | One value per story | Applied to all glyphs | Yes | Command covered | Applied to PDF | No selected-range model; live field result needs a dedicated outcome test | **Partial** |
| Point text | Type icon only | No point/area discriminator | Every type object is a box | Generic JSON only | Frame creation only | Exports as a frame | Canvas click creates a fixed-width, two-line frame | **Missing** |
| Paragraph text | Generic frame | One frame box | Greedy wrapping | Yes | Generic resize | Yes | Drag gesture creates the same default-frame behavior, not an authored area frame | **Partial** |
| Direct typing | No caret/input surface | Whole-string setter only | Can render supplied strings | Setter persists | Whole-story command | Yes | Pointer typing was ignored; double-click created another layer | **Broken** |
| Text selection | None | No selection state or ranges | No cluster/caret data | No | No | N/A | No edit-session or overlay implementation | **Architecture blocker** |
| Mixed formatting | Character panel suggests formatting | One character object per story | One style/face per composition | No ranges | No range commands | One PDF font/style | `Story.character` applies to the entire string | **Architecture blocker** |
| Variable fonts | None | None | No axis coordinates | No | No | No | No family/face/instance registry or axis metadata | **Missing** |
| OpenType features | None | `otFeatures: string[]` globally | Feature tags reach HarfBuzz | Yes | No dedicated command | Shaped glyphs export | Default stories enable `kern` and `liga`; no per-range or font-capability UI | **Partial** |
| Font fallback | None | None | One face for every story | No | No | No | `fontId` is not resolved by the compositor | **Missing** |
| Missing fonts | None | Requested ID can remain | Renderer still receives bundled face | ID persists without a warning | No | Silently uses the available face | No missing-font status or substitution record | **Broken** |
| Font substitution | None | None | None | No | No | No | No find/replace-font operation | **Missing** |
| Frame resizing | Generic W/H controls and handles | Generic transform | Width triggers reflow | Yes | Generic transform command | Yes | No separate point/area semantics or text-frame mode | **Partial** |
| Character H/V scaling | None | None | None | No | No | No | Generic layer scale is not character scaling | **Missing** |
| Text-object transforms | Generic move/resize/rotate | Rotation plus scale fields | World transform is composited | Yes | Generic command | PDF transform path exists | No skew, warp, type-specific commit-to-typography, or explicit transform semantics | **Partial** |
| Selected-word magnification | None | No word/range state | No range style layout | No | No | No | Unicode word selection is absent | **Architecture blocker** |
| Paragraph formatting | Alignment, first indent, after | One paragraph object per story | Four alignments, indent, after | Yes | Commands covered | Yes | Applies to the whole story; no paragraph ranges | **Partial** |
| Unicode shaping | No editing UI | Plain JS string | HarfBuzz shapes a guessed run | Text persists | Whole-story only | Glyph placement exported | Shaped glyph `cluster` is discarded; no bidi run orchestration or fallback | **Partial** |
| Unicode line breaking | None | N/A | Whitespace regex plus `Array.from` fallback | N/A | N/A | Same layout reused | Not UAX #14, grapheme-safe, or language-hyphenated | **Broken** |
| Threaded text | None | `nextFrameId` exists | Link is ignored during composition | Field persists | No commands | Frames export independently | No ports, story flow, cycle checks, or unlink behavior | **UI-only model hook** |
| Overset | No editable indicator/navigation | No stored preflight state | `composeFrame().overflow` | Recomputed | No | Red marker exported | No thread continuation, story navigation, or preflight panel | **Partial** |
| PSD raster layers | Open supports PSD | Groups and image frames | CanvasKit renders assets | Yes | Open is a snapshot entry | Raster/vector PDF mix | `ag-psd` canvases are mapped | **Works with limits** |
| PSD live text | None | No run model for PSD text | N/A | No | No | No | Importer comment states text without bitmaps is skipped | **Missing** |
| PSD smart objects/effects | None | None | N/A | No | No | No | Unsupported and not preserved as reference metadata | **Missing** |
| PDF import | File filter excludes PDF | None | None | No | No | Export only | No PDF parser/import entry point | **Missing** |
| SVG import/export | File filter excludes SVG | Vector paths exist but no SVG text model | No SVG pipeline | No | No | No | No importer/exporter | **Missing** |
| DOCX/RTF/TXT placement | File filters exclude them | No style mapping | No parser | No | No | No | Place accepts `image/*` only | **Missing** |
| JPEG/PNG layer reconstruction | Place image exists | One image asset/frame | Raster draw | Yes | Image-place command | Raster PDF/PNG | No OCR, segmentation, provenance, or confidence | **Missing** |

## Root causes

### 1. The document model cannot describe professional typography

`Story` contains one string, one `CharacterStyle`, and one `ParagraphStyle`.
It cannot represent mixed fonts, emphasized words, multiple paragraph styles,
source ranges, local overrides, variable axes, fallbacks, or style references.
`TypeFrameLayer.nextFrameId` is present but has no operational semantics.

### 2. There is no text-editing state machine

The pointer handler for the Type tool always dispatches `type.addFrame`.
There is no distinction among creating point text, dragging area text, entering
an existing story, placing a caret, selecting a range, composing an IME edit,
or transforming the text object. The only text mutation API replaces the whole
story string.

### 3. Shaping output is render-only

HarfBuzz returns glyph information and positions, but Viro stores only glyph
ID, offsets, and advance. It discards source clusters. A glyph and a source
character are not one-to-one for ligatures, combining marks, complex scripts,
or emoji sequences. Without clusters, correct caret stops, selections, hit
testing, deletion, fallback, and range styling cannot be built.

The line breaker additionally splits on whitespace and breaks an oversized
word with `Array.from`. That is not Unicode line breaking and is not sufficient
for script-sensitive or grapheme-sensitive composition.

### 4. `fontId` is metadata, not resolution

The application loads one Noto Sans face at startup. The compositor and PDF
exporter receive that face directly rather than resolving the story's font ID
through a registry. A missing or different font therefore has no honest state.

### 5. Imports flatten or skip data according to each source format

PSD raster canvases work, but live text and smart-object semantics are not
mapped. Native PDF, SVG, Word, RTF, and text placement have no pipelines.
Flattened JPEG/PNG designs have already lost their source layer graph; any new
layers must be explicitly labelled as inferred reconstructions.

### 6. Tests prove command plumbing, not typography outcomes

The browser “first working loop” clicks the Type tool and then continues. It
does not type into the new layer or assert its story. It fills transform fields
without asserting the canonical transform. It exports without inspecting the
type content. Passing this test therefore cannot support a claim that typing,
text editing, font editing, or editable import works.

### 7. Capability documentation has drifted

The import/export ledger says the Electron bridge is used, while the file-format
document says the bridge is called by nothing. Current `desk.ts` does call the
bridge. Capability ledgers need executable checks or a single maintained source
of truth.

## Research contract

The implementation must preserve the distinctions established by professional
tools and standards:

- Photoshop distinguishes point text from paragraph text and keeps editable
  type separate from object transforms.
- InDesign separates frame geometry from character formatting, supports linked
  stories, overset state, paragraph/character styles, missing-font workflows,
  variable fonts, and placed Word style mapping.
- OpenType shaping requires script, language, direction, features, and font
  instance data.
- HarfBuzz clusters must survive shaping so editing can map glyph geometry back
  to source text.
- Unicode UAX #9 and UAX #14 define bidirectional ordering and line-break
  opportunities.
- PDF, PSD, SVG, and flattened raster images expose different recoverable
  structures; one “break into layers” promise would be technically dishonest.

Primary references:

- https://helpx.adobe.com/photoshop/desktop/text-typography/get-started-with-text/add-text.html
- https://helpx.adobe.com/photoshop/using/editing-text.html
- https://helpx.adobe.com/indesign/desktop/add-and-manage-text/add-and-import-text/thread-text-frames.html
- https://helpx.adobe.com/indesign/desktop/format-and-style-text/text-styles/create-and-edit-text-styles.html
- https://helpx.adobe.com/indesign/desktop/fonts/find-and-replace-fonts.html
- https://learn.microsoft.com/en-us/typography/opentype/spec/otvaroverview
- https://harfbuzz.github.io/shaping-concepts.html
- https://harfbuzz.github.io/working-with-harfbuzz-clusters.html
- https://www.unicode.org/reports/tr9/
- https://unicode.org/reports/tr14/
- https://www.w3.org/TR/SVG2/text.html
- https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/

## Required implementation sequence

### Slice T1: versioned rich-text schema

Add an additive document version with:

- stable character and paragraph ranges;
- style IDs plus local overrides;
- point/area/path text kind;
- frame insets, columns, vertical alignment, auto-size, and thread metadata;
- requested font, fallback, language, script, direction, OpenType, and variable
  axis data;
- deterministic migration from v1-v3 documents;
- validation and exact migration round-trip tests.

This slice must not yet pretend to render unsupported properties. It creates an
honest, serializable contract for later slices.

### Slice T2: font registry

Introduce one resolver used by the editor, compositor, thumbnails, importer,
PDF/SVG exporters, and Anchor. Separate family, face, variable instance, project
asset, system reference, missing reference, and substitution. Retain license and
embedding metadata.

### Slice T3: cluster-preserving layout

Retain HarfBuzz clusters and segment by style, script, language, direction, and
fallback face. Add bidi ordering, Unicode line-break opportunities, grapheme
safety, reusable caret stops, selection geometry, and script fixtures.

### Slice T4: editing session

Implement point-text click, area-text drag, entry into existing text, caret,
selection, clipboard, IME, word/paragraph selection, and typed range commands.
Typing must coalesce into undo transactions. Anchor must use the same commands.

### Slice T5: formatting and transforms

Connect real family/face pickers and range formatting. Keep font size, frame
resize, object transform, character H/V scaling, selected-word magnification,
and canvas zoom as distinct operations with separate tests.

### Slice T6: threading and preflight

Implement story flow, ports, overset navigation, circular-link prevention,
unlink preservation, missing-font preflight, and export preflight.

### Slice I1-I5: editable imports

Proceed in this order: PSD live text and retained unsupported metadata; SVG
text/vector import/export; native PDF text/vector reconstruction with
provenance; DOCX/RTF/TXT placement and style mapping; then confidence-labelled
OCR/segmentation for flattened raster designs.

## Acceptance gate for the first implementation slice

Do not begin UI expansion until the rich-text model has all of the following:

1. A current document version and deterministic v1-v3 migration.
2. Valid empty and mixed-style stories.
3. Range normalization after insertion, deletion, and replacement.
4. Grapheme-safe public edit boundaries.
5. Exact undo/redo through typed commands.
6. Save/reopen preservation.
7. Validation for overlapping, inverted, and out-of-bounds ranges.
8. Unit fixtures for Latin ligatures, combining marks, RTL text, Devanagari,
   Thai, CJK, and emoji sequences.
9. No changes to the meaning of existing transforms or image-fit behavior.
10. All current tests still passing.

## Concurrent work boundary

`src/document/command-bus.ts`, `src/document/ui-commands.ts`, and their tests are
the newest source files in the repository. Treat them as active concurrent work.
The first schema/layout work should be additive and isolated; integration into
the command registry should be a small reviewed patch after checking their
latest contents again.
