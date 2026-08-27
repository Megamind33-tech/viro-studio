import type { PressApp } from "../app";
import {
  SUPPORTED_DOCUMENT_COLOR_SPACE,
  activePage,
  cloneDoc,
  createDocument,
  ink,
  paper,
  selectedLayers,
} from "../document/factory";
import { setLayerLocked, setLayerVisible } from "../document/ops";
import { listUserAssets, type UserAsset } from "../library/store";
import { WORKFLOWS, workflowById } from "../library/workflows";
import { authAvailable, currentUser, signIn, signUp } from "../platform/auth";
import { loadFontCatalog, parseCatalogRecordId, searchCatalog, type CatalogFamily } from "../engine/font-catalog";
import type { Preset, PresetCategory, PresetMargin, PresetUnit } from "../document/presets";
import {
  DEFAULT_PRESET_ID,
  PRESET_CATEGORIES,
  PRESETS,
  mmToPx,
  presetById,
  presetTree,
  pxToIn,
  pxToMm,
  unitToPx,
} from "../document/presets";
import type {
  Align,
  BlendMode,
  ColorSpace,
  ImageFit,
  Layer,
  PressDocument,
  RenderIntent,
  Rgba,
  ResampleAlgo,
  ToolId,
} from "../document/types";
import { RULER } from "../engine/compositor";
import {
  BLEND_LABEL,
  childrenOf,
  docSizeLabel,
  fmt,
  fromRgb8,
  hexToRgba,
  hsvToRgba,
  layerKindMark,
  parseNum,
  rgb8,
  rgbToHsv,
  rgbaCss,
  rgbaToHex,
  rootsOf,
} from "./format";

/** Layer-row thumbnail edge, and the Navigator page composite edge, in px. */
const THUMB = 30;
const NAV_THUMB = 256;

const PAGE_THUMB_PX = 64;

/**
 * Tools the chrome will actually let you pick. This is the honesty gate: a tool
 * only belongs here once it is wired end to end in `PressApp`, so a button that
 * slipped into the markup early cannot become theatre.
 */
const TOOLS: ToolId[] = [
  "move",
  "marquee",
  "crop",
  "eyedropper",
  "type",
  "pen",
  "rect",
  "ellipse",
  "line",
  "roundrect",
  "polygon",
  "star",
  "hand",
  "zoom",
];

type DeskState = {
  tool: ToolId;
  constrain: boolean;
  trConstrain: boolean;
  imgRatio: number;
  feather: number;
  antiAlias: boolean;
  hsv: { h: number; s: number; v: number };
  channel: "rgb" | "r" | "g" | "b";
  nd: NewDocState;
  fg: Rgba;
  bg: Rgba;
  helpOpen: boolean;
  layerKind: "all" | Layer["kind"];
};

/**
 * Live state of the New Document dialog.
 *
 * `width`/`height`/`margin`/`gutter` are held in `unit`; `bleedMm` is always
 * millimetres because bleed is a physical trade measure (see Preset.bleedMm).
 * Every field here maps 1:1 onto a CreateDocumentOptions field — there is no
 * control in the dialog that this shape cannot carry into the document.
 */
type NewDocState = {
  category: PresetCategory;
  /** null once any field has been edited away from the preset it came from. */
  presetId: string | null;
  label: string;
  name: string;
  width: number;
  height: number;
  unit: PresetUnit;
  ppi: number;
  colorSpace: ColorSpace;
  intent: RenderIntent;
  pages: number;
  facing: boolean;
  columns: number;
  gutter: number;
  margin: PresetMargin;
  marginLinked: boolean;
  bleedMm: number;
};

