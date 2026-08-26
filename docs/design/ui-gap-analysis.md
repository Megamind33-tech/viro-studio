# UI Gap Analysis — Reference "PRESS" suite vs. actual VIRO Press

> Governed by `/GOVERNOR.md` and `/docs/product/terminology.md`. Evidence-based;
> every claim cites a real file location. **Reality over appearance:** the two
> supplied screenshots depict an aspirational hosted suite. Anything in them with
> no truthful backing is classified **ABSENT** per GOVERNOR.md, never faked.
>
> Sources inspected: `index.html`, `src/chrome/desk.ts`, `src/chrome/desk.css`,
> `src/styles/desk.css`, `src/document/types.ts` (`ToolId`, `LayerEffect`),
> `src/document/ui-commands.ts`, `src/app.ts`.

---

## 1. Side-by-side gap table

### Image 1 — Editor chrome

| Reference UI element | Exists today? | Evidence | Gap |
| --- | --- | --- | --- |
| Top menu bar (File/Edit/Image/Layer/Type/Select/Filter/View/Window/**Help**) | partial | `index.html` `#menubar` has File→Window (`data-menu` × 8) | No **Help** menu; no `data-menu="help"`. |
| Left toolbox, full tool column | partial | `#toolbox` exposes 10: `data-tool` move/marquee/crop/type/pen/rect/ellipse/line/hand/zoom | Engine `ToolId` (`types.ts:345`) also supports `eyedropper`, `frame`, `roundrect`, `polygon`, `rotate`, `guide` — **built but not surfaced**. |
| Toolbox: Lasso, Brush, Pencil, Eraser, Gradient, Fill, Heal, Clone | no | Not in `#toolbox`, not in `ToolId` (`types.ts:345-361`) | No engine backing. Terminology (`terminology.md:26`) names them but the tool registry does not implement them — a terminology/reality mismatch to resolve, not to fake. |
| Options bar: "Auto-Select: Layer" | no | `#optionsbar` strips (`index.html:128-179`) | No auto-select control. |
| Options bar: "Show Transform Controls" toggle | no | `#optionsbar` | Absent. |
| Options bar: alignment / distribution icon row | no | Only paragraph text align exists (`type.paragraphAlign`, `app.ts:1256`) | **Layer** align/distribute absent (no command in `ui-commands.ts`). |
| Options bar: Move strip (X/Y/W/H, rotation, fit) | yes | `#opt-x/-y/-w/-h/-r/-fit`, `applyTransform` (`desk.ts:703`) | Complete for move. |
| Top-right **Share** (cloud) button | no | none in `#menubar` | ABSENT — cloud (see §3). |
| Top-right **Export** dropdown | partial | Export lives in File flyout only (`data-cmd="export-png/-pdf"`, `index.html:29-30`) | No persistent top-bar Export affordance. |
| Right panel top tabs "Design / Color / Swatches" | partial | `#g-color` tabs are Color/Swatches only (`index.html:237-239`) | No "Design" master tab; panel is a vertical stack of groups, not a tabbed shell. |
| Color: HSV plane + hue + hex + RGB | yes | `#sv-plane`, `#hue-bar`, `#hex`, `#rgb-r/g/b` (`index.html:242-256`); `bindColor` (`desk.ts:731`) | Present and real. |
| Typography section (font, size, leading, tracking, align) | partial | `#g-type` Character/Paragraph panes; `#opt-font/-size/-lead/-track`; `applyType` (`desk.ts:727`) | No weight/style selector, no VA/optical kerning, no caps/super/subscript controls (fields exist on `CharacterStyle` `types.ts:170-189` but are not exposed). |
| Transform section (X/Y/W/H/rotation) | yes | `#g-transform` `#tr-x/-y/-w/-h/-r` (`index.html:312-330`) | No flip, no reference-point (anchor 9-grid) selector shown in reference. |
| **Appearance** section (Opacity, Blend, Fill, Stroke in one place) | no (scattered) | Blend+Opacity in `.layer-head` (`index.html:363-364`); Stroke in `#g-type` Stroke pane; Fill via Color studio (`app.ts:1242`) | No consolidated Appearance panel; the reference groups these four together. |
| Effects: Drop Shadow | yes | `#g-effects` `#fx-shadow-*`; `bindEffects` (`desk.ts:187`); `DropShadowEffect` (`types.ts:77`) | Real and non-destructive. |
| Effects: Gradient Overlay / Background / others | no | `LayerEffect = DropShadowEffect` only (`types.ts:90`) | No engine backing beyond drop shadow. |
| Layers / History / Pages panels | yes | `#g-layers` (Layers/Channels/Paths), `#g-pages`, `#g-nav` (Navigator/History) | Present as separate groups rather than one tab cluster; functionally equivalent. |
| Layers panel: Kind filter, lock-group toolbar, fx badges | partial | Rows carry eye/lock/thumb/name/fx (`desk.css .ly`, `renderLayers` `desk.ts:1672`) | No "Kind" filter dropdown; single lock toggle only (no pixels/position/all lock cluster). |
| Blend-mode + opacity for a layer | yes | `#blend`, `#opacity`, `app.setBlend/setOpacity` (`app.ts:1204-1210`) | Present. |

### Image 2 — "Templates & Assets" library

| Reference UI element | Exists today? | Evidence | Gap |
| --- | --- | --- | --- |
| "120,000+ professional templates" library | no | no such string/surface in repo | ABSENT (aspirational). Truthful local counterpart: presets (`presets.ts`) + Projects dashboard (`#dlg-projects`). |
| Template category rail (For You / Social / Posters / Branding…) | no | none | ABSENT. |
| Assets tabs: Photos / Icons / Illustrations / Textures / Mockups (stock) | no | `#g-library` has Assets/Fonts only (`index.html:417-437`) | ABSENT — stock marketplaces. Local Library holds user assets/fonts (`src/library/store.ts`). |
| Curated Collections / stock photo grid | no | none | ABSENT. |
| "Go Premium / Upgrade Now" | no | none | ABSENT — billing (out of scope, ADR 0004). |
| Quick Actions: Remove Background | partial | `data-cmd="cutout"` gated on model (`#menu-cutout` hidden; `cutout.ts`) | Only truthful item — real ONNX cutout, availability-gated. |
| Quick Actions: Select Subject / Improve Lighting / Enhance Details / Magic Resize / Generate Similar | no | none | ABSENT — AI with no model/service (see §3). |

---

## 2. Prioritized, de-duplicated backlog

Legend — **chrome** = wire-up of existing engine capability; **engine** = needs new
document/command/compositor capability (higher cost, may need an ADR per GOVERNOR.md §71).

### P1 — highest value, mostly truthful chrome

1. **Surface already-built tools in the toolbox** — add `eyedropper` and `frame` (and consider `roundrect`/`polygon`/`rotate`/`guide`) to `#toolbox`; handlers/`ToolId` already exist (`types.ts:345`). *chrome.* Highest ratio of value to risk — these are real, unexposed capabilities.
2. **Consolidate an Appearance panel** — one section with Opacity, Blend, Fill, Stroke, currently split across `.layer-head`, the Stroke pane, and the Color studio. All four map to existing commands (`layer.opacity`, `layer.blend`, `layer.fill`, `vector.strokeWidth`). *chrome.*
3. **Layer alignment / distribution controls** — align left/center/right/top/middle/bottom + distribute, in the options bar for the Move tool (as in the reference). *engine* — no `layer.align`/`layer.distribute` command exists (`ui-commands.ts` has none; only `type.paragraphAlign`).
4. **Reconcile the tool terminology vs. reality** — `terminology.md:26` lists Lasso/Brush/Pencil/Eraser/Gradient/Fill/Heal/Clone, none implemented in `ToolId`. Either build them (*engine*, large) or correct the canonical list. Governor decision required; do not paint dead tool buttons.

### P2 — completeness and density

5. **Options-bar completeness** — add contextual controls the reference shows: Auto-Select scope and Show-Transform-Controls toggle. *chrome* for the toggles; Auto-Select semantics may need selection-model support (*engine-light*).
6. **Typography depth** — expose weight/style, VA/kerning, and case controls already modeled on `CharacterStyle` (`types.ts:170-189`) but not surfaced in `#g-type`. *chrome* for modeled fields; variable-font/OT UI is DEFERRED per GOVERNOR.md.
7. **Transform panel: flip + reference-point (anchor 9-grid)** — reference shows both. *engine-light* (compose into `layer.transform`).
8. **Persistent Export affordance** — a top-bar Export entry point mirroring the File-menu actions (`export-png`/`export-pdf`). *chrome.* (**Not** cloud Share — see §3.)
9. **Panel spacing/density pass to match the reference** — tighten section headers and row rhythm onto the token scale (see §4). *chrome, cosmetic only.*

### P3 — polish

10. **Help menu** — add a `data-menu="help"` (About/shortcuts). *chrome.*
11. **Layers "Kind" filter + richer lock cluster** — filter rows by layer kind; expand the single lock into the reference's lock group where it maps to real state. *chrome* (filter) / *engine-light* (per-axis locks not modeled).
12. **Effects breadth (Gradient Overlay, etc.)** — only if genuinely built end-to-end in the compositor and exporter. *engine* — requires extending `LayerEffect` (`types.ts:90`) + ADR; do not stub.

---

## 3. DO NOT BUILD (fake / aspirational)

Per GOVERNOR.md (§ Feature Truth Ledger) and `terminology.md:31-35`, these appear in the
screenshots with **no truthful backing**. They are **ABSENT**, not decorative, and must not be
faked to match the images. Any of these requires an owner-approved Architecture RFC (ADR 0004
path), not a UI mockup.

- **"120,000+ professional templates"** and the whole Templates library screen — no data, no catalog of that size.
- **Stock marketplaces**: Photos / Icons / Illustrations / Textures / Mockups panels, "Curated Collections" — no assets, no service.
- **AI Quick Actions**: Improve Lighting, Enhance Details, Magic Resize, Generate Similar, Select Subject — no model/service. (Only **Cutout / Remove Background** is real, via ONNX U²-Netp, and stays availability-gated — `src/engine/cutout.ts`.)
- **Cloud "Share"** button — no accounts, no server, no sharing (GOVERNOR.md: no hosted platform in-repo today).
- **"Go Premium / Upgrade Now"** — no billing/entitlements (deferred to ADR 0004 P3, provisioning-blocked).
- **"Bebas Neue" / decorative font menu entries** — do not list faces that are not registered and renderable (`font-registry.ts` is the source of truth).
- **"PRESS Professional Design Suite" branding** — the product is VIRO Press, a local editor; do not adopt hosted-suite naming/`terminology.md:31`.

---

## 4. Design-token observations (`desk.css`)

Tokens are well-defined and largely respected — this is a healthy system, so the note below is
targeted, **not** a call to refactor stable working styles.

- **Solid, consistent foundation.** `:root` defines a full palette and a `--space-1..6` scale (`src/styles/desk.css:2-33`). Accent copper `--accent:#e07a2f` is used only on active/selection states throughout (tool rail, tabs, selection rows), matching GOVERNOR.md UX rules. Radius stays 0–1px. Keep as-is.
- **Conflicting `.hint` rule (real inconsistency).** `.hint` is defined twice with different values: `src/styles/desk.css:931` (`color:var(--dim); font-size:10px`) and `src/chrome/desk.css:9` (`color:var(--muted); font-size:11px`). Because `chrome/desk.css` `@import`s the styles file first, the chrome rule wins globally — so the tokened 10px/dim intent is silently overridden. Suggestion: pick one definition (prefer the `--dim`/10px hint) and delete the duplicate.
- **Hardcoded spacing that bypasses the scale.** Several rows use literal px where a token exists: `.opt-strip{gap:8px}` (`styles/desk.css:253` → `var(--space-4)`), `.menu-btn{padding:0 9px}` / `.brand{padding:0 10px}` (`:144/:131`), and the Projects/dialog paddings in `chrome/desk.css` (`10px 14px`, `12px` gaps). Suggestion: migrate to `--space-*` opportunistically when a rule is touched for other reasons; do not do a standalone sweep of stable panels.
- **Two `.dialog-foot` definitions.** `styles/desk.css:1026` vs `chrome/desk.css:89` differ in padding/border; the chrome one overrides. Harmless today but worth collapsing to one rule to avoid drift.
- **Typography scale is intentionally dense** (11px base, 10px secondary, 9px micro-labels). This is correct for a Photoshop-class desk and should **not** be enlarged to chase the marketing-sized type in the reference screenshots.

---

## Appendix — evidence index

- Toolbox markup: `index.html:181-221`; engine tool set: `src/document/types.ts:345-361`.
- Menu/options/studios structure: `index.html:16-456`.
- Command surface: `src/document/ui-commands.ts`; app methods: `src/app.ts:1191-1304`.
- Effects model + binding: `src/document/types.ts:77-102`, `src/chrome/desk.ts:187-230`.
- Tokens + component styles: `src/styles/desk.css:1-34` and throughout; chrome overrides: `src/chrome/desk.css`.
- Product truth + aspirational classification: `GOVERNOR.md` (Feature Truth Ledger), `docs/product/terminology.md:31-35`.
