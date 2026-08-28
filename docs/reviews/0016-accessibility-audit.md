# VIRO-0016 — Accessibility / Keyboard Audit of Editor Chrome

- Packet: VIRO-0016 (ui-ux, P2) · Role: builder (`zcode-a11y-pc1`, machine `pc-cloud1`)
- Before-state audited: `origin/main` `14e2812`
- Surface: `index.html`, `src/chrome/**` (desk.ts, controls.ts, format.ts, desk.css, styles via `src/chrome/desk.css` import)
- Method: static walkthrough + live Playwright probes against the running desk (`node_modules/.a11y-probe*.mjs`, dev server 127.0.0.1:5177), keyboard-driven only. Probe outputs quoted verbatim in the findings.
- Date: 2026-08-27

## Journeys evaluated

| Journey | Path exercised | Result before fixes |
| --- | --- | --- |
| New document | Ctrl+N → New dialog → Enter / Create | Dialog opens but focus never enters it; Enter-to-create is dead from the keyboard (see F2); Create button reachable only after Tab through background chrome |
| Open | Ctrl+O Projects dialog; File > Open File… | Projects dialog opens without focus management (F2); Open File… delegates to the native file picker (keyboard-operable) |
| Save | Ctrl+S / File > Save to Projects; File > Save Press JSON… | Works (app.ts wiring); result announced only visually in `#stat-engine` (F8) |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Edit menu items | Shortcuts wired in `src/app.ts::bindKeys` and fire without crash; Edit menu items keyboard-reachable once flyout open, but menu cannot be dismissed with Escape (F1) |
| Tool switching | V/M/T/P/C/H/Z/U letters, toolbox buttons | Passes — letters switch tools live (probe: `m` → `marquee`), `aria-pressed` tracks active tool in `render()` |
| Zoom | Ctrl+=/−/0/1, status-bar zoom combo, Navigator slider, zoom tool | Ctrl+1/Ctrl+0 verified live (21%→100%→fit); combo keyboard-complete via `controls.ts` (Enter/Space/F4/Alt+↓ open, arrows, Home/End, Escape, Tab commit, focus restored, `aria-expanded` set); Navigator slider unnamed (F3) |
| Panels (tabs/channels/layers/pages/history/effects) | Tab traversal + state exposure | Tabs/channels/align/view toggles expose no state to AT (F4); layer rows cannot be selected from the keyboard at all (F5); pages/paths rows are real buttons (pass) |

## Findings

### F1 — HIGH · Menus: no Escape dismissal, no expanded state, flyout survives focus loss
Evidence (probe 1): after focusing `File` and pressing Enter,
`menu aria-expanded after Enter: null`, and after Escape,
`flyout hidden after Escape: null` / `menu still open after Escape: 1`.
`bindMenus()` (src/chrome/desk.ts) closes menus only on item click or `pointerdown`
outside; a keyboard user who opens a flyout cannot dismiss it with Escape and
Tabbing away leaves it painted over the workspace. Screen readers get no
open/closed state.
**Disposition: FIXED.** `bindMenus`/`closeMenus` now sync `aria-expanded`
(markup gains `aria-haspopup`/`aria-expanded`), Escape closes the open flyout
and refocuses its menu button, and closing the menubar on `focusout` keeps the
chrome consistent for Tab users. No pointer behavior changes.

### F2 — HIGH · Modal dialogs: no focus management (open, trap, restore, Escape)
Evidence (probe 1): with `#dlg-new` visible,
`activeElement with dialog open: BUTTON.is-on #` (a menubar button) and the
first Tab lands `inDialog=false`. Probe 3: after Ctrl+N, pressing Enter does
**not** create the document because the Enter handler is bound on `#dlg-new`
and focus never enters it — the advertised keyboard path to a new document is
dead. Escape while focus is inside a dialog field is swallowed by the typing
guard (`dlg-new visible after Escape in field: true`). Applies to
`#dlg-new`, `#dlg-image`, `#dlg-bc`, `#dlg-projects`.
**Disposition: FIXED.** Desk chrome now: moves focus to the first field when a
dialog opens; restores focus to the trigger on close; wraps Tab inside the
dialog; and closes on Escape from anywhere inside (including text fields).
Implemented in `src/chrome/desk.ts` (`render()` dialog transitions, dialog
keydown helpers, `openProjects`/`closeProjects`). No layout or visual change.

