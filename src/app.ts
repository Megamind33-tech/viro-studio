import { migrateDocument } from "./document/migrate";
import type { BlendMode, ImageFit, PressDocument, ResampleAlgo, ToolId } from "./document/types";
import {
  addImageFrame,
  addTypeFrame,
  addVectorEllipse,
  addVectorLine,
  addVectorRect,
  applyImageSize,
  cloneDoc,
  hitTest,
  selectedLayers,
  uid,
} from "./document/factory";
import { CommandBus, type CommandNote } from "./document/command-bus";
import { anchorCommands, installAnchorCommands, PatchScopeError } from "./anchor/anchor-command";
import { installUiCommands } from "./document/ui-commands";
import type { Command } from "./document/commands";
import { documentFromPreset, PRESETS } from "./document/presets";
import {
  addAdjustment,
  addPage,
  addVectorPath,
  appendPathNode,
  applyFill,
  closePath,
  deleteSelected,
  duplicateSelected,
  groupSelected,
  reorderLayer,
  replaceAssetData,
  selectIntersecting,
  setActiveLayers,
  setActivePage,
  setCharacter,
  setImageCrop,
  setImageFit,
  setLayerBlend,
  setLayerLocked,
  setLayerOpacity,
  setLayerTransform,
  setLayerVisible,
  setParagraphAlign,
  setStoryText,
  ungroupSelected,
} from "./document/ops";
import {
  ANCHOR_TOOLS,
  applyAnchorBatch,
  type AnchorOp,
  type AnchorOpResult,
} from "./anchor/tools";
import { loadCanvasKit } from "./engine/canvaskit";
import { Compositor, type Engines, type HandleId } from "./engine/compositor";
import { colourStackLabel, loadLcms, rgb8ToLab, type Lcms } from "./engine/lcms";
import { cutoutAvailable, cutoutDataUrl } from "./engine/cutout";
import { loadFace, type FacePack } from "./engine/type";
import type { PdfExportReport } from "./export/pdf";
import { documentFromPsd } from "./import/psd";
import { documentFromVdj } from "./import/vdj";

/** Smallest edge a layer may be scaled to, in page px. */
const MIN_SIZE = 4;

/** Cursor for each transform handle, so the affordance is visible before the drag. */
const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  rotate: "crosshair",
  move: "move",
};

export class PressApp {
  doc: PressDocument;
  /**
   * The one place the document is mutated. Migrated call sites push typed
   * commands with inverses; the rest still push whole-document snapshots
   * through commit(). Both live in one ordered stack so undo stays correct
   * while the migration proceeds. See docs/adr/0002-command-bus.md.
   */
  bus = new CommandBus();
  compositor: Compositor | null = null;
  engines: Engines | null = null;
  lcms: Lcms | null = null;
  face: FacePack | null = null;
  labSample: { L: number; a: number; b: number } | null = null;
  ckSource = "";
  status = "Booting engines…";
  hasCutout = false;
  resampleAlgo: ResampleAlgo = "bicubic";
  /** Default stroke weight in page px for the Line tool. */
  strokeWidth = 2;
  constrainImageSize = true;
  listeners = new Set<() => void>();
  dialog: "image-size" | "new" | "brightness" | null = null;
  channelThumbs: { r: string; g: string; b: string; rgb: string } | null = null;
  /** Per-op audit trail from the last Anchor batch, for the queue surface. */
  anchorResults: AnchorOpResult[] = [];
  /** What the last PDF export actually emitted — vector counts and any raster fallbacks. */
  lastPdfReport: PdfExportReport | null = null;
  drag: {
    mode: "move" | "marquee" | "pan" | "rect" | "ellipse" | "line" | "crop" | "resize";
    x: number;
    y: number;
    lx: number;
    ly: number;
    lw?: number;
    lh?: number;
    /** Which transform handle started a "resize" drag. */
    handle?: HandleId;
    /** The selection frame at pointerdown — every step is measured from this, not incrementally. */
    frame0?: { x: number; y: number; w: number; h: number; rotation: number };
    /** Each selected layer's transform at pointerdown, so a multi-selection scales together. */
    layers0?: { id: string; x: number; y: number; w: number; h: number; rotation: number }[];
    /**
     * Coalescing key for this gesture. Every command emitted during the drag
     * carries it, so two hundred pointer events collapse to ONE history entry
     * whose inverse is the state at pointerdown. This replaces the old trick of
     * cloning the whole document on pointerdown.
     */
    session?: string;
  } | null = null;

  constructor() {
    installUiCommands();
    installAnchorCommands();
    this.doc = documentFromPreset(PRESETS[0]!);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.compositor?.draw(this.doc);
    for (const fn of this.listeners) fn();
  }

  private rafEmit = 0;

