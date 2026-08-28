# VIRO-0017 — UI Visual-Polish Defect Sweep (computed-style audit against the GOVERNOR.md UX token spec)

- Packet: VIRO-0017 (ui-ux, P3) · Role: builder (`zcode-polish-pc1`, machine `pc-cloud1`)
- Before-state audited: local `main` `72b05f0` (includes VIRO-0016 accessibility fixes; this packet must not regress them)
- Scope honoured: `index.html`, `src/chrome/**` edits only. `src/styles/desk.css` is the token *source* but is **outside this packet's lease** — deviations found there are recorded, not edited (OWNERSHIP.md scope discipline).
- Date: 2026-08-27

## Method

Three passes, so every verdict below rests on a measurement rather than an impression:

1. **Static enumeration** of every `var(--accent)` / `#e07a2f` / `rgba(224,122,47,…)`, every
   `border-radius`, and every `font-family` declaration across `src/styles/desk.css`,
   `src/chrome/desk.css`, `src/chrome/anchor-panel.css`, and inline styles in `index.html`.
2. **Live computed-style audit** of the running desk (`127.0.0.1:5184`, headless Chromium +
   SwiftShader, identical flags to `playwright.config.ts`): root custom-property resolution,
   computed `backgroundColor` of every structural chrome surface, a `border-radius` sweep over
   *all* elements, a `font-family` census of *all* visible elements, and an accent sweep that
   reads `backgroundColor`, `color`, all four `border*Color`s, `outlineColor`, `boxShadow`,
   `fill`, `stroke`, `textDecorationColor`, `caretColor`, `columnRuleColor` — plus
   `::before`/`::after` paints — on every visible element. Probe script:
   `node_modules/.polish-probe.mjs` (uncommitted evidence tool, 0016 precedent); raw output in
   `node_modules/.polish-shots-before/probe-report.json`.
3. **Stateful probes**: each finding's exact state was driven live (hover with 2+ layers
   selected, Projects dialog, recovery bar forced visible, Anchor studio opened) and measured
   before and after the fix. Per-item captures: `node_modules/.polish-shots-{before,after}/`.

Verdict rule (frozen acceptance): copper `#E07A2F` may appear **only** on (a) the active tool,
(b) a selection state — selected row/tab/preset/option, a checked control, the selected view
region, and (c) keyboard `:focus`/`:focus-visible` indicators. (c) is a keyboard-*selection*
indicator and is additionally mandated by the Governor's accessibility release gate; VIRO-0016's
suite asserts it (`#hex` focus border must equal `rgb(224, 122, 47)`), so removing it would
regress a shipped, verified gate. Focus stays; everything else must be neutral.

## A. Token resolution (PASS — no deviation)

Root custom properties resolve to the exact spec values; structural chrome uses the two panel
tokens and the pasteboard token, computed live:

| Token | Spec | Computed | Used by (computed `backgroundColor`) |
| --- | --- | --- | --- |
| `--panel` | `#2B2B2B` | `#2b2b2b` | optionsbar, toolbox, studios, panes → `rgb(43, 43, 43)` |
| `--raised` | `#323232` | `#323232` | menubar, statusbar, dialogs → `rgb(50, 50, 50)` |
| `--pasteboard` | `#1F1F1F` | `#1f1f1f` | workspace, pasteboard → `rgb(31, 31, 31)` |
| `--accent` | `#E07A2F` | `#e07a2f` | (state paint only — see §C) |

Sub-token hardcoded surfaces are **not panel bodies** and are consistent tonal steps of the
Photoshop-class ramp, not token drift: input wells `#1e1e1e`, tab-strip rails `#252525`/`#262626`
(darker rail so the `--panel`-coloured active tab reads against it), list bodies `#282828`/
`#292929`/`#2a2a2a`, hover/pressed steps `#3a3a3a`/`#3d3d3d`/`#484848`, hairlines `#1a1a1a`.
Disposition per surface: **not-a-defect** (value ramp of non-panel sub-surfaces; panels
themselves are exactly `#2B2B2B`/`#323232`). Reclassifying the ramp would be a redesign, which
this packet forbids.

## B. Radius + font stack (PASS — no deviation)