### F3 — MEDIUM · Controls with no accessible name
Evidence (probe 1 label audit — `name: null`): `#nav-zoom` (zoom slider),
`#rgb-r/g/b` (color sliders), `#rgb-r-n` (+ g/b numeric pairs), `#hex`,
`#bc-b`, `#bc-c` (Brightness/Contrast ranges), `#swap-fgbg` (name is the glyph
"↔"), `#default-fgbg` ("■"). Also `#nd-cs` ("Color Mode") is a `role="status"`
div pointed at by `for=` which cannot associate with a div.
**Disposition: FIXED** with `aria-label`s in `index.html` (Red/Green/Blue,
Red value…, Hex color, Brightness, Contrast, Navigator zoom, Swap foreground
and background colors, Default colors) and an `aria-labelledby` fix for
`#nd-cs`. All labels are invisible; zero visual drift. Fields whose visible
`<label>` wraps them (X/Y/W/H/Size/…) already have names equal to their
visible labels — single-letter names kept as-is to avoid visual drift
(not-a-defect).

### F4 — MEDIUM · Toggle state not exposed to assistive technology
Evidence (probe 1): studio tabs (`Color/Swatches/Stroke/…`) all report
`ariaPressed: null` while `isOn: true/false`; view/window menu toggles
(Rulers/Guides/Snap/Bleed, panel groups) expose state only as a decorative
"✓" text span (`btnAriaPressed: null`); channel buttons, paragraph-align
buttons and the New-dialog orientation buttons use the same bare `is-on`
class. `#nd-link` (margin link) already sets `aria-pressed` — the codebase
convention exists; the rest predate it.
**Disposition: FIXED.** `aria-pressed` is now synced wherever `is-on` is
toggled (studio tabs on click + init, channels and paragraph align in
`render()`, orientation in `renderNewDialog()`, view/window toggles in the
`render()` checks loop), and the "✓" spans are `aria-hidden` so the state is
spoken once, not twice. No decorative ARIA added: every attribute mirrors a
real handler state.

### F5 — HIGH · Layer rows cannot be selected or read from the keyboard
Evidence: `renderLayers()` emits `<div class="ly" data-id>` rows; selection,
the row's real handler, is click-only
(`el("layer-list").addEventListener("click")`). A keyboard user can toggle
visibility/lock (eye/lock are buttons) but can never select a layer, so the
Transform/Type/Effects panels and layer commands are unreachable for them.
(Probe 3 found 0 rows on a fresh boot; the row markup was verified in source —
divs with no tabindex/role, name in a `<span class="nm">`.)
**Disposition: FIXED.** The layer name becomes a real `<button class="nm">`
carrying `aria-pressed` (selection state). Click delegation already routes its
`click` (Enter/Space) to the row logic, including Shift for extend-selection —
zero handler changes; `src/chrome/desk.css` adds a box-neutral reset
(`display:block; width:100%; text-align:left`) so the button paints exactly
where the span painted. Pointer behavior unchanged.

### F6 — LOW · Swatch buttons named only by `title`
Evidence: `render()` emits `<button data-hex title="{name}">` with no text
content; accessible name survives only via the title attribute.
**Disposition: FIXED.** `aria-label` added from the same swatch name.
No visual change.

### F7 — MEDIUM · Modal dialogs incomplete semantics
Evidence: only `#dlg-projects` carries `aria-modal="true"`; `#dlg-image`,
`#dlg-new`, `#dlg-bc` are `role="dialog"` + `aria-labelledby` only, although
`app.ts` treats all of them modally (Escape sets `this.dialog = null`).
**Disposition: FIXED.** `aria-modal="true"` added to the three dialog
elements in `index.html`.

