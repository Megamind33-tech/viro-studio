/**
 * Anchor studio — the op console that lives inside the docked `#g-anchor`
 * panel (Window ▸ Anchor). Per DESK-CHROME.md this is a studio in the right
 * column, not product chrome: no destination rails, no Generate pills, no
 * command strip. Everything the operator needs to drive Anchor is in here.
 *
 * Three surfaces over one engine:
 *   Catalogue — the op schemas, grouped and searchable. The reference surface.
 *   Compose   — schema-driven fields that build one `{ id, op, params, reason }`
 *               envelope and push it onto the batch.
 *   JSON      — the honest primitive: paste the batch a model would emit.
 *
 * All three funnel into the same queue, and the queue is applied through
 * `PressApp.applyAnchorDetailed` — one undo step, an audit trail back. The
 * batch is atomic: a rejected op leaves the document untouched, so a failed
 * apply keeps the queue pending and quotes the engine's error verbatim.
 *
 * This module mounts itself into the markup that is already in index.html: it
 * queries `#g-anchor` / `#anchor-ops`, strips the static prose, and populates.
 */

import "./anchor-panel.css";
import type { PressApp } from "../app";
import {
  ANCHOR_CONTRACT,
  ANCHOR_TOOLS,
  type AnchorOp,
  type AnchorOpResult,
  type AnchorTool,
} from "../anchor/tools";
import {
  assembleOps,
  getAnchorProvider,
  interpret,
  providerContext,
  type Interpretation,
} from "../anchor/interpret";
import { listUserAssets, type UserAsset } from "../library/store";
import type { Layer, PressDocument } from "../document/types";

/* ------------------------------------------------------------------ *
 * Schema reading
 * ------------------------------------------------------------------ */

type Schema = Record<string, unknown>;
type FieldKind = "number" | "integer" | "boolean" | "enum" | "string" | "color" | "json";

interface Param {
  name: string;
  schema: Schema;
  kind: FieldKind;
  required: boolean;
}

interface OpSpec {
  tool: AnchorTool;
  name: string;
  short: string;
  description: string;
  params: Param[];
  family: string;
}

function schemaBody(tool: AnchorTool): Schema {
  // The engine advertises `inputSchema`; tolerate a `parameters` alias so a
  // renamed catalogue does not silently empty this panel.
  const raw = tool as unknown as { inputSchema?: unknown; parameters?: unknown };
  const s = (raw.inputSchema ?? raw.parameters ?? {}) as Schema;
  return s;
}

function fieldKind(schema: Schema): FieldKind {
  if (Array.isArray(schema.enum)) return "enum";
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    const branches = oneOf as Schema[];
    // The colour schema is the one union with a hex-string branch.
    if (branches.some((b) => typeof b.pattern === "string" && b.pattern.includes("#"))) return "color";
    return "json";
  }
  switch (schema.type) {
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    default:
      return "json";
  }
}

/** Compact constraint label for the catalogue, e.g. "number 0–1" or "enum(4)". */
function typeLabel(p: Param): string {
  const s = p.schema;
  const bits: string[] = [];
  switch (p.kind) {
    case "enum":
      bits.push(`enum(${(s.enum as unknown[]).length})`);
      break;
    case "color":
      bits.push("rgba | #hex");
      break;
    case "json":
      bits.push(typeof s.type === "string" ? String(s.type) : "object");
      if (typeof s.minItems === "number") bits.push(`min ${s.minItems}`);
      break;
    case "boolean":
      bits.push("boolean");
      break;
    case "integer":
    case "number": {
      bits.push(p.kind);
      const lo = typeof s.minimum === "number" ? String(s.minimum) : typeof s.exclusiveMinimum === "number" ? `>${s.exclusiveMinimum}` : null;
      const hi = typeof s.maximum === "number" ? String(s.maximum) : null;
      if (lo !== null && hi !== null) bits.push(`${lo}–${hi}`);
      else if (lo !== null) bits.push(`≥ ${lo}`);
      else if (hi !== null) bits.push(`≤ ${hi}`);
      break;
    }
    default: {
      bits.push("string");
      if (typeof s.maxLength === "number") bits.push(`≤ ${s.maxLength} ch`);
      else if (typeof s.minLength === "number") bits.push(`≥ ${s.minLength} ch`);
      break;
    }
  }
  return bits.join(" ");
}

/* ------------------------------------------------------------------ *
 * Families — the natural grouping of the catalogue
 * ------------------------------------------------------------------ */

const FAMILY_ORDER = [
  "Selection",
  "Page & document",
  "Layer lifecycle",
  "Layer properties",
  "Type",
  "Vector",
  "Image",
  "Colour",
  "Adjustment",
  "Other",
] as const;

const FAMILY_OF: Record<string, string> = {
  "press.select": "Selection",
  "press.select_in_region": "Selection",
  "press.set_active_page": "Page & document",
  "press.add_page": "Page & document",
  "press.add_guide": "Page & document",
  "press.image_size": "Page & document",
  "press.duplicate": "Layer lifecycle",
  "press.delete": "Layer lifecycle",
  "press.group": "Layer lifecycle",
  "press.ungroup": "Layer lifecycle",
  "press.reorder": "Layer lifecycle",
  "press.set_name": "Layer properties",
  "press.set_visible": "Layer properties",
  "press.set_locked": "Layer properties",
  "press.set_opacity": "Layer properties",
  "press.set_blend": "Layer properties",
  "press.set_transform": "Layer properties",
  "press.add_type_frame": "Type",
  "press.set_story_text": "Type",
  "press.set_character": "Type",
  "press.set_paragraph_align": "Type",
  "press.add_rect": "Vector",
  "press.add_ellipse": "Vector",
  "press.add_line": "Vector",
  "press.add_path": "Vector",
  "press.append_path_node": "Vector",
  "press.close_path": "Vector",
  "press.place_image": "Image",
  "press.set_image_fit": "Image",
  "press.set_image_focal": "Image",
  "press.set_image_crop": "Image",
  "press.apply_fill": "Colour",
  "press.add_adjustment": "Adjustment",
};