- **Radius**: `--radius: 1px`; the total sweep found **0 elements** with computed
  `border-radius > 2px` (max observed: 2px on `.recover-bar`/`.recover-btn`; scrollbar thumb 1px).
- **Font**: body resolves to `"Segoe UI Variable", "Segoe UI", SegoeUI, Tahoma, sans-serif`.
  Full visible-element census found exactly three families:
  1. the Segoe stack (all UI) — conformant;
  2. `"Cascadia Mono", Consolas, "Segoe UI Mono", monospace` — machine-data readouts only
     (Anchor op names/JSON/ids/counts). Disposition: **not-a-defect** (functional monospace for
     JSON/IDs so columns align; all UI labels remain Segoe UI);
  3. `sans-serif` on `#type-input` — the invisible IME surface (opacity 0.01, transparent,
     `pointer-events: none`, never paints). Disposition: **not-a-defect** (no painted pixel; its
     16px metric exists for IME caret math; changing it risks composition positioning for zero
     visible gain).

## C. Accent census — enumerated findings

Live accent sweep at rest + driven states found accent paint on exactly these element groups:

### Allowed states (not-a-defect, verified stateful)

| # | Surface | Evidence |
| --- | --- | --- |
| A1 | `.tool.is-active::before` copper bar | Only the active tool; moves when the tool changes (move→marquee verified by `aria-pressed` sweep). |
| A2 | `.tabs button.is-on`, `.nd-tabs button.is-on`, `.anc-mode.is-on` active-tab inset underline | Only the `is-on` tab in each strip. |
| A3 | `.ly.is-on`, `.channel.is-on`, `.page-row.is-on`, `.hist-row.is-on`, `.preset-list button.is-on`, `.lib-font.is-on`, `.align button.is-on`, `.cbx-opt.is-on` selected-row markers | Only selected rows/options. |
| A4 | `input[type="checkbox"]:checked` copper fill | A checked box is a binary control's *selected* state. |
| A5 | `input[type=color]` swatch wells / `#swatch-list` "Copper" swatch (`rgb(224,122,47)` background) | **Content**, not chrome: a paintable palette entry named "Copper" and user color values. |
| A6 | `:focus` / `:focus-visible` borders and outlines (fields, selects, ranges, checkboxes, buttons) | Keyboard-selection indicator; accessibility-mandated (§Verdict rule). VIRO-0016 suite asserts it. |
| A7 | `#nav-port` copper border | Marks the *active view region* in the Navigator (the selected viewport); Photoshop-convention proxy highlight. |
| A8 | `.doc-tab` copper top edge | Static markup renders exactly one tab, which is always the active document; no inactive-tab state exists that could paint copper. Latent caveat if multi-tab ever lands (recorded for the Governor). |
| A9 | `.nd-badge.is-custom` copper text/border | Lights only while a *custom preset is the current selection*; selection-derived state. |
| A10 | `.nd-orient .is-on`, `.nd-link[aria-pressed=true]`, `.anc-chip.is-sel`, `.nd-pv-*` no — see D3 | orientation/link/chip are selected states. |

### Proven deviations — FIXED in this packet (in lease)

- **D1 · MEDIUM — `.recover-primary` paints a solid copper CTA button**
  `src/chrome/desk.css:313-317` — `background/border: var(--accent)`, dark text. Measured live
  (`rgb(224, 122, 47)` fill) with the bar forced visible; capture
  `.polish-shots-before/recover-bar.png`. A recommended-action fill is neither an active tool nor
  a selection; it is the single largest constant copper area in the product.
  **Fix:** standard raised-button treatment (`#3d3d3d` fill, `#1a1a1a` border, `--ink` text — the
  exact `.btn`/`.anc-btn` token set), keeping Restore visually distinct from Discard without accent.