export function mountDesk(_root: HTMLElement, app: PressApp): HTMLCanvasElement {
  const state: DeskState = {
    tool: "move",
    constrain: true,
    trConstrain: true,
    imgRatio: 1,
    feather: 0,
    antiAlias: true,
    hsv: { h: 24, s: 0.79, v: 0.88 },
    channel: "rgb",
    nd: ndFromPreset(presetById(DEFAULT_PRESET_ID) ?? PRESETS[0]!),
    fg: { r: 0.12, g: 0.12, b: 0.12, a: 1 },
    bg: { r: 1, g: 1, b: 1, a: 1 },
    helpOpen: false,
    layerKind: "all",
  };
  let listedAssets: UserAsset[] = [];
  let fontCatalog: CatalogFamily[] | null = null;

  const blend = el<HTMLSelectElement>("blend");
  blend.innerHTML = (Object.keys(BLEND_LABEL) as BlendMode[])
    .map((k) => `<option value="${k}">${BLEND_LABEL[k]}</option>`)
    .join("");

  el("nd-tabs").innerHTML = PRESET_CATEGORIES.map(
    (c) =>
      `<button type="button" role="tab" data-ndcat="${c.id}" aria-selected="false">${esc(c.label)}</button>`,
  ).join("");
  buildPresetList();

  let lastDialog: PressApp["dialog"] = null;

  bindMenus();
  bindTools();
  bindOptions();
  bindColor();
  bindStudios();
  bindDialogs();
  bindKeys();
  bindRecovery();
  bindProjects();
  bindEffects();
  bindAlign();

  app.onChange(() => render());
  render();
  return el<HTMLCanvasElement>("skia");

  function bindAlign(): void {
    el("align-row").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-align],[data-dist]");
      if (!btn) return;
      if (btn.dataset.align) app.alignSelected(btn.dataset.align as Parameters<typeof app.alignSelected>[0]);
      else if (btn.dataset.dist) app.distributeSelected(btn.dataset.dist as "h" | "v");
    });
  }

  function bindEffects(): void {
    const defaultShadow = () => ({
      type: "drop-shadow" as const,
      enabled: true,
      color: { r: 0, g: 0, b: 0, a: 1 },
      offsetX: 6,
      offsetY: 8,
      blur: 12,
      opacity: 0.45,
    });
    const currentShadow = () => {
      const sel = selectedLayers(app.doc)[0];
      const fx = sel?.effects?.find((e) => e.type === "drop-shadow");
      return fx ?? null;
    };
    el<HTMLInputElement>("fx-shadow-on").addEventListener("change", () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) {
        render();
        return;
      }
      const on = el<HTMLInputElement>("fx-shadow-on").checked;
      const cur = currentShadow();
      if (on) app.setDropShadow(sel.id, cur ? { ...cur, enabled: true } : defaultShadow());
      else if (cur) app.setDropShadow(sel.id, { ...cur, enabled: false });
    });
    const commitShadow = () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) return;
      const cur = currentShadow() ?? defaultShadow();
      app.setDropShadow(sel.id, {
        ...cur,
        enabled: true,
        offsetX: parseNum(el<HTMLInputElement>("fx-shadow-x").value) ?? cur.offsetX,
        offsetY: parseNum(el<HTMLInputElement>("fx-shadow-y").value) ?? cur.offsetY,
        blur: Math.max(0, parseNum(el<HTMLInputElement>("fx-shadow-blur").value) ?? cur.blur),
        opacity: Math.min(1, Math.max(0, parseNum(el<HTMLInputElement>("fx-shadow-opacity").value) ?? cur.opacity)),
        color: hexToRgba(el<HTMLInputElement>("fx-shadow-color").value),
      });
    };
    for (const id of ["fx-shadow-x", "fx-shadow-y", "fx-shadow-blur", "fx-shadow-opacity", "fx-shadow-color"]) {
      el(id).addEventListener("change", commitShadow);
    }

    const currentGrad = () => {
      const sel = selectedLayers(app.doc)[0];
      return sel?.effects?.find((e) => e.type === "gradient-overlay") ?? null;
    };
    const defaultGrad = () => ({
      type: "gradient-overlay" as const,
      enabled: true,
      angle: 90,
      stops: [
        { offset: 0, color: { r: 0.88, g: 0.48, b: 0.18, a: 1 } },
        { offset: 1, color: { r: 0.12, g: 0.12, b: 0.14, a: 1 } },
      ],
      opacity: 1,
    });
    el<HTMLInputElement>("fx-grad-on").addEventListener("change", () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) {
        render();
        return;
      }
      const on = el<HTMLInputElement>("fx-grad-on").checked;
      const cur = currentGrad();
      if (on) app.setGradientOverlay(sel.id, cur ? { ...cur, enabled: true } : defaultGrad());
      else if (cur) app.setGradientOverlay(sel.id, { ...cur, enabled: false });
    });
    const commitGrad = () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) return;
      const cur = currentGrad() ?? defaultGrad();
      const a = hexToRgba(el<HTMLInputElement>("fx-grad-a").value);
      const b = hexToRgba(el<HTMLInputElement>("fx-grad-b").value);
      app.setGradientOverlay(sel.id, {
        ...cur,
        enabled: true,
        angle: parseNum(el<HTMLInputElement>("fx-grad-angle").value) ?? cur.angle,
        opacity: Math.min(1, Math.max(0, parseNum(el<HTMLInputElement>("fx-grad-opacity").value) ?? cur.opacity)),
        stops: [
          { offset: 0, color: a },
          { offset: 1, color: b },
        ],
      });
    };
    for (const id of ["fx-grad-a", "fx-grad-b", "fx-grad-angle", "fx-grad-opacity"]) {
      el(id).addEventListener("change", commitGrad);
    }

    const currentStroke = () => {
      const sel = selectedLayers(app.doc)[0];
      return sel?.effects?.find((e) => e.type === "stroke") ?? null;
    };
    const defaultStroke = () => ({
      type: "stroke" as const,
      enabled: true,
      color: { r: 0.88, g: 0.48, b: 0.18, a: 1 },
      width: 6,
      opacity: 1,
    });
    el<HTMLInputElement>("fx-stroke-on").addEventListener("change", () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) {
        render();
        return;
      }
      const on = el<HTMLInputElement>("fx-stroke-on").checked;
      const cur = currentStroke();
      if (on) app.setStrokeEffect(sel.id, cur ? { ...cur, enabled: true } : defaultStroke());
      else if (cur) app.setStrokeEffect(sel.id, { ...cur, enabled: false });
    });
    const commitStroke = () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) return;
      const cur = currentStroke() ?? defaultStroke();
      app.setStrokeEffect(sel.id, {
        ...cur,
        enabled: true,
        width: Math.max(0, parseNum(el<HTMLInputElement>("fx-stroke-width").value) ?? cur.width),
        opacity: Math.min(1, Math.max(0, parseNum(el<HTMLInputElement>("fx-stroke-opacity").value) ?? cur.opacity)),
        color: hexToRgba(el<HTMLInputElement>("fx-stroke-color").value),
      });
    };
    for (const id of ["fx-stroke-width", "fx-stroke-opacity", "fx-stroke-color"]) {
      el(id).addEventListener("change", commitStroke);
    }

    const currentGlow = () => {
      const sel = selectedLayers(app.doc)[0];
      return sel?.effects?.find((e) => e.type === "outer-glow") ?? null;
    };
    const defaultGlow = () => ({
      type: "outer-glow" as const,
      enabled: true,
      color: { r: 1, g: 0.9, b: 0.4, a: 1 },
      blur: 16,
      opacity: 0.85,
    });
    el<HTMLInputElement>("fx-glow-on").addEventListener("change", () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) {
        render();
        return;
      }
      const on = el<HTMLInputElement>("fx-glow-on").checked;
      const cur = currentGlow();
      if (on) app.setOuterGlow(sel.id, cur ? { ...cur, enabled: true } : defaultGlow());
      else if (cur) app.setOuterGlow(sel.id, { ...cur, enabled: false });
    });
    const commitGlow = () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) return;
      const cur = currentGlow() ?? defaultGlow();
      app.setOuterGlow(sel.id, {
        ...cur,
        enabled: true,
        blur: Math.max(0, parseNum(el<HTMLInputElement>("fx-glow-blur").value) ?? cur.blur),
        opacity: Math.min(1, Math.max(0, parseNum(el<HTMLInputElement>("fx-glow-opacity").value) ?? cur.opacity)),
        color: hexToRgba(el<HTMLInputElement>("fx-glow-color").value),
      });
    };
    for (const id of ["fx-glow-blur", "fx-glow-opacity", "fx-glow-color"]) {
      el(id).addEventListener("change", commitGlow);
    }

    const currentInner = () => selectedLayers(app.doc)[0]?.effects?.find((e) => e.type === "inner-shadow") ?? null;
    const defaultInner = () => ({
      type: "inner-shadow" as const,
      enabled: true,
      color: { r: 0, g: 0, b: 0, a: 1 },
      offsetX: 2,
      offsetY: 4,
      blur: 8,
      opacity: 0.55,
    });
    el<HTMLInputElement>("fx-inner-on").addEventListener("change", () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) {
        render();
        return;
      }
      const on = el<HTMLInputElement>("fx-inner-on").checked;
      const cur = currentInner();
      if (on) app.setInnerShadow(sel.id, cur ? { ...cur, enabled: true } : defaultInner());
      else if (cur) app.setInnerShadow(sel.id, { ...cur, enabled: false });
    });
    const commitInner = () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) return;
      const cur = currentInner() ?? defaultInner();
      app.setInnerShadow(sel.id, {
        ...cur,
        enabled: true,
        offsetX: parseNum(el<HTMLInputElement>("fx-inner-x").value) ?? cur.offsetX,
        offsetY: parseNum(el<HTMLInputElement>("fx-inner-y").value) ?? cur.offsetY,
        blur: Math.max(0, parseNum(el<HTMLInputElement>("fx-inner-blur").value) ?? cur.blur),
        opacity: Math.min(1, Math.max(0, parseNum(el<HTMLInputElement>("fx-inner-opacity").value) ?? cur.opacity)),
        color: hexToRgba(el<HTMLInputElement>("fx-inner-color").value),
      });
    };
    for (const id of ["fx-inner-x", "fx-inner-y", "fx-inner-blur", "fx-inner-opacity", "fx-inner-color"]) {
      el(id).addEventListener("change", commitInner);
    }

    const currentLong = () => selectedLayers(app.doc)[0]?.effects?.find((e) => e.type === "long-shadow") ?? null;
    const defaultLong = () => ({
      type: "long-shadow" as const,
      enabled: true,
      color: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
      angle: 135,
      length: 28,
      opacity: 0.55,
    });
    el<HTMLInputElement>("fx-long-on").addEventListener("change", () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) {
        render();
        return;
      }
      const on = el<HTMLInputElement>("fx-long-on").checked;
      const cur = currentLong();
      if (on) app.setLongShadow(sel.id, cur ? { ...cur, enabled: true } : defaultLong());
      else if (cur) app.setLongShadow(sel.id, { ...cur, enabled: false });
    });
    const commitLong = () => {
      const sel = selectedLayers(app.doc)[0];
      if (!sel) return;
      const cur = currentLong() ?? defaultLong();
      app.setLongShadow(sel.id, {
        ...cur,
        enabled: true,
        angle: parseNum(el<HTMLInputElement>("fx-long-angle").value) ?? cur.angle,
        length: Math.max(1, parseNum(el<HTMLInputElement>("fx-long-length").value) ?? cur.length),
        opacity: Math.min(1, Math.max(0, parseNum(el<HTMLInputElement>("fx-long-opacity").value) ?? cur.opacity)),
        color: hexToRgba(el<HTMLInputElement>("fx-long-color").value),
      });
    };
    for (const id of ["fx-long-angle", "fx-long-length", "fx-long-opacity", "fx-long-color"]) {
      el(id).addEventListener("change", commitLong);
    }
  }

  function submitAuth(signup: boolean): void {
    const email = el<HTMLInputElement>("auth-email").value.trim();
    const password = el<HTMLInputElement>("auth-pass").value;
    const status = el("auth-status");
    if (!email || !password) {
      status.textContent = "Email and password are required.";
      return;
    }
    status.textContent = signup ? "Creating account…" : "Signing in…";
    status.dataset.busy = "1";
    void (async () => {
      try {
        const session = signup ? await signUp(email, password) : await signIn(email, password);
        status.textContent = session.user.email ? `Signed in as ${session.user.email}` : "Signed in.";
        delete status.dataset.busy;
        app.closeDialog();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        delete status.dataset.busy;
      }
    })();
  }

  function bindRecovery(): void {
    const bar = document.getElementById("recover-bar");
    bar?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
      if (btn?.dataset.cmd) cmd(btn.dataset.cmd);
    });
  }

  function openProjects(): void {
    el("dlg-projects").hidden = false;
    void renderProjects();
  }

  function closeProjects(): void {
    el("dlg-projects").hidden = true;
  }

  async function renderProjects(): Promise<void> {
    const grid = el("projects-grid");
    const list = await app.listProjects();
    if (!list.length) {
      grid.innerHTML = `<p class="empty">No projects yet. Your saved work will appear here.</p>`;
      return;
    }
    grid.innerHTML = list
      .map((p) => {
        const when = new Date(p.updatedAt).toLocaleString();
        const thumb = p.thumbnail
          ? `<img src="${esc(p.thumbnail)}" alt="">`
          : `<span class="proj-noimg" aria-hidden="true"></span>`;
        return `<div class="proj-card" data-proj="${esc(p.id)}">
          <button type="button" class="proj-open" data-proj-open="${esc(p.id)}" title="Open ${esc(p.name)}">
            <span class="proj-thumb">${thumb}</span>
            <span class="proj-name">${esc(p.name)}</span>
            <time class="proj-time">${esc(when)}</time>
          </button>
          <div class="proj-actions">
            <button type="button" class="proj-btn" data-proj-rename="${esc(p.id)}">Rename</button>
            <button type="button" class="proj-btn" data-proj-delete="${esc(p.id)}">Delete</button>
          </div>
        </div>`;
      })
      .join("");
  }

  function bindProjects(): void {
    const dlg = el("dlg-projects");
    dlg.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-dlg="projects-close"]')) {
        closeProjects();
        return;
      }
      if (t.closest('[data-cmd="new"]')) {
        closeProjects();
        cmd("new");
        return;
      }
      const openId = t.closest<HTMLElement>("[data-proj-open]")?.dataset.projOpen;
      if (openId) {
        void app.openProject(openId).then((ok) => {
          if (ok) closeProjects();
        });
        return;
      }
      const renameId = t.closest<HTMLElement>("[data-proj-rename]")?.dataset.projRename;
      if (renameId) {
        const card = t.closest<HTMLElement>(".proj-card");
        const current = card?.querySelector(".proj-name")?.textContent ?? "";
        const name = window.prompt("Rename project", current);
        if (name && name.trim()) void app.renameProject(renameId, name).then(() => renderProjects());
        return;
      }
      const deleteId = t.closest<HTMLElement>("[data-proj-delete]")?.dataset.projDelete;
      if (deleteId) {
        if (window.confirm("Delete this project? This cannot be undone.")) {
          void app.deleteProject(deleteId).then(() => renderProjects());
        }
        return;
      }
    });
  }

  function view() {
    return app.compositor?.view ?? null;
  }

  function paint(): void {
    const v = view();
    if (v) {
      v.tool = state.tool;
      v.fg = state.fg;
      v.bg = state.bg;
    }
    app.compositor?.draw(app.doc);
    render();
  }

  function setTool(id: ToolId): void {
    state.tool = id;
    app.setTool(id);
    paint();
  }

  function setFg(c: Rgba, fill = false): void {
    state.fg = c;
    state.hsv = rgbToHsv(c);
    const v = view();
    if (v) v.fg = c;
    if (fill) {
      app.setFg(c.r, c.g, c.b);
      return;
    }
    paint();
  }

  function cmd(name: string): void {
    switch (name) {
      case "new":
        app.openNewDialog();
        return;
      case "open":
        void openDocument();
        return;
      case "place":
        void placeFiles();
        return;
      case "import-fonts":
        el<HTMLInputElement>("file-fonts").click();
        return;
      case "import-assets":
        el<HTMLInputElement>("file-assets").click();
        return;
      case "export-png":
        app.exportPng();
        return;
      case "export-pdf":
        void app.exportPdf();
        return;
      case "save-json":
        void saveDocument();
        return;
      case "undo":
        app.undo();
        return;
      case "redo":
        app.redo();
        return;
      case "duplicate":
        app.duplicate();
        return;
      case "delete":
        app.deleteLayers();
        return;
      case "image-size":
        app.openImageSize();
        return;
      case "adj-bc":
        app.openBrightness();
        return;
      case "cutout":
        void app.cutoutSelected();
        return;
      case "enhance-details":
        void app.enhanceSelected("sharpen");
        return;
      case "improve-lighting":
        void app.enhanceSelected("lighting");
        return;
      case "type-size-up":
        app.bumpTypeSize(2);
        return;
      case "type-size-down":
        app.bumpTypeSize(-2);
        return;
      case "type-underline":
        toggleTypeDeco("underline");
        return;
      case "type-strike":
        toggleTypeDeco("strikethrough");
        return;
      case "flip-h":
        app.flipSelected("h");
        return;
      case "flip-v":
        app.flipSelected("v");
        return;
      case "fill-gradient":
        app.applyLinearFill();
        return;
      case "fill-radial":
        app.applyRadialFill();
        return;
      case "help-shortcuts":
        state.helpOpen = true;
        el("dlg-help").hidden = false;
        return;
      case "sign-in":
        if (currentUser()) {
          app.signOutSession();
        } else {
          app.openAuthDialog();
        }
        return;
      case "group":
        app.group();
        return;
      case "ungroup":
        app.ungroup();
        return;
      case "boolean-union":
        app.booleanSelected("union");
        return;
      case "boolean-subtract":
        app.booleanSelected("subtract");
        return;
      case "boolean-intersect":
        app.booleanSelected("intersect");
        return;
      case "boolean-exclude":
        app.booleanSelected("exclude");
        return;
      case "subtract-vectors":
        app.booleanSelected("subtract");
        return;
      case "bring-forward":
        app.reorder(1);
        return;
      case "send-backward":
        app.reorder(-1);
        return;
      case "lock": {
        const layer = selectedLayers(app.doc)[0];
        if (layer) app.setLocked(layer.id, !layer.locked);
        return;
      }
      case "hide": {
        const layer = selectedLayers(app.doc)[0];
        if (layer) app.setVisible(layer.id, !layer.visible);
        return;
      }
      case "type-left":
      case "type-center":
      case "type-right":
      case "type-justify":
        app.setAlign(name.slice(5) as Align);
        return;
      case "select-all":
        app.selectAll();
        return;
      case "deselect":
        app.deselect();
        return;
      case "view-rulers":
        app.toggleRulers();
        return;
      case "view-guides":
        app.toggleGuides();
        return;
      case "view-snap":
        app.toggleSnap();
        return;
      case "view-bleed":
        app.toggleBleed();
        return;
      case "zoom-in":
        app.zoomBy(1.25);
        return;
      case "zoom-out":
        app.zoomBy(1 / 1.25);
        return;
      case "zoom-fit":
        fit();
        return;
      case "zoom-100":
        setZoom(1);
        return;
      case "win-color":
        toggle("g-color");
        return;
      case "win-type":
        toggle("g-type");
        return;
      case "win-transform":
        toggle("g-transform");
        return;
      case "win-effects":
        toggle("g-effects");
        return;
      case "win-layers":
        toggle("g-layers");
        return;
      case "win-pages":
        toggle("g-pages");
        return;
      case "win-nav":
        toggle("g-nav");
        return;
      case "win-library":
        toggle("g-library");
        return;
      case "win-anchor":
        toggle("g-anchor");
        return;
      case "snapshot":
        app.nameHistory("Snapshot");
        return;
      case "add-page":
        app.addPageToDoc();
        return;
      case "recover-restore":
        app.restoreRecovery();
        return;
      case "recover-discard":
        app.discardRecovery();
        return;
      case "projects":
        void openProjects();
        return;
      case "save-project":
        void app.saveProjectNow();
        return;
      default:
        return;
    }
  }

  /** Use the native Electron dialog when available; keep the web picker real. */
  async function openDocument(): Promise<void> {
    const bridge = window.viroPress;
    if (!bridge) {
      el<HTMLInputElement>("file-open").click();
      return;
    }
    try {
      const opened = await bridge.openFile([
        { name: "VIRO and design documents", extensions: ["json", "vdj", "psd"] },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
      ]);
      if (!opened) return;
      const name = opened.path.split(/[\\/]/).pop() || opened.path;
      await app.openBytes(name, opened.bytes);
    } catch (err) {
      app.status = `Open failed — ${err instanceof Error ? err.message : String(err)}`;
      paint();
    }
  }

  async function placeFiles(): Promise<void> {
    const bridge = window.viroPress;
    if (!bridge) {
      el<HTMLInputElement>("file-place").click();
      return;
    }
    try {
      const opened = await bridge.openFile([
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
        { name: "Fonts", extensions: ["ttf", "otf", "woff"] },
      ]);
      if (!opened) return;
      const name = opened.path.split(/[\\/]/).pop() || opened.path;
      await app.openBytes(name, opened.bytes);
    } catch (err) {
      app.status = `Place failed — ${err instanceof Error ? err.message : String(err)}`;
      paint();
    }
  }

  /** Save through Electron's filesystem bridge, with browser download fallback. */
  async function saveDocument(): Promise<void> {
    const bridge = window.viroPress;
    if (!bridge) {
      app.savePressJson();
      return;
    }
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(app.doc));
      const saved = await bridge.saveFile({
        defaultPath: `${app.doc.name}.press.json`,
        bytes: bytes.buffer,
      });
      if (saved) {
        app.status = `Saved ${saved.split(/[\\/]/).pop() || saved}`;
        paint();
      }
    } catch (err) {
      app.status = `Save failed — ${err instanceof Error ? err.message : String(err)}`;
      paint();
    }
  }

  function toggle(id: string): void {
    const node = el(id);
    node.hidden = !node.hidden;
    render();
  }

  function setZoom(z: number): void {
    const v = view();
    if (!v) return;
    v.zoom = Math.min(16, Math.max(0.05, z));
    paint();
  }

  function fit(): void {
    const v = view();
    const host = el("pasteboard");
    if (!v) return;
    const page = activePage(app.doc);
    const r = v.showRulers ? RULER : 0;
    const pad = 48;
    const z = Math.min(
      (host.clientWidth - r - pad) / Math.max(1, page.widthPx),
      (host.clientHeight - r - pad) / Math.max(1, page.heightPx),
    );
    v.zoom = Math.min(16, Math.max(0.05, z));
    v.panX = 24;
    v.panY = 24;
    paint();
  }

  function bindMenus(): void {
    document.getElementById("menubar")!.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const btn = t.closest<HTMLElement>("[data-menu]");
      if (btn) {
        const id = btn.dataset.menu!;
        const open = !btn.classList.contains("open");
        closeMenus();
        if (open) {
          btn.classList.add("open");
          const fly = document.querySelector<HTMLElement>(`[data-flyout="${id}"]`);
          if (fly) fly.hidden = false;
        }
        return;
      }
      const item = t.closest<HTMLElement>("[data-cmd]");
      if (item?.dataset.cmd) {
        closeMenus();
        cmd(item.dataset.cmd);
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".menubar")) closeMenus();
    });
  }

  function closeMenus(): void {
    document.querySelectorAll(".menu-btn.open").forEach((b) => b.classList.remove("open"));
    document.querySelectorAll<HTMLElement>("[data-flyout]").forEach((f) => {
      f.hidden = true;
    });
  }

  function bindTools(): void {
    el("toolbox").addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tool]");
      if (t?.dataset.tool && TOOLS.includes(t.dataset.tool as ToolId)) {
        setTool(t.dataset.tool as ToolId);
      }
    });
    el("fg-swatch").addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = rgbaToHex(state.fg);
      inp.addEventListener("input", () => setFg(hexToRgba(inp.value), true));
      inp.click();
    });
    el("bg-swatch").addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = rgbaToHex(state.bg);
      inp.addEventListener("input", () => {
        state.bg = hexToRgba(inp.value);
        const v = view();
        if (v) v.bg = state.bg;
        paint();
      });
      inp.click();
    });
    el("swap-fgbg").addEventListener("click", () => {
      const a = state.fg;
      state.fg = state.bg;
      state.bg = a;
      state.hsv = rgbToHsv(state.fg);
      paint();
    });
    el("default-fgbg").addEventListener("click", () => {
      state.fg = { ...ink };
      state.bg = { ...paper };
      state.hsv = rgbToHsv(state.fg);
      paint();
    });
  }

  function bindOptions(): void {
    const applyT = () => applyTransform("opt");
    for (const id of ["opt-x", "opt-y", "opt-w", "opt-h", "opt-r"]) {
      el(id).addEventListener("change", applyT);
    }
    el<HTMLInputElement>("opt-constrain").addEventListener("change", (e) => {
      state.constrain = (e.target as HTMLInputElement).checked;
    });
    el<HTMLSelectElement>("opt-fit").addEventListener("change", (e) => {
      app.setFit((e.target as HTMLSelectElement).value as ImageFit);
    });
    for (const [id, key] of [
      ["opt-size", "size"],
      ["opt-lead", "leading"],
      ["opt-track", "tracking"],
      ["ch-size", "size"],
      ["ch-lead", "leading"],
      ["ch-track", "tracking"],
    ] as const) {
      el(id).addEventListener("change", () => applyType({ [key]: parseNum(el<HTMLInputElement>(id).value) ?? undefined }));
    }
    el<HTMLSelectElement>("opt-font").addEventListener("change", () => {
      void app.setFont(el<HTMLSelectElement>("opt-font").value);
    });
    el<HTMLSelectElement>("ch-font").addEventListener("change", () => {
      void app.setFont(el<HTMLSelectElement>("ch-font").value);
    });
    const applyWeight = () => {
      const w = parseNum(el<HTMLSelectElement>("ch-weight").value) ?? 400;
      const italic = el<HTMLInputElement>("ch-italic").checked;
      void app.setTypeWeight(w, italic);
    };
    el<HTMLSelectElement>("ch-weight").addEventListener("change", applyWeight);
    el<HTMLInputElement>("ch-italic").addEventListener("change", applyWeight);
    el<HTMLSelectElement>("opt-weight").addEventListener("change", () => {
      el<HTMLSelectElement>("ch-weight").value = el<HTMLSelectElement>("opt-weight").value;
      applyWeight();
    });
    el<HTMLInputElement>("opt-italic").addEventListener("change", () => {
      el<HTMLInputElement>("ch-italic").checked = el<HTMLInputElement>("opt-italic").checked;
      applyWeight();
    });
    el<HTMLInputElement>("opt-feather").addEventListener("change", (e) => {
      state.feather = parseNum((e.target as HTMLInputElement).value) ?? 0;
    });
    el<HTMLInputElement>("opt-aa").addEventListener("change", (e) => {
      state.antiAlias = (e.target as HTMLInputElement).checked;
    });
    const fontSearch = document.getElementById("lib-font-search") as HTMLInputElement | null;
    fontSearch?.addEventListener("input", () => renderFontList());
    const radiusEl = document.getElementById("opt-rr-radius") as HTMLInputElement | null;
    radiusEl?.addEventListener("change", () => {
      const n = parseNum(radiusEl.value);
      if (n != null) app.roundRectRadius = Math.max(0, n);
    });
    const sidesEl = document.getElementById("opt-poly-sides") as HTMLInputElement | null;
    sidesEl?.addEventListener("change", () => {
      const n = parseNum(sidesEl.value);
      if (n != null) app.polygonSides = Math.max(3, Math.min(24, Math.round(n)));
    });
    const starEl = document.getElementById("opt-star-points") as HTMLInputElement | null;
    starEl?.addEventListener("change", () => {
      const n = parseNum(starEl.value);
      if (n != null) app.starPoints = Math.max(3, Math.min(16, Math.round(n)));
    });
    for (const [id, key] of [
      ["opt-underline", "underline"],
      ["opt-strike", "strikethrough"],
      ["ch-underline", "underline"],
      ["ch-strike", "strikethrough"],
    ] as const) {
      const node = document.getElementById(id) as HTMLInputElement | null;
      node?.addEventListener("change", () => applyType({ [key]: node.checked }));
    }
    el("ch-shift").addEventListener("change", () => {
      const n = parseNum(el<HTMLInputElement>("ch-shift").value);
      if (n != null) applyType({ baselineShift: n });
    });
    const kindFilter = document.getElementById("layer-kind-filter") as HTMLSelectElement | null;
    kindFilter?.addEventListener("change", () => {
      const v = kindFilter.value;
      state.layerKind = v === "all" ? "all" : (v as Layer["kind"]);
      render();
    });
  }

  function applyTransform(src: "opt" | "tr"): void {
    const sel = selectedLayers(app.doc)[0];
    if (!sel || sel.locked) return;
    const p = src === "opt" ? "opt" : "tr";
    const x = parseNum(el<HTMLInputElement>(`${p}-x`).value);
    const y = parseNum(el<HTMLInputElement>(`${p}-y`).value);
    let w = parseNum(el<HTMLInputElement>(`${p}-w`).value);
    let h = parseNum(el<HTMLInputElement>(`${p}-h`).value);
    const r = parseNum(el<HTMLInputElement>(`${p}-r`).value);
    const con = src === "opt" ? state.constrain : state.trConstrain;
    if (con && w != null && h != null && sel.transform.w) {
      const ratio = sel.transform.h / sel.transform.w;
      if (document.activeElement === el(`${p}-w`)) h = w * ratio;
      if (document.activeElement === el(`${p}-h`)) w = ratio ? h / ratio : w;
    }
    app.setTransform({
      ...(x != null ? { x } : {}),
      ...(y != null ? { y } : {}),
      ...(w != null ? { w } : {}),
      ...(h != null ? { h } : {}),
      ...(r != null ? { rotation: r } : {}),
    });
  }

  function applyType(patch: Parameters<PressApp["setCharacter"]>[0]): void {
    app.setCharacter(patch);
  }

  function toggleTypeDeco(key: "underline" | "strikethrough"): void {
    const sel = selectedLayers(app.doc).find((l) => l.kind === "type-frame");
    if (!sel || sel.kind !== "type-frame") return;
    const story = app.doc.stories.find((s) => s.id === sel.storyId);
    if (!story) return;
    app.setCharacter({ [key]: !story.character[key] });
  }

  function bindColor(): void {
    const sv = el("sv-plane");
    const hue = el("hue-bar");
    const drag = (mode: "sv" | "h") => (e: PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      pick(e, mode);
    };
    sv.addEventListener("pointerdown", drag("sv"));
    sv.addEventListener("pointermove", (e) => {
      if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) pick(e, "sv");
    });
    hue.addEventListener("pointerdown", drag("h"));
    hue.addEventListener("pointermove", (e) => {
      if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) pick(e, "h");
    });
    const syncRgb = () => {
      const r = Number(el<HTMLInputElement>("rgb-r").value);
      const g = Number(el<HTMLInputElement>("rgb-g").value);
      const b = Number(el<HTMLInputElement>("rgb-b").value);
      setFg(fromRgb8(r, g, b), false);
    };
    for (const id of ["rgb-r", "rgb-g", "rgb-b"]) {
      el(id).addEventListener("input", syncRgb);
    }
    for (const [id, ch] of [
      ["rgb-r-n", "r"],
      ["rgb-g-n", "g"],
      ["rgb-b-n", "b"],
    ] as const) {
      el(id).addEventListener("change", () => {
        const n = parseNum(el<HTMLInputElement>(id).value) ?? 0;
        const cur = rgb8(state.fg);
        cur[ch] = Math.max(0, Math.min(255, n));
        setFg(fromRgb8(cur.r, cur.g, cur.b), false);
      });
    }
    el("hex").addEventListener("change", () => setFg(hexToRgba(el<HTMLInputElement>("hex").value), false));
    el("swatch-list").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-hex]");
      if (!b?.dataset.hex) return;
      setFg(hexToRgba(b.dataset.hex), true);
    });
  }

  function pick(e: PointerEvent, mode: "sv" | "h"): void {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (mode === "h") {
      state.hsv.h = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * 360;
    } else {
      state.hsv.s = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      state.hsv.v = 1 - Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    }
    setFg(hsvToRgba(state.hsv.h, state.hsv.s, state.hsv.v), false);
  }

  function bindStudios(): void {
    el("studios").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const tab = t.closest<HTMLElement>("[data-tab]");
      if (tab?.dataset.tab) {
        const group = tab.closest(".group")!;
        group.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("is-on", b === tab));
        group.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => {
          p.hidden = p.dataset.pane !== tab.dataset.tab;
        });
        if (tab.dataset.tab === "channels") app.refreshChannels();
        return;
      }
      const wf = t.closest<HTMLElement>("[data-workflow]");
      if (wf?.dataset.workflow) {
        runWorkflow(wf.dataset.workflow);
        return;
      }
      const c = t.closest<HTMLElement>("[data-cmd]");
      if (c?.dataset.cmd) cmd(c.dataset.cmd);
      const ch = t.closest<HTMLElement>("[data-ch]");
      if (ch?.dataset.ch) {
        state.channel = ch.dataset.ch as DeskState["channel"];
        render();
      }
      const path = t.closest<HTMLElement>("[data-path]");
      if (path?.dataset.path) {
        app.selectLayer(path.dataset.path, false);
      }
      const pg = t.closest<HTMLElement>("[data-page]");
      if (pg?.dataset.page) {
        app.goToPage(pg.dataset.page);
      }
      const al = t.closest<HTMLElement>("[data-align]");
      if (al?.dataset.align) {
        app.setAlign(al.dataset.align as Align);
      }
      const fontBtn = t.closest<HTMLElement>("[data-font]");
      if (fontBtn?.dataset.font) {
        void app.setFont(fontBtn.dataset.font);
      }
      const catalogBtn = t.closest<HTMLElement>("[data-catalog]");
      if (catalogBtn?.dataset.catalog) {
        const fam = fontCatalog?.find((f) => f.id === catalogBtn.dataset.catalog);
        if (fam) {
          const w = parseNum(el<HTMLSelectElement>("ch-weight").value) ?? 400;
          const italic = el<HTMLInputElement>("ch-italic").checked;
          void app.applyCatalogFont(fam, w, italic);
        }
      }
      const assetBtn = t.closest<HTMLElement>("[data-asset]");
      if (assetBtn?.dataset.asset) {
        const asset = listedAssets.find((a) => a.id === assetBtn.dataset.asset);
        if (asset) {
          app.run({
            type: "image.place",
            params: {
              asset: {
                name: asset.name,
                mime: asset.mime,
                dataUrl: asset.dataUrl,
                width: asset.width,
                height: asset.height,
              },
              x: 48,
              y: 48,
            },
          });
        }
      }
    });

    el("layer-list").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>("[data-id]");
      if (!row?.dataset.id) return;
      const id = row.dataset.id;
      if (t.closest("[data-act=vis]")) {
        const layer = activePage(app.doc).layers.find((l) => l.id === id);
        if (layer) app.run({ type: "layer.visible", params: { layerId: id, visible: !layer.visible } });
        return;
      }
      if (t.closest("[data-act=lock]")) {
        const layer = activePage(app.doc).layers.find((l) => l.id === id);
        if (layer) app.run({ type: "layer.locked", params: { layerId: id, locked: !layer.locked } });
        return;
      }
      const ids = e.shiftKey;
      app.selectLayer(id, ids);
    });

    el<HTMLSelectElement>("blend").addEventListener("change", (e) => {
      app.setBlend((e.target as HTMLSelectElement).value as BlendMode);
    });
    el("opacity").addEventListener("change", () => {
      const n = parseNum(el<HTMLInputElement>("opacity").value);
      if (n == null) return;
      app.setOpacity(n > 1 ? n / 100 : n);
    });
    el("lock-btn").addEventListener("click", () => cmd("lock"));

    for (const id of ["tr-x", "tr-y", "tr-w", "tr-h", "tr-r"]) {
      el(id).addEventListener("change", () => applyTransform("tr"));
    }
    el<HTMLInputElement>("tr-constrain").addEventListener("change", (e) => {
      state.trConstrain = (e.target as HTMLInputElement).checked;
    });

    for (const [id, key] of [
      ["ch-size", "size"],
      ["ch-lead", "leading"],
      ["ch-track", "tracking"],
    ] as const) {
      el(id).addEventListener("change", () =>
        applyType({ [key]: parseNum(el<HTMLInputElement>(id).value) ?? undefined }),
      );
    }
    el("para-first").addEventListener("change", () => patchParagraph());
    el("para-after").addEventListener("change", () => patchParagraph());
    el("stroke-w").addEventListener("change", () => patchStroke());
    el("stroke-cap").addEventListener("change", () => patchStroke());
    el("stroke-join").addEventListener("change", () => patchStroke());
    el("stroke-dash").addEventListener("change", () => patchStroke());

    el<HTMLInputElement>("nav-zoom").addEventListener("input", (e) => {
      setZoom(Number((e.target as HTMLInputElement).value) / 100);
    });
  }

  function patchParagraph(): void {
    const sel = selectedLayers(app.doc).find((l) => l.kind === "type-frame");
    if (!sel) return;
    const first = parseNum(el<HTMLInputElement>("para-first").value);
    const after = parseNum(el<HTMLInputElement>("para-after").value);
    if (first == null && after == null) return;
    app.run({
      type: "type.paragraphSpacing",
      params: {
        layerId: sel.id,
        ...(first != null ? { firstLineIndent: first } : {}),
        ...(after != null ? { spaceAfter: after } : {}),
      },
    });
  }

  function patchStroke(): void {
    const w = parseNum(el<HTMLInputElement>("stroke-w").value);
    if (w == null) return;
    const cap = el<HTMLSelectElement>("stroke-cap").value;
    const join = el<HTMLSelectElement>("stroke-join").value;
    const dash = parseDash(el<HTMLInputElement>("stroke-dash").value);
    const params: Record<string, unknown> = { width: w, fallbackColor: state.fg, cap, join };
    // Undefined means "leave the dash as-is" (unparseable input); an explicit
    // [] clears back to solid. Only send a parsed value so a typo never clobbers.
    if (dash !== undefined) params.dash = dash;
    app.run({ type: "vector.strokeWidth", params });
  }

  /**
   * Parse a dash field ("12 6", "12,6", "8") into Skia's even on/off intervals.
   * Empty is solid ([]); a single value repeats as an equal on/off; an odd list
   * is doubled (SVG's rule) so the control can never emit an invalid pattern.
   * Returns undefined for non-numeric input, meaning "do not touch the dash".
   */
  function parseDash(raw: string): number[] | undefined {
    const text = raw.trim();
    if (!text) return [];
    const parts = text.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
    let arr = parts;
    if (arr.length === 1) arr = [arr[0]!, arr[0]!];
    else if (arr.length % 2 !== 0) arr = [...arr, ...arr];
    if (arr.every((n) => n === 0)) return [];
    return arr;
  }

  function bindDialogs(): void {
    el<HTMLInputElement>("file-open").addEventListener("change", () => {
      const f = el<HTMLInputElement>("file-open").files?.[0];
      if (f) void f.arrayBuffer().then((buf) => app.openBytes(f.name, buf));
      el<HTMLInputElement>("file-open").value = "";
    });
    el<HTMLInputElement>("file-place").addEventListener("change", () => {
      const files = [...(el<HTMLInputElement>("file-place").files ?? [])];
      if (files.length) void app.ingestFiles(files);
      el<HTMLInputElement>("file-place").value = "";
    });
    el<HTMLInputElement>("file-fonts").addEventListener("change", () => {
      const files = [...(el<HTMLInputElement>("file-fonts").files ?? [])];
      if (files.length) void app.ingestFiles(files);
      el<HTMLInputElement>("file-fonts").value = "";
    });
    el<HTMLInputElement>("file-assets").addEventListener("change", () => {
      const files = [...(el<HTMLInputElement>("file-assets").files ?? [])];
      if (files.length) void app.ingestFiles(files);
      el<HTMLInputElement>("file-assets").value = "";
    });
    bindNewDialog();
    document.querySelectorAll("[data-dlg]").forEach((b) => {
      b.addEventListener("click", () => {
        const n = (b as HTMLElement).dataset.dlg;
        if (n === "image-cancel" || n === "new-cancel" || n === "bc-cancel" || n === "auth-cancel") app.closeDialog();
        if (n === "help-close") {
          state.helpOpen = false;
          el("dlg-help").hidden = true;
        }
        if (n === "image-ok") applyImageSizeDlg();
        if (n === "new-ok") createFromNewDialog();
        if (n === "bc-ok") {
          const br = Number(el<HTMLInputElement>("bc-b").value);
          const ct = Number(el<HTMLInputElement>("bc-c").value);
          app.brightnessContrast(br, ct);
        }
        if (n === "auth-in" || n === "auth-up") void submitAuth(n === "auth-up");
      });
    });
    el("img-w").addEventListener("input", () => syncImageDims("w"));
    el("img-h").addEventListener("input", () => syncImageDims("h"));
    el("img-ppi").addEventListener("input", updatePrint);
    el<HTMLInputElement>("bc-b").addEventListener("input", () => {
      el("bc-b-n").textContent = el<HTMLInputElement>("bc-b").value;
    });
    el<HTMLInputElement>("bc-c").addEventListener("input", () => {
      el("bc-c-n").textContent = el<HTMLInputElement>("bc-c").value;
    });
    el<HTMLSelectElement>("stat-zoom").addEventListener("change", (e) => {
      const raw = (e.target as HTMLSelectElement).value;
      if (raw === "fit") fit();
      else setZoom(Number.parseFloat(raw) / 100);
    });
  }

  /* ── New Document ─────────────────────────────────────────────────────────
     Category tabs filter the list; picking a preset loads the whole detail
     column; touching any detail field drops the preset id and the dialog goes
     to Custom. On Create the detail column — not the preset — is what builds
     the document, so a custom size is a first-class result. */

  function buildPresetList(): void {
    const html: string[] = [];
    for (const group of presetTree()) {
      for (const fam of group.families) {
        html.push(
          `<div class="nd-fam" data-ndcat="${group.category.id}">${esc(fam.family)}</div>`,
        );
        for (const p of fam.presets) {
          html.push(
            `<button type="button" role="option" aria-selected="false" data-preset="${p.id}" data-ndcat="${p.category}">` +
              `<span class="nd-row-1"><span class="nd-nm">${esc(shortName(p))}</span>` +
              `<span class="nd-dim">${esc(sizeLabel(p))}</span></span>` +
              `<span class="nd-desc" title="${esc(p.description)}">${esc(p.description)}</span>` +
              `</button>`,
          );
        }
      }
    }
    el("preset-list").innerHTML = html.join("");
  }

  function bindNewDialog(): void {
    el("nd-tabs").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ndcat]");
      const cat = b?.dataset.ndcat as PresetCategory | undefined;
      if (!cat) return;
      state.nd.category = cat;
      renderNewDialog();
      el("preset-list").scrollTop = 0;
    });

    el("preset-list").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-preset]");
      const id = b?.dataset.preset;
      if (!id) return;
      const preset = presetById(id);
      if (!preset) return;
      const name = state.nd.name;
      state.nd = ndFromPreset(preset);
      state.nd.name = name;
      renderNewDialog(true);
    });

    // Text/number fields. Each one owns exactly one slot of NewDocState.
    ndNum("nd-w", (v) => {
      state.nd.width = Math.max(0.001, v);
    });
    ndNum("nd-h", (v) => {
      state.nd.height = Math.max(0.001, v);
    });
    ndNum("nd-ppi", (v) => {
      state.nd.ppi = clamp(Math.round(v), 1, 4000);
    });
    ndNum("nd-pages", (v) => {
      state.nd.pages = clamp(Math.round(v), 1, 999);
    });
    ndNum("nd-cols", (v) => {
      state.nd.columns = clamp(Math.round(v), 1, 40);
    });
    ndNum("nd-gutter", (v) => {
      state.nd.gutter = Math.max(0, v);
    });
    ndNum("nd-bleed", (v) => {
      state.nd.bleedMm = clamp(v, 0, 100);
    });
    const edges: { id: string; key: keyof PresetMargin }[] = [
      { id: "nd-mt", key: "top" },
      { id: "nd-mr", key: "right" },
      { id: "nd-mb", key: "bottom" },
      { id: "nd-ml", key: "left" },
    ];
    for (const edge of edges) {
      ndNum(edge.id, (v) => {
        const next = Math.max(0, v);
        if (state.nd.marginLinked) state.nd.margin = { top: next, right: next, bottom: next, left: next };
        else state.nd.margin[edge.key] = next;
      });
    }

    el<HTMLInputElement>("nd-name").addEventListener("input", () => {
      state.nd.name = el<HTMLInputElement>("nd-name").value;
      renderNewDialog();
    });

    el<HTMLSelectElement>("nd-unit").addEventListener("change", () => {
      const next = el<HTMLSelectElement>("nd-unit").value as PresetUnit;
      const nd = state.nd;
      if (next === nd.unit) return;
      const from = nd.unit;
      const to = next;
      const c = (v: number) => convertUnit(v, from, to, nd.ppi);
      nd.width = c(nd.width);
      nd.height = c(nd.height);
      nd.gutter = c(nd.gutter);
      nd.margin = { top: c(nd.margin.top), right: c(nd.margin.right), bottom: c(nd.margin.bottom), left: c(nd.margin.left) };
      nd.unit = to;
      // A unit change is a presentation change, not a document change: the
      // resulting pixels are identical, so the preset link survives it. Every
      // unit-bearing field is rewritten, focused or not — a field still showing
      // "150" after mm → px would be reading as 150 px and lying.
      renderNewDialog(true);
    });

    el<HTMLInputElement>("nd-facing").addEventListener("change", () => {
      state.nd.facing = el<HTMLInputElement>("nd-facing").checked;
      ndCustom(true);
    });

    el("nd-portrait").addEventListener("click", () => setOrientation(false));
    el("nd-landscape").addEventListener("click", () => setOrientation(true));

    el("nd-link").addEventListener("click", () => {
      const nd = state.nd;
      nd.marginLinked = !nd.marginLinked;
      if (nd.marginLinked) {
        const v = nd.margin.top;
        nd.margin = { top: v, right: v, bottom: v, left: v };
        ndCustom(true);
      } else renderNewDialog(true);
    });

    el("dlg-new").addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === "Enter" && !(ev.target as HTMLElement).matches("button")) {
        ev.preventDefault();
        createFromNewDialog();
      }
    });
  }

  /** Wire one numeric field: parse, apply, fall to Custom, repaint. */
  function ndNum(id: string, apply: (v: number) => void): void {
    const node = el<HTMLInputElement>(id);
    const commit = () => {
      const v = parseNum(node.value);
      if (v === null) return;
      apply(v);
      ndCustom();
    };
    node.addEventListener("input", commit);
    node.addEventListener("change", () => {
      commit();
      renderNewDialog(true);
    });
  }

  function ndCustom(force = false): void {
    state.nd.presetId = null;
    renderNewDialog(force);
  }

  function setOrientation(landscape: boolean): void {
    const nd = state.nd;
    if (landscape === nd.width > nd.height) return;
    const w = nd.width;
    nd.width = nd.height;
    nd.height = w;
    ndCustom(true);
  }

  /** Everything the current dialog state resolves to in device pixels. */
  function ndPixels() {
    const nd = state.nd;
    const u = (v: number) => unitToPx(v, nd.unit, nd.ppi);
    return {
      widthPx: Math.max(1, u(nd.width)),
      heightPx: Math.max(1, u(nd.height)),
      bleedPx: Math.max(0, mmToPx(nd.bleedMm, nd.ppi)),
      gutterPx: Math.max(0, u(nd.gutter)),
      margin: {
        top: Math.max(0, u(nd.margin.top)),
        right: Math.max(0, u(nd.margin.right)),
        bottom: Math.max(0, u(nd.margin.bottom)),
        left: Math.max(0, u(nd.margin.left)),
      },
    };
  }

  /**
   * Repaint the dialog from NewDocState.
   *
   * `force` rewrites even the field the caret is in. Typing must not do that
   * (the caret would jump on every keystroke), but anything that changes what a
   * number *means* — a unit change, a preset load, an orientation swap — must,
   * or the focused field keeps showing a figure in the old unit.
   */
  function renderNewDialog(force = false): void {
    const nd = state.nd;
    const px = ndPixels();
    const custom = nd.presetId === null;
    const put = (id: string, v: string) => {
      if (force) el<HTMLInputElement>(id).value = v;
      else fillIfIdle(id, v);
    };

    document.querySelectorAll<HTMLElement>("#nd-tabs [data-ndcat]").forEach((b) => {
      const on = b.dataset.ndcat === nd.category;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", String(on));
    });
    const cat = PRESET_CATEGORIES.find((c) => c.id === nd.category);
    el("nd-blurb").textContent = cat?.blurb ?? "";

    let visible = 0;
    document.querySelectorAll<HTMLElement>("#preset-list [data-ndcat]").forEach((node) => {
      const show = node.dataset.ndcat === nd.category;
      node.hidden = !show;
      if (show && node.dataset.preset) visible++;
      if (!node.dataset.preset) return;
      const on = node.dataset.preset === nd.presetId;
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-selected", String(on));
    });

    el("nd-head-name").textContent = custom ? "Custom size" : nd.label;
    const badge = el("nd-badge");
    badge.textContent = custom ? "Custom" : "Preset";
    badge.classList.toggle("is-custom", custom);

    fillIfIdle("nd-name", nd.name);
    put("nd-w", fmtUnit(nd.width, nd.unit));
    put("nd-h", fmtUnit(nd.height, nd.unit));
    put("nd-ppi", String(nd.ppi));
    put("nd-pages", String(nd.pages));
    put("nd-cols", String(nd.columns));
    put("nd-gutter", fmtUnit(nd.gutter, nd.unit));
    put("nd-bleed", fmtUnit(nd.bleedMm, "mm"));
    put("nd-mt", fmtUnit(nd.margin.top, nd.unit));
    put("nd-mr", fmtUnit(nd.margin.right, nd.unit));
    put("nd-mb", fmtUnit(nd.margin.bottom, nd.unit));
    put("nd-ml", fmtUnit(nd.margin.left, nd.unit));
    el<HTMLSelectElement>("nd-unit").value = nd.unit;
    el<HTMLInputElement>("nd-facing").checked = nd.facing;
    document.querySelectorAll<HTMLElement>("#dlg-new [data-unit-label]").forEach((n) => {
      n.textContent = nd.unit;
    });

    const landscape = nd.width > nd.height;
    el("nd-portrait").classList.toggle("is-on", !landscape);
    el("nd-landscape").classList.toggle("is-on", landscape);
    el("nd-link").setAttribute("aria-pressed", String(nd.marginLinked));
    // On facing pages the binding edge is `left` (see Preset.margin).
    el("nd-ml-lbl").textContent = nd.facing ? "I" : "L";
    el("nd-ml-lbl").setAttribute("title", nd.facing ? "Inside (binding) margin" : "Left margin");
    for (const id of ["nd-mr", "nd-mb", "nd-ml"]) {
      el<HTMLInputElement>(id).disabled = nd.marginLinked;
    }

    el("nd-derived-px").textContent = `${px.widthPx} × ${px.heightPx} px`;
    const parts: string[] = [];
    if (nd.unit !== "px") parts.push(`${fmtUnit(nd.width, nd.unit)} × ${fmtUnit(nd.height, nd.unit)} ${nd.unit}`);
    parts.push(`${nd.ppi} ppi`);
    parts.push(nd.colorSpace === "cmyk" ? "CMYK" : "RGB");
    if (px.bleedPx > 0) {
      parts.push(`bleed ${fmtUnit(nd.bleedMm, "mm")} mm → ${px.widthPx + px.bleedPx * 2} × ${px.heightPx + px.bleedPx * 2} px`);
    }
    el("nd-derived-sub").textContent = parts.join(" · ");

    const liveW = Math.max(0, px.widthPx - px.margin.left - px.margin.right);
    const liveH = Math.max(0, px.heightPx - px.margin.top - px.margin.bottom);
    const cols = nd.columns > 1 ? `${nd.columns} columns` : "1 column";
    const pages = nd.pages > 1 ? `${nd.pages} pages${nd.facing ? ", facing" : ""}` : "1 page";
    el("nd-note").textContent = `Live area ${liveW} × ${liveH} px · ${cols} · ${pages}`;

    el("nd-preview").innerHTML = previewSvg(px);
  }

  /** Page proportions with the bleed ring, the margin box and the columns. */
  function previewSvg(px: ReturnType<typeof ndPixels>): string {
    const boxW = 300;
    const boxH = 122;
    const outW = px.widthPx + px.bleedPx * 2;
    const outH = px.heightPx + px.bleedPx * 2;
    const s = Math.min(boxW / outW, boxH / outH);
    const w = px.widthPx * s;
    const h = px.heightPx * s;
    // 3 mm on an A4 is a third of a pixel at preview scale. The ring is a
    // schematic marker of "there is bleed here", so it gets a 2 px floor — the
    // exact figure is printed in full on the derived line above.
    const b = px.bleedPx > 0 ? Math.max(2, px.bleedPx * s) : 0;
    const vw = w + b * 2;
    const vh = h + b * 2;
    const mt = px.margin.top * s;
    const mr = px.margin.right * s;
    const mb = px.margin.bottom * s;
    const ml = px.margin.left * s;
    const innerW = w - ml - mr;
    const innerH = h - mt - mb;

    const bits: string[] = [];
    if (b > 0.4) bits.push(`<rect class="nd-pv-bleed" x="0.5" y="0.5" width="${r2(vw - 1)}" height="${r2(vh - 1)}" />`);
    bits.push(`<rect class="nd-pv-page" x="${r2(b + 0.5)}" y="${r2(b + 0.5)}" width="${r2(w - 1)}" height="${r2(h - 1)}" />`);
    if (innerW > 2 && innerH > 2) {
      bits.push(
        `<rect class="nd-pv-margin" x="${r2(b + ml + 0.5)}" y="${r2(b + mt + 0.5)}" width="${r2(innerW - 1)}" height="${r2(innerH - 1)}" />`,
      );
      const gutter = px.gutterPx * s;
      const colW = (innerW - gutter * (state.nd.columns - 1)) / state.nd.columns;
      if (state.nd.columns > 1 && colW > 1) {
        for (let i = 1; i < state.nd.columns; i++) {
          const x = b + ml + colW * i + gutter * (i - 1);
          bits.push(`<line class="nd-pv-col" x1="${r2(x + 0.5)}" y1="${r2(b + mt)}" x2="${r2(x + 0.5)}" y2="${r2(b + mt + innerH)}" />`);
          if (gutter > 0.6) {
            const x2 = x + gutter;
            bits.push(`<line class="nd-pv-col" x1="${r2(x2 + 0.5)}" y1="${r2(b + mt)}" x2="${r2(x2 + 0.5)}" y2="${r2(b + mt + innerH)}" />`);
          }
        }
      }
    }
    return `<svg width="${r2(vw)}" height="${r2(vh)}" viewBox="0 0 ${r2(vw)} ${r2(vh)}" aria-hidden="true">${bits.join("")}</svg>`;
  }

  /**
   * Build the document from the detail column. The preset — if one is still
   * selected — has already been copied into that column, so this one path
   * serves both "picked a preset" and "typed a custom size".
   */
  function createFromNewDialog(): void {
    const nd = state.nd;
    const px = ndPixels();
    const doc = createDocument({
      name: nd.name.trim() || "Untitled",
      ppi: nd.ppi,
      widthPx: px.widthPx,
      heightPx: px.heightPx,
      bleedPx: px.bleedPx,
      pageCount: nd.pages,
      facingPages: nd.facing,
      margin: px.margin,
      mirrorMargins: nd.facing,
      columns: nd.columns,
      columnGutterPx: px.gutterPx,
      colorSpace: nd.colorSpace,
      intent: nd.intent,
    });
    app.closeDialog();
    app.commit("New document", doc);
    fit();
  }

  function applyImageSizeDlg(): void {
    const w = parseNum(el<HTMLInputElement>("img-w").value);
    const h = parseNum(el<HTMLInputElement>("img-h").value);
    const ppi = parseNum(el<HTMLInputElement>("img-ppi").value);
    if (w == null || h == null || ppi == null) return;
    const resample = el<HTMLInputElement>("img-resample").checked;
    const algo = el<HTMLSelectElement>("img-algo").value as ResampleAlgo;
    app.constrainImageSize = el<HTMLInputElement>("img-constrain").checked;
    app.imageSize(w, h, ppi, resample, algo);
  }

  function fillImageSizeFields(): void {
    const page = activePage(app.doc);
    el<HTMLInputElement>("img-w").value = String(page.widthPx);
    el<HTMLInputElement>("img-h").value = String(page.heightPx);
    el<HTMLInputElement>("img-ppi").value = String(app.doc.ppi);
    el<HTMLSelectElement>("img-algo").value = app.resampleAlgo;
    el<HTMLInputElement>("img-constrain").checked = app.constrainImageSize;
    state.imgRatio = page.widthPx / Math.max(1, page.heightPx);
    updatePrint();
  }

  function syncImageDims(axis: "w" | "h"): void {
    if (!el<HTMLInputElement>("img-constrain").checked) {
      updatePrint();
      return;
    }
    const w = parseNum(el<HTMLInputElement>("img-w").value);
    const h = parseNum(el<HTMLInputElement>("img-h").value);
    if (axis === "w" && w != null) el<HTMLInputElement>("img-h").value = String(Math.round(w / state.imgRatio));
    if (axis === "h" && h != null) el<HTMLInputElement>("img-w").value = String(Math.round(h * state.imgRatio));
    updatePrint();
  }

  function updatePrint(): void {
    const w = parseNum(el<HTMLInputElement>("img-w").value) ?? 0;
    const h = parseNum(el<HTMLInputElement>("img-h").value) ?? 0;
    const ppi = parseNum(el<HTMLInputElement>("img-ppi").value) ?? 72;
    el("img-print").textContent = `${fmt(w / ppi, 2)} × ${fmt(h / ppi, 2)} in`;
  }

  function bindKeys(): void {
    new ResizeObserver(() => render()).observe(el("pasteboard"));
    window.addEventListener("keydown", (e) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      const c = e.ctrlKey || e.metaKey;
      if (!c && !e.altKey) {
        if (k === "x") {
          const a = state.fg;
          state.fg = state.bg;
          state.bg = a;
          paint();
        }
        if (k === "d") {
          state.fg = { ...ink };
          state.bg = { ...paper };
          paint();
        }
        return;
      }
      if (k === "n") {
        e.preventDefault();
        cmd("new");
      }
      if (k === "u" && !e.shiftKey) {
        e.preventDefault();
        cmd("type-underline");
      }
      if (k === "o" && !e.shiftKey) {
        e.preventDefault();
        cmd("projects");
      }
      if (k === "s" && !e.shiftKey) {
        e.preventDefault();
        cmd("save-project");
      }
      if (k === "j") {
        e.preventDefault();
        cmd("duplicate");
      }
      if (k === "g") {
        e.preventDefault();
        e.shiftKey ? cmd("ungroup") : cmd("group");
      }
      if (k === "d" && !e.shiftKey) {
        e.preventDefault();
        cmd("deselect");
      }
      if (k === "p" && e.shiftKey) {
        e.preventDefault();
        cmd("place");
      }
      if (k === "r") {
        e.preventDefault();
        cmd("view-rulers");
      }
      if (k === "=" || k === "+") {
        e.preventDefault();
        cmd("zoom-in");
      }
      if (k === "-") {
        e.preventDefault();
        cmd("zoom-out");
      }
      if (k === "0") {
        e.preventDefault();
        cmd("zoom-fit");
      }
      if (k === "1") {
        e.preventDefault();
        cmd("zoom-100");
      }
      if (k === "]") {
        e.preventDefault();
        cmd("bring-forward");
      }
      if (k === "[") {
        e.preventDefault();
        cmd("send-backward");
      }
      if (k === "i" && e.altKey) {
        e.preventDefault();
        cmd("image-size");
      }
    });
  }

  function render(): void {
    const v = view();
    const tool = v?.tool ?? state.tool;
    state.tool = tool;
    if (v) {
      state.fg = v.fg;
      state.bg = v.bg;
    }

    if (app.dialog === "image-size" && lastDialog !== "image-size") fillImageSizeFields();
    if (app.dialog === "new" && lastDialog !== "new") renderNewDialog();
    lastDialog = app.dialog;
    el("dlg-image").hidden = app.dialog !== "image-size";
    el("dlg-new").hidden = app.dialog !== "new";
    el("dlg-bc").hidden = app.dialog !== "brightness";
    el("dlg-auth").hidden = app.dialog !== "auth";
    el("dlg-help").hidden = !state.helpOpen;
    const signBtn = document.querySelector<HTMLElement>('[data-cmd="sign-in"]');
    const who = currentUser();
    if (signBtn) signBtn.textContent = who ? `Sign out (${who.email || "session"})` : "Sign in / Create account…";
    if (app.dialog === "auth") {
      const status = el("auth-status");
      if (!status.dataset.busy) {
        status.textContent = who
          ? `Signed in as ${who.email}. Sign out from File, or create another account.`
          : authAvailable()
            ? "Sign in or create an account. Session tokens stay on this device."
            : "Cloud accounts need a provisioned Supabase project (ADR 0004). Until then this editor stays local-first — nothing here is faked.";
      }
    }
    const recoverBar = document.getElementById("recover-bar");
    if (recoverBar) {
      const snap = app.pendingRecovery;
      recoverBar.hidden = !snap;
      if (snap) {
        const nameEl = document.getElementById("recover-name");
        if (nameEl) {
          const when = new Date(snap.savedAt).toLocaleString();
          nameEl.textContent = `“${snap.name}” — autosaved ${when}`;
        }
      }
    }
    el("menu-cutout").hidden = !app.hasCutout;
    const filterCut = document.getElementById("filter-cutout");
    if (filterCut) filterCut.hidden = !app.hasCutout;
    document.querySelectorAll<HTMLButtonElement>("#toolbox [data-tool]").forEach((b) => {
      const on = b.dataset.tool === tool;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll<HTMLElement>(".opt-strip").forEach((s) => {
      s.hidden = s.dataset.for !== tool;
    });

    const page = activePage(app.doc);
    const sel = selectedLayers(app.doc)[0];
    const z = v?.zoom ?? 0.35;

    fillIfIdle("opt-x", sel ? fmt(sel.transform.x, 1) : "");
    fillIfIdle("opt-y", sel ? fmt(sel.transform.y, 1) : "");
    fillIfIdle("opt-w", sel ? fmt(sel.transform.w, 1) : "");
    fillIfIdle("opt-h", sel ? fmt(sel.transform.h, 1) : "");
    fillIfIdle("opt-r", sel ? fmt(sel.transform.rotation, 1) : "");
    fillIfIdle("tr-x", sel ? fmt(sel.transform.x, 1) : "");
    fillIfIdle("tr-y", sel ? fmt(sel.transform.y, 1) : "");
    fillIfIdle("tr-w", sel ? fmt(sel.transform.w, 1) : "");
    fillIfIdle("tr-h", sel ? fmt(sel.transform.h, 1) : "");
    fillIfIdle("tr-r", sel ? fmt(sel.transform.rotation, 1) : "");

    const story =
      sel?.kind === "type-frame" ? app.doc.stories.find((s) => s.id === sel.storyId) : undefined;
    fillIfIdle("opt-size", story ? fmt(story.character.size, 1) : "");
    fillIfIdle("opt-lead", story ? fmt(story.character.leading, 1) : "");
    fillIfIdle("opt-track", story ? fmt(story.character.tracking, 1) : "");
    fillIfIdle("ch-size", story ? fmt(story.character.size, 1) : "");
    fillIfIdle("ch-lead", story ? fmt(story.character.leading, 1) : "");
    fillIfIdle("ch-track", story ? fmt(story.character.tracking, 1) : "");
    fillIfIdle("ch-shift", story ? fmt(story.character.baselineShift ?? 0, 1) : "");
    syncTypeWeight(story?.character.fontId);
    for (const [id, on] of [
      ["opt-underline", !!story?.character.underline],
      ["opt-strike", !!story?.character.strikethrough],
      ["ch-underline", !!story?.character.underline],
      ["ch-strike", !!story?.character.strikethrough],
    ] as const) {
      const box = document.getElementById(id) as HTMLInputElement | null;
      if (box && document.activeElement !== box) box.checked = on;
    }
    fillIfIdle("para-first", story ? fmt(story.paragraph.firstLineIndent, 1) : "");
    fillIfIdle("para-after", story ? fmt(story.paragraph.spaceAfter, 1) : "");
    document.querySelectorAll<HTMLElement>("#para-align [data-align]").forEach((b) => {
      b.classList.toggle("is-on", story?.paragraph.align === b.dataset.align);
    });

    setDisabled(TRANSFORM_FIELDS, !sel);
    setDisabled(LAYER_FIELDS, !sel);
    setDisabled(STORY_FIELDS, !story);
    setDisabled(["opt-underline", "opt-strike", "ch-underline", "ch-strike", "ch-shift", "ch-weight", "ch-italic", "opt-weight", "opt-italic"], !story);
    setDisabled(["stroke-w"], sel?.kind !== "vector");
    // Cap/join/dash only apply once a vector actually carries a stroke.
    const hasStroke = sel?.kind === "vector" && !!sel.stroke;
    setDisabled(["stroke-cap", "stroke-join", "stroke-dash"], !hasStroke);
    setDisabled(["duplicate-btn", "delete-btn"], !sel);
    document.querySelectorAll<HTMLButtonElement>("#para-align [data-align]").forEach((b) => {
      b.disabled = !story;
    });

    if (sel?.kind === "image-frame") el<HTMLSelectElement>("opt-fit").value = sel.fit;
    if (sel) {
      el<HTMLSelectElement>("blend").value = sel.blend;
      fillIfIdle("opacity", fmt(sel.opacity * 100, 0));
      el("lock-btn").classList.toggle("is-on", sel.locked);
    }
    if (sel?.kind === "vector") {
      fillIfIdle("stroke-w", sel.stroke ? fmt(sel.stroke.width, 1) : "0");
      el("stroke-well").style.background = sel.stroke ? rgbaCss(sel.stroke.color) : "transparent";
      el<HTMLSelectElement>("stroke-cap").value = sel.stroke?.cap ?? "butt";
      el<HTMLSelectElement>("stroke-join").value = sel.stroke?.join ?? "miter";
      fillIfIdle("stroke-dash", sel.stroke?.dash?.length ? sel.stroke.dash.join(" ") : "");
    }

    // Effects — drop shadow of the selected layer.
    const shadow = sel?.effects?.find((e) => e.type === "drop-shadow") ?? null;
    const shadowOn = !!shadow && shadow.enabled;
    el<HTMLInputElement>("fx-shadow-on").checked = shadowOn;
    fillIfIdle("fx-shadow-x", shadow ? fmt(shadow.offsetX, 0) : "6");
    fillIfIdle("fx-shadow-y", shadow ? fmt(shadow.offsetY, 0) : "8");
    fillIfIdle("fx-shadow-blur", shadow ? fmt(shadow.blur, 0) : "12");
    fillIfIdle("fx-shadow-opacity", shadow ? fmt(shadow.opacity, 2) : "0.45");
    if (shadow) el<HTMLInputElement>("fx-shadow-color").value = rgbaToHex(shadow.color);
    setDisabled(["fx-shadow-on"], !sel);
    setDisabled(["fx-shadow-x", "fx-shadow-y", "fx-shadow-blur", "fx-shadow-opacity", "fx-shadow-color"], !shadowOn);

    const grad = sel?.effects?.find((e) => e.type === "gradient-overlay") ?? null;
    const gradOn = !!grad && grad.enabled;
    el<HTMLInputElement>("fx-grad-on").checked = gradOn;
    fillIfIdle("fx-grad-angle", grad ? fmt(grad.angle, 0) : "90");
    fillIfIdle("fx-grad-opacity", grad ? fmt(grad.opacity, 2) : "1");
    if (grad && grad.stops[0]) el<HTMLInputElement>("fx-grad-a").value = rgbaToHex(grad.stops[0].color);
    if (grad && grad.stops[1]) el<HTMLInputElement>("fx-grad-b").value = rgbaToHex(grad.stops[grad.stops.length - 1].color);
    setDisabled(["fx-grad-on"], !sel);
    setDisabled(["fx-grad-a", "fx-grad-b", "fx-grad-angle", "fx-grad-opacity"], !gradOn);

    const strokeFx = sel?.effects?.find((e) => e.type === "stroke") ?? null;
    const strokeOn = !!strokeFx && strokeFx.enabled;
    el<HTMLInputElement>("fx-stroke-on").checked = strokeOn;
    fillIfIdle("fx-stroke-width", strokeFx ? fmt(strokeFx.width, 0) : "6");
    fillIfIdle("fx-stroke-opacity", strokeFx ? fmt(strokeFx.opacity, 2) : "1");
    if (strokeFx) el<HTMLInputElement>("fx-stroke-color").value = rgbaToHex(strokeFx.color);
    setDisabled(["fx-stroke-on"], !sel);
    setDisabled(["fx-stroke-width", "fx-stroke-opacity", "fx-stroke-color"], !strokeOn);

    const glow = sel?.effects?.find((e) => e.type === "outer-glow") ?? null;
    const glowOn = !!glow && glow.enabled;
    el<HTMLInputElement>("fx-glow-on").checked = glowOn;
    fillIfIdle("fx-glow-blur", glow ? fmt(glow.blur, 0) : "16");
    fillIfIdle("fx-glow-opacity", glow ? fmt(glow.opacity, 2) : "0.85");
    if (glow) el<HTMLInputElement>("fx-glow-color").value = rgbaToHex(glow.color);
    setDisabled(["fx-glow-on"], !sel);
    setDisabled(["fx-glow-blur", "fx-glow-opacity", "fx-glow-color"], !glowOn);

    const inner = sel?.effects?.find((e) => e.type === "inner-shadow") ?? null;
    const innerOn = !!inner && inner.enabled;
    el<HTMLInputElement>("fx-inner-on").checked = innerOn;
    fillIfIdle("fx-inner-x", inner ? fmt(inner.offsetX, 0) : "2");
    fillIfIdle("fx-inner-y", inner ? fmt(inner.offsetY, 0) : "4");
    fillIfIdle("fx-inner-blur", inner ? fmt(inner.blur, 0) : "8");
    fillIfIdle("fx-inner-opacity", inner ? fmt(inner.opacity, 2) : "0.55");
    if (inner) el<HTMLInputElement>("fx-inner-color").value = rgbaToHex(inner.color);
    setDisabled(["fx-inner-on"], !sel);
    setDisabled(["fx-inner-x", "fx-inner-y", "fx-inner-blur", "fx-inner-opacity", "fx-inner-color"], !innerOn);

    const longFx = sel?.effects?.find((e) => e.type === "long-shadow") ?? null;
    const longOn = !!longFx && longFx.enabled;
    el<HTMLInputElement>("fx-long-on").checked = longOn;
    fillIfIdle("fx-long-angle", longFx ? fmt(longFx.angle, 0) : "135");
    fillIfIdle("fx-long-length", longFx ? fmt(longFx.length, 0) : "28");
    fillIfIdle("fx-long-opacity", longFx ? fmt(longFx.opacity, 2) : "0.55");
    if (longFx) el<HTMLInputElement>("fx-long-color").value = rgbaToHex(longFx.color);
    setDisabled(["fx-long-on"], !sel);
    setDisabled(["fx-long-angle", "fx-long-length", "fx-long-opacity", "fx-long-color"], !longOn);

    fillIfIdle("opt-rr-radius", fmt(app.roundRectRadius, 0));
    fillIfIdle("opt-poly-sides", String(app.polygonSides));
    fillIfIdle("opt-star-points", String(app.starPoints));

    const fxEmpty = document.getElementById("fx-empty");
    if (fxEmpty) fxEmpty.hidden = !!sel;

    // Align needs 2+ selected layers; distribute needs 3+.
    const selCount = app.doc.activeLayerIds.length;
    document.querySelectorAll<HTMLButtonElement>("#align-row [data-align]").forEach((b) => {
      b.disabled = selCount < 2;
    });
    document.querySelectorAll<HTMLButtonElement>("#align-row [data-dist]").forEach((b) => {
      b.disabled = selCount < 3;
    });

    el("fg-swatch").style.background = rgbaCss(state.fg);
    el("bg-swatch").style.background = rgbaCss(state.bg);
    el("fg-well").style.background = rgbaCss(state.fg);
    el("ch-well").style.background = story ? rgbaCss(story.character.fill) : rgbaCss(state.fg);

    const rgb = rgb8(state.fg);
    el<HTMLInputElement>("rgb-r").value = String(rgb.r);
    el<HTMLInputElement>("rgb-g").value = String(rgb.g);
    el<HTMLInputElement>("rgb-b").value = String(rgb.b);
    fillIfIdle("rgb-r-n", String(rgb.r));
    fillIfIdle("rgb-g-n", String(rgb.g));
    fillIfIdle("rgb-b-n", String(rgb.b));
    fillIfIdle("hex", rgbaToHex(state.fg).slice(1));
    const hsv = rgbToHsv(state.fg);
    state.hsv = hsv;
    el("sv-plane").style.background =
      `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h} 100% 50%))`;
    el("sv-dot").style.left = `${hsv.s * 100}%`;
    el("sv-dot").style.top = `${(1 - hsv.v) * 100}%`;
    el("hue-dot").style.left = `${(hsv.h / 360) * 100}%`;

    el("swatch-list").innerHTML = app.doc.swatches
      .map((s) => {
        const c = s.rgb ?? { r: 0, g: 0, b: 0, a: 1 };
        return `<button type="button" data-hex="${rgbaToHex(c)}" title="${esc(s.name)}" style="background:${rgbaCss(c)}"></button>`;
      })
      .join("");

    renderLayers(page);
    renderPaths(page);
    renderPages();
    renderHistory();
    renderNav(page, z);
    fillFontSelects(story?.character.fontId);
    renderFontList(story?.character.fontId);
    renderWorkflows();
    void renderLibrary();

    document.querySelectorAll<HTMLElement>("[data-ch]").forEach((b) => {
      b.classList.toggle("is-on", b.dataset.ch === state.channel);
    });
    const thumbs = app.channelThumbs;
    const thumb = el<HTMLImageElement>("ch-thumb");
    const wrap = el("ch-thumbs");
    if (thumbs) {
      wrap.hidden = false;
      const map = { rgb: thumbs.rgb, r: thumbs.r, g: thumbs.g, b: thumbs.b };
      thumb.src = map[state.channel];
    } else wrap.hidden = true;

    const pct = `${Math.round(z * 1000) / 10}%`;
    el("doc-name").textContent = app.doc.name;
    el("doc-zoom").textContent = pct;
    el("stat-doc").textContent = app.doc.name;
    el("stat-size").textContent = `${page.widthPx} × ${page.heightPx} px`;
    el("stat-ppi").textContent = `${app.doc.ppi} ppi`;
    // Report what the compositor actually edits and exports. Older documents
    // can carry aspirational `cmyk` metadata, but this build is RGB-only.
    el("stat-color").textContent = `${SUPPORTED_DOCUMENT_COLOR_SPACE.toUpperCase()}/8`;
    // Photoshop ships a document readout here, not build telemetry. While the
    // engines are still loading there is no document to measure, so the boot
    // status stands in until they are up.
    el("stat-engine").textContent = app.engines ? docSizeLabel(page, page.layers, 4) : app.status;
    el("nav-zoom-lbl").textContent = pct;
    el<HTMLInputElement>("nav-zoom").value = String(Math.round(z * 100));
    syncZoomSelect(z);

    const checks: Record<string, boolean> = {
      rulers: v?.showRulers ?? true,
      guides: v?.showGuides ?? true,
      snap: app.snapEnabled,
      bleed: v?.showBleed ?? true,
      "g-color": !el("g-color").hidden,
      "g-type": !el("g-type").hidden,
      "g-transform": !el("g-transform").hidden,
      "g-layers": !el("g-layers").hidden,
      "g-pages": !el("g-pages").hidden,
      "g-nav": !el("g-nav").hidden,
      "g-library": !el("g-library").hidden,
      "g-anchor": !el("g-anchor").hidden,
    };
    document.querySelectorAll<HTMLElement>("[data-check]").forEach((n) => {
      n.textContent = checks[n.dataset.check!] ? "✓" : "";
    });
  }

  function fillFontSelects(fontId?: string): void {
    const faces = app.fonts.list();
    const html = faces
      .map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`)
      .join("");
    for (const id of ["opt-font", "ch-font"] as const) {
      const sel = el<HTMLSelectElement>(id);
      if (sel.innerHTML !== html) sel.innerHTML = html || `<option value="">No fonts loaded</option>`;
      const pick = fontId && faces.some((f) => f.id === fontId) ? fontId : app.fonts.defaultId();
      if (pick && sel.value !== pick) sel.value = pick;
    }
  }

  function syncTypeWeight(fontId?: string): void {
    const parsed = fontId ? parseCatalogRecordId(fontId) : null;
    const rec = fontId ? app.fonts.get(fontId) : undefined;
    let weight = 400;
    let italic = false;
    if (parsed) {
      weight = parsed.weight;
      italic = parsed.italic;
    } else if (rec) {
      italic = /italic/i.test(rec.style);
      if (/bold|black|heavy/i.test(rec.style)) weight = 700;
      else if (/semibold|demi/i.test(rec.style)) weight = 600;
      else if (/medium/i.test(rec.style)) weight = 500;
      else if (/light/i.test(rec.style)) weight = 300;
      else if (/thin/i.test(rec.style)) weight = 100;
    }
    fillIfIdle("ch-weight", String(weight));
    fillIfIdle("opt-weight", String(weight));
    for (const id of ["ch-italic", "opt-italic"] as const) {
      const box = document.getElementById(id) as HTMLInputElement | null;
      if (box && document.activeElement !== box) box.checked = italic;
    }
  }

  function renderFontList(fontId?: string): void {
    const host = document.getElementById("lib-fonts");
    if (!host) return;
    const faces = app.fonts.list();
    const loaded = faces
      .map(
        (f) =>
          `<button type="button" class="lib-font${f.id === fontId ? " is-on" : ""}" data-font="${esc(f.id)}">${esc(f.name)}<span>${esc(f.source)}</span></button>`,
      )
      .join("");
    const q = (document.getElementById("lib-font-search") as HTMLInputElement | null)?.value ?? "";
    if (!fontCatalog) {
      host.innerHTML =
        (loaded || `<p class="empty">No faces yet — import a TTF or OTF, or wait for the Google catalog.</p>`) +
        `<p class="hint">Loading Google Fonts catalog…</p>`;
      void loadFontCatalog()
        .then((list) => {
          fontCatalog = list;
          renderFontList(fontId);
        })
        .catch((err) => {
          const hint = document.getElementById("lib-font-hint");
          if (hint) hint.textContent = err instanceof Error ? err.message : String(err);
        });
      return;
    }
    const loadedIds = new Set(faces.map((f) => f.id));
    const hits = searchCatalog(fontCatalog, q, 80);
    const catalogHtml = hits
      .filter((f) => !loadedIds.has(`gf-${f.id}-400-n`) && !loadedIds.has(f.id))
      .map(
        (f) =>
          `<button type="button" class="lib-font" data-catalog="${esc(f.id)}">${esc(f.family)}<span>${esc(f.category)}</span></button>`,
      )
      .join("");
    const hint = document.getElementById("lib-font-hint");
    if (hint) {
      hint.textContent = q.trim()
        ? `${hits.length} match${hits.length === 1 ? "" : "es"} in ${fontCatalog.length} Google families — click to fetch the real TTF.`
        : `${fontCatalog.length} Google families indexed. Search, then click to install a real TTF. Loaded faces listed first.`;
    }
    host.innerHTML =
      (loaded ? `<p class="hint">Loaded ${faces.length} face${faces.length === 1 ? "" : "s"}</p>${loaded}` : "") +
      (catalogHtml
        ? `<p class="hint">Catalog</p>${catalogHtml}`
        : `<p class="empty">${q.trim() ? "No catalog matches." : "Catalog empty."}</p>`);
  }

  function renderWorkflows(): void {
    const host = document.getElementById("lib-workflows");
    if (!host) return;
    host.innerHTML = WORKFLOWS.map(
      (w) =>
        `<button type="button" class="lib-font" data-workflow="${esc(w.id)}">${esc(w.name)}<span>${esc(w.blurb)}</span></button>`,
    ).join("");
  }

  function runWorkflow(id: string): void {
    const wf = workflowById(id);
    if (!wf) return;
    const page = activePage(app.doc);
    const ops = wf.build({ width: page.widthPx, height: page.heightPx, fg: state.fg });
    try {
      app.applyAnchorDetailed(ops);
      if (wf.after === "long-shadow-type") {
        const type = selectedLayers(app.doc).find((l) => l.kind === "type-frame");
        if (type) {
          app.setLongShadow(type.id, {
            type: "long-shadow",
            enabled: true,
            color: { r: 0.08, g: 0.08, b: 0.1, a: 1 },
            angle: 135,
            length: 48,
            opacity: 0.65,
          });
        }
      }
      app.status = `Workflow “${wf.name}” — ${ops.length} real Anchor op${ops.length === 1 ? "" : "s"}`;
    } catch (err) {
      app.status = err instanceof Error ? err.message : String(err);
    }
  }

  async function renderLibrary(): Promise<void> {
    const host = document.getElementById("lib-assets");
    if (!host) return;
    try {
      listedAssets = await listUserAssets();
    } catch {
      listedAssets = [];
    }
    host.innerHTML = listedAssets.length
      ? listedAssets
          .map(
            (a) =>
              `<button type="button" class="lib-card" data-asset="${esc(a.id)}" title="${esc(a.name)}"><img src="${esc(a.dataUrl)}" alt=""><span>${esc(a.name)}</span></button>`,
          )
          .join("")
      : `<p class="empty">No imported pictures yet.</p>`;
  }

  function renderLayers(page: ReturnType<typeof activePage>): void {
    const rows: string[] = [];
    const walk = (layers: Layer[], depth: number) => {
      for (const layer of [...layers].reverse()) {
        if (state.layerKind !== "all" && layer.kind !== state.layerKind) {
          if (layer.kind === "group") walk(childrenOf(page, layer.id), depth + 1);
          continue;
        }
        const on = app.doc.activeLayerIds.includes(layer.id);
        const fx =
          layer.kind === "adjustment"
            ? "BC"
            : layer.kind === "group"
              ? ""
              : "";
        // A real composite of this layer alone. `layerThumb` returns null when
        // there are genuinely no pixels to show (empty group, adjustment
        // layer, degenerate transform) — in that case the kind mark stands in
        // rather than the panel inventing an image. A throw must not wipe the list.
        let url: string | null = null;
        try {
          url = app.compositor?.layerThumb(app.doc, layer.id, THUMB) ?? null;
        } catch {
          url = null;
        }
        const cell = url
          ? `<span class="thumb"><img src="${url}" alt="" draggable="false" /></span>`
          : `<span class="thumb is-empty">${layerKindMark(layer.kind)}</span>`;
        rows.push(
          `<div class="ly${on ? " is-on" : ""}${depth ? " child" : ""}${layer.kind === "group" ? " group-row" : ""}" data-id="${layer.id}" style="--depth:${depth}">
            <button type="button" class="eye${layer.visible ? " is-on" : ""}" data-act="vis" title="Visibility" aria-label="Visibility"></button>
            <button type="button" class="lk" data-act="lock" title="Lock">${layer.locked ? "L" : ""}</button>
            ${cell}
            <span class="nm">${esc(layer.name)}</span>
            <span class="fx">${fx}</span>
          </div>`,
        );
        const kids = childrenOf(page, layer.id);
        if (kids.length) walk(kids, depth + 1);
      }
    };
    walk(rootsOf(page), 0);
    const tab = document.getElementById("tab-layers");
    if (tab) tab.textContent = page.layers.length ? `Layers (${page.layers.length})` : "Layers";
    const empty =
      page.layers.length === 0
        ? "No layers"
        : state.layerKind !== "all"
          ? `No ${state.layerKind} layers`
          : "No layers";
    el("layer-list").innerHTML = rows.join("") || `<div class="empty">${empty}</div>`;
  }

  function renderPaths(page: ReturnType<typeof activePage>): void {
    const paths = page.layers.filter((l) => l.kind === "vector");
    el("path-list").innerHTML = paths.length
      ? paths
          .map(
            (l) =>
              `<button type="button" class="path-row${app.doc.activeLayerIds.includes(l.id) ? " is-on" : ""}" data-path="${l.id}">${esc(l.name)}${l.kind === "vector" && l.closed ? " · closed" : ""}</button>`,
          )
          .join("")
      : `<div class="empty">No paths</div>`;
  }

  function renderPages(): void {
    const rows = app.doc.pages
      .map((p) => {
        const wide = p.widthPx > p.heightPx;
        // A real composite of the page, not an empty box pretending to be one.
        // Null (a genuinely empty page) leaves the blank sheet, which is honest.
        const url = app.compositor?.pageThumb(app.doc, p.id, PAGE_THUMB_PX) ?? null;
        const art = url ? `<img src="${url}" alt="" draggable="false" />` : "";
        return `<button type="button" class="page-row${p.id === app.doc.activePageId ? " is-on" : ""}" data-page="${p.id}">
          <span class="page-thumb${wide ? " wide" : ""}">${art}</span>
          <span>${esc(p.name)} · ${p.widthPx}×${p.heightPx}</span>
        </button>`;
      })
      .join("");
    el("page-list").innerHTML = rows;
  }

  function renderHistory(): void {
    const labels = app.bus.labels();
    const named = app.bus.namedList();
    const items = [
      `<button type="button" class="hist-row" data-cmd="snapshot">New snapshot</button>`,
      `<div class="hist-row is-on">Current</div>`,
      ...labels.map((l) => `<div class="hist-row">${esc(l)}</div>`),
      ...named.map((n) => `<div class="hist-row">${esc(n.label)}</div>`),
    ];
    el("history-list").innerHTML = items.join("");
  }

  function renderNav(page: ReturnType<typeof activePage>, z: number): void {
    const host = el("nav-view");
    const v = view();
    const box = host.getBoundingClientRect();
    const pb = el("pasteboard").getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return;
    const scale = Math.min(box.width / page.widthPx, box.height / page.heightPx) * 0.82;
    const pw = page.widthPx * scale;
    const ph = page.heightPx * scale;
    const nx = (box.width - pw) / 2;
    const ny = (box.height - ph) / 2;
    const np = el("nav-page");
    np.style.left = `${nx}px`;
    np.style.top = `${ny}px`;
    np.style.width = `${pw}px`;
    np.style.height = `${ph}px`;
    // A Navigator that cannot show the artwork has no reason to exist. This is
    // a real composite of the page, not a painted stand-in.
    const url = app.compositor?.pageThumb(app.doc, page.id, NAV_THUMB) ?? null;
    np.style.backgroundImage = url ? `url("${url}")` : "none";
    if (!v) return;
    const r = v.showRulers ? RULER : 0;
    const x0 = (0 - r - v.panX) / z;
    const y0 = (0 - r - v.panY) / z;
    const x1 = (pb.width - r - v.panX) / z;
    const y1 = (pb.height - r - v.panY) / z;
    const port = el("nav-port");
    port.style.left = `${nx + x0 * scale}px`;
    port.style.top = `${ny + y0 * scale}px`;
    port.style.width = `${Math.max(4, (x1 - x0) * scale)}px`;
    port.style.height = `${Math.max(4, (y1 - y0) * scale)}px`;
  }
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/* ── New Document helpers ────────────────────────────────────────────────── */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function r2(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Seed the dialog from a catalogue preset, constrained to real capabilities. */
function ndFromPreset(p: Preset): NewDocState {
  const mg = p.margin;
  return {
    category: p.category,
    presetId: p.id,
    label: shortName(p),
    name: "Untitled",
    width: p.width,
    height: p.height,
    unit: p.unit,
    ppi: p.ppi,
    colorSpace: SUPPORTED_DOCUMENT_COLOR_SPACE,
    intent: p.intent,
    pages: p.pageCount,
    facing: p.facingPages,
    columns: p.columns,
    gutter: p.gutter,
    margin: { ...mg },
    marginLinked: mg.top === mg.right && mg.right === mg.bottom && mg.bottom === mg.left,
    bleedMm: p.bleedMm,
  };
}

/**
 * Change of unit at a fixed ppi. Pixels are the pivot, so the conversion is the
 * document's own arithmetic (factory mmToPx / inToPx / pxToMm / pxToIn) rather
 * than a second, drifting copy of it.
 */
function convertUnit(v: number, from: PresetUnit, to: PresetUnit, ppi: number): number {
  if (from === to) return v;
  const px = unitToPx(v, from, ppi);
  if (to === "mm") return pxToMm(px, ppi);
  if (to === "in") return pxToIn(px, ppi);
  return px;
}

/**
 * px whole, mm to 0.001, in to 0.0001. Trailing zeros are dropped, so the
 * common values still read "210" and "8.5" — but US trade bleed is exactly
 * 0.125 in = 3.175 mm, and a 2 dp field would show 3.17 and hand back 3.17
 * the moment the user touched it.
 */
function fmtUnit(v: number, unit: PresetUnit): string {
  const dp = unit === "px" ? 0 : unit === "mm" ? 3 : 4;
  return String(Number(v.toFixed(dp)));
}

function sizeLabel(p: Preset): string {
  const dp = p.unit === "px" ? 0 : 2;
  const n = (v: number) => String(Number(v.toFixed(dp)));
  return `${n(p.width)} × ${n(p.height)} ${p.unit}`;
}

/**
 * Catalogue names carry the size after an em dash ("A4 — 210 × 297 mm"). The
 * list already prints the size in its own column, so the row shows the bare
 * name and lets the size column say it once.
 */
function shortName(p: Preset): string {
  const cut = p.name.indexOf(" — ");
  return cut > 0 ? p.name.slice(0, cut) : p.name;
}

function fillIfIdle(id: string, value: string): void {
  const node = el<HTMLInputElement>(id);
  if (document.activeElement === node) return;
  node.value = value;
}

/** Mirror the live zoom into the status-bar combo. Without this the combo keeps
 *  its markup default (100%) while the tab and Navigator report the real zoom. */
function syncZoomSelect(z: number): void {
  const sel = el<HTMLSelectElement>("stat-zoom");
  const label = `${Math.round(z * 1000) / 10}%`;
  if (sel.value === label) return;
  let opt = [...sel.options].find((o) => o.value === label);
  if (!opt) {
    for (const stale of [...sel.options]) {
      if (stale.dataset.live === "1") stale.remove();
    }
    opt = new Option(label, label);
    opt.dataset.live = "1";
    sel.insertBefore(opt, sel.options[1] ?? null);
  }
  sel.value = label;
}

/** Photoshop greys a control it has no value for. A blank but live-looking
 *  input reads as breakage, so inert beats empty. */
function setDisabled(ids: readonly string[], off: boolean): void {
  for (const id of ids) {
    const node = document.getElementById(id);
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLButtonElement) {
      node.disabled = off;
    }
  }
}

const TRANSFORM_FIELDS = [
  "opt-x", "opt-y", "opt-w", "opt-h", "opt-r",
  "tr-x", "tr-y", "tr-w", "tr-h", "tr-r",
] as const;
const STORY_FIELDS = [
  "opt-font", "opt-size", "opt-lead", "opt-track", "opt-weight", "opt-italic",
  "ch-font", "ch-size", "ch-lead", "ch-track", "ch-weight", "ch-italic",
  "para-first", "para-after",
] as const;
const LAYER_FIELDS = ["blend", "opacity", "lock-btn"] as const;

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
