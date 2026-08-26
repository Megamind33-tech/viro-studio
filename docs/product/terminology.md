# Product Terminology (canonical)

Governed by `/GOVERNOR.md` §73. Consult before introducing any user-facing concept.
Use these terms exactly; do not introduce synonyms for the same concept.

| Canonical term | Meaning | Do NOT call it |
| --- | --- | --- |
| Document (`.press.json`) | The saved design file / `PressDocument` | file, project, design (in code) |
| Page | A page within a document | sheet |
| Artboard | A bounded canvas region on a page | frame page, board |
| Layer | Any document object (vector, image-frame, type-frame, group, adjustment) | element, item |
| Group | A layer containing child layers | folder |
| Type frame | A text layer | textbox (UI label may say "Type") |
| Image frame | A placed-image layer with fit/crop | picture |
| Vector path | A Bézier path layer | shape (Shape is the tool) |
| Command | A reversible document mutation on the command bus | action, mutation |
| History | The undo/redo stack + named snapshots | timeline |
| Autosave / Recovery | Local IndexedDB safety-net snapshot of the working document | backup, cloud save |
| Marks / Stock | Procedurally generated vector marks and stock (`catalog.ts`) | Elements, Assets rail |
| Preset | A starting document template (`presets.ts`) | template (reserve for curated families) |
| Library | Local user assets + fonts (IndexedDB) | cloud, DAM |
| Font (source: bundled / user / system) | A registered, actually-renderable face | — |
| Anchor | The structured, previewable, auditable op API (`window.viroAnchor`) | AI, assistant |
| Cutout | ONNX U²-Netp background removal | "Remove Background" (unless UI-labelled), magic |

Tool names (from the Tool Registry / toolbox): Move, Marquee, Lasso, Crop, Frame, Brush,
Pencil, Eraser, Gradient, Fill, Heal, Clone, Pen, Shape, Text, Hand, Zoom, Eyedropper.
Each has one semantic icon, one accessible name, and one shortcut. Do not reuse an icon
across unrelated tools.

Terms that appear in the supplied product screenshots but are **not** implemented (do not use
them in code or UI until backed by real features and an approved RFC): "PRESS Professional
Design Suite", "Templates & Assets" marketplace, "120,000+ templates", stock Photos/Icons/
Illustrations panels, "Quick Actions", "Improve Lighting", "Enhance Details", "Magic Resize",
"Generate Similar", "Bebas Neue", cloud "Share".