- **D2 · LOW — copper hover borders on non-stateful buttons**
  `.align-btn:hover:not(:disabled)` (`src/chrome/desk.css:108-110`), `.proj-btn:hover`
  (`src/chrome/desk.css:252-254`), `.recover-btn:hover` (`src/chrome/desk.css:309-311`).
  Measured: `.align-btn` hover border = `rgb(224, 122, 47)` with 2+ layers selected (capture
  `.polish-shots-before/align-btn-hover.png`). Hover is not active/selection; neutral hovers use
  the `#3d…#48` ramp everywhere else.
  **Fix:** hover border → `#3d3d3d` (the ramp's raised-control border tone). No layout change.
- **D3 · LOW — copper ring on Anchor default-action buttons**
  `#g-anchor .anc-btn-default { border-color: var(--accent) }` (`anchor-panel.css:572-574`;
  measured on "Send" and both "Apply batch" buttons) and
  `#g-anchor .anc-mini-default:not(:disabled) { border-color: var(--accent) }`
  (`anchor-panel.css:600-603`; engages when a batch is queued). A persistent default-action ring
  is chrome emphasis, not an active/selection state.
  **Fix:** remove the accent declarations (`.anc-btn-default` rule deleted; `.anc-mini-default`
  keeps its non-accent `color: var(--ink)` emphasis). No replacement ornament is invented.
- **D4 · LOW — dead governance prose in the Anchor markup**
  `index.html:518-521` renders *"Anchor applies structured ops … It is a docked studio, never
  product chrome."* — internal/governance prose in production markup. It is currently
  unreachable: `mountAnchorPanel` strips static `H2`/`P` at init (`anchor-panel.ts:334`), so the
  sentence never paints, but it remains shipped descriptive prose.
  **Fix:** delete the dead `<p>` from `index.html` (zero visual delta by construction).

### Deviations outside this packet's lease — recorded for the Governor (not edited)

- **D5 · LOW — `.btn.default { border-color: var(--accent) }`** (`src/styles/desk.css:1046-1048`).
  Same class of defect as D3: persistent copper ring on dialog OK/Create buttons (measured on all
  three dialogs). Fixing it requires `src/styles/desk.css`, which this lease does not include.
  **Disposition: out-of-scope; returned to Governor** (recommended: same neutral treatment as D3).
- **D6 · LOW — copper guide strokes in the New-Document preview**
  `.nd-pv-margin { stroke: var(--accent) }` and `.nd-pv-col { stroke: rgba(224,122,47,0.42) }`
  (`src/styles/desk.css:1501-1511`). Static preview illustration, not a UI state.
  **Disposition: out-of-scope; returned to Governor** (defensible either way: print-guide
  semantics vs. chrome-accent rule — Governor decides; this packet does not touch it).

## D. Honest empty states + distinct semantic icons (PASS)

- Empty states are honest and textually truthful: `#anchor-ops` "No ops in queue.", Projects grid
  empty message, `#fx-empty` "Select a layer to add effects.", Library hints describe real
  behavior only (capture `.polish-shots-before/anchor-panel.png`).
- Toolbox: 10 tool buttons, each with a unique `title`, unique `aria-label`, and a distinct
  non-empty SVG path set (asserted in `tests/visual-polish-chrome.spec.ts`). No glyph reuse, no
  letter placeholders. Panel foot buttons likewise carry distinct stroke icons.

## E. Enforcement tests

`tests/visual-polish-tokens.spec.ts` and `tests/visual-polish-chrome.spec.ts` (added with the
fixes) turn the audit into gates: token/radius/font sweeps, "no `:hover` rule may reference the
accent", "no non-stateful button may paint copper at rest", statefulness of the allowed accent
sites (active tool marker + selected-row markers), Anchor default-button neutrality, recovery-bar
neutrality, icon distinctness, and the prose removal. VIRO-0016's `a11y-keyboard.spec.ts` is
expected green — focus indicators are deliberately untouched.

## F. Before/after captures

Per fixed item, in `node_modules/.polish-shots-before/` and `.polish-shots-after/` (uncommitted,
0016 precedent; the committed tests are the durable re-runnable proof):

| Item | Capture |
| --- | --- |
| D1 recovery primary | `recover-bar.png` |
| D2 align-btn hover (2+ layers selected) | `align-btn-hover.png` |
| D3 Anchor default buttons | `anchor-panel.png` |
| Reference frames | `desk-full.png`, `projects-dialog.png` |

## Summary

| Count | |
| --- | --- |
| Token/radius/font/icon/empty-state checks | PASS (§A, §B, §D) |
| Deviations fixed in-lease | 4 (D1, D2, D3, D4) |
| Deviations dismissed as not-a-defect (with reasons) | 10 groups (A1–A10) |
| Deviations out-of-lease, returned to Governor | 2 (D5, D6) |