function buildSpecs(): OpSpec[] {
  return ANCHOR_TOOLS.map((tool) => {
    const body = schemaBody(tool);
    const props = (body.properties ?? {}) as Record<string, Schema>;
    const required = new Set(Array.isArray(body.required) ? (body.required as string[]) : []);
    const params: Param[] = Object.entries(props)
      .filter(([name]) => name !== "reason")
      .map(([name, schema]) => ({ name, schema, kind: fieldKind(schema), required: required.has(name) }));
    return {
      tool,
      name: tool.name,
      short: tool.name.replace(/^press\./, ""),
      description: tool.description,
      params,
      family: FAMILY_OF[tool.name] ?? "Other",
    };
  });
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls: string, text: string, title?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

function caret(): HTMLSpanElement {
  return el("span", "anc-caret");
}

function clock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One-line preview of an op's params, for the dense queue rows. */
function paramPreview(op: AnchorOp): string {
  const params = (op.params ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    let text: string;
    if (typeof v === "string") text = v.length > 22 ? `${v.slice(0, 21)}…` : v;
    else if (v === null || typeof v === "number" || typeof v === "boolean") text = String(v);
    else {
      const json = JSON.stringify(v) ?? "";
      text = json.length > 22 ? `${json.slice(0, 21)}…` : json;
    }
    bits.push(`${k} ${text}`);
  }
  return bits.join(" · ");
}

function opTarget(op: AnchorOp): string | null {
  const params = (op.params ?? {}) as Record<string, unknown>;
  const t = op.target ?? params.layerId ?? params.layerIds ?? params.pageId;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.join(", ");
  return null;
}

function layerIndex(doc: PressDocument): Map<string, Layer> {
  const map = new Map<string, Layer>();
  for (const page of doc.pages) for (const layer of page.layers) map.set(layer.id, layer);
  return map;
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

interface QueueEntry {
  key: string;
  op: AnchorOp;
}

interface TrailEntry {
  n: number;
  at: string;
  results: AnchorOpResult[];
}

interface BatchError {
  message: string;
  index: number | null;
}

type Mode = "chat" | "catalogue" | "compose" | "json";

/* ------------------------------------------------------------------ *
 * Chat transcript model
 * ------------------------------------------------------------------ */

/** One proposal of work: ops that have not been applied, and may never be. */
interface Proposal {
  ops: AnchorOp[];
  /** Zone groupings that need a second batch, if this was a composed design. */
  zones: { name: string; ids: string[] }[];
  /** Set for the follow-up assemble step, so the card block reads differently. */
  kind: "work" | "assemble";
  state: "pending" | "applied" | "discarded";
  results: AnchorOpResult[];
  error: string | null;
}

interface Turn {
  role: "user" | "anchor" | "system";
  at: string;
  /** Who produced an anchor turn: the built-in interpreter, or a named provider. */
  source: string | null;
  lines: string[];
  notes: string[];
  unread: Interpretation["unread"];
  proposals: Proposal[];
  design: Interpretation["design"];
}

export function mountAnchorPanel(app: PressApp): () => void {
  const rootEl = document.getElementById("g-anchor");
  const opsEl = document.getElementById("anchor-ops");
  if (!rootEl || !opsEl) return () => {};
  // Declared non-null so the closures below inherit the narrowing.
  const root: HTMLElement = rootEl;
  const opsHost: HTMLElement = opsEl;

  const specs = buildSpecs();
  const byName = new Map(specs.map((s) => [s.name, s]));

  const body = root.querySelector<HTMLElement>(".anchor-body") ?? opsHost.parentElement ?? root;
  // The panel used to be documentation: a heading and a paragraph restating the
  // contract. The contract now lives in the catalogue, where it is data.
  for (const stale of Array.from(body.children)) {
    if (stale !== opsHost && (stale.tagName === "H2" || stale.tagName === "P")) stale.remove();
  }
  body.classList.add("anc");
  root.classList.add("anc-panel");

  /* ---- state ---- */
  let mode: Mode = "catalogue";
  let queue: QueueEntry[] = [];
  let trail: TrailEntry[] = [];
  let batchNo = 0;
  let error: BatchError | null = null;
  let note: string | null = null;
  let opSeq = 0;
  let filter = "";
  const openOps = new Set<string>();
  let contractOpen = false;
  let composeOp: OpSpec = specs[0]!;
  let values = new Map<string, string>();
  let composeIssue: string | null = null;

  /* ---- chrome: mode row ---- */
  const modeRow = el("div", "anc-modes");
  const modeButtons: Record<Mode, HTMLButtonElement> = {
    chat: button("anc-mode", "Chat", "Ask for a design in words; nothing is applied until you apply it"),
    catalogue: button("anc-mode", "Catalogue", "The 33 op schemas"),
    compose: button("anc-mode", "Compose", "Build one op from its schema"),
    json: button("anc-mode", "JSON", "Paste a batch as a model emits it"),
  };
  for (const key of Object.keys(modeButtons) as Mode[]) {
    const b = modeButtons[key];
    b.addEventListener("click", () => setMode(key));
    modeRow.append(b);
  }

  const docBar = el("div", "anc-docbar");

  /* ---- view: chat ---- *
   *
   * The transcript is a log, not a messaging app: no bubbles, no avatars, no
   * typing animation. A turn is a 15px header strip and a body, in the same
   * idiom as the batch rows below it, because that is what the rest of this
   * studio looks like. Ops a turn proposes render as the same op cards the
   * queue uses and wait behind Apply — a reply can suggest work, it cannot do
   * work.
   */
  const chatView = el("div", "anc-view anc-view-chat");
  const chatSrc = el("div", "anc-src");
  const chatSrcName = el("span", "anc-src-n", "Built-in interpreter");
  const chatSrcNote = el("span", "anc-src-m", "no model attached");
  const chatClear = button("anc-mini anc-mini-thin", "Clear", "Empty the transcript. The document is untouched.");
  chatSrc.append(chatSrcName, chatSrcNote, chatClear);
  const chatLog = el("div", "anc-log");
  const chatBar = el("div", "anc-say");
  const sayInput = el("textarea", "ctrl anc-sayin");
  sayInput.rows = 2;
  sayInput.spellcheck = false;
  sayInput.placeholder = "Ask for a design, an element, or a clean-up…";
  const sendBtn = button("anc-btn anc-btn-default anc-send", "Send", "Enter to send · Shift+Enter for a new line");
  chatBar.append(sayInput, sendBtn);
  chatView.append(chatSrc, chatLog, chatBar);

  /* ---- view: catalogue ---- */
  const catView = el("div", "anc-view anc-view-cat");
  const searchRow = el("div", "anc-search");
  const searchInput = el("input", "ctrl anc-find");
  searchInput.type = "text";
  searchInput.placeholder = "Filter ops, params, text…";
  searchInput.spellcheck = false;
  const searchCount = el("span", "anc-count");
  searchRow.append(searchInput, searchCount);
  const catList = el("div", "anc-cat");
  const contractBlock = el("div", "anc-contract");
  catView.append(searchRow, catList);
  searchInput.addEventListener("input", () => {
    filter = searchInput.value.trim().toLowerCase();
    renderCatalogue();
  });

  /* ---- view: compose ---- */
  const composeView = el("div", "anc-view anc-view-compose");
  const opSelect = el("select", "ctrl anc-op");
  const idInput = el("input", "ctrl anc-id");
  idInput.type = "text";
  idInput.spellcheck = false;
  const reasonInput = el("textarea", "ctrl anc-reason");
  reasonInput.rows = 2;
  reasonInput.spellcheck = false;
  reasonInput.placeholder = "Why this op exists — kept as the audit trail";
  const opDesc = el("div", "anc-opdesc");
  const fieldsHost = el("div", "anc-fields");
  const previewPre = el("pre", "anc-preview");
  const issueLine = el("div", "anc-issue");
  const layerList = el("datalist");
  layerList.id = "anc-layer-ids";

  const composeActions = el("div", "anc-actions");
  const queueBtn = button("anc-btn", "Queue op", "Append this op to the batch");
  const applyOneBtn = button("anc-btn anc-btn-default", "Queue + apply", "Append and apply the whole batch");
  composeActions.append(queueBtn, applyOneBtn);

  composeView.append(
    fieldRow("Op", opSelect),
    opDesc,
    fieldRow("id", idInput),
    fieldRow("reason", reasonInput, true),
    fieldsHost,
    sectionLabel("Envelope"),
    previewPre,
    issueLine,
    composeActions,
    layerList,
  );

  /* ---- view: json ---- */
  const jsonView = el("div", "anc-view anc-view-json");
  const jsonArea = el("textarea", "ctrl anc-json");
  jsonArea.rows = 9;
  jsonArea.spellcheck = false;
  jsonArea.placeholder =
    '[\n  {\n    "op": "press.add_rect",\n    "params": { "x": 200, "y": 200, "w": 900, "h": 300, "fill": "#E07A2F" },\n    "reason": "why this op exists"\n  }\n]';
  const jsonActions = el("div", "anc-actions");
  const jsonQueueBtn = button("anc-btn", "Queue batch", "Parse and append to the queue");
  const jsonApplyBtn = button("anc-btn anc-btn-default", "Apply batch", "Parse, append, and apply");
  const jsonDumpBtn = button("anc-btn anc-btn-thin", "◂ Queue", "Load the current queue back into this box");
  jsonActions.append(jsonQueueBtn, jsonApplyBtn, jsonDumpBtn);
  const jsonIssue = el("div", "anc-issue");
  jsonView.append(
    sectionLabel("Batch JSON"),
    el(
      "div",
      "anc-help",
      "An array of { id?, op, target?, params, reason }. A single object is accepted. Applied through the same path as the composer — one undo step, all or nothing.",
    ),
    jsonArea,
    jsonIssue,
    jsonActions,
  );

  /* ---- queue + trail ---- */
  const queueHead = el("div", "anc-sec anc-queuehead");
  const queueTitle = el("span", "anc-sec-t", "Op queue");
  const queueCount = el("span", "anc-sec-n", "0");
  const queueSpacer = el("span", "anc-sec-sp");
  const clearBtn = button("anc-mini", "Clear", "Discard the pending batch");
  const applyBtn = button("anc-mini anc-mini-default", "Apply batch", "Apply every pending op as one undo step");
  queueHead.append(queueTitle, queueCount, queueSpacer, clearBtn, applyBtn);

  opsHost.className = "anc-queue";
  const errorBox = el("div", "anc-error");
  errorBox.hidden = true;
  const noteBox = el("div", "anc-note");
  noteBox.hidden = true;

  body.append(modeRow, docBar, chatView, catView, composeView, jsonView, queueHead, errorBox, noteBox, opsHost);

  /* ------------------------------------------------------------------ *
   * Small builders
   * ------------------------------------------------------------------ */

  function sectionLabel(text: string): HTMLElement {
    const s = el("div", "anc-sec");
    s.append(el("span", "anc-sec-t", text));
    return s;
  }

  function fieldRow(label: string, control: HTMLElement, stacked = false): HTMLElement {
    const row = el("div", stacked ? "anc-row anc-row-stack" : "anc-row");
    row.append(el("label", "anc-lbl", label), control);
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Mode switching
   * ------------------------------------------------------------------ */

  function setMode(next: Mode): void {
    mode = next;
    for (const key of Object.keys(modeButtons) as Mode[]) {
      modeButtons[key].classList.toggle("is-on", key === mode);
    }
    chatView.hidden = mode !== "chat";
    catView.hidden = mode !== "catalogue";
    composeView.hidden = mode !== "compose";
    jsonView.hidden = mode !== "json";
    // The op queue belongs to the three structured surfaces. Chat has its own
    // proposals inline, so showing an unrelated empty queue under it would be
    // chrome that means nothing.
    queueHead.hidden = mode === "chat";
    opsHost.hidden = mode === "chat";
    if (mode === "chat") sayInput.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ *
   * Catalogue
   * ------------------------------------------------------------------ */

  function matches(spec: OpSpec): boolean {
    if (!filter) return true;
    if (spec.name.toLowerCase().includes(filter)) return true;
    if (spec.family.toLowerCase().includes(filter)) return true;
    if (spec.description.toLowerCase().includes(filter)) return true;
    return spec.params.some(
      (p) =>
        p.name.toLowerCase().includes(filter) ||
        String(p.schema.description ?? "").toLowerCase().includes(filter),
    );
  }

  function renderCatalogue(): void {
    catList.replaceChildren();
    const shown = specs.filter(matches);
    searchCount.textContent = `${shown.length}/${specs.length}`;

    for (const family of FAMILY_ORDER) {
      const group = shown.filter((s) => s.family === family);
      if (!group.length) continue;
      const head = el("div", "anc-fam");
      head.append(el("span", "anc-fam-t", family), el("span", "anc-fam-n", String(group.length)));
      catList.append(head);
      for (const spec of group) catList.append(catRow(spec));
    }
    if (!shown.length) catList.append(el("div", "anc-empty", `No op matches “${searchInput.value}”.`));
    catList.append(contractBlock);
  }

  function catRow(spec: OpSpec): HTMLElement {
    const wrap = el("div", "anc-op-wrap");
    const open = openOps.has(spec.name);
    const head = el("div", "anc-op-row");
    if (open) head.classList.add("is-open");
    const tri = caret();
    if (open) tri.classList.add("is-open");
    const nm = el("span", "anc-op-nm", spec.short);
    const req = spec.params.filter((p) => p.required).length;
    const meta = el("span", "anc-op-meta", spec.params.length ? `${spec.params.length}p${req ? ` · ${req} req` : ""}` : "no params");
    const use = button("anc-mini anc-op-use", "Compose", `Load ${spec.name} into the composer`);
    head.append(tri, nm, meta, use);
    head.addEventListener("click", (ev) => {
      if (ev.target === use) return;
      if (openOps.has(spec.name)) openOps.delete(spec.name);
      else openOps.add(spec.name);
      renderCatalogue();
    });
    use.addEventListener("click", (ev) => {
      ev.stopPropagation();
      loadIntoComposer(spec);
      setMode("compose");
    });
    wrap.append(head);

    if (open) {
      const detail = el("div", "anc-op-detail");
      detail.append(el("div", "anc-op-full", spec.name));
      detail.append(el("p", "anc-op-desc", spec.description));
      if (spec.params.length) {
        const table = el("div", "anc-params");
        for (const p of spec.params) {
          const row = el("div", "anc-param");
          const top = el("div", "anc-param-top");
          top.append(el("span", "anc-param-nm", p.name));
          top.append(el("span", "anc-param-ty", typeLabel(p)));
          if (p.required) top.append(el("span", "anc-req", "required"));
          row.append(top);
          const desc = String(p.schema.description ?? "");
          if (desc) row.append(el("div", "anc-param-desc", desc));
          if (Array.isArray(p.schema.enum)) {
            const vals = el("div", "anc-enum");
            for (const v of p.schema.enum as unknown[]) vals.append(el("span", "anc-enum-v", String(v)));
            row.append(vals);
          }
          table.append(row);
        }
        detail.append(table);
      }
      wrap.append(detail);
    }
    return wrap;
  }

  function renderContract(): void {
    contractBlock.replaceChildren();
    const head = el("div", "anc-fam anc-fam-click");
    const tri = caret();
    if (contractOpen) tri.classList.add("is-open");
    head.append(tri, el("span", "anc-fam-t", "Contract"), el("span", "anc-fam-n", String(ANCHOR_CONTRACT.split("\n").length)));
    head.addEventListener("click", () => {
      contractOpen = !contractOpen;
      renderContract();
    });
    contractBlock.append(head);
    if (contractOpen) {
      const list = el("div", "anc-contract-body");
      for (const line of ANCHOR_CONTRACT.split("\n")) list.append(el("div", "anc-contract-line", line));
      contractBlock.append(list);
    }
  }

  /* ------------------------------------------------------------------ *
   * Composer
   * ------------------------------------------------------------------ */

  function buildOpSelect(): void {
    opSelect.replaceChildren();
    for (const family of FAMILY_ORDER) {
      const group = specs.filter((s) => s.family === family);
      if (!group.length) continue;
      const optgroup = document.createElement("optgroup");
      optgroup.label = family;
      for (const spec of group) {
        const opt = document.createElement("option");
        opt.value = spec.name;
        opt.textContent = spec.short;
        optgroup.append(opt);
      }
      opSelect.append(optgroup);
    }
    opSelect.value = composeOp.name;
  }

  function nextOpId(): string {
    opSeq += 1;
    return `op${opSeq}`;
  }

  function loadIntoComposer(spec: OpSpec): void {
    composeOp = spec;
    values = new Map();
    for (const p of spec.params) {
      if (p.kind === "enum" && p.required) values.set(p.name, String((p.schema.enum as unknown[])[0]));
      if (p.kind === "boolean" && p.required) values.set(p.name, "true");
    }
    composeIssue = null;
    opSelect.value = spec.name;
    idInput.value = nextOpId();
    renderComposer();
  }

  function renderComposer(): void {
    opDesc.textContent = composeOp.description;
    fieldsHost.replaceChildren();
    if (composeOp.params.length) {
      fieldsHost.append(sectionLabel("Params"));
      for (const p of composeOp.params) fieldsHost.append(paramField(p));
    } else {
      fieldsHost.append(sectionLabel("Params"));
      fieldsHost.append(el("div", "anc-help", "This op takes no parameters."));
    }
    renderPreview();
  }

  function setValue(name: string, v: string): void {
    if (v === "") values.delete(name);
    else values.set(name, v);
    renderPreview();
  }

  function paramField(p: Param): HTMLElement {
    const row = el("div", "anc-field");
    const head = el("div", "anc-field-head");
    head.append(el("span", "anc-field-nm", p.name));
    head.append(el("span", "anc-field-ty", typeLabel(p)));
    if (p.required) head.append(el("span", "anc-req", "req"));
    row.append(head);

    const box = el("div", "anc-field-ctl");
    const current = values.get(p.name) ?? "";

    if (p.kind === "enum") {
      const sel = el("select", "ctrl");
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "—";
      sel.append(none);
      for (const v of p.schema.enum as unknown[]) {
        const opt = document.createElement("option");
        opt.value = String(v);
        opt.textContent = String(v);
        sel.append(opt);
      }
      sel.value = current;
      sel.addEventListener("change", () => setValue(p.name, sel.value));
      box.append(sel);
    } else if (p.kind === "boolean") {
      const sel = el("select", "ctrl");
      for (const [v, label] of [["", "—"], ["true", "true"], ["false", "false"]] as const) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = label;
        sel.append(opt);
      }
      sel.value = current;
      sel.addEventListener("change", () => setValue(p.name, sel.value));
      box.append(sel);
    } else if (p.kind === "color") {
      const text = el("input", "ctrl anc-grow");
      text.type = "text";
      text.spellcheck = false;
      text.placeholder = "#E07A2F or {\"r\":0.8,\"g\":0.4,\"b\":0}";
      text.value = current;
      const swatch = el("input", "anc-swatch");
      swatch.type = "color";
      swatch.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#e07a2f";
      text.addEventListener("input", () => {
        if (/^#[0-9a-fA-F]{6}$/.test(text.value)) swatch.value = text.value;
        setValue(p.name, text.value.trim());
      });
      swatch.addEventListener("input", () => {
        text.value = swatch.value.toUpperCase();
        setValue(p.name, text.value);
      });
      box.append(swatch, text);
    } else if (p.kind === "json") {
      const area = el("textarea", "ctrl anc-jsonfield");
      area.rows = 2;
      area.spellcheck = false;
      area.placeholder = p.name === "layerIds" ? '["ly_…","ly_…"]' : "JSON value";
      area.value = current;
      area.addEventListener("input", () => setValue(p.name, area.value));
      box.append(area);
      if (p.name === "layerIds") box.append(selectionButton(() => JSON.stringify(app.doc.activeLayerIds), area));
    } else if (p.kind === "string" && (p.name === "text" || p.name === "dataUrl")) {
      const area = el("textarea", "ctrl anc-jsonfield");
      area.rows = p.name === "text" ? 3 : 2;
      area.spellcheck = false;
      area.value = current;
      area.addEventListener("input", () => setValue(p.name, area.value));
      box.append(area);
    } else {
      const input = el("input", "ctrl anc-grow");
      input.type = p.kind === "number" || p.kind === "integer" ? "number" : "text";
      input.spellcheck = false;
      if (p.kind === "number") input.step = "any";
      const s = p.schema;
      if (typeof s.minimum === "number") input.min = String(s.minimum);
      if (typeof s.maximum === "number") input.max = String(s.maximum);
      input.value = current;
      input.addEventListener("input", () => setValue(p.name, input.value.trim()));
      if (p.name === "layerId" || p.name === "pageId") {
        if (p.name === "layerId") input.setAttribute("list", layerList.id);
        input.placeholder = p.name === "layerId" ? "omit → current selection" : app.doc.activePageId;
        box.append(input, selectionButton(() => (p.name === "layerId" ? (app.doc.activeLayerIds[0] ?? "") : app.doc.activePageId), input));
      } else {
        box.append(input);
      }
    }
    row.append(box);
    return row;
  }

  function selectionButton(read: () => string, target: HTMLInputElement | HTMLTextAreaElement): HTMLButtonElement {
    const b = button("anc-mini anc-mini-thin", "sel", "Fill from the current document selection");
    b.addEventListener("click", () => {
      const v = read();
      if (!v || v === "[]") {
        flashNote("Nothing is selected in the document.");
        return;
      }
      target.value = v;
      const name = target.closest(".anc-field")?.querySelector(".anc-field-nm")?.textContent ?? "";
      if (name) setValue(name, v);
    });
    return b;
  }

  /** Coerce the typed strings into the JSON the envelope carries. Throws with a quotable message. */
  function collectParams(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of composeOp.params) {
      const raw = values.get(p.name);
      if (raw === undefined || raw === "") continue;
      switch (p.kind) {
        case "number":
        case "integer": {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw new Error(`"${p.name}" must be a number — got "${raw}"`);
          out[p.name] = n;
          break;
        }
        case "boolean":
          out[p.name] = raw === "true";
          break;
        case "color":
          out[p.name] = raw.startsWith("{") ? parseJson(p.name, raw) : raw;
          break;
        case "json":
          out[p.name] = parseJson(p.name, raw);
          break;
        default:
          out[p.name] = raw;
          break;
      }
    }
    return out;
  }

  function parseJson(name: string, raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      throw new Error(`"${name}" is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Built in envelope order — { id, op, params, reason } — because this is the shape a model emits. */
  function currentEnvelope(): AnchorOp {
    const id = idInput.value.trim();
    const params = collectParams();
    const op: AnchorOp = id
      ? { id, op: composeOp.name, params, reason: reasonInput.value.trim() }
      : { op: composeOp.name, params, reason: reasonInput.value.trim() };
    return op;
  }

  function renderPreview(): void {
    try {
      const env = currentEnvelope();
      previewPre.textContent = JSON.stringify(env, null, 2);
      previewPre.classList.remove("is-bad");
      composeIssue = null;
    } catch (err) {
      previewPre.textContent = "—";
      previewPre.classList.add("is-bad");
      composeIssue = err instanceof Error ? err.message : String(err);
    }
    issueLine.textContent = composeIssue ?? "";
    issueLine.hidden = !composeIssue;
    const missing = composeOp.params.filter((p) => p.required && !values.get(p.name)).map((p) => p.name);
    if (!composeIssue && missing.length) {
      issueLine.textContent = `Missing required: ${missing.join(", ")}`;
      issueLine.hidden = false;
    }
  }

  function pushComposed(): boolean {
    let env: AnchorOp;
    try {
      env = currentEnvelope();
    } catch (err) {
      composeIssue = err instanceof Error ? err.message : String(err);
      issueLine.textContent = composeIssue;
      issueLine.hidden = false;
      return false;
    }
    if (env.reason.length < 3) {
      issueLine.textContent = "reason is required on every op — at least 3 characters. It is the audit trail.";
      issueLine.hidden = false;
      reasonInput.focus();
      return false;
    }
    queue.push({ key: `q${queue.length}-${Date.now()}`, op: env });
    error = null;
    idInput.value = nextOpId();
    renderQueue();
    return true;
  }

  queueBtn.addEventListener("click", () => {
    pushComposed();
  });
  applyOneBtn.addEventListener("click", () => {
    if (pushComposed()) applyQueue();
  });
  opSelect.addEventListener("change", () => {
    const spec = byName.get(opSelect.value);
    if (spec) loadIntoComposer(spec);
  });
  reasonInput.addEventListener("input", renderPreview);
  idInput.addEventListener("input", renderPreview);

  /* ------------------------------------------------------------------ *
   * JSON batch entry
   * ------------------------------------------------------------------ */

  function readJsonBatch(): AnchorOp[] | null {
    const raw = jsonArea.value.trim();
    if (!raw) {
      showJsonIssue("Nothing to parse — paste a batch first.");
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      showJsonIssue(`JSON: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        showJsonIssue(`Entry #${i} is not an op object { op, params, reason }.`);
        return null;
      }
    }
    jsonIssue.hidden = true;
    return list as AnchorOp[];
  }

  function showJsonIssue(text: string): void {
    jsonIssue.textContent = text;
    jsonIssue.hidden = false;
  }

  jsonQueueBtn.addEventListener("click", () => {
    const ops = readJsonBatch();
    if (!ops) return;
    for (const op of ops) queue.push({ key: `j${queue.length}-${Date.now()}`, op });
    error = null;
    flashNote(`${ops.length} op${ops.length === 1 ? "" : "s"} queued from JSON.`);
    renderQueue();
  });

  jsonApplyBtn.addEventListener("click", () => {
    const ops = readJsonBatch();
    if (!ops) return;
    for (const op of ops) queue.push({ key: `j${queue.length}-${Date.now()}`, op });
    renderQueue();
    applyQueue();
  });

  jsonDumpBtn.addEventListener("click", () => {
    jsonArea.value = JSON.stringify(
      queue.map((q) => q.op),
      null,
      2,
    );
    jsonIssue.hidden = true;
  });

  /* ------------------------------------------------------------------ *
   * Queue + apply + audit trail
   * ------------------------------------------------------------------ */

  function applyQueue(): void {
    if (!queue.length) {
      flashNote("Queue is empty — nothing to apply.");
      return;
    }
    const ops = queue.map((q) => q.op);
    try {
      const results = app.applyAnchorDetailed(ops);
      batchNo += 1;
      trail.unshift({ n: batchNo, at: clock(), results });
      queue = [];
      error = null;
      note = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const m = /^Anchor op #(\d+)/.exec(message);
      error = { message, index: m ? Number(m[1]) : null };
      note = null;
    }
    renderQueue();
    // The outcome — the new batch, or the ops that were refused — is at the top.
    opsHost.scrollTop = 0;
  }

  clearBtn.addEventListener("click", () => {
    queue = [];
    error = null;
    renderQueue();
  });
  applyBtn.addEventListener("click", applyQueue);

  function flashNote(text: string): void {
    note = text;
    error = null;
    renderNotices();
  }

  function renderNotices(): void {
    if (error) {
      errorBox.replaceChildren();
      const head = el("div", "anc-error-head");
      head.append(el("span", "anc-error-tag", "Batch rejected"));
      head.append(el("span", "anc-error-sub", "document unchanged · queue kept"));
      errorBox.append(head, el("div", "anc-error-msg", error.message));
      errorBox.hidden = false;
    } else {
      errorBox.hidden = true;
    }
    noteBox.textContent = note ?? "";
    noteBox.hidden = !note || error !== null;
  }

  function layerChip(id: string, layers: Map<string, Layer>): HTMLElement {
    const layer = layers.get(id);
    const chip = button("anc-chip", id, layer ? `Select ${layer.name} (${layer.kind})` : "This id is no longer in the document");
    if (!layer) {
      chip.classList.add("is-stale");
      chip.disabled = true;
    } else {
      if (app.doc.activeLayerIds.includes(id)) chip.classList.add("is-sel");
      chip.addEventListener("click", () => {
        app.selectLayer(id, false);
      });
    }
    return chip;
  }

  function renderQueue(): void {
    queueCount.textContent = String(queue.length);
    applyBtn.disabled = queue.length === 0;
    clearBtn.disabled = queue.length === 0;
    renderNotices();

    const layers = layerIndex(app.doc);
    opsHost.replaceChildren();

    if (queue.length) {
      opsHost.append(sectionRule("Pending", `${queue.length} op${queue.length === 1 ? "" : "s"} · one undo step`));
      queue.forEach((entry, i) => opsHost.append(pendingRow(entry, i)));
    }

    if (!queue.length && !trail.length) {
      opsHost.append(
        el("div", "anc-empty", "No ops in queue. Compose one, or paste a batch as JSON — nothing is applied until you apply it."),
      );
    }

    for (const batch of trail) {
      const head = el("div", "anc-batch");
      head.append(el("span", "anc-batch-n", `Batch ${batch.n}`));
      head.append(el("span", "anc-batch-meta", `${batch.at} · ${batch.results.length} op${batch.results.length === 1 ? "" : "s"} · applied`));
      opsHost.append(head);
      for (const r of batch.results) opsHost.append(resultRow(r, layers));
      const last = batch.results[batch.results.length - 1];
      if (last && last.selection.length) {
        const sel = el("div", "anc-selline");
        sel.append(el("span", "anc-selline-t", "selection"));
        for (const id of last.selection) sel.append(layerChip(id, layers));
        opsHost.append(sel);
      }
    }
  }

  function sectionRule(title: string, meta: string): HTMLElement {
    const row = el("div", "anc-rule");
    row.append(el("span", "anc-rule-t", title), el("span", "anc-rule-m", meta));
    return row;
  }

  function pendingRow(entry: QueueEntry, i: number): HTMLElement {
    const row = el("div", "anc-qrow");
    if (error && error.index === i) row.classList.add("is-bad");
    const head = el("div", "anc-qrow-head");
    head.append(el("span", "anc-qi", `#${i}`));
    head.append(el("span", "anc-qop", String(entry.op.op ?? entry.op.name ?? "?")));
    if (entry.op.id) head.append(el("span", "anc-qid", String(entry.op.id)));
    const spacer = el("span", "anc-sec-sp");
    const up = button("anc-mini anc-mini-thin", "▲", "Move earlier in the batch");
    const down = button("anc-mini anc-mini-thin", "▼", "Move later in the batch");
    const kill = button("anc-mini anc-mini-thin", "✕", "Remove from the batch");
    up.disabled = i === 0;
    down.disabled = i === queue.length - 1;
    up.addEventListener("click", () => moveOp(i, -1));
    down.addEventListener("click", () => moveOp(i, 1));
    kill.addEventListener("click", () => {
      queue.splice(i, 1);
      renderQueue();
    });
    head.append(spacer, up, down, kill);
    row.append(head);

    const target = opTarget(entry.op);
    if (target) {
      const t = el("div", "anc-qtarget");
      t.append(el("span", "anc-qtarget-t", "target"), el("span", "anc-qtarget-v", target));
      row.append(t);
    }
    const preview = paramPreview(entry.op);
    if (preview) row.append(el("div", "anc-qparams", preview));
    const reason = typeof entry.op.reason === "string" ? entry.op.reason : "";
    row.append(el("div", reason ? "anc-qreason" : "anc-qreason is-bad", reason || "no reason — this op will be rejected"));
    return row;
  }

  function moveOp(i: number, delta: number): void {
    const j = i + delta;
    if (j < 0 || j >= queue.length) return;
    const a = queue[i]!;
    const b = queue[j]!;
    queue[i] = b;
    queue[j] = a;
    renderQueue();
  }

  function resultRow(r: AnchorOpResult, layers: Map<string, Layer>): HTMLElement {
    const row = el("div", "anc-rrow");
    const head = el("div", "anc-rrow-head");
    head.append(el("span", "anc-tick", "✓"));
    head.append(el("span", "anc-qop", r.op));
    if (r.id) head.append(el("span", "anc-qid", r.id));
    row.append(head);
    row.append(el("div", "anc-summary", r.summary));
    row.append(el("div", "anc-qreason", r.reason));
    if (r.created.length) {
      const made = el("div", "anc-made");
      made.append(el("span", "anc-made-t", "created"));
      for (const id of r.created) made.append(layerChip(id, layers));
      row.append(made);
    }
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Document readout
   * ------------------------------------------------------------------ */

  function renderDocBar(): void {
    const doc = app.doc;
    const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0];
    docBar.replaceChildren();
    if (!page) return;
    const idx = doc.pages.findIndex((p) => p.id === page.id) + 1;
    const bits = [
      `pg ${idx}/${doc.pages.length}`,
      `${Math.round(page.widthPx)}×${Math.round(page.heightPx)}`,
      `${page.layers.length} layer${page.layers.length === 1 ? "" : "s"}`,
      `${doc.activeLayerIds.length} sel`,
    ];
    for (const b of bits) docBar.append(el("span", "anc-docbit", b));
    const id = el("span", "anc-docbit anc-docid", page.id);
    docBar.append(id);
  }

  function refreshLayerList(): void {
    layerList.replaceChildren();
    for (const page of app.doc.pages) {
      for (const layer of page.layers) {
        const opt = document.createElement("option");
        opt.value = layer.id;
        opt.label = `${layer.name} · ${layer.kind}`;
        layerList.append(opt);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Chat
   *
   * The honesty rules this surface exists under:
   *   · The reply is labelled with what produced it, every time.
   *   · With no provider registered it says so, once, in words, at the top of
   *     the transcript — not in a tooltip, not in grey 8px.
   *   · A proposal is inert until Apply. Nothing here writes to the document.
   *   · A clause the interpreter could not read is quoted back verbatim with
   *     the ops that came nearest, rather than turned into a guess.
   * ------------------------------------------------------------------ */

  const turns: Turn[] = [];
  let userAssets: UserAsset[] = [];
  let chatBusy = false;

  void listUserAssets()
    .then((rows) => {
      userAssets = rows;
    })
    .catch(() => {
      // No IndexedDB (private mode, or a locked-down embed). The library is
      // simply empty then, and "place my logo" refuses honestly on its own.
      userAssets = [];
    });

  function providerName(): string | null {
    const p = getAnchorProvider();
    return p ? p.name : null;
  }

  function refreshSourceStrip(): void {
    const name = providerName();
    chatSrcName.textContent = name ?? "Built-in interpreter";
    chatSrcNote.textContent = name ? "provider · proposals still gated by Apply" : "no model attached";
  }

  function openingTurn(): Turn {
    const name = providerName();
    return {
      role: "system",
      at: clock(),
      source: null,
      lines: name
        ? [
            `“${name}” is registered as an Anchor provider, so it answers here and every reply is labelled with its name.`,
            "It proposes ops. It cannot write to the document: everything it returns waits behind Apply, exactly like the built-in interpreter's work.",
          ]
        : [
            "No model is attached to this build, and nothing is sent anywhere.",
            "Answering is the built-in interpreter: a deterministic grammar over the 33 press.* ops and this app's own composed designs. It composes whole layouts on your page grid, builds and cleans elements, moves them by name, and sources marks and fields from the local library.",
            "It reads only the phrasings it was built for. When it cannot read something it quotes it back and says so — it does not guess. Type ? for the whole grammar.",
          ],
      notes: [],
      unread: [],
      proposals: [],
      design: null,
    };
  }

  function pushTurn(turn: Turn): Turn {
    turns.push(turn);
    return turn;
  }

  function say(text: string): void {
    const message = text.trim();
    if (!message || chatBusy) return;
    pushTurn({ role: "user", at: clock(), source: null, lines: message.split("\n"), notes: [], unread: [], proposals: [], design: null });
    sayInput.value = "";
    syncSend();
    renderChat();

    const provider = getAnchorProvider();
    if (!provider) {
      const reading = interpret(message, app.doc, { userAssets });
      pushTurn(turnFromInterpretation(reading, "built-in interpreter"));
      renderChat();
      return;
    }

    chatBusy = true;
    syncSend();
    const history = turns
      .filter((t) => t.role !== "system")
      .map((t) => ({ role: t.role === "user" ? ("user" as const) : ("anchor" as const), text: t.lines.join("\n") }));
    void provider
      .complete(message, providerContext(app.doc, history))
      .then((reply) => {
        if (Array.isArray(reply)) {
          pushTurn({
            role: "anchor",
            at: clock(),
            source: provider.name,
            lines: [`${provider.name} proposed ${reply.length} op${reply.length === 1 ? "" : "s"}. Nothing is applied until you apply it.`],
            notes: [],
            unread: [],
            proposals: reply.length ? [{ ops: reply, zones: [], kind: "work", state: "pending", results: [], error: null }] : [],
            design: null,
          });
        } else {
          pushTurn({
            role: "anchor",
            at: clock(),
            source: provider.name,
            lines: [],
            notes: [],
            unread: [{ text: message, why: `${provider.name} returned an error: ${reply.error}`, suggest: [] }],
            proposals: [],
            design: null,
          });
        }
      })
      .catch((err: unknown) => {
        pushTurn({
          role: "anchor",
          at: clock(),
          source: provider.name,
          lines: [],
          notes: [],
          unread: [{ text: message, why: `${provider.name} threw: ${err instanceof Error ? err.message : String(err)}`, suggest: [] }],
          proposals: [],
          design: null,
        });
      })
      .finally(() => {
        chatBusy = false;
        syncSend();
        renderChat();
      });
  }

  function turnFromInterpretation(reading: Interpretation, source: string): Turn {
    return {
      role: "anchor",
      at: clock(),
      source,
      lines: reading.say,
      notes: reading.notes,
      unread: reading.unread,
      proposals: reading.ops.length
        ? [{ ops: reading.ops, zones: reading.zones, kind: "work", state: "pending", results: [], error: null }]
        : [],
      design: reading.design,
    };
  }

  function applyProposal(turn: Turn, proposal: Proposal): void {
    try {
      proposal.results = app.applyAnchorDetailed(proposal.ops);
      proposal.state = "applied";
      proposal.error = null;
      // A composed design wants its zones named. That cannot ride in the same
      // batch — no op can name a layer a later op in the same batch will make —
      // so it is offered as its own step, and labelled as its own undo step.
      if (proposal.zones.length) {
        const byEnvelope = new Map<string, string>();
        for (const r of proposal.results) if (r.id && r.created.length) byEnvelope.set(r.id, r.created[0]!);
        const ops = assembleOps(proposal.zones, (id) => byEnvelope.get(id));
        if (ops.length) {
          turn.proposals.push({ ops, zones: [], kind: "assemble", state: "pending", results: [], error: null });
        }
      }
    } catch (err) {
      proposal.error = err instanceof Error ? err.message : String(err);
    }
    renderChat();
  }

  function opCard(op: AnchorOp, index: number): HTMLElement {
    const row = el("div", "anc-qrow anc-card");
    const head = el("div", "anc-qrow-head");
    head.append(el("span", "anc-qi", `#${index}`));
    head.append(el("span", "anc-qop", String(op.op ?? "?")));
    if (op.id) head.append(el("span", "anc-qid", String(op.id)));
    row.append(head);
    const preview = paramPreview(op);
    if (preview) row.append(el("div", "anc-qparams", preview));
    const reason = typeof op.reason === "string" ? op.reason : "";
    row.append(el("div", reason ? "anc-qreason" : "anc-qreason is-bad", reason || "no reason — this op will be rejected"));
    return row;
  }

  const CARD_LIMIT = 6;
  const expanded = new Set<Proposal>();

  function proposalBlock(turn: Turn, proposal: Proposal): HTMLElement {
    const wrap = el("div", "anc-proposal");
    const n = proposal.ops.length;
    const head = el("div", "anc-rule");
    head.append(el("span", "anc-rule-t", proposal.kind === "assemble" ? "Assemble" : "Proposed"));
    head.append(
      el(
        "span",
        "anc-rule-m",
        proposal.state === "applied"
          ? `${n} op${n === 1 ? "" : "s"} · applied`
          : proposal.state === "discarded"
            ? `${n} op${n === 1 ? "" : "s"} · discarded`
            : `${n} op${n === 1 ? "" : "s"} · not applied`,
      ),
    );
    wrap.append(head);

    if (turn.design && proposal.kind === "work") {
      const d = el("div", "anc-design");
      d.append(el("span", "anc-design-t", turn.design.title));
      d.append(el("span", "anc-design-n", `${turn.design.layers} layers`));
      wrap.append(d);
    }

    if (proposal.state === "pending" || proposal.state === "discarded") {
      const show = expanded.has(proposal) ? proposal.ops.length : Math.min(CARD_LIMIT, proposal.ops.length);
      proposal.ops.slice(0, show).forEach((op, i) => wrap.append(opCard(op, i)));
      if (proposal.ops.length > CARD_LIMIT) {
        const more = button(
          "anc-mini anc-more",
          expanded.has(proposal) ? `Show first ${CARD_LIMIT}` : `Show all ${proposal.ops.length} ops`,
          "Every op in the proposal, in the order it will run",
        );
        more.addEventListener("click", () => {
          if (expanded.has(proposal)) expanded.delete(proposal);
          else expanded.add(proposal);
          renderChat();
        });
        wrap.append(more);
      }
    }

    if (proposal.error) {
      const box = el("div", "anc-error");
      const eh = el("div", "anc-error-head");
      eh.append(el("span", "anc-error-tag", "Batch rejected"));
      eh.append(el("span", "anc-error-sub", "document unchanged"));
      box.append(eh, el("div", "anc-error-msg", proposal.error));
      wrap.append(box);
    }

    if (proposal.state === "pending") {
      const actions = el("div", "anc-actions anc-proposal-act");
      const apply = button(
        "anc-btn anc-btn-default",
        proposal.kind === "assemble" ? `Group zones · ${n}` : `Apply · ${n} op${n === 1 ? "" : "s"}`,
        "Applies as one undo step. Ctrl+Z reverts the whole batch.",
      );
      const discard = button("anc-btn anc-btn-thin", "Discard", "Drop these ops. The document was never touched.");
      apply.addEventListener("click", () => applyProposal(turn, proposal));
      discard.addEventListener("click", () => {
        proposal.state = "discarded";
        renderChat();
      });
      actions.append(apply, discard);
      wrap.append(actions);
      wrap.append(el("div", "anc-gate", "Nothing above has touched the document."));
    }

    if (proposal.state === "applied") {
      const layers = layerIndex(app.doc);
      const done = el("div", "anc-batch");
      done.append(el("span", "anc-batch-n", "Applied"));
      done.append(el("span", "anc-batch-meta", `${proposal.results.length} op${proposal.results.length === 1 ? "" : "s"} · one undo step`));
      wrap.append(done);
      for (const res of proposal.results) wrap.append(resultRow(res, layers));
      const last = proposal.results[proposal.results.length - 1];
      if (last && last.selection.length) {
        const selLine = el("div", "anc-selline");
        selLine.append(el("span", "anc-selline-t", "selection"));
        for (const id of last.selection) selLine.append(layerChip(id, layers));
        wrap.append(selLine);
      }
    }

    if (proposal.state === "discarded") wrap.classList.add("is-off");
    return wrap;
  }

  function unreadBlock(entry: Interpretation["unread"][number]): HTMLElement {
    const box = el("div", "anc-unread");
    const head = el("div", "anc-unread-head");
    head.append(el("span", "anc-unread-tag", "Could not read"));
    box.append(head);
    box.append(el("div", "anc-unread-q", `“${entry.text}”`));
    box.append(el("div", "anc-unread-why", entry.why));
    if (entry.suggest.length) {
      const chips = el("div", "anc-unread-ops");
      chips.append(el("span", "anc-unread-t", "nearest ops"));
      for (const name of entry.suggest) {
        const spec = byName.get(name);
        const chip = button("anc-chip", name.replace(/^press\./, ""), spec ? `Open ${name} in Compose` : name);
        if (spec) {
          chip.addEventListener("click", () => {
            loadIntoComposer(spec);
            setMode("compose");
          });
        } else {
          chip.disabled = true;
        }
        chips.append(chip);
      }
      box.append(chips);
    }
    return box;
  }

  function turnBlock(turn: Turn): HTMLElement {
    const wrap = el("div", `anc-turn is-${turn.role}`);
    const head = el("div", "anc-turn-head");
    head.append(el("span", "anc-turn-who", turn.role === "user" ? "You" : turn.role === "system" ? "Anchor · standing note" : "Anchor"));
    if (turn.source) head.append(el("span", "anc-turn-src", turn.source));
    head.append(el("span", "anc-turn-at", turn.at));
    wrap.append(head);
    for (const line of turn.lines) wrap.append(el("div", "anc-turn-body", line));
    if (turn.notes.length) {
      const notes = el("div", "anc-notes");
      notes.append(el("div", "anc-notes-t", "chosen for you"));
      for (const note of turn.notes) notes.append(el("div", "anc-note-line", note));
      wrap.append(notes);
    }
    for (const entry of turn.unread) wrap.append(unreadBlock(entry));
    for (const proposal of turn.proposals) wrap.append(proposalBlock(turn, proposal));
    return wrap;
  }

  function renderChat(): void {
    refreshSourceStrip();
    chatLog.replaceChildren();
    for (const turn of turns) chatLog.append(turnBlock(turn));
    if (chatBusy) chatLog.append(el("div", "anc-turn is-anchor", `Waiting on ${providerName() ?? "the provider"}…`));
    chatClear.disabled = turns.length <= 1;
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function syncSend(): void {
    sendBtn.disabled = chatBusy || sayInput.value.trim().length === 0;
  }

  sayInput.addEventListener("input", syncSend);
  sayInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      say(sayInput.value);
    }
  });
  sendBtn.addEventListener("click", () => say(sayInput.value));
  chatClear.addEventListener("click", () => {
    turns.length = 0;
    expanded.clear();
    turns.push(openingTurn());
    renderChat();
  });

  /* ------------------------------------------------------------------ *
   * Boot + live wiring
   * ------------------------------------------------------------------ */

  let pending = 0;
  function scheduleRefresh(): void {
    if (root.hidden) return;
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      renderDocBar();
      refreshLayerList();
      renderQueue();
    });
  }

  const unsubscribe = app.onChange(scheduleRefresh);
  const observer = new MutationObserver(() => {
    if (!root.hidden) {
      renderDocBar();
      refreshLayerList();
      renderQueue();
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ["hidden"] });

  buildOpSelect();
  loadIntoComposer(composeOp);
  setMode("catalogue");
  renderCatalogue();
  renderContract();
  renderDocBar();
  refreshLayerList();
  renderQueue();

  return () => {
    unsubscribe();
    observer.disconnect();
  };
}
