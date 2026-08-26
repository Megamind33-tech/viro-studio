# Desk chrome — Anchor as a studio, not product chrome

VIRO Press chrome is a Photoshop CC-class HTML/CSS desk. The page is Skia (CanvasKit) in `#skia`. This file records how **Anchor** fits that desk.

## Where Anchor lives

Anchor is a **docked studio** in the right column (`#g-anchor`), the same family as Color, Layers, and History.

- **Open:** Window → Anchor (checkmark when visible).
- **Default:** hidden. It is not in the menu bar as a product, not in the toolbox, not in the options bar.
- **Never:** destination rails, Generate pills, Looks chips, Edit/Effects/Animate tabs, or an always-on command strip.

The panel copy states the op law: Anchor emits `{ id, op, target, params, reason }` against the Press document graph. It does not flatten pixels and hope.

## Runtime hook (engine-owned)

`src/main.ts` exposes `window.viroAnchor`:

- `tools` — structured op catalogue (`ANCHOR_TOOLS`)
- `apply(ops)` — `PressApp.applyAnchor`, one undo step
- `document()` — current `PressDocument`

Chrome only shows the queue surface (`#anchor-ops`). The engine applies ops. Do not add a prompt pill row to the options bar when wiring a later chat UI — put that UI **inside this panel**.

## Token reminder

Panels `#2B2B2B` / `#323232`, pasteboard `#1F1F1F`, copper `#E07A2F` only on active tool and selection. Segoe UI. Radius 0–2px.
