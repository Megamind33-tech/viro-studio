import { migrateDocument } from "./document/migrate";
import type { BlendMode, DropShadowEffect, GradientOverlayEffect, ImageFit, Layer, OuterGlowEffect, PressDocument, ResampleAlgo, Rgba, StrokeEffect, ToolId, VectorLayer } from "./document/types";
import { setBooleanEngineProvider, type BooleanOp } from "./document/boolean-ops";
import {
  addImageFrame,
  addTypeFrame,
  addVectorEllipse,
  addVectorLine,
  addVectorRect,
  applyImageSize,
  activePage,
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
  alignLayers,
  distributeLayers,
  type AlignMode,
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
  setLayerDropShadow,
  setLayerGradientOverlay,
  setLayerOuterGlow,
  setLayerStrokeEffect,
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
import { nearestCaretOffset, type FacePack } from "./engine/type";
import { fontRegistry, type FontRegistry } from "./engine/font-registry";
import { makeFallbackFace } from "./engine/latin-fallback";
import { mimeForImageFile, sniffBytes } from "./engine/sniff";
import type { PdfExportReport } from "./export/pdf";
import { documentFromPsd } from "./import/psd";
import { documentFromVdj } from "./import/vdj";
import { pageToLocal, worldBounds } from "./document/transform";
import {
  movedLayerBox,
  resolveMoveSnap,
  rotatedLayerBox,
  scaleFromHandle,
  scaledLayerBox,
  type Frame,
  type ResizeHandle,
} from "./document/multi-transform";
import {
  deleteRecovery,
  getRecovery,
  putRecovery,
  putUserAsset,
  type RecoverySnapshot,
} from "./library/store";
import { flag } from "./platform/flags";
import { projects, type ProjectRecord, type ProjectSummary } from "./platform/projects";

/** Smallest edge a layer may be scaled to, in page px. */
const MIN_SIZE = 4;

/** Smart-guide snap tolerance, in screen (CSS) px, converted to page px per drag. */
const SNAP_PX = 6;
/** Fixed capacity of the reused smart-guide line arrays — a move can light at most a handful. */
const GUIDE_CAP = 8;

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
  fonts: FontRegistry = fontRegistry();
  face: FacePack | null = null;
  /**
   * Live type-edit. The hidden textarea is the IME/keyboard surface; the
   * compositor paints the caret from the same offsets.
   */
  textSession: { layerId: string; session: string } | null = null;
  private editor: HTMLTextAreaElement | null = null;
  labSample: { L: number; a: number; b: number } | null = null;
  ckSource = "";
  status = "Booting engines…";
  hasCutout = false;
  resampleAlgo: ResampleAlgo = "bicubic";
  /** Default stroke weight in page px for the Line tool. */
  strokeWidth = 2;
  constrainImageSize = true;
  listeners = new Set<() => void>();
  /**
   * Autosave/recovery. The working document is written to IndexedDB shortly
   * after each edit so a reload or crash does not lose unsaved work. `dirty`
   * gates writes so an untouched freshly-booted document never overwrites a
   * genuine recovery snapshot. `pendingRecovery` is a snapshot found at boot
   * that predates this session; the UI offers to restore it.
   */
  private dirty = false;
  private booted = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  /** Bus revision last durably written to the recovery slot. */
  private savedRev = 0;
  pendingRecovery: RecoverySnapshot | null = null;
  /** Debounce for autosave writes, in ms. */
  private static AUTOSAVE_MS = 1200;
  /**
   * The project this session is editing. Once the user makes a real edit a
   * project is created (or an opened one is reused), so work is always captured
   * in the local library, not just the crash-recovery slot.
   */
  currentProjectId: string | null = null;
  private projectCreatedAt = 0;
  private lastThumbnail: string | null = null;
  private lastThumbAt = 0;
  /** Regenerate the page thumbnail at most this often during active editing. */
  private static THUMB_MS = 4000;
  dialog: "image-size" | "new" | "brightness" | null = null;
  channelThumbs: { r: string; g: string; b: string; rgb: string } | null = null;
  /** Per-op audit trail from the last Anchor batch, for the queue surface. */
  anchorResults: AnchorOpResult[] = [];
  /** What the last PDF export actually emitted — vector counts and any raster fallbacks. */
  lastPdfReport: PdfExportReport | null = null;
  drag: {
    mode: "move" | "marquee" | "pan" | "rect" | "ellipse" | "line" | "crop" | "resize" | "type";
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
    /**
     * Smart-guide candidate lines, precomputed ONCE at pointer-down so the
     * pointer-move loop never rebuilds them (RFC-6 perf constraint). `snapXs`
     * are vertical-line X positions, `snapYs` horizontal-line Y positions, both
     * in page px; `snapTol` is the tolerance in page px at the drag's zoom.
     */
    snapXs?: number[];
    snapYs?: number[];
    snapTol?: number;
  } | null = null;

  /**
   * Smart-guide snapping toggle (View ▸ Snap to Guides). On by default; holding
   * Alt mid-drag suspends it for one gesture without changing the setting.
   */
  snapEnabled = true;

  /**
   * The smart-guide overlay lines, reused across every pointer event of a move
   * so the hot path allocates nothing — only `xn`/`yn` and the slots change.
   * The compositor reads this off the view during its overlay pass.
   */
  private guideLines = {
    xs: new Float64Array(GUIDE_CAP),
    xn: 0,
    ys: new Float64Array(GUIDE_CAP),
    yn: 0,
  };

  constructor() {
    installUiCommands();
    installAnchorCommands();
    this.doc = documentFromPreset(PRESETS[0]!);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(forceChrome = false): void {
    this.trackRevision();
    this.compositor?.draw(this.doc);
    // During a pointer gesture the canvas must repaint every frame, but rebuilding
    // every panel (layer rows, navigator page thumb, history, …) on each coalesced
    // move does N layerThumb + pageThumb composites plus a full innerHTML rewrite.
    // That work is deferred to pointer-up so drag/resize stays on the hot path only.
    if (!forceChrome && this.drag) return;
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

  /**
   * Detect a genuine content change via the command-bus revision. Every path
   * that mutates the document (commit, run, Anchor batches, drag commits,
   * undo/redo) advances the revision, while pure selection/tool repaints do
   * not — so autosave fires on real edits only. Called from emit(), the single
   * repaint funnel.
   */
  private trackRevision(): void {
    if (!this.booted) return;
    if (this.bus.revision() !== this.savedRev) {
      this.dirty = true;
      this.scheduleAutosave();
    }
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer) return;
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = 0;
      void this.autosaveTick();
    }, PressApp.AUTOSAVE_MS);
  }

  /** One debounced autosave: crash-recovery slot + the persisted project. */
  private async autosaveTick(): Promise<void> {
    await this.writeRecovery();
    if (flag("platform.enabled")) await this.persistCurrentProject();
  }

  /**
   * Persist the working document to the local recovery slot. Serialises through
   * JSON so the stored value is a plain structured-clone-safe snapshot and never
   * a live reference. Failures (private mode, quota) degrade to an in-memory
   * session rather than throwing into the edit path.
   */
  async writeRecovery(): Promise<void> {
    if (!this.dirty) return;
    const rev = this.bus.revision();
    const snapshot: RecoverySnapshot = {
      id: "current",
      doc: JSON.parse(JSON.stringify(this.doc)),
      name: this.doc.name,
      savedAt: Date.now(),
    };
    try {
      await putRecovery(snapshot);
      this.savedRev = rev;
      // Edits may have landed while the write was in flight.
      if (this.bus.revision() === rev) this.dirty = false;
      else this.scheduleAutosave();
    } catch {
      // Non-durable environment: keep editing; the reload safety net is simply
      // unavailable and we do not pretend otherwise.
    }
  }

  /**
   * Flush any pending autosave immediately. Used when the page is being hidden
   * or unloaded so the last edits are not lost to the debounce window.
   */
  flushRecovery(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = 0;
    }
    void this.autosaveTick();
  }

  // ── Projects (local library; cloud provider slots in behind this) ─────────

  /**
   * Render a page thumbnail from the ACTUAL document, throttled so active
   * editing does not pay a full composite every autosave. Returns the last
   * thumbnail when not due, or null if rendering is unavailable.
   */
  private maybeThumbnail(force = false): string | null {
    if (!this.compositor) return this.lastThumbnail;
    const now = Date.now();
    if (!force && this.lastThumbnail && now - this.lastThumbAt < PressApp.THUMB_MS) {
      return this.lastThumbnail;
    }
    try {
      const url = this.compositor.thumbnailDataUrl(this.doc, 360);
      if (url) {
        this.lastThumbnail = url;
        this.lastThumbAt = now;
      }
    } catch {
      // A thumbnail failure must never break autosave or the edit path.
    }
    return this.lastThumbnail;
  }

  /** Upsert the working document into the local project library. */
  async persistCurrentProject(force = false): Promise<void> {
    if (!this.dirty && !force) return;
    if (!this.currentProjectId) {
      this.currentProjectId = uid("proj");
      this.projectCreatedAt = Date.now();
    }
    const now = Date.now();
    const record: ProjectRecord = {
      id: this.currentProjectId,
      name: this.doc.name || "Untitled",
      doc: JSON.parse(JSON.stringify(this.doc)),
      thumbnail: this.maybeThumbnail(force),
      createdAt: this.projectCreatedAt || now,
      updatedAt: now,
    };
    try {
      await projects().save(record);
    } catch {
      // Non-durable environment: keep editing; local library is unavailable.
    }
  }

  /** Save the current project immediately with a freshly rendered thumbnail. */
  async saveProjectNow(): Promise<void> {
    await this.persistCurrentProject(true);
    this.status = `Saved “${this.doc.name || "Untitled"}” to Projects`;
    this.emit();
  }

  listProjects(): Promise<ProjectSummary[]> {
    return projects().list();
  }

  /** Load a saved project as the working document. */
  async openProject(id: string): Promise<boolean> {
    const record = await projects().get(id);
    if (!record || !record.doc) {
      this.status = "Project not found";
      this.emit();
      return false;
    }
    try {
      const doc = JSON.parse(JSON.stringify(record.doc)) as PressDocument;
      migrateDocument(doc);
      this.commit("Open project", doc);
      this.currentProjectId = record.id;
      this.projectCreatedAt = record.createdAt;
      this.lastThumbnail = record.thumbnail;
      this.lastThumbAt = 0;
      // The freshly opened state is the saved baseline, not unsaved work.
      this.savedRev = this.bus.revision();
      this.dirty = false;
      this.status = `Opened “${doc.name || "Untitled"}”`;
      this.emit();
      return true;
    } catch (err) {
      this.status = `Could not open project — ${err instanceof Error ? err.message : String(err)}`;
      this.emit();
      return false;
    }
  }

  /** Start a fresh project from a preset, capturing it in the library. */
  async newProject(presetId?: string): Promise<void> {
    const preset = presetId ? PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]! : PRESETS[0]!;
    this.commit("New project", documentFromPreset(preset));
    this.currentProjectId = uid("proj");
    this.projectCreatedAt = Date.now();
    this.lastThumbnail = null;
    this.lastThumbAt = 0;
    await this.persistCurrentProject(true);
    this.emit();
  }

  async renameProject(id: string, name: string): Promise<void> {
    const clean = name.trim();
    if (!clean) return;
    const record = await projects().get(id);
    if (!record) return;
    record.name = clean;
    record.updatedAt = Date.now();
    if (record.doc && typeof record.doc === "object") {
      (record.doc as { name?: string }).name = clean;
    }
    await projects().save(record);
    if (id === this.currentProjectId) {
      this.doc.name = clean;
    }
    this.emit();
  }

  async deleteProject(id: string): Promise<void> {
    await projects().remove(id);
    if (id === this.currentProjectId) {
      this.currentProjectId = null;
    }
    this.emit();
  }

  /**
   * Read any recovery snapshot left by a previous session. Only surfaces a
   * snapshot that predates this session's edits, so a normal fresh load shows
   * no prompt.
   */
  private async loadPendingRecovery(): Promise<void> {
    if (this.dirty) return;
    try {
      const snap = await getRecovery();
      if (snap && snap.doc) this.pendingRecovery = snap;
    } catch {
      this.pendingRecovery = null;
    }
  }

  /** Adopt the recovery snapshot as the working document. */
  restoreRecovery(): boolean {
    const snap = this.pendingRecovery;
    if (!snap || !snap.doc) return false;
    try {
      const doc = JSON.parse(JSON.stringify(snap.doc)) as PressDocument;
      migrateDocument(doc);
      this.commit("Recover unsaved work", doc);
      this.pendingRecovery = null;
      this.status = `Recovered “${doc.name}” from ${new Date(snap.savedAt).toLocaleString()}`;
      this.emit();
      return true;
    } catch (err) {
      this.status = `Could not recover — ${err instanceof Error ? err.message : String(err)}`;
      this.emit();
      return false;
    }
  }

  /** Discard the recovery snapshot; the user has chosen to start clean. */
  discardRecovery(): void {
    this.pendingRecovery = null;
    void deleteRecovery();
    this.emit();
  }

  async boot(canvas: HTMLCanvasElement): Promise<void> {
    this.status = "Loading CanvasKit (Skia)…";
    this.emit();
    await this.loadPendingRecovery();
    const { ck, source } = await loadCanvasKit();
    this.ckSource = source;

    this.status = "Loading fonts…";
    this.emit();
    await this.fonts.loadBundled();
    await this.fonts.loadUserFonts();
    if (window.viroPress?.listFonts) {
      try {
        this.fonts.registerSystem(await window.viroPress.listFonts());
      } catch (err) {
        console.warn("[fonts] system list failed", err);
      }
    }
    if (!this.fonts.resolve(undefined)) {
      const fallback = await makeFallbackFace();
      this.fonts.add({
        id: fallback.id,
        family: "Viro Fallback",
        style: "Regular",
        name: "Viro Fallback",
        source: "bundled",
        face: fallback,
      });
      this.fonts.fallbackId = fallback.id;
    }
    this.face = this.fonts.resolve(undefined);

    this.status = "Loading LittleCMS…";
    this.emit();
    this.lcms = await loadLcms();
    this.labSample = rgb8ToLab(this.lcms, 224, 122, 47);

    this.hasCutout = await cutoutAvailable();

    this.engines = { ck, backend: "webgl", face: this.face, fonts: this.fonts };
    this.compositor = new Compositor(this.engines, canvas);
    setBooleanEngineProvider(() => this.compositor?.engines.ck ?? null);
    const host = canvas.parentElement!;
    const fit = () => {
      this.compositor?.resize(host.clientWidth, host.clientHeight);
      this.compositor?.draw(this.doc);
    };
    fit();
    new ResizeObserver(fit).observe(host);
    this.bindCanvas(canvas);
    this.bindKeys();
    this.bindPasteboard(canvas);
    this.status = `Skia ${this.engines.backend} · HarfBuzz · ${this.fonts.list().filter((f) => f.face).length} face(s) · ${colourStackLabel()}`;
    this.booted = true;
    // Flush the last edits before the tab is hidden or torn down, so the
    // debounce window never costs unsaved work on reload/close.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this.flushRecovery();
      });
      window.addEventListener("pagehide", () => this.flushRecovery());
    }
    // Catch any edits that landed before boot completed.
    this.trackRevision();
    this.emit();
  }

  setTool(tool: ToolId): void {
    if (!this.compositor) return;
    if (tool !== "type") this.exitTypeEdit();
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
        this.exitTypeEdit();
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
        if (this.textSession) return;
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
    const f: Frame = d.frame0;

    if (d.handle === "rotate") {
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      const base = Math.atan2(d.y - cy, d.x - cx);
      const now = Math.atan2(py - cy, px - cx);
      let deg = ((now - base) * 180) / Math.PI;
      // Photoshop snaps rotation to 15° increments with Shift held.
      if (shift) deg = Math.round(deg / 15) * 15;
      this.run(
        d.layers0.map((l0) => {
          const r = rotatedLayerBox(l0, f, deg);
          return {
            type: "layer.transform" as const,
            params: { layerId: l0.id, patch: { x: r.x, y: r.y, rotation: r.rotation }, session: d.session },
          };
        }),
        { label: "Rotate", soon: true },
      );
      return;
    }

    const s = scaleFromHandle(f, d.handle as ResizeHandle, px, py, { shift, minSize: MIN_SIZE });
    this.run(
      d.layers0.map((l0) => {
        const box = scaledLayerBox(l0, f, s, MIN_SIZE);
        return {
          type: "layer.transform" as const,
          params: {
            layerId: l0.id,
            patch: { x: box.x, y: box.y, w: box.w, h: box.h },
            session: d.session,
          },
        };
      }),
      { label: "Scale", soon: true },
    );
  }

  /**
   * Begin a move gesture for `picked`, capturing each member's pointer-down box
   * and — when snapping is on and the frame is axis-aligned — the candidate
   * guide lines ONCE, so the pointer-move loop rebuilds nothing (RFC-6 perf).
   */
  private beginMoveDrag(p: { x: number; y: number }, picked: Layer[]): void {
    if (!this.compositor) return;
    const frame = this.compositor.selectionFrame(this.doc);
    const layers0 = picked.map((l) => ({ id: l.id, ...l.transform }));
    const drag: NonNullable<PressApp["drag"]> = {
      mode: "move",
      session: uid("drag"),
      x: p.x,
      y: p.y,
      lx: p.x,
      ly: p.y,
      layers0,
      ...(frame ? { frame0: frame } : {}),
    };
    if (this.snapEnabled && frame && frame.rotation === 0) {
      const exclude = new Set(picked.map((l) => l.id));
      const cand = this.buildSnapCandidates(exclude);
      drag.snapXs = cand.xs;
      drag.snapYs = cand.ys;
      drag.snapTol = SNAP_PX / this.compositor.view.zoom;
      this.guideLines.xn = 0;
      this.guideLines.yn = 0;
      this.compositor.view.smartGuides = this.guideLines;
    }
    this.drag = drag;
  }

  /**
   * Snap-target lines for a move, computed once at pointer-down: the page frame,
   * its margins and centre, plus every OTHER top-level layer's edges and centre.
   * Excludes the layers being moved so a selection never snaps to itself.
   */
  private buildSnapCandidates(exclude: Set<string>): { xs: number[]; ys: number[] } {
    const page = activePage(this.doc);
    const xs: number[] = [0, page.widthPx / 2, page.widthPx];
    const ys: number[] = [0, page.heightPx / 2, page.heightPx];
    const m = page.margin;
    xs.push(m.left, page.widthPx - m.right);
    ys.push(m.top, page.heightPx - m.bottom);
    for (const l of page.layers) {
      if (l.parentId || exclude.has(l.id) || l.kind === "adjustment") continue;
      const b = worldBounds(page, l);
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    return { xs, ys };
  }

  /**
   * One step of a move drag: raw delta from pointer-down, nudged onto the
   * nearest smart guide (unless Alt suspends snapping), then applied to every
   * member from its OWN pointer-down box so the set moves rigidly. The whole
   * gesture coalesces to one undo entry via the shared `session` key.
   *
   * Allocation on this path is limited to the per-event command array the bus
   * already requires; the snap candidates and guide-line arrays are reused.
   */
  private applyMoveDrag(px: number, py: number, alt: boolean): void {
    const d = this.drag;
    if (!d?.layers0) return;
    let dx = px - d.x;
    let dy = py - d.y;
    const guides = this.guideLines;
    guides.xn = 0;
    guides.yn = 0;
    if (!alt && this.snapEnabled && d.frame0 && d.snapXs && d.snapYs && d.snapTol) {
      const snap = resolveMoveSnap(d.frame0, dx, dy, d.snapXs, d.snapYs, d.snapTol);
      dx += snap.ox;
      dy += snap.oy;
      if (snap.guideX !== null && guides.xn < GUIDE_CAP) guides.xs[guides.xn++] = snap.guideX;
      if (snap.guideY !== null && guides.yn < GUIDE_CAP) guides.ys[guides.yn++] = snap.guideY;
    }
    const cmds: Command[] = d.layers0.map((l0) => {
      const mv = movedLayerBox(l0, dx, dy);
      return {
        type: "layer.transform",
        params: { layerId: l0.id, patch: { x: mv.x, y: mv.y }, session: d.session },
      };
    });
    if (cmds.length) this.run(cmds, { label: "Move", soon: true });
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
        if (this.textSession) this.exitTypeEdit();
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
        // Group move: pressing INSIDE the union frame of a 2+ selection drags
        // every member together, without collapsing the selection to the layer
        // under the cursor. Shift falls through to additive single-hit select.
        const selected = selectedLayers(this.doc);
        if (selected.length > 1 && handle === "move" && !e.shiftKey) {
          const picked = selected.filter((l) => !l.locked && l.parentId === null);
          if (picked.length) {
            this.beginMoveDrag(p, picked);
            return;
          }
        }
        const hit = hitTest(this.doc, p.x, p.y);
        const next = cloneDoc(this.doc);
        next.activeLayerIds = hit ? [hit.id] : [];
        this.doc = next;
        if (hit && !hit.locked) {
          this.beginMoveDrag(p, [hit]);
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
        const hit = hitTest(this.doc, p.x, p.y);
        if (hit?.kind === "type-frame" && !hit.locked) {
          this.doc = setActiveLayers(this.doc, [hit.id]);
          const local = pageToLocal(activePage(this.doc), hit, p.x, p.y);
          const layout = this.compositor.typeLayout(this.doc, hit.id);
          const offset =
            local && layout ? nearestCaretOffset(layout.stops, local.x, local.y) : 0;
          this.enterTypeEdit(hit.id, offset);
          return;
        }
        this.exitTypeEdit();
        this.drag = { mode: "type", x: p.x, y: p.y, lx: p.x, ly: p.y };
        this.compositor.view.shapePreview = { kind: "rect", x: p.x, y: p.y, w: 0, h: 0 };
        return;
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
        this.applyMoveDrag(p.x, p.y, e.altKey);
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
      if (this.drag.mode === "rect" || this.drag.mode === "ellipse" || this.drag.mode === "line" || this.drag.mode === "type") {
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
          this.compositor.view.shapePreview = { kind: this.drag.mode === "type" ? "rect" : this.drag.mode, ...this.shapeBox(p.x, p.y, e.shiftKey) };
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
      if (this.drag.mode === "type") {
        const b = this.shapeBox(p.x, p.y, e.shiftKey);
        const fontId = this.fonts.defaultId();
        if (b.w >= 8 && b.h >= 8) {
          this.run({
            type: "type.addFrame",
            params: { fontId, x: b.x, y: b.y, w: b.w, h: b.h, text: "" },
          });
        } else {
          this.run({
            type: "type.addFrame",
            params: { fontId, x: this.drag.x, y: this.drag.y, text: "Type" },
          });
        }
        const id = this.doc.activeLayerIds[0];
        if (id) this.enterTypeEdit(id, 0, true);
      }
      if (this.drag.mode === "marquee" && this.compositor.view.marquee) {
        this.doc = selectIntersecting(this.doc, this.compositor.view.marquee);
        this.compositor.view.marquee = null;
        this.compositor.view.smartGuides = null;
        this.drag = null;
        this.emit(true);
        return;
      }
      const ended = this.drag.mode;
      this.drag = null;
      // Smart guides are a mid-drag affordance only; drop them on release.
      if (this.compositor.view.smartGuides) this.compositor.view.smartGuides = null;
      // The drag repaints through a frame-coalesced path, so the last pointer
      // position may still be unpainted when the button comes up. Refresh panels
      // once the gesture ends — they were skipped during the drag for perf.
      if (ended === "resize" || ended === "move" || ended === "crop") this.emit(true);
    });
    canvas.addEventListener("dblclick", (e) => {
      if (!this.compositor) return;
      const rect = canvas.getBoundingClientRect();
      const p = this.compositor.screenToPage(e.clientX - rect.left, e.clientY - rect.top);
      const hit = hitTest(this.doc, p.x, p.y);
      if (hit?.kind === "type-frame" && !hit.locked) {
        this.doc = setActiveLayers(this.doc, [hit.id]);
        const local = pageToLocal(activePage(this.doc), hit, p.x, p.y);
        const layout = this.compositor.typeLayout(this.doc, hit.id);
        const offset = local && layout ? nearestCaretOffset(layout.stops, local.x, local.y) : 0;
        this.setTool("type");
        this.enterTypeEdit(hit.id, offset);
      }
    });
    canvas.addEventListener("wheel", (e) => {
      if (!this.compositor) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      this.compositor.view.zoom = Math.min(16, Math.max(0.05, this.compositor.view.zoom * factor));
      this.emitSoon();
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
    this.exitTypeEdit();
    this.doc = setActiveLayers(this.doc, []);
    this.emit();
  }

  async placeImage(file: File, at?: { x: number; y: number }): Promise<void> {
    try {
      const mime = mimeForImageFile(file);
      const blob = file.type === mime ? file : new Blob([await file.arrayBuffer()], { type: mime });
      const dataUrl = await blobToDataUrl(blob);
      const dims = await imageSize(dataUrl);
      this.run({
        type: "image.place",
        params: {
          asset: { name: file.name, mime, dataUrl, width: dims.w, height: dims.h },
          x: at?.x ?? 48,
          y: at?.y ?? 48,
        },
      });
      try {
        await putUserAsset({
          id: uid("lib"),
          name: file.name,
          mime,
          dataUrl,
          width: dims.w,
          height: dims.h,
          addedAt: Date.now(),
        });
      } catch {
        // IndexedDB is optional; the layer is already on the page.
      }
    } catch (err) {
      this.status = `Place failed — ${err instanceof Error ? err.message : String(err)}`;
      this.emit();
    }
  }

  async ingestFiles(files: File[], at?: { x: number; y: number }): Promise<void> {
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const sniff = sniffBytes(file.name, bytes);
      if (sniff.kind === "font") {
        await this.importFontBytes(file.name, bytes);
        continue;
      }
      if (sniff.kind === "image") {
        await this.placeImage(new File([bytes], file.name, { type: sniff.mime }), at);
        continue;
      }
      if (sniff.kind === "document" || /\.(psd|vdj|json)$/i.test(file.name)) {
        await this.openBytes(file.name, bytes);
        continue;
      }
      this.status = `Cannot place “${file.name}” — drop a PNG, JPEG, WebP, GIF, BMP, TTF/OTF, PSD or Press JSON`;
      this.emit();
    }
  }

  async importFontBytes(fileName: string, bytes: ArrayBuffer): Promise<void> {
    try {
      const rec = await this.fonts.importBytes(fileName, bytes, true);
      this.status = `Imported font ${rec.name}`;
      const layer = selectedLayers(this.doc).find((l) => l.kind === "type-frame");
      if (layer) this.setFont(rec.id);
      else this.emit();
    } catch (err) {
      this.status = `Font import failed — ${err instanceof Error ? err.message : String(err)}`;
      this.emit();
    }
  }

  async setFont(fontId: string): Promise<void> {
    await this.fonts.ensureLoaded(fontId);
    const layer = selectedLayers(this.doc).find((l) => l.kind === "type-frame");
    if (!layer) {
      this.emit();
      return;
    }
    this.run({ type: "type.character", params: { layerId: layer.id, fontId } });
  }

  typeText(text: string): void {
    const layer = selectedLayers(this.doc).find((l) => l.kind === "type-frame");
    if (!layer) return;
    this.run({
      type: "story.setText",
      params: { layerId: layer.id, text, session: this.textSession?.session },
    });
    if (this.textSession) this.syncEditorFromStory();
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

  /** Align the current multi-selection to its shared bounds. One undo step. */
  alignSelected(mode: AlignMode): void {
    const ids = this.doc.activeLayerIds;
    if (ids.length < 2) return;
    this.commit(`Align ${mode}`, alignLayers(this.doc, ids, mode));
  }

  /** Evenly distribute the current selection along an axis. One undo step. */
  distributeSelected(axis: "h" | "v"): void {
    const ids = this.doc.activeLayerIds;
    if (ids.length < 3) return;
    this.commit(`Distribute ${axis}`, distributeLayers(this.doc, ids, axis));
  }

  /** Set or clear (null) the drop-shadow effect on a layer. One undo step. */
  setDropShadow(id: string, shadow: DropShadowEffect | null): void {
    this.commit("Drop shadow", setLayerDropShadow(this.doc, id, shadow));
  }

  /** Set or clear (null) the gradient-overlay effect on a layer. One undo step. */
  setGradientOverlay(id: string, overlay: GradientOverlayEffect | null): void {
    this.commit("Gradient overlay", setLayerGradientOverlay(this.doc, id, overlay));
  }

  /** Set or clear (null) the stroke/outline effect on a layer. One undo step. */
  setStrokeEffect(id: string, stroke: StrokeEffect | null): void {
    this.commit("Stroke effect", setLayerStrokeEffect(this.doc, id, stroke));
  }

  /** Set or clear (null) the outer-glow effect on a layer. One undo step. */
  setOuterGlow(id: string, glow: OuterGlowEffect | null): void {
    this.commit("Outer glow", setLayerOuterGlow(this.doc, id, glow));
  }

  /** A sensible default stroke/outline used when the effect is first enabled. */
  static defaultStrokeEffect(): StrokeEffect {
    return {
      type: "stroke",
      enabled: true,
      color: { r: 0.88, g: 0.48, b: 0.18, a: 1 },
      width: 6,
      opacity: 1,
    };
  }

  /** A sensible default outer glow used when the effect is first enabled. */
  static defaultOuterGlow(): OuterGlowEffect {
    return {
      type: "outer-glow",
      enabled: true,
      color: { r: 1, g: 0.9, b: 0.4, a: 1 },
      blur: 16,
      opacity: 0.85,
    };
  }

  /** A sensible default gradient overlay used when the effect is first enabled. */
  static defaultGradientOverlay(): GradientOverlayEffect {
    return {
      type: "gradient-overlay",
      enabled: true,
      angle: 90,
      stops: [
        { offset: 0, color: { r: 0.88, g: 0.48, b: 0.18, a: 1 } },
        { offset: 1, color: { r: 0.12, g: 0.12, b: 0.14, a: 1 } },
      ],
      opacity: 1,
    };
  }

  /** A sensible default drop shadow, used when the effect is first enabled. */
  static defaultDropShadow(): DropShadowEffect {
    return {
      type: "drop-shadow",
      enabled: true,
      color: { r: 0, g: 0, b: 0, a: 1 },
      offsetX: 6,
      offsetY: 8,
      blur: 12,
      opacity: 0.45,
    };
  }

  setFg(r: number, g: number, b: number): void {
    if (this.compositor) this.compositor.view.fg = { r, g, b, a: 1 };
    const sel = selectedLayers(this.doc);
    if (sel.length) this.run({ type: "layer.fill", params: { color: { r, g, b, a: 1 } } });
    else this.emit();
  }

  setCharacter(patch: { size?: number; leading?: number; tracking?: number; fill?: Rgba; fontId?: string }): void {
    const layer = selectedLayers(this.doc).find((l) => l.kind === "type-frame");
    if (!layer) return;
    if (patch.fontId) void this.fonts.ensureLoaded(patch.fontId);
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

  /**
   * ADR 0005 Phase A Pathfinder. Combine 2+ selected vector layers with the
   * given boolean op, consuming operands into one multi-contour result layer in a
   * single derived-inverse history step (undo restores all operands).
   */
  booleanSelected(op: BooleanOp): boolean {
    const ok = this.run({ type: "vector.boolean", params: { op } });
    if (ok) {
      const result = selectedLayers(this.doc).find((l) => l.kind === "vector");
      if (result?.kind === "vector") {
        const n = result.contours?.length ?? 1;
        this.status = `Pathfinder ${op} → "${result.name}" (${n} contour${n === 1 ? "" : "s"})`;
        this.emit();
      }
    }
    return ok;
  }

  /** Minus Front — topmost minus the one beneath. */
  subtractSelected(): boolean {
    return this.booleanSelected("subtract");
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
        face: this.fonts.resolve(undefined) ?? this.face,
        fonts: this.fonts,
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
      if (typeof json.version === "number" && json.version >= 1 && json.version <= 6 && json.pages && json.stories) {
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
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) {
      const blob = new Blob([bytes]);
      const file = new File([blob], name);
      await this.placeImage(file);
      return;
    }
    if (/\.(ttf|otf|woff)$/i.test(name)) {
      await this.importFontBytes(name, bytes);
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

  /** Toggle smart-guide snapping (edges/centres/page). Off suspends snap + guides. */
  toggleSnap(): void {
    this.snapEnabled = !this.snapEnabled;
    if (!this.snapEnabled && this.compositor?.view.smartGuides) {
      this.compositor.view.smartGuides = null;
    }
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

  enterTypeEdit(layerId: string, offset = 0, selectAll = false): void {
    const layer = selectedLayers(this.doc).find((l) => l.id === layerId) ??
      activePage(this.doc).layers.find((l) => l.id === layerId);
    if (!layer || layer.kind !== "type-frame" || layer.locked) return;
    this.doc = setActiveLayers(this.doc, [layerId]);
    const story = this.doc.stories.find((s) => s.id === layer.storyId);
    if (!story) return;
    this.textSession = { layerId, session: uid("type") };
    const editor = this.ensureEditor();
    editor.value = story.text;
    const start = selectAll ? 0 : Math.max(0, Math.min(offset, story.text.length));
    const end = selectAll ? story.text.length : start;
    editor.setSelectionRange(start, end);
    this.pushTextEditView(start, end);
    this.placeEditor();
    editor.focus();
    this.emit();
  }

  exitTypeEdit(): void {
    if (!this.textSession) return;
    this.textSession = null;
    if (this.compositor) this.compositor.view.textEdit = null;
    this.editor?.blur();
  }

  private ensureEditor(): HTMLTextAreaElement {
    if (this.editor) return this.editor;
    const el = document.createElement("textarea");
    el.id = "type-editor";
    el.setAttribute("aria-label", "Type editor");
    el.autocomplete = "off";
    el.spellcheck = false;
    el.style.cssText =
      "position:fixed;z-index:40;margin:0;padding:0;border:0;outline:none;resize:none;overflow:hidden;background:transparent;color:transparent;caret-color:transparent;font:16px sans-serif;line-height:1;width:12px;height:24px;opacity:0.01;";
    el.addEventListener("input", () => {
      if (!this.textSession) return;
      this.run(
        {
          type: "story.setText",
          params: { layerId: this.textSession.layerId, text: el.value, session: this.textSession.session },
        },
        { soon: true },
      );
      this.pushTextEditView(el.selectionStart, el.selectionEnd);
      this.placeEditor();
    });
    const syncCaret = () => {
      if (!this.textSession) return;
      this.pushTextEditView(el.selectionStart, el.selectionEnd);
      this.placeEditor();
      this.compositor?.requestOverlayRepaint();
    };
    el.addEventListener("keyup", syncCaret);
    el.addEventListener("click", syncCaret);
    el.addEventListener("select", syncCaret);
    document.body.appendChild(el);
    this.editor = el;
    return el;
  }

  private syncEditorFromStory(): void {
    const el = this.editor;
    const session = this.textSession;
    if (!el || !session) return;
    const layer = activePage(this.doc).layers.find((l) => l.id === session.layerId);
    if (!layer || layer.kind !== "type-frame") return;
    const story = this.doc.stories.find((s) => s.id === layer.storyId);
    if (!story) return;
    if (el.value !== story.text) {
      const start = el.selectionStart;
      el.value = story.text;
      el.setSelectionRange(start, start);
    }
    this.pushTextEditView(el.selectionStart, el.selectionEnd);
  }

  private pushTextEditView(anchor: number, focus: number): void {
    if (!this.compositor || !this.textSession) return;
    this.compositor.view.textEdit = { layerId: this.textSession.layerId, anchor, focus };
  }

  private placeEditor(): void {
    const el = this.editor;
    const session = this.textSession;
    if (!el || !session || !this.compositor) return;
    const layer = activePage(this.doc).layers.find((l) => l.id === session.layerId);
    if (!layer) return;
    const layout = this.compositor.typeLayout(this.doc, layer.id);
    const caret = layout?.stops.find((s) => s.offset === el.selectionStart) ?? layout?.stops[0];
    const localX = (caret?.x ?? 0) + layer.transform.x;
    const localY = (caret?.y ?? 0) + layer.transform.y;
    const screen = this.compositor.pageToScreen(localX, localY);
    const box = this.compositor.canvas.getBoundingClientRect();
    el.style.left = `${box.left + screen.x}px`;
    el.style.top = `${box.top + screen.y - 16}px`;
  }

  private bindPasteboard(canvas: HTMLCanvasElement): void {
    const host = canvas.parentElement ?? canvas;
    host.addEventListener("dragover", (e) => {
      if (![...e.dataTransfer?.types ?? []].includes("Files")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    host.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length || !this.compositor) return;
      const rect = canvas.getBoundingClientRect();
      const p = this.compositor.screenToPage(e.clientX - rect.left, e.clientY - rect.top);
      void this.ingestFiles(files, p);
    });
    window.addEventListener("paste", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && t !== this.editor) {
        return;
      }
      const items = [...(e.clipboardData?.items ?? [])];
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      void this.ingestFiles(files);
    });
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return blobToDataUrl(file);
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