  /**
   * Coalesce repaints to one per frame.
   *
   * A pointer-move drag that mutates the document (move, crop, marquee) has to
   * re-composite the page, and pointer events arrive far faster than frames. A
   * synchronous `emit()` per event allocates a fresh Skia surface for a page
   * that may be 2480×3508 and exhausts the WASM heap, which surfaces as
   * `Aborted()` and can lose the layer the drag was building.
   */
  private emitSoon(): void {
    if (this.rafEmit) return;
    this.rafEmit = requestAnimationFrame(() => {
      this.rafEmit = 0;
      this.emit();
    });
  }

  /**
   * Legacy mutation path: records a whole-document clone. Every call site that
   * moves onto a typed command turns one of these clones into a pair of small
   * serializable objects.
   */
  commit(label: string, next: PressDocument): void {
    this.bus.pushSnapshot(label, this.doc);
    this.doc = next;
    this.emit();
  }

  /**
   * Run typed commands. A rejected batch leaves the document untouched and the
   * reason is surfaced verbatim rather than swallowed.
   */
  run(cmds: Command | Command[], opts: { label?: string; soon?: boolean } = {}): boolean {
    try {
      const res = this.bus.execute(this.doc, cmds, opts.label ? { label: opts.label } : {});
      this.doc = res.doc;
      if (opts.soon) this.emitSoon();
      else this.emit();
      return true;
    } catch (err) {
      this.status = err instanceof Error ? err.message : String(err);
      this.emit();
      return false;
    }
  }

  async boot(canvas: HTMLCanvasElement): Promise<void> {
    this.status = "Loading CanvasKit (Skia)…";
    this.emit();
    const { ck, source } = await loadCanvasKit();
    this.ckSource = source;

    this.status = "Loading HarfBuzz…";
    this.emit();
    const fontBytes = await (await fetch("/fonts/NotoSans-Regular.ttf")).arrayBuffer();
    this.face = await loadFace("noto-sans", "Noto Sans", fontBytes);

    this.status = "Loading LittleCMS…";
    this.emit();
    this.lcms = await loadLcms();
    this.labSample = rgb8ToLab(this.lcms, 224, 122, 47);

    this.hasCutout = await cutoutAvailable();

    this.engines = { ck, backend: "webgl", face: this.face };
    this.compositor = new Compositor(this.engines, canvas);
    const host = canvas.parentElement!;
    const fit = () => {
      this.compositor?.resize(host.clientWidth, host.clientHeight);
      this.compositor?.draw(this.doc);
    };
    fit();
    new ResizeObserver(fit).observe(host);
    this.bindCanvas(canvas);
    this.bindKeys();
    this.status = `Skia ${this.engines.backend} · HarfBuzz · ${colourStackLabel()}`;
    this.emit();
  }

  setTool(tool: ToolId): void {
    if (!this.compositor) return;
    this.compositor.view.tool = tool;
    this.emit();
  }

