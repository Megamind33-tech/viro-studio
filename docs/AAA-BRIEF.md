# VIRO Press — AAA brief (binding for every agent)

You are one of several agents raising VIRO Press to Photoshop CC / InDesign CC
finish quality. Read this whole file before touching code.

## What the app is

A Photoshop/InDesign-class design OS **and** the harness an AI uses to emit
*editable* graphics. The compositor is Skia (CanvasKit/WebGL), type is HarfBuzz,
colour is LittleCMS. It is **not** Canvas2D and **not** Canva.

## Non-negotiable design law

| Token | Value |
|---|---|
| Panel | `#2B2B2B` |
| Raised | `#323232` |
| Pasteboard | `#1F1F1F` |
| Input well | `#1E1E1E` |
| Hairline | `#1A1A1A` |
| Ink / muted / dim | `#E8E8E8` / `#B4B4B4` / `#8A8A8A` |
| Accent (copper) | `#E07A2F` — **active tool and selection only** |
| Font | Segoe UI, 11px base |
| Radius | 0–2px |

- **No Canva DNA.** No Inter, no `#5350FF`, no `Generate`/`Looks`/`Animate`
  tabs, no destination rails, no pill buttons, no purple.
- **Honesty over theatre.** An incomplete tool is *hidden*, never stubbed and
  never toasted. A missing feature is acceptable; a fake one is not. Do not add
  a control that does nothing.
- **Copper is precious.** If everything is orange, nothing is. Active tool,
  active selection, checked checkbox, focused field. That is the whole list.
- Do not invent npm package names. See `VERSIONS.md`. Everything you need is
  already installed — prefer zero new dependencies.

## The single biggest quality defect: native OS chrome

The desk currently ships **9 `<select>`, 6 `<input type=range>` and 5
`<input type=checkbox>`** rendered as operating-system widgets: grey pill
slider thumbs, a **bright blue** Navigator zoom thumb, and native dropdown
arrows. Photoshop has *zero* native form chrome. This is the loudest possible
"not premium" tell and it is visible in every screenshot.

## Verification — you must do this, not assert it

The dev server is already running on <http://127.0.0.1:5173> (Vite, HMR — it
picks up your edits from disk automatically; do **not** start another server,
the port is taken).

```
node tests/shots.mjs          # writes tests/qa-shots/*.png at 1600x1000 @2x
npx tsc --noEmit              # must stay clean — this is the regression gate
```

`shots.mjs` prints every scene as `ok:true/false` plus console errors, layer
count and zoom agreement. **Then `Read` the PNGs it wrote** — you can see
images. Judge your own work with your eyes before you report done. A scene it
could not drive is a failure, never a skip.

Report honestly. If you could not finish something, say which part and why.
Never claim a visual result you did not look at.