### F8 — LOW · Status messages not announced
Evidence: `app.status` (Saved…/Opened…/…failed) renders into `#stat-engine`
with no live-region semantics; screen readers never hear save/open results.
**Disposition: FIXED.** `aria-live="polite"` added to `#stat-engine` (text
content unchanged). Observation recorded for the Governor (outside this
packet's visual-drift constraint): `render()` overwrites `#stat-engine` with
the document-size label once engines are up, so post-boot status strings are
transient by design; this packet does not change which text wins. The save
journey is verified through persistence (Projects dialog lists the saved
project), not through the transient status string.

## Dismissed — inspected, not defects

- **SV plane / hue bar are pointer-only.** Keyboard color entry exists in the
  same pane: the R/G/B sliders + numeric fields and the Hex field cover full
  color input; sliders and pickers are complementary. In-place arrow-key
  slider semantics would be an enhancement, not a defect fix.
- **Canvas is not keyboard-focusable.** Direct-manipulation painting is
  inherently pointer-driven; after F5 every selection/move/zoom journey has a
  keyboard route through panels, menus and shortcuts.
- **Custom `<select>` popup (controls.ts).** Keyboard-complete and
  state-correct (verified live: listbox opens with Enter, `aria-expanded`
  true, Escape closes and restores focus). The real `<select>` keeps native
  semantics. Passes.
- **Button focus visibility.** UA `:focus-visible` ring renders visibly on
  the dark desk (screenshot `before-menu-open.png` shows the focused File
  button); text fields, checkboxes, ranges, preset/nd buttons already have
  accent focus styles in `src/styles/desk.css`. Not-a-defect.
- **Undo/redo shortcuts.** Wired in `src/app.ts::bindKeys`
  (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) — outside this packet's lease and already
  functional; menu labels match the handlers.
- **Shortcuts suppressed while typing (`isTyping` guard).** Intentional
  protection for text entry; dialog-scoped Escape is restored by F2.
- **`window.prompt`/`confirm` in Projects rename/delete.** Native, keyboard-
  operable, screen-reader accessible dialogs. Not-a-defect.
- **History list rows are static labels** (only "New snapshot" is a control,
  and it is a button). No interactive affordance is missing.

## Fix inventory (all in-lease, no layout redesign, no new components)

- `index.html`: F3 labels, F4 initial states (`.check` spans `aria-hidden`),
  F7 `aria-modal`, menubar `aria-haspopup`/`aria-expanded` seeds (F1).
- `src/chrome/desk.ts`: F1 menu keyboard/state, F2 dialog focus management
  (focus in on open, Tab trap, Escape from anywhere including fields, focus
  restored on close — app dialogs and Projects alike), F4 `aria-pressed` sync
  (studio tabs, channels, paragraph align, New-dialog orientation, view/window
  toggles, plus the layer row's eye/lock/name controls), F5 name button in
  `renderLayers`, F6 swatch `aria-label`.
- `src/chrome/desk.css`: F5 button.nm box-neutral reset only.
- `tests/a11y-keyboard.spec.ts`: keyboard-driven walkthrough (new/open/save,
  undo/redo, tool switch, zoom, menu state/Escape, layer selection, visible
  focus). `tests/a11y-playwright.config.ts`: same runner on port 5177 with
  `reuseExistingServer: false` because the root config's port 5173 +
  `reuseExistingServer: true` lets a stale dev server from another checkout
  silently serve the wrong code to a local suite (observed on this machine).

## Post-fix verification evidence

- `npx tsc --noEmit` clean; `npm run test:unit` 316/316; `npm run build`
  exit 0; a11y suite exit 0 (5 passed + 1 flaky SwiftShader cold-boot recovered
  by the suite's documented retry policy).
- After-fix live probes (`node_modules/.a11y-probe-after.txt`): menu
  `aria-expanded after Enter: true`, `flyout hidden after Escape: hidden`
  (`menu still open after Escape: 0`), first Tab inside the New dialog lands
  `inDialog=true`.
- Before/after drift (identical viewport, SwiftShader, dev server):
  desk at rest **byte-identical** PNG (51,160 B); menu open **byte-identical**
  (60,742 B); New dialog open differs by **542 px of 1,296,000 (0.04%),
  confined to rows 52–240** — the visible focus indicator on the dialog
  control that now receives focus, i.e. the fixed defect itself, not layout
  drift. Diff computed by canvas decode (`node_modules/.a11y-drift.mjs`).

## Evidence artifacts

- Probe scripts + raw outputs: `node_modules/.a11y-probe*.mjs`,
  `node_modules/.a11y-probe-out.txt` (before),
  `node_modules/.a11y-probe-after.txt` (after) (gitignored, reproducible).
- Before screenshots: `node_modules/.a11y-shots/` (desk, menu open, New
  dialog). After screenshots: `node_modules/.a11y-shots-after/` (same states).
- Walkthrough results: `npx playwright test --config
  tests/a11y-playwright.config.ts` — exit 0; per-test lines in
  `node_modules/.a11y-spec-run.log`.
- Layer-row geometry: `.ly` row height asserted at exactly 38 px in the
  walkthrough spec, i.e. the button change moved no pixels.