  private bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          this.undo();
        }
        return;
      }
      if (e.key === "Escape") {
        this.dialog = null;
        this.emit();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        this.selectAll();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        this.run({ type: "layer.delete", params: {} });
        return;
      }
      if (e.key === "Enter" && this.compositor?.view.tool === "pen") {
        const id = this.doc.activeLayerIds[0];
        if (id) this.run({ type: "path.close", params: { layerId: id } });
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "u" && !e.ctrlKey && !e.metaKey) {
        // U picks the shape tool; Shift+U cycles the group, as Photoshop does.
        const group: ToolId[] = ["rect", "ellipse", "line"];
        const at = group.indexOf(this.compositor?.view.tool ?? "rect");
        this.setTool(e.shiftKey && at >= 0 ? group[(at + 1) % group.length]! : group[at >= 0 ? at : 0]!);
        return;
      }
      const map: Record<string, ToolId> = { v: "move", m: "marquee", t: "type", p: "pen", c: "crop", h: "hand", z: "zoom" };
      const tool = map[key];
      if (tool && !e.ctrlKey && !e.metaKey) this.setTool(tool);
    });
  }

  /**
   * Normalised drag box for a box-shaped tool. With Shift held the box is
   * squared off the larger axis, the way Photoshop constrains a shape drag.
   */
  private shapeBox(px: number, py: number, shift: boolean): { x: number; y: number; w: number; h: number } {
    const ox = this.drag?.x ?? px;
    const oy = this.drag?.y ?? py;
    let w = Math.abs(px - ox);
    let h = Math.abs(py - oy);
    if (shift) w = h = Math.max(w, h);
    return {
      x: px < ox ? ox - w : ox,
      y: py < oy ? oy - h : oy,
      w,
      h,
    };
  }

  /**
   * Apply one step of a handle drag to every selected layer.
   *
   * Measured from the frame captured at pointerdown, never accumulated, so a
   * drag that passes back over its origin returns the layer exactly to where it
   * started. The maths runs in the frame's own rotated space — the pointer is
   * un-rotated about the frame centre, the edges the handle owns are moved, and
   * the resulting centre is rotated back — so a rotated layer scales along its
   * own axes rather than the screen's, and the opposite handle stays put.
   */
  private applyHandleDrag(px: number, py: number, shift: boolean): void {
    const d = this.drag;
    if (!d?.frame0 || !d.layers0 || !d.handle) return;
    const f = d.frame0;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const rad = (-f.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const toLocal = (ax: number, ay: number) => {
      const dx = ax - cx;
      const dy = ay - cy;
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    };

    if (d.handle === "rotate") {
      const base = Math.atan2(d.y - cy, d.x - cx);
      const now = Math.atan2(py - cy, px - cx);
      let deg = ((now - base) * 180) / Math.PI;
      // Photoshop snaps rotation to 15° increments with Shift held.
      if (shift) deg = Math.round(deg / 15) * 15;
      this.run(
        d.layers0.map((l0) => ({
          type: "layer.transform",
          params: { layerId: l0.id, patch: { rotation: l0.rotation + deg }, session: d.session },
        })),
        { label: "Rotate", soon: true },
      );
      return;
    }

    const l = toLocal(px, py);
    const h = d.handle;
    let left = f.x;
    let top = f.y;
    let right = f.x + f.w;
    let bottom = f.y + f.h;
    if (h.includes("w")) left = Math.min(l.x, right - MIN_SIZE);
    if (h.includes("e")) right = Math.max(l.x, left + MIN_SIZE);
    if (h.includes("n")) top = Math.min(l.y, bottom - MIN_SIZE);
    if (h.includes("s")) bottom = Math.max(l.y, top + MIN_SIZE);

    let w = right - left;
    let hgt = bottom - top;
    // Shift locks the original aspect on a corner handle.
    const corner = h.length === 2;
    if (shift && corner && f.w > 0 && f.h > 0) {
      const k = Math.max(w / f.w, hgt / f.h);
      w = f.w * k;
      hgt = f.h * k;
      if (h.includes("w")) left = right - w;
      else right = left + w;
      if (h.includes("n")) top = bottom - hgt;
      else bottom = top + hgt;
    }

    // Rotate the new centre back out of local space so the anchored edge holds.
    const lcx = (left + right) / 2;
    const lcy = (top + bottom) / 2;
    const back = (f.rotation * Math.PI) / 180;
    const bc = Math.cos(back);
    const bs = Math.sin(back);
    const ddx = lcx - cx;
    const ddy = lcy - cy;
    const nx = cx + ddx * bc - ddy * bs - w / 2;
    const ny = cy + ddx * bs + ddy * bc - hgt / 2;

    const kx = f.w > 0 ? w / f.w : 1;
    const ky = f.h > 0 ? hgt / f.h : 1;
    this.run(
      d.layers0.map((l0) => ({
        type: "layer.transform",
        params: {
          layerId: l0.id,
          patch: {
            x: nx + (l0.x - f.x) * kx,
            y: ny + (l0.y - f.y) * ky,
            w: Math.max(MIN_SIZE, l0.w * kx),
            h: Math.max(MIN_SIZE, l0.h * ky),
          },
          session: d.session,
        },
      })),
      { label: "Scale", soon: true },
    );
  }

  /** Line endpoint, snapped to the nearest 45° when Shift is held. */
  private lineEnd(px: number, py: number, shift: boolean): { x: number; y: number } {
    const ox = this.drag?.x ?? px;
    const oy = this.drag?.y ?? py;
    if (!shift) return { x: px, y: py };
    const dx = px - ox;
    const dy = py - oy;
    const len = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: ox + Math.cos(angle) * len, y: oy + Math.sin(angle) * len };
  }

  private bindCanvas(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.compositor) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const p = this.compositor.screenToPage(sx, sy);
      const tool = this.compositor.view.tool;
      if (tool === "hand" || e.button === 1) {
        this.drag = { mode: "pan", x: sx, y: sy, lx: this.compositor.view.panX, ly: this.compositor.view.panY };
        return;
      }
      if (tool === "move") {
        // Handles first: they sit on top of the layer they belong to, and a
        // grab on one must scale or rotate rather than start a move. Without
        // this the eight handles the compositor paints are pure decoration.
        const handle = this.compositor.hitHandle(this.doc, sx, sy);
        const frame = handle && handle !== "move" ? this.compositor.selectionFrame(this.doc) : null;
        if (handle && frame) {
          const picked = selectedLayers(this.doc).filter((l) => !l.locked);
          if (picked.length) {
            this.drag = {
              mode: "resize",
              session: uid("drag"),
              x: p.x,
              y: p.y,
              lx: frame.x,
              ly: frame.y,
              handle,
              frame0: frame,
              layers0: picked.map((l) => ({ id: l.id, ...l.transform })),
            };
            return;
          }
        }
        const hit = hitTest(this.doc, p.x, p.y);
        const next = cloneDoc(this.doc);
        next.activeLayerIds = hit ? [hit.id] : [];
        this.doc = next;
        if (hit && !hit.locked) {
          this.drag = { mode: "move", x: p.x, y: p.y, lx: hit.transform.x, ly: hit.transform.y, session: uid("drag") };
        }
        this.emit();
        return;
      }
      if (tool === "crop") {
        const hit = selectedLayers(this.doc).find((l) => l.kind === "image-frame") ?? hitTest(this.doc, p.x, p.y);
        if (hit && hit.kind === "image-frame") {
          this.doc = setActiveLayers(this.doc, [hit.id]);
          this.drag = { mode: "crop", x: p.x, y: p.y, lx: hit.transform.x, ly: hit.transform.y, lw: hit.transform.w, lh: hit.transform.h, session: uid("drag") };
        }
        this.emit();
        return;
      }
      if (tool === "marquee") {
        this.drag = { mode: "marquee", x: p.x, y: p.y, lx: p.x, ly: p.y };
        this.compositor.view.marquee = { x: p.x, y: p.y, w: 0, h: 0 };
        this.emit();
        return;
      }
      if (tool === "rect" || tool === "ellipse" || tool === "line") {
        this.drag = { mode: tool, x: p.x, y: p.y, lx: p.x, ly: p.y };
        this.compositor.view.shapePreview = { kind: tool, x: p.x, y: p.y, w: 0, h: 0 };
        return;
      }
      if (tool === "pen") {
        const sel = selectedLayers(this.doc).find((l) => l.kind === "vector" && !l.closed);
        if (sel) this.run({ type: "path.appendNode", params: { layerId: sel.id, x: p.x, y: p.y } });
        else this.run({ type: "vector.addPath", params: { x: p.x, y: p.y, color: this.compositor.view.fg } });
        return;
      }
      if (tool === "type") {
        this.run({ type: "type.addFrame", params: { fontId: this.face?.id ?? "noto-sans", x: p.x, y: p.y } });
      }
      if (tool === "zoom") {
        const factor = e.altKey ? 1 / 1.25 : 1.25;
        this.compositor.view.zoom = Math.min(16, Math.max(0.05, this.compositor.view.zoom * factor));
        this.emit();
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.compositor) return;
      if (!this.drag) {
        // Hover feedback. A handle you cannot see you can grab may as well not
        // be there, so the cursor names what the press will do.
        if (this.compositor.view.tool === "move") {
          const r0 = canvas.getBoundingClientRect();
          const over = this.compositor.hitHandle(this.doc, e.clientX - r0.left, e.clientY - r0.top);
          canvas.style.cursor = over ? HANDLE_CURSOR[over] : "default";
        }
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const p = this.compositor.screenToPage(sx, sy);
      if (this.drag.mode === "pan") {
        this.compositor.view.panX = this.drag.lx + (sx - this.drag.x);
        this.compositor.view.panY = this.drag.ly + (sy - this.drag.y);
        this.emitSoon();
        return;
      }
      if (this.drag.mode === "resize") {
        this.applyHandleDrag(p.x, p.y, e.shiftKey);
        return;
      }
      if (this.drag.mode === "move") {
        const d = this.drag;
        const cmds: Command[] = selectedLayers(this.doc)
          .filter((l) => !l.locked)
          .map((l) => ({
            type: "layer.transform",
            params: { layerId: l.id, patch: { x: d.lx + (p.x - d.x), y: d.ly + (p.y - d.y) }, session: d.session },
          }));
        if (cmds.length) this.run(cmds, { label: "Move", soon: true });
        return;
      }
      if (this.drag.mode === "crop") {
        const layer = selectedLayers(this.doc).find((l) => l.kind === "image-frame");
        if (!layer || layer.kind !== "image-frame") return;
        const x = Math.min(this.drag.x, p.x);
        const y = Math.min(this.drag.y, p.y);
        const w = Math.max(4, Math.abs(p.x - this.drag.x));
        const h = Math.max(4, Math.abs(p.y - this.drag.y));
        const asset = layer.assetId ? this.doc.assets[layer.assetId] : null;
        if (!asset) return;
        const sx0 = ((x - layer.transform.x) / layer.transform.w) * asset.width;
        const sy0 = ((y - layer.transform.y) / layer.transform.h) * asset.height;
        const sw = (w / layer.transform.w) * asset.width;
        const sh = (h / layer.transform.h) * asset.height;
        // Crop and re-frame are one gesture, so they go in as one batch and
        // coalesce into a single undo entry across the whole drag.
        this.run(
          [
            {
              type: "image.crop",
              params: {
                layerId: layer.id,
                crop: {
                  x: Math.max(0, sx0),
                  y: Math.max(0, sy0),
                  w: Math.min(asset.width, sw),
                  h: Math.min(asset.height, sh),
                },
                session: this.drag.session,
              },
            },
            {
              type: "layer.transform",
              params: { layerId: layer.id, patch: { x, y, w, h }, session: this.drag.session },
            },
          ],
          { label: "Crop", soon: true },
        );
        return;
      }
      if (this.drag.mode === "marquee" && this.compositor.view.marquee) {
        this.compositor.view.marquee = {
          x: Math.min(this.drag.x, p.x),
          y: Math.min(this.drag.y, p.y),
          w: Math.abs(p.x - this.drag.x),
          h: Math.abs(p.y - this.drag.y),
        };
        this.emitSoon();
        return;
      }
      if (this.drag.mode === "rect" || this.drag.mode === "ellipse" || this.drag.mode === "line") {
        // A line keeps its true endpoints (w/h may be negative); a box shape is
        // normalised. Both run through the same constrain helpers pointerup
        // uses, so the preview shows exactly the geometry that will commit.
        if (this.drag.mode === "line") {
          const end = this.lineEnd(p.x, p.y, e.shiftKey);
          this.compositor.view.shapePreview = {
            kind: "line",
            x: this.drag.x,
            y: this.drag.y,
            w: end.x - this.drag.x,
            h: end.y - this.drag.y,
          };
        } else {
          this.compositor.view.shapePreview = { kind: this.drag.mode, ...this.shapeBox(p.x, p.y, e.shiftKey) };
        }
        // Overlay-only: the document has not changed. A full emit() here would
        // re-composite the page on every pointer move and exhaust the heap.
        this.compositor.requestOverlayRepaint();
      }
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!this.drag || !this.compositor) return;
      const rect = canvas.getBoundingClientRect();
      const p = this.compositor.screenToPage(e.clientX - rect.left, e.clientY - rect.top);
      // Clear the preview and repaint even when nothing commits below, so a
      // drag that fell under the threshold does not leave the outline behind.
      if (this.compositor.view.shapePreview) {
        this.compositor.view.shapePreview = null;
        this.compositor.requestOverlayRepaint();
      }
      if (this.drag.mode === "rect" || this.drag.mode === "ellipse") {
        const b = this.shapeBox(p.x, p.y, e.shiftKey);
        // Below the minimum this was a stray click, not a drag. Photoshop opens
        // a size dialog here; we simply decline rather than drop a 4px artefact.
        if (b.w >= 4 && b.h >= 4) {
          const fg = this.compositor.view.fg;
          this.run({
            type: this.drag.mode === "rect" ? "vector.addRect" : "vector.addEllipse",
            params: { x: b.x, y: b.y, w: b.w, h: b.h, fill: fg },
          });
        }
      }
      if (this.drag.mode === "line") {
        const end = this.lineEnd(p.x, p.y, e.shiftKey);
        if (Math.hypot(end.x - this.drag.x, end.y - this.drag.y) >= 4) {
          this.run({
            type: "vector.addLine",
            params: {
              x1: this.drag.x,
              y1: this.drag.y,
              x2: end.x,
              y2: end.y,
              stroke: { color: this.compositor.view.fg, width: this.strokeWidth },
            },
          });
        }
      }
      if (this.drag.mode === "marquee" && this.compositor.view.marquee) {
        this.doc = selectIntersecting(this.doc, this.compositor.view.marquee);
        this.compositor.view.marquee = null;
        this.emit();
      }
      const wasResize = this.drag.mode === "resize";
      this.drag = null;
      // The drag repaints through a frame-coalesced path, so the last pointer
      // position may still be unpainted when the button comes up.
      if (wasResize) this.emit();
    });
    canvas.addEventListener("wheel", (e) => {
      if (!this.compositor) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      this.compositor.view.zoom = Math.min(16, Math.max(0.05, this.compositor.view.zoom * factor));
      this.emit();
    }, { passive: false });
  }

  undo(): void {
    const res = this.bus.undo(this.doc);
    if (res) {
      this.doc = res.doc;
      this.emit();
    }
  }

  redo(): void {
    const res = this.bus.redo(this.doc);
    if (res) {
      this.doc = res.doc;
      this.emit();
    }
  }

  newFromPreset(id: string): void {
    const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
    this.dialog = null;
    this.commit("New document", documentFromPreset(preset));
  }

  openNewDialog(): void {
    this.dialog = "new";
    this.emit();
  }

  openImageSize(): void {
    this.dialog = "image-size";
    this.emit();
  }

  openBrightness(): void {
    this.dialog = "brightness";
    this.emit();
  }

  closeDialog(): void {
    this.dialog = null;
    this.emit();
  }

  selectAll(): void {
    this.doc = setActiveLayers(
      this.doc,
      this.doc.pages.find((p) => p.id === this.doc.activePageId)?.layers.filter((l) => !l.parentId).map((l) => l.id) ?? [],
    );
    this.emit();
  }

  deselect(): void {
    this.doc = setActiveLayers(this.doc, []);
    this.emit();
  }

  async placeImage(file: File): Promise<void> {
    const dataUrl = await fileToDataUrl(file);
    const dims = await imageSize(dataUrl);
    this.run({
      type: "image.place",
      params: {
        asset: { name: file.name, mime: file.type || "image/png", dataUrl, width: dims.w, height: dims.h },
        x: 48,
        y: 48,
      },
    });
  }

  imageSize(w: number, h: number, ppi: number, resample: boolean, algo: ResampleAlgo = this.resampleAlgo): void {
    this.resampleAlgo = algo;
    // Resampling needs the compositor, which the document layer has no access to.
    // The pixel work happens here and the resulting bytes go in as command
    // params, so the derived inverse carries the ORIGINAL bytes — which is what
    // undoing a resample actually requires.
    const assets: Record<string, { dataUrl: string; width: number; height: number }> = {};
    if (resample && this.compositor) {
      const cur = this.doc.pages.find((p) => p.id === this.doc.activePageId)!;
      const sx = w / cur.widthPx;
      const sy = h / cur.heightPx;
      for (const layer of cur.layers) {
        if ((layer.kind === "image-frame" || layer.kind === "raster") && layer.assetId && this.doc.assets[layer.assetId]) {
          const asset = this.doc.assets[layer.assetId]!;
          if (assets[asset.id]) continue;
          const nw = Math.max(1, Math.round(asset.width * sx));
          const nh = Math.max(1, Math.round(asset.height * sy));
          assets[asset.id] = {
            dataUrl: this.compositor.resampleDataUrl(asset.dataUrl, nw, nh, algo),
            width: nw,
            height: nh,
          };
        }
      }
    }
    this.dialog = null;
    this.run({ type: "doc.imageSize", params: { w, h, ppi, resample, assets } });
    for (const id of Object.keys(assets)) this.compositor?.invalidateAsset(id);
  }

  typeText(text: string): void {
    const layer = selectedLayers(this.doc).find((l) => l.kind === "type-frame");
    if (!layer) return;
    this.run({ type: "story.setText", params: { layerId: layer.id, text } });
  }

  setTransform(patch: { x?: number; y?: number; w?: number; h?: number; rotation?: number; scaleX?: number; scaleY?: number }): void {
    const layer = selectedLayers(this.doc)[0];
    if (!layer) return;
    this.run({ type: "layer.transform", params: { layerId: layer.id, patch } });
  }

  setOpacity(v: number): void {
    const layer = selectedLayers(this.doc)[0];
    if (!layer) return;
    this.run({ type: "layer.opacity", params: { layerId: layer.id, opacity: v } });
  }

  setBlend(blend: BlendMode): void {
    const layer = selectedLayers(this.doc)[0];
    if (!layer) return;
    this.run({ type: "layer.blend", params: { layerId: layer.id, blend } });
  }

  setVisible(id: string, v: boolean): void {
    this.run({ type: "layer.visible", params: { layerId: id, visible: v } });
  }

  setLocked(id: string, v: boolean): void {
    this.run({ type: "layer.locked", params: { layerId: id, locked: v } });
  }

  setFg(r: number, g: number, b: number): void {
    if (this.compositor) this.compositor.view.fg = { r, g, b, a: 1 };
    const sel = selectedLayers(this.doc);
    if (sel.length) this.run({ type: "layer.fill", params: { color: { r, g, b, a: 1 } } });
    else this.emit();
  }

  setCharacter(patch: { size?: number; leading?: number; tracking?: number }): void {
    const layer = selectedLayers(this.doc).find((l) => l.kind === "type-frame");
    if (!layer) return;
    this.run({ type: "type.character", params: { layerId: layer.id, ...patch } });
  }

  setAlign(align: "left" | "center" | "right" | "justify"): void {
    const layer = selectedLayers(this.doc).find((l) => l.kind === "type-frame");
    if (!layer) return;
    this.run({ type: "type.paragraphAlign", params: { layerId: layer.id, align } });
  }

  setFit(fit: ImageFit): void {
    const layer = selectedLayers(this.doc).find((l) => l.kind === "image-frame");
    if (!layer) return;
    this.run({ type: "image.fit", params: { layerId: layer.id, fit } });
  }

  group(): void {
    this.run({ type: "layer.group", params: {} });
  }

  ungroup(): void {
    this.run({ type: "layer.ungroup", params: {} });
  }

  duplicate(): void {
    this.run({ type: "layer.duplicate", params: {} });
  }

  deleteLayers(): void {
    this.run({ type: "layer.delete", params: {} });
  }

  reorder(dir: 1 | -1): void {
    const id = this.doc.activeLayerIds[0];
    if (!id) return;
    this.run({ type: "layer.reorder", params: { layerId: id, dir } });
  }

  selectLayer(id: string, additive: boolean): void {
    const ids = additive ? [...new Set([...this.doc.activeLayerIds, id])] : [id];
    this.doc = setActiveLayers(this.doc, ids);
    this.emit();
  }

  addPageToDoc(): void {
    this.run({ type: "page.add", params: {} });
  }

  goToPage(id: string): void {
    this.doc = setActivePage(this.doc, id);
    this.emit();
  }

  brightnessContrast(brightness: number, contrast: number): void {
    this.dialog = null;
    this.run({ type: "adjustment.add", params: { brightness, contrast: 1 + contrast } });
  }

  async cutoutSelected(): Promise<void> {
    if (!this.hasCutout) return;
    const layer = selectedLayers(this.doc).find((l) => l.kind === "image-frame" || l.kind === "raster");
    if (!layer || (layer.kind !== "image-frame" && layer.kind !== "raster") || !layer.assetId) {
      this.status = "Select an image layer for cutout.";
      this.emit();
      return;
    }
    const asset = this.doc.assets[layer.assetId];
    if (!asset) return;
    this.status = "U²-Netp cutout…";
    this.emit();
    const out = await cutoutDataUrl(asset.dataUrl);
    this.compositor?.invalidateAsset(asset.id);
    this.run({ type: "asset.replace", params: { assetId: asset.id, dataUrl: out.dataUrl, width: out.width, height: out.height } });
    this.status = `Cutout · ${out.model}`;
  }

  applyAnchor(ops: AnchorOp[]): void {
    this.applyAnchorDetailed(ops);
  }

  /**
   * Apply a batch and keep the audit trail. The batch stays one undo step, and
   * the history label carries the ops own reasons rather than a flat "Anchor".
   */
  /** History label for a batch: one op speaks for itself, many get a count. */
  private anchorLabel(ops: AnchorOp[]): string {
    const first = ops[0]?.reason ?? "";
    return ops.length === 1 && first ? `Anchor — ${first}` : `Anchor — ${ops.length} ops`;
  }

  /** Turn the bus's generic notes back into the audit shape Anchor callers expect. */
  private notesToResults(ops: AnchorOp[], notes: CommandNote[]): AnchorOpResult[] {
    return notes.map((n, i) => ({
      id: ops[i]?.id ?? `op_${i}`,
      op: ops[i]?.op ?? n.type,
      reason: n.reason || (ops[i]?.reason ?? ""),
      summary: n.summary,
      created: n.created,
      selection: n.selection,
    }));
  }

  /**
   * Report exactly what a batch WOULD do, without applying it or touching
   * history. Preview and execution share one code path in the bus, so a preview
   * cannot drift from what execution actually does.
   */
  previewAnchor(ops: AnchorOp[]): AnchorOpResult[] {
    installAnchorCommands();
    const res = this.bus.preview(this.doc, anchorCommands(ops), { label: this.anchorLabel(ops) });
    return this.notesToResults(ops, res.notes);
  }

  /**
   * Apply an Anchor batch through the SAME command bus the UI uses: one undo
   * entry, a derived inverse rather than a document clone, and an audit trail.
   */
  applyAnchorDetailed(ops: AnchorOp[]): AnchorOpResult[] {
    installAnchorCommands();
    const label = this.anchorLabel(ops);
    try {
      const res = this.bus.execute(this.doc, anchorCommands(ops), { label });
      this.doc = res.doc;
      this.anchorResults = this.notesToResults(ops, res.notes);
      this.emit();
      return this.anchorResults;
    } catch (err) {
      if (!(err instanceof PatchScopeError)) throw err;
      // The op changed something the diff cannot express, so no honest inverse
      // exists yet. Fall back to the snapshot path rather than recording an undo
      // that would silently lose data. The working copy from the failed attempt
      // was discarded, so re-running is safe.
      const batch = applyAnchorBatch(this.doc, ops);
      this.anchorResults = batch.results;
      this.commit(label, batch.doc);
      this.status = `${label} — undo recorded as a full snapshot: ${err.message}`;
      return batch.results;
    }
  }

  anchorTools(): typeof ANCHOR_TOOLS {
    return ANCHOR_TOOLS;
  }

  refreshChannels(): void {
    this.channelThumbs = this.compositor?.channelThumbs(this.doc) ?? null;
    this.emit();
  }

  exportPng(): void {
    if (!this.compositor) return;
    const bytes = this.compositor.snapshotPagePng(this.doc);
    download(bytes, `${this.doc.name}.png`, "image/png");
  }

  /**
   * Vector PDF. The document graph is walked and emitted as PDF path and text
   * operators — not a page screenshot. Type goes in as real glyphs against an
   * embedded, subset Noto Sans, positioned at the coordinates HarfBuzz shaped
   * for the canvas, so the PDF cannot reflow away from what the user sees.
   * The only raster in the file is the raster that belongs there: placed images,
   * plus the sub-stack under an adjustment layer, which is a pixel operation.
   */
  async exportPdf(): Promise<void> {
    const compositor = this.compositor;
    if (!compositor) return;
    const { exportPagePdf } = await import("./export/pdf");
    try {
      const { bytes, report } = await exportPagePdf({
        doc: this.doc,
        face: this.face,
        rasterise: (doc) => compositor.snapshotPagePng(doc),
      });
      download(bytes, `${this.doc.name}.pdf`, "application/pdf");
      const bits = [
        `${report.pagePt.w} × ${report.pagePt.h} pt`,
        `${report.vectorPaths} path${report.vectorPaths === 1 ? "" : "s"}`,
        `${report.glyphs} glyph${report.glyphs === 1 ? "" : "s"} in ${report.textRuns} run${report.textRuns === 1 ? "" : "s"}`,
        `${report.images} image${report.images === 1 ? "" : "s"}`,
      ];
      if (report.rasterFallbacks.length) bits.push(`${report.rasterFallbacks.length} raster fallback(s)`);
      this.status = `PDF exported — ${bits.join(", ")}. RGB, not PDF/X.`;
      this.lastPdfReport = report;
    } catch (err) {
      this.status = `PDF export failed — ${err instanceof Error ? err.message : String(err)}`;
      this.lastPdfReport = null;
    }
    this.emit();
  }

  savePressJson(): void {
    const bytes = new TextEncoder().encode(JSON.stringify(this.doc));
    download(bytes, `${this.doc.name}.press.json`, "application/json");
  }

  async openBytes(name: string, bytes: ArrayBuffer): Promise<void> {
    const lower = name.toLowerCase();
    if (lower.endsWith(".psd")) {
      this.commit("Open PSD", documentFromPsd(bytes, name));
      return;
    }
    if (lower.endsWith(".vdj") || lower.endsWith(".json")) {
      const text = new TextDecoder().decode(bytes);
      const json = JSON.parse(text);
      if (typeof json.version === "number" && json.version >= 1 && json.version <= 3 && json.pages && json.stories) {
        // A v1 file holds ABSOLUTE child coordinates. v2 composes group
        // transforms, so it MUST be rebased on the way in or every grouped
        // document would open shifted by its own group origin.
        const doc = json as PressDocument;
        const report = migrateDocument(doc);
        this.commit("Open", doc);
        if (report.from !== report.to) {
          const bits = [`migrated v${report.from}→v${report.to}`, `${report.layersRebased} layer(s) rebased`];
          if (report.imageFitsNormalised) {
            bits.push(`${report.imageFitsNormalised} image fit(s) "fill" → "stretch"`);
          }
          if (report.groupRotationsDiscarded) {
            bits.push(`${report.groupRotationsDiscarded} inert group rotation(s) dropped`);
          }
          if (report.textStoriesInitialised || report.textFramesInitialised) {
            bits.push(
              `${report.textStoriesInitialised} text stor${report.textStoriesInitialised === 1 ? "y" : "ies"} and ` +
                `${report.textFramesInitialised} text frame(s) upgraded`,
            );
          }
          if (report.notes.length) bits.push(report.notes.join("; "));
          this.status = `Opened ${name} — ${bits.join(", ")}`;
        }
      } else {
        this.commit("Open VDJ", documentFromVdj(json, name));
      }
      return;
    }
    if (/\.(png|jpe?g|webp)$/i.test(name)) {
      const blob = new Blob([bytes]);
      const file = new File([blob], name);
      await this.placeImage(file);
    }
  }

  toggleRulers(): void {
    if (!this.compositor) return;
    this.compositor.view.showRulers = !this.compositor.view.showRulers;
    this.emit();
  }

  toggleBleed(): void {
    if (!this.compositor) return;
    this.compositor.view.showBleed = !this.compositor.view.showBleed;
    this.emit();
  }

  toggleGuides(): void {
    if (!this.compositor) return;
    this.compositor.view.showGuides = !this.compositor.view.showGuides;
    this.emit();
  }

  zoomBy(factor: number): void {
    if (!this.compositor) return;
    this.compositor.view.zoom = Math.min(16, Math.max(0.05, this.compositor.view.zoom * factor));
    this.emit();
  }

  nameHistory(label: string): void {
    this.bus.nameSnapshot(label, this.doc);
    this.emit();
  }
}

function download(bytes: Uint8Array, name: string, mime: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
}

export { PRESETS };
