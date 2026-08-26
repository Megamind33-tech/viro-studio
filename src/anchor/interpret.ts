/**
 * Anchor — the built-in interpreter, and the seam a real model plugs into.
 *
 * There is no language model in this application. Nothing here infers, and
 * nothing here calls out. This file is a **deterministic design engine**: a
 * fixed grammar over the `press.*` ops in `./tools.ts`, the composed designs in
 * `src/library/catalog.ts`, and the grid arithmetic in `./compose.ts`.
 *
 * It does five things, in the operator's own words:
 *
 *   generate — "make me a concert poster" lays down a complete composed design,
 *              re-registered on the current page's own grid, with their words
 *              and their accent substituted in.
 *   build    — "add a headline saying X", "three body columns", "a rule under
 *              the masthead" compose against `pageGrid`, never at eyeballed px.
 *   clean    — "clean this up" snaps what is already on the page to the
 *              columns, the margins and the baseline, and reports every move.
 *   move     — targets resolve by layer name, destinations by grid position.
 *   source   — marks, procedural two-ink fields, paper stock and the operator's
 *              own imported assets, chosen by intent and named in the reply.
 *
 * Its contract with the operator is the point of it:
 *
 *  - It **never guesses**. A clause it does not recognise comes back as an
 *    `unread` entry naming the exact text it could not read, plus the ops it
 *    *does* have that came closest.
 *  - Where it fills in a value nobody gave it, it says so, in numbers, with the
 *    rule it used. A silent default is a small lie.
 *  - Words with no defined meaning in the document model — "pop", "modern" —
 *    are refused by name rather than mapped onto some arbitrary change that
 *    would look like understanding.
 *
 * Nothing here touches a document. It returns op envelopes; the panel gates
 * them behind Apply, and `PressApp.applyAnchorDetailed` is the only writer.
 */

import type { Layer, Page, PressDocument } from "../document/types";
import {
  autoLeading,
  defaultTypeSizePx,
  estimateLines,
  frameHeightFor,
  pageGrid,
  ptToPx,
} from "../document/factory";
import {
  CHALK,
  COPPER,
  INK as INK_RGBA,
  MARKS,
  NIGHT,
  PAPERS,
  hex,
  markNodes,
  paperPng,
  placeholderAsset,
  type MarkId,
  type StockFieldId,
} from "../library/catalog";
import type { UserAsset } from "../library/store";
import {
  assembleOps,
  baselineStep,
  gridPlacement,
  matchTemplate,
  opsFromTemplate,
  rgbaToHex,
  snapBaseline,
  snapSpan,
  snapX,
  templateList,
  type ComposedDesign,
  type Placement,
} from "./compose";
import { ANCHOR_CONTRACT, ANCHOR_TOOLS, type AnchorOp, type AnchorTool } from "./tools";

export { assembleOps } from "./compose";

/* ------------------------------------------------------------------ *
 * The provider seam
 * ------------------------------------------------------------------ */

/** What a provider is handed alongside the prompt. Read-only — a provider never writes. */
export interface AnchorProviderContext {
  /** The whole document graph, as `window.viroAnchor.document()` returns it. */
  document: PressDocument;
  /** The op catalogue the reply must be expressed in. */
  tools: AnchorTool[];
  /** The envelope rules a caller has to honour. */
  contract: string;
  /** Layers currently selected, flattened to what a caller needs to address them. */
  selection: { id: string; name: string; kind: Layer["kind"]; x: number; y: number; w: number; h: number }[];
  /** Prior turns of this conversation, oldest first. */
  history: { role: "user" | "anchor"; text: string }[];
}

/**
 * A model backend. Register one as `window.viroAnchorProvider` and Chat will
 * use it and label every reply with its `name`.
 *
 * The ops it returns are NOT applied. They land in the same op cards the local
 * interpreter produces and wait behind the same Apply button. A provider can
 * propose; only the operator commits.
 */
export interface AnchorProvider {
  name: string;
  complete(prompt: string, context: AnchorProviderContext): Promise<AnchorOp[] | { error: string }>;
}

type ProviderWindow = Window & { viroAnchorProvider?: unknown };

/** The registered provider, or null. Read at send time, so late registration works. */
export function getAnchorProvider(): AnchorProvider | null {
  if (typeof window === "undefined") return null;
  const raw = (window as ProviderWindow).viroAnchorProvider;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<AnchorProvider>;
  if (typeof p.name !== "string" || !p.name) return null;
  if (typeof p.complete !== "function") return null;
  return p as AnchorProvider;
}

export function providerContext(
  doc: PressDocument,
  history: { role: "user" | "anchor"; text: string }[],
): AnchorProviderContext {
  const page = activePageOf(doc);
  const selection = page.layers
    .filter((l) => doc.activeLayerIds.includes(l.id))
    .map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      x: Math.round(l.transform.x),
      y: Math.round(l.transform.y),
      w: Math.round(l.transform.w),
      h: Math.round(l.transform.h),
    }));
  return { document: doc, tools: ANCHOR_TOOLS, contract: ANCHOR_CONTRACT, selection, history };
}

/* ------------------------------------------------------------------ *
 * Result shapes
 * ------------------------------------------------------------------ */

/** One clause the interpreter could not read, and the nearest ops it does have. */
export interface UnreadClause {
  text: string;
  why: string;
  suggest: string[];
}

export interface Interpretation {
  /** Ops proposed. Never applied by this module. */
  ops: AnchorOp[];
  /** What Anchor says back, in plain sentences. */
  say: string[];
  /** Values the interpreter chose that the operator did not give. Always stated. */
  notes: string[];
  /** Clauses it refused rather than guessed at. */
  unread: UnreadClause[];
  /**
   * Zone groupings for a composed design. These cannot ride in the same batch —
   * no op can name a layer a later op in the same batch will create — so the
   * panel offers them as a second, separate step and says so.
   */
  zones: { name: string; ids: string[] }[];
  /** Set when the proposal is a whole composition rather than an edit. */
  design: { title: string; blurb: string; layers: number } | null;
}

export interface InterpretOptions {
  /** The operator's own imported assets, for "use my logo". */
  userAssets?: UserAsset[];
}

/* ------------------------------------------------------------------ *
 * Named colours
 *
 * A closed list, weighted to the studio palette in src/library/catalog.ts.
 * A colour word that is not in it is refused by name rather than approximated.
 * ------------------------------------------------------------------ */

const COLOURS: Record<string, string> = {
  black: "#1A1A1A",
  ink: "#1A1A1A",
  night: "#12161A",
  slate: "#20262B",
  charcoal: "#2B2B2B",
  white: "#FFFFFF",
  paper: "#FFFFFF",
  chalk: "#F4F1EA",
  sand: "#E8E1D5",
  bone: "#E3DDD1",
  cream: "#F2E9D8",
  stone: "#8A8F93",
  mist: "#C9CFD3",
  grey: "#8A8F93",
  gray: "#8A8F93",
  silver: "#C4C4C4",
  copper: "#E07A2F",
  orange: "#E07A2F",
  rust: "#9E4A24",
  amber: "#D89A2B",
  gold: "#C9A227",
  yellow: "#E8C93A",
  moss: "#3C5145",
  green: "#3A8A46",
  olive: "#6B7038",
  teal: "#2C7A72",
  turquoise: "#2FB3A8",
  cyan: "#3BB6D6",
  blue: "#2F6FE0",
  navy: "#1C3057",
  indigo: "#3B3B78",
  violet: "#6B4A9E",
  purple: "#6B3FA0",
  magenta: "#C0399B",
  pink: "#E08AA8",
  coral: "#E0705A",
  oxblood: "#6E2A2A",
  maroon: "#6E2A2A",
  crimson: "#B2233B",
  red: "#B2233B",
  brown: "#6B4A32",
  tan: "#C09566",
};

/** Vague words with no defined meaning in the document model. Refused by name. */
const VAGUE = [
  "pop", "nicer", "prettier", "beautiful", "gorgeous", "stylish", "sleek", "cool",
  "punchy", "aesthetic", "vibe", "vibey", "elegant", "premium", "fancy",
  "interesting", "dynamic", "harmonious", "wow", "sexy", "trendy",
];

/* ------------------------------------------------------------------ *
 * Document readers
 * ------------------------------------------------------------------ */

function activePageOf(doc: PressDocument): Page {
  return doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]!;
}

interface Ctx {
  doc: PressDocument;
  page: Page;
  grid: ReturnType<typeof pageGrid>;
  /** Selected layers on the active page, in page order. */
  selection: Layer[];
  bodyPx: number;
  baseline: number;
  userAssets: UserAsset[];
}

function makeCtx(doc: PressDocument, opts: InterpretOptions): Ctx {
  const page = activePageOf(doc);
  const bodyPx = defaultTypeSizePx(doc.ppi);
  return {
    doc,
    page,
    grid: pageGrid(page),
    selection: page.layers.filter((l) => doc.activeLayerIds.includes(l.id)),
    bodyPx,
    baseline: baselineStep(bodyPx),
    userAssets: opts.userAssets ?? [],
  };
}

/* ------------------------------------------------------------------ *
 * Lexical helpers
 * ------------------------------------------------------------------ */

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const UNIT = String.raw`(?:px|pt|mm|cm|in|")?`;

/** A measurement, converted to page px through the document's own ppi. */
function toPx(value: number, unit: string | undefined, ppi: number): number {
  switch ((unit ?? "").toLowerCase()) {
    case "pt":
      return ptToPx(value, ppi);
    case "mm":
      return (value / 25.4) * ppi;
    case "cm":
      return (value / 2.54) * ppi;
    case "in":
    case '"':
      return value * ppi;
    default:
      return value;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The literal the operator typed, if they quoted one. Straight and curly quotes. */
function quoted(text: string): string | null {
  const m = /["“”'‘’]([^"“”'‘’]{1,600})["“”'‘’]/.exec(text);
  return m ? m[1]!.trim() : null;
}

function findColour(clause: string): { hex: string; word: string } | null {
  const h = /#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/i.exec(clause);
  if (h) return { hex: `#${h[1]!.toUpperCase()}`, word: `#${h[1]!.toUpperCase()}` };
  const names = Object.keys(COLOURS).sort((a, b) => b.length - a.length);
  for (const key of names) {
    if (new RegExp(`\\b${key}\\b`, "i").test(clause)) return { hex: COLOURS[key]!, word: key };
  }
  return null;
}

/** "400x300", "400 by 300", "90mm x 60mm", "width 400 height 300". */
function findSize(clause: string, ppi: number): { w: number; h: number } | null {
  const pair = new RegExp(`(${NUM})\\s*(${UNIT})\\s*(?:x|×|by)\\s*(${NUM})\\s*(${UNIT})`, "i").exec(clause);
  if (pair) {
    const w = toPx(Number(pair[1]), pair[2] || pair[4], ppi);
    const h = toPx(Number(pair[3]), pair[4] || pair[2], ppi);
    if (w > 0 && h > 0) return { w: round(w), h: round(h) };
  }
  const w = new RegExp(`\\b(?:w|width)\\s*(?:=|:|of)?\\s*(${NUM})\\s*(${UNIT})`, "i").exec(clause);
  const h = new RegExp(`\\b(?:h|height)\\s*(?:=|:|of)?\\s*(${NUM})\\s*(${UNIT})`, "i").exec(clause);
  if (w && h) return { w: round(toPx(Number(w[1]), w[2], ppi)), h: round(toPx(Number(h[1]), h[2], ppi)) };
  return null;
}

/** "at 100,100", "at x 100 y 200", "at (100, 100)". Explicit coordinates only. */
function findPoint(clause: string, ppi: number): { x: number; y: number } | null {
  const pair = new RegExp(`\\bat\\s*\\(?\\s*(${NUM})\\s*(${UNIT})\\s*,\\s*(${NUM})\\s*(${UNIT})\\s*\\)?`, "i").exec(clause);
  if (pair) {
    return {
      x: round(toPx(Number(pair[1]), pair[2] || pair[4], ppi)),
      y: round(toPx(Number(pair[3]), pair[4] || pair[2], ppi)),
    };
  }
  const x = new RegExp(`\\bx\\s*(?:=|:|of)?\\s*(${NUM})\\s*(${UNIT})`, "i").exec(clause);
  const y = new RegExp(`\\by\\s*(?:=|:|of)?\\s*(${NUM})\\s*(${UNIT})`, "i").exec(clause);
  if (x && y) return { x: round(toPx(Number(x[1]), x[2], ppi)), y: round(toPx(Number(y[1]), y[2], ppi)) };
  return null;
}

/* ------------------------------------------------------------------ *
 * Clause splitting
 * ------------------------------------------------------------------ */

const VERB_HEAD =
  /^(?:add|put|draw|create|insert|place|make|set|select|deselect|rename|call|group|ungroup|delete|remove|duplicate|copy|move|push|centre|center|align|justify|rotate|resize|scale|hide|show|lock|unlock|bring|send|fill|colou?r|change|clear|go|snap|clean|tidy|build|design|generate|compose|use)\b/;

/**
 * Cut a message into instruction clauses. Splitting on "and" is only safe when
 * what follows starts with a verb — "a 400x300 red rectangle and a circle" is
 * one clause, "add a rect and select it" is two.
 */
function splitClauses(text: string): string[] {
  const rough = text
    .replace(/\r\n/g, "\n")
    .split(/[\n;]+|(?:\s+then\s+)|(?:\.\s+)/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of rough) {
    let rest = part;
    let guard = 0;
    while (guard++ < 12) {
      const m = /\s*(?:,\s*and\s+|\s+and\s+|,\s+)/.exec(rest);
      if (!m || m.index <= 0) break;
      const tail = rest.slice(m.index + m[0].length);
      if (!VERB_HEAD.test(tail.trim())) break;
      out.push(rest.slice(0, m.index).trim());
      rest = tail;
    }
    if (rest.trim()) out.push(rest.trim());
  }
  return out.length ? out : [text.trim()];
}

/* ------------------------------------------------------------------ *
 * Nearest supported ops, for an honest refusal
 * ------------------------------------------------------------------ */

const STOP = new Set([
  "the", "a", "an", "and", "to", "of", "it", "them", "this", "that", "with", "for", "on", "in", "at",
  "my", "me", "please", "can", "you", "i", "want", "would", "like", "some", "more", "very", "make",
  "set", "is", "are", "be", "do", "get", "put", "add",
]);

export function nearestOps(clause: string, limit = 3): string[] {
  const words = clause
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const fallback = ["press.add_type_frame", "press.add_rect", "press.set_transform"];
  if (!words.length) return fallback;
  const scored = ANCHOR_TOOLS.map((tool) => {
    const hay = `${tool.name} ${tool.description}`.toLowerCase();
    const shortName = tool.name.replace(/^press\./, "").replace(/_/g, " ");
    let score = 0;
    for (const w of words) {
      if (shortName.includes(w)) score += 4;
      else if (hay.includes(w)) score += 1;
    }
    return { name: tool.name, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored.slice(0, limit).map((s) => s.name) : fallback;
}

/* ------------------------------------------------------------------ *
 * The reply under construction
 * ------------------------------------------------------------------ */

class Reply {
  ops: AnchorOp[] = [];
  say: string[] = [];
  notes: string[] = [];
  unread: UnreadClause[] = [];
  zones: { name: string; ids: string[] }[] = [];
  design: Interpretation["design"] = null;
  private seq = 0;

  push(op: string, params: Record<string, unknown>, reason: string): string {
    this.seq += 1;
    const id = `c${this.seq}`;
    this.ops.push({ id, op, params, reason });
    return id;
  }

  /** Op whose reason is the operator's own sentence — the audit trail quotes them. */
  pushQ(op: string, params: Record<string, unknown>, clause: string): string {
    return this.push(op, params, `chat: "${clause.slice(0, 320)}"`);
  }

  refuse(clause: string, why: string, suggest?: string[]): void {
    this.unread.push({ text: clause, why, suggest: suggest ?? nearestOps(clause) });
  }
}

/* ------------------------------------------------------------------ *
 * Target resolution
 * ------------------------------------------------------------------ */

const PRONOUN = /^(?:it|them|this|that|these|those|the selection|selected|selection|the layer|the layers)$/;

/** Layers matching a name fragment, case-insensitively, on the active page. */
function layersNamed(ctx: Ctx, fragment: string): Layer[] {
  const f = fragment.trim().toLowerCase().replace(/^(?:the|a|an|my)\s+/, "").replace(/\s+layer$/, "");
  if (!f) return [];
  const exact = ctx.page.layers.filter((l) => l.name.toLowerCase() === f);
  if (exact.length) return exact;
  const contains = ctx.page.layers.filter((l) => l.name.toLowerCase().includes(f));
  if (contains.length) return contains;
  // Fall back on the kind, so "move the image" works on a page with one picture.
  const kindWord: Record<string, Layer["kind"]> = {
    image: "image-frame", picture: "image-frame", photo: "image-frame",
    text: "type-frame", type: "type-frame", copy: "type-frame",
    shape: "vector", rule: "vector", line: "vector", group: "group",
  };
  const kind = kindWord[f];
  return kind ? ctx.page.layers.filter((l) => l.kind === kind) : [];
}

/** The layers a "it / them / the selection" clause acts on. Null means: it said so. */
function targetLayers(ctx: Ctx, r: Reply, clause: string): Layer[] | null {
  if (ctx.selection.length) return ctx.selection;
  r.refuse(
    clause,
    "nothing is selected, so there is no “it” to act on — select a layer on the canvas, or name it (“select the Title”)",
    ["press.select", "press.select_in_region"],
  );
  return null;
}

function vagueWord(clause: string): string | null {
  for (const w of VAGUE) if (new RegExp(`\\b${w}\\b`, "i").test(clause)) return w;
  return null;
}

function names(layers: Layer[]): string {
  return layers.map((l) => l.name).join(", ");
}

/* ================================================================== *
 * VERB 1 — generate a composed design
 * ================================================================== */

const DESIGN_VERB = /\b(?:make|build|design|generate|compose|create|lay ?out|start|set up|i need|i want|give me|do me)\b/;

function tryGenerate(clause: string, c: string, ctx: Ctx, r: Reply): boolean {
  const match = matchTemplate(c);
  const wantsDesign = DESIGN_VERB.test(c);
  if (!match) {
    // "make me a brochure" — a design request for something not in the library.
    if (wantsDesign && /\b(?:brochure|menu|cv|r[eé]sum[eé]|invitation|certificate|ticket|banner|billboard|zine|book cover|album|packaging|label design|infographic|newsletter|programme|program)\b/.test(c)) {
      const wanted = /\b(brochure|menu|cv|r[eé]sum[eé]|invitation|certificate|ticket|banner|billboard|zine|book cover|album|packaging|label design|infographic|newsletter|programme|program)\b/.exec(c)![1]!;
      r.refuse(
        clause,
        `there is no composed “${wanted}” in this library. I will not improvise one — a design assembled from guesses is worse than none. The ten I can lay down are: ` +
          templateList().map((t) => t.name).join("; "),
        ["press.add_type_frame", "press.add_rect", "press.add_guide"],
      );
      return true;
    }
    return false;
  }
  if (!wantsDesign && !/^\s*(?:a|an|the)?\s*[\w\s-]*\b(poster|flyer|card|letterhead|editorial|magazine|quote|story|landing|hero|app screen)\b/.test(c)) {
    return false;
  }

  const headline = quoted(clause);
  const colour = findColour(c);
  const pageWord = /\bpage\s+(\d+)\b/.exec(c);
  const composed: ComposedDesign | null = opsFromTemplate(ctx.doc, match.id, {
    headline,
    accent: colour ? colour.hex : null,
    pageIndex: pageWord ? Number(pageWord[1]) - 1 : 0,
    reason: clause,
  });
  if (!composed) {
    r.refuse(clause, `“${match.name}” could not be built`, ["press.add_type_frame"]);
    return true;
  }

  for (const op of composed.ops) r.ops.push(op);
  r.zones = composed.zones;
  r.notes.push(...composed.notes);
  r.design = { title: match.name, blurb: match.blurb, layers: composed.layerCount };
  r.say.push(
    `${match.name}, composed onto “${ctx.page.name}”: ${composed.layerCount} editable layers — ${match.blurb}`,
  );
  r.say.push(
    `Everything is registered on your own grid: live area ${Math.round(ctx.grid.w)}×${Math.round(ctx.grid.h)} px at ` +
      `${Math.round(ctx.grid.x)},${Math.round(ctx.grid.y)}, ${ctx.grid.columns} column(s) of ${Math.round(ctx.grid.columnWidth)} px. ` +
      `Column guides come with it, so the grid is document state you can see.`,
  );
  if (headline) r.say.push(`Display copy set to “${headline}”.`);
  if (colour) r.say.push(`Accent re-inked ${colour.word} ${colour.hex}.`);
  if (!headline) r.notes.push("No copy given, so the template's own words are in place — quote a headline (“…”) and I will set it instead.");
  if (composed.zones.length) {
    r.say.push(
      `After Apply I can group it into ${composed.zones.length} named zones (${composed.zones.map((z) => z.name).join(", ")}). ` +
        `That has to be a second step: no op can name a layer that a later op in the same batch is still going to create.`,
    );
  }
  return true;
}

/* ================================================================== *
 * VERB 3 — clean: snap what is on the page to the grid
 * ================================================================== */

function tryClean(clause: string, c: string, ctx: Ctx, r: Reply): boolean {
  const asked =
    /\b(clean|tidy)\b/.test(c) ||
    /\b(snap|align)\b[^.]*\b(grid|column|columns|margin|margins|baseline)\b/.test(c) ||
    /\bfix (?:the )?(spacing|alignment|layout|grid)\b/.test(c) ||
    /\bon the grid\b/.test(c);
  if (!asked) return false;

  const pool = ctx.selection.length ? ctx.selection : ctx.page.layers.filter((l) => !l.parentId);
  if (!pool.length) {
    r.refuse(clause, `“${ctx.page.name}” has nothing on it to clean up`, ["press.add_type_frame", "press.add_rect"]);
    return true;
  }
  const g = ctx.grid;
  const tolX = g.columnWidth * 0.5;
  const tolY = ctx.baseline * 0.5;
  const moves: string[] = [];
  let touched = 0;
  let bled = 0;

  for (const l of pool) {
    // Anything running past the trim is deliberate. Snapping a bleed to a
    // margin is the single most destructive thing a "clean up" can do.
    if (l.transform.x < 0 || l.transform.x + l.transform.w > ctx.page.widthPx + 1) {
      bled += 1;
      continue;
    }
    if (l.kind === "group") continue;
    const params: Record<string, unknown> = { layerId: l.id };
    const parts: string[] = [];
    const sx = snapX(g, l.transform.x, tolX);
    if (sx) {
      params.x = sx.x;
      parts.push(`x ${sx.moved > 0 ? "+" : ""}${num(round(sx.moved))}`);
    }
    const sy = snapBaseline(g, l.transform.y, ctx.baseline, tolY);
    if (sy) {
      params.y = sy.y;
      parts.push(`y ${sy.moved > 0 ? "+" : ""}${num(round(sy.moved))}`);
    }
    if (l.kind === "type-frame" || (l.kind === "vector" && l.closed)) {
      const sw = snapSpan(g, l.transform.w, g.columnWidth * 0.34);
      if (sw) {
        params.w = sw.w;
        parts.push(`w ${sw.moved > 0 ? "+" : ""}${num(round(sw.moved))}`);
      }
    }
    if (parts.length) {
      touched += 1;
      moves.push(`${l.name} ${parts.join(" ")}`);
      r.push(
        "press.set_transform",
        params,
        `clean up: snap “${l.name}” to the column grid and the ${ctx.baseline} px baseline (${parts.join(", ")} px)`,
      );
    }
  }

  if (!touched) {
    r.say.push(
      `Nothing to do — all ${pool.length} layer(s) are already inside half a column of a column edge and half a baseline of the ladder. ` +
        `I will not move things that are already right.`,
    );
    if (bled) r.notes.push(`${bled} full-bleed layer(s) left alone: running past the trim is deliberate.`);
    return true;
  }
  r.say.push(
    `Clean up “${ctx.page.name}”: ${touched} of ${pool.length} layer(s) snapped to the ${g.columns}-column grid ` +
      `(${Math.round(g.columnWidth)} px columns, ${Math.round(g.gutter)} px gutters) and the ${ctx.baseline} px baseline.`,
  );
  r.say.push(moves.slice(0, 8).join(" · ") + (moves.length > 8 ? ` · +${moves.length - 8} more` : ""));
  r.notes.push(`Snap tolerance is half a column (${Math.round(tolX)} px) and half a baseline (${Math.round(tolY)} px) — anything further off was left alone rather than dragged somewhere it was never meant to be.`);
  if (bled) r.notes.push(`${bled} full-bleed layer(s) left alone: running past the trim is deliberate.`);
  return true;
}

/* ================================================================== *
 * VERB 4 — move a named asset to a grid position
 * ================================================================== */

function tryMove(clause: string, c: string, ctx: Ctx, r: Reply): boolean {
  const m = /^(?:move|put|push|place|send|drop)\s+(?:the\s+|my\s+)?(.+?)\s+(?:to|into|in|onto|over to|across to)\s+(?:the\s+)?(.+)$/.exec(c);
  if (!m) return false;
  const targetWord = m[1]!.trim();
  const dest = m[2]!.trim();
  if (/^\d/.test(dest) || /^\(/.test(dest)) return false; // "move it to 100,200" — the coordinate path

  const targets = PRONOUN.test(targetWord) ? targetLayers(ctx, r, clause) : layersNamed(ctx, targetWord);
  if (targets === null) return true;
  if (!targets.length) {
    r.refuse(
      clause,
      `no layer named “${targetWord}” on “${ctx.page.name}”. Layers here: ${ctx.page.layers.map((l) => l.name).join(", ") || "none"}`,
      ["press.select", "press.set_transform"],
    );
    return true;
  }

  let any = false;
  for (const l of targets) {
    const place = gridPlacement(dest, ctx.grid, ctx.page, l.transform.w, l.transform.h);
    if (!place) continue;
    const params: Record<string, unknown> = { layerId: l.id, x: place.x };
    // "column 3" is an x destination; it must not silently reset y.
    if (!/\bcolumn\b/.test(dest)) params.y = place.y;
    if (/\bcolumn\b/.test(dest) && (l.kind === "type-frame" || l.kind === "image-frame")) {
      params.w = round(ctx.grid.columnWidth);
    }
    r.push("press.set_transform", params, `move “${l.name}” to the ${place.label} — a grid position, not an eyeballed one`);
    r.say.push(`Move ${l.name} to the ${place.label} (${num(place.x)}${params.y !== undefined ? `,${num(place.y)}` : ""}).`);
    any = true;
  }
  if (!any) {
    r.refuse(
      clause,
      `“${dest}” is not a place on the grid. I understand: top left / top right / bottom left / bottom right / centre / top / bottom / left / right / column N (1–${ctx.grid.columns}), or explicit coordinates.`,
      ["press.set_transform"],
    );
  }
  return true;
}

/* ================================================================== *
 * VERB 5 — source an asset from the local library
 * ================================================================== */

const FIELD_WORDS: { id: StockFieldId; test: RegExp; why: string }[] = [
  { id: "grain", test: /\bgrain(y)?|noise|noisy|film|rough|tooth\b/, why: "grain reads as paper tooth and hides banding on a flat ink" },
  { id: "halftone-grid", test: /\bhalftone|dots?|screen|newsprint|print(ed)? texture\b/, why: "a halftone grid is the print-native texture — it is what ink on stock actually looks like" },
  { id: "radial-bloom", test: /\bglow|bloom|radial|spotlight|vignette\b/, why: "a radial bloom puts light behind the display type without adding a second ink" },
  { id: "duotone-diagonal", test: /\bdiagonal|angled|dynamic|sweep\b/, why: "the diagonal duotone carries the eye across the sheet" },
  { id: "duotone-vertical", test: /\bduotone|gradient|fade|two[- ]ink|backdrop|background|ground|field\b/, why: "a vertical duotone is the quietest ground: one ink darkening into another, nothing competing with the type" },
];

function tryAsset(clause: string, c: string, ctx: Ctx, r: Reply): boolean {
  const g = ctx.grid;
  const bleed = ctx.page.bleedPx;
  const colour = findColour(c);

  /* ---- the operator's own imported assets ---- */
  if (/\b(?:my|our)\s+(?:own\s+)?(logo|mark|image|picture|photo|asset|file|artwork)\b/.test(c) || /\bfrom (?:my|the) library\b/.test(c)) {
    if (!ctx.userAssets.length) {
      r.refuse(
        clause,
        "your asset library is empty — nothing has been imported yet. Import a picture first (File ▸ Place, or the Library panel), then ask for it by name.",
        ["press.place_image"],
      );
      return true;
    }
    const wordMatch = /\b(?:my|our)\s+(?:own\s+)?([\w-]+)/.exec(c);
    const want = wordMatch ? wordMatch[1]!.toLowerCase() : "";
    const asset =
      ctx.userAssets.find((a) => a.name.toLowerCase().includes(want)) ?? ctx.userAssets[0]!;
    const w = round(Math.min(g.columnWidth, g.w));
    const h = round((w * asset.height) / Math.max(1, asset.width));
    const place = gridPlacement(c, g, ctx.page, w, h) ?? { x: Math.round(g.x), y: Math.round(g.y), label: "top left of the live area" };
    r.pushQ(
      "press.place_image",
      { x: place.x, y: place.y, w, h, dataUrl: asset.dataUrl, width: asset.width, height: asset.height, name: asset.name, fit: "contain" },
      clause,
    );
    r.say.push(`Place “${asset.name}” (${asset.width}×${asset.height} px, from your library) one column wide at the ${place.label}.`);
    r.notes.push(`Chosen from ${ctx.userAssets.length} imported asset(s) by name match on “${want}”. Fit is “contain”, so a logo is never cropped.`);
    return true;
  }

  /* ---- a mark ---- */
  const markWord = /\b(register(?:ration)? mark|register|disc|circle mark|diamond|plus|cross|chevron|triangle|star|arrow|bullet|dot)\b/.exec(c);
  if (markWord && /\b(?:add|put|place|draw|insert|use|need|want|give)\b/.test(c)) {
    const map: Record<string, MarkId> = {
      "register mark": "register", "registration mark": "register", register: "register",
      disc: "disc", "circle mark": "disc", dot: "disc", bullet: "disc",
      diamond: "diamond", plus: "plus", cross: "plus", chevron: "chevron",
      triangle: "triangle", star: "star", arrow: "arrow",
    };
    const id = map[markWord[1]!.toLowerCase()] ?? "disc";
    const spec = MARKS.find((mk) => mk.id === id)!;
    const explicit = findSize(c, ctx.doc.ppi);
    const size = explicit ? explicit.w : round(g.columnWidth * 0.45);
    const place = gridPlacement(c, g, ctx.page, size, size) ?? {
      x: Math.round(g.x + g.w - size),
      y: Math.round(g.y),
      label: "top right of the live area",
    };
    const ink = colour ? colour.hex : rgbaToHex(COPPER);
    const nodes = markNodes(id, size, size).map((nd) => ({ x: round(nd.x), y: round(nd.y), inX: round(nd.inX), inY: round(nd.inY), outX: round(nd.outX), outY: round(nd.outY) }));
    const params: Record<string, unknown> = {
      x: place.x, y: place.y, w: size, h: size, nodes, closed: spec.closed, name: spec.name,
    };
    if (spec.fill) params.fill = ink;
    if (!spec.fill || spec.stroke) params.stroke = { color: ink, width: Math.max(1, round(size * 0.06)) };
    r.pushQ("press.add_path", params, clause);
    r.say.push(`Add the ${spec.name} mark, ${num(size)} px (0.45 of a column), at the ${place.label}, in ${colour ? colour.word : "copper"}.`);
    r.notes.push(`From the press mark set in the local library — an editable ${nodes.length}-node path, not a glyph and not an icon font.`);
    return true;
  }

  /* ---- a generated two-ink field ---- */
  const wantsField =
    /\b(?:backdrop|background|ground|texture|field|duotone|halftone|grain|grainy|gradient|bloom|glow|paper stock|stock)\b/.test(c) &&
    /\b(?:add|put|place|need|want|give|use|make|set|source|find)\b/.test(c);
  if (wantsField) {
    const paper = PAPERS.find((p) => new RegExp(`\\b${p.id}\\b|\\b${p.name.toLowerCase()}\\b`).test(c));
    const fieldRow = FIELD_WORDS.find((f) => f.test.test(c));
    const w = Math.round(ctx.page.widthPx + bleed * 2);
    const h = Math.round(ctx.page.heightPx + bleed * 2);

    if (paper && !fieldRow) {
      const png = paperPng(paper.id, 256);
      r.pushQ(
        "press.place_image",
        { x: -bleed, y: -bleed, w, h, dataUrl: png.dataUrl, width: png.width, height: png.height, name: `${paper.name} — stock`, fit: "stretch" },
        clause,
      );
      r.say.push(`Lay “${paper.name}” stock across the full bleed (${w}×${h} px).`);
      r.notes.push(`${paper.name} is a 256 px generated tile upsampled to the sheet — it reads as stock, not as photography. Replace it with a scan when you have one.`);
      return true;
    }

    const field = fieldRow ?? FIELD_WORDS[FIELD_WORDS.length - 1]!;
    const a = colour ? hex(colour.hex) : COPPER;
    const b = /\blight|pale|chalk|white|paper\b/.test(c) ? CHALK : NIGHT;
    const asset = placeholderAsset(`Backdrop — ${field.id}`, w, h, field.id, a, b);
    r.pushQ(
      "press.place_image",
      { x: -bleed, y: -bleed, w, h, dataUrl: asset.dataUrl, width: asset.width, height: asset.height, name: asset.name, fit: "cover" },
      clause,
    );
    r.say.push(
      `Backdrop: the “${field.id}” field from ${colour ? colour.word : "copper"} into ${b === CHALK ? "chalk" : "night"}, run to the ${bleed} px bleed.`,
    );
    r.notes.push(`Chosen because ${field.why}. It is generated locally at ${asset.width}×${asset.height} px — there is no network here and no stock photo service.`);
    return true;
  }

  return false;
}

/* ================================================================== *
 * VERB 2 — build against the grid
 * ================================================================== */

/** Size multiples relative to the document's own 12 pt body default. Stated, never silent. */
const TYPE_ROLE: Record<string, { scale: number; label: string; span: number; align?: string }> = {
  masthead: { scale: 4.5, label: "masthead", span: 1 },
  headline: { scale: 3.5, label: "headline", span: 1 },
  heading: { scale: 3.5, label: "heading", span: 1 },
  title: { scale: 3.5, label: "title", span: 1 },
  display: { scale: 4.5, label: "display", span: 1 },
  subhead: { scale: 1.8, label: "subhead", span: 0.75 },
  subtitle: { scale: 1.8, label: "subtitle", span: 0.75 },
  deck: { scale: 1.8, label: "deck", span: 0.75 },
  standfirst: { scale: 1.8, label: "standfirst", span: 0.75 },
  kicker: { scale: 0.9, label: "kicker", span: 0.75 },
  caption: { scale: 0.8, label: "caption", span: 0.5 },
  footnote: { scale: 0.7, label: "footnote", span: 0.5 },
  folio: { scale: 0.75, label: "folio", span: 0.25 },
};

function createType(clause: string, c: string, word: string, ctx: Ctx, r: Reply): void {
  const ppi = ctx.doc.ppi;
  const g = ctx.grid;
  const role = TYPE_ROLE[word] ?? { scale: 1, label: "type frame", span: 1 };

  const says = /\b(?:that says|saying|reading|which says|with the (?:text|words|copy)|that reads|says)\s+(.+)$/.exec(c);
  const text = (quoted(clause) ?? (says ? says[1]!.trim() : null) ?? "").replace(/^["'“”]|["'“”.]$/g, "").trim();
  if (!text) {
    r.refuse(
      clause,
      `I need the words. Say what the ${role.label} reads — add a heading saying “Margin of Error” — I will not invent copy for you.`,
      ["press.add_type_frame", "press.set_story_text"],
    );
    return;
  }

  const explicitSize = new RegExp(`\\b(?:at|size|set in)\\s*(${NUM})\\s*(pt|px|mm)\\b`, "i").exec(c);
  const size = explicitSize ? round(toPx(Number(explicitSize[1]), explicitSize[2], ppi)) : round(ctx.bodyPx * role.scale);
  const leading = round(role.scale >= 3 ? size * 0.92 : autoLeading(size));

  const given = findSize(c, ppi);
  const colWord = /\b(?:across|spanning|over)\s+(\d+)\s+columns?\b/.exec(c) ?? /\b(\d+)[- ]column\b/.exec(c);
  const spanCols = colWord ? Math.min(g.columns, Math.max(1, Number(colWord[1]))) : null;
  const w = given
    ? given.w
    : spanCols
      ? round(g.colSpan(0, spanCols))
      : round(Math.min(g.w, g.w * role.span));
  const lines = Math.max(text.split("\n").length, estimateLines(text, size, w));
  const h = given ? given.h : frameHeightFor(lines, size, leading);

  const rawPoint = findPoint(c, ppi);
  const point: Placement | null = rawPoint ? { ...rawPoint, label: "the coordinates you gave" } : null;
  const place = point ?? gridPlacement(c, g, ctx.page, w, h) ?? { x: Math.round(g.x), y: Math.round(g.y), label: "live-area origin" };

  const colour = findColour(c);
  const alignWord = /\b(centred|centered|right[- ]aligned|justified|justify|flush right)\b/.exec(c);

  const params: Record<string, unknown> = { x: place.x, y: place.y, w, h, text, size, leading };
  if (colour) params.fill = colour.hex;
  if (role.scale >= 3) params.tracking = -15;
  if (role.label === "kicker") params.tracking = 90;
  if (alignWord) {
    const a = alignWord[1]!;
    params.align = /just/.test(a) ? "justify" : /right/.test(a) ? "right" : "center";
  }
  params.name = text.length > 40 ? `${text.slice(0, 39)}…` : text;

  r.pushQ("press.add_type_frame", params, clause);
  if (!explicitSize) {
    r.notes.push(
      `“${role.label}” is a role, not a size: ${role.scale}× the document's ${Math.round(ctx.bodyPx)} px body default = ${num(size)} px, ` +
        `leading ${num(leading)} px${role.scale >= 3 ? " (set solid — display type wants leading tighter than the size)" : " (Auto, 120 %)"}.`,
    );
  }
  if (!given) {
    r.notes.push(
      `Measure ${num(w)} px${spanCols ? ` (${spanCols} of ${g.columns} columns)` : role.span < 1 ? ` (${Math.round(role.span * 100)} % of the live width — a ${role.label} wants a shorter line than the display)` : " (full live width)"}, ` +
        `frame ${num(h)} px for ${lines} estimated line(s). HarfBuzz breaks the real lines at draw time.`,
    );
  }
  if (!point) r.notes.push(`No position given — set at the ${place.label}, ${num(place.x)},${num(place.y)}.`);
  if (role.scale >= 3) params.tracking = -15;
  r.say.push(`Add a ${num(size)} px ${role.label} reading “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”${colour ? ` in ${colour.word}` : ""} on the grid.`);
}

/** "three body columns of X" — a real multi-column text block on the page grid. */
function tryColumns(clause: string, c: string, ctx: Ctx, r: Reply): boolean {
  const m = /\b(?:(\d+|two|three|four|five)[- ]column|(\d+|two|three|four|five)\s+columns?)\b/.exec(c);
  if (!m || !/\b(?:body|text|copy|columns? of)\b/.test(c) || !/\b(?:add|put|set|build|create|make|lay)\b/.test(c)) return false;
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  const raw = (m[1] ?? m[2])!;
  const n = words[raw] ?? Number(raw);
  const g = ctx.grid;
  if (!Number.isFinite(n) || n < 1 || n > g.columns) {
    r.refuse(clause, `this page's grid has ${g.columns} column(s); ${raw} does not fit it. Change the grid in the page setup, or ask for ${g.columns} or fewer.`, ["press.add_type_frame"]);
    return true;
  }
  const text = quoted(clause);
  if (!text) {
    r.refuse(clause, "I need the copy to flow. Quote it: add three body columns of “…”. I will not fill columns with lorem ipsum.", ["press.add_type_frame", "press.set_story_text"]);
    return true;
  }
  const size = round(ctx.bodyPx);
  const leading = round(autoLeading(size));
  const width = round(g.colSpan(0, 1));
  const point = findPoint(c, ctx.doc.ppi);
  const top = point ? point.y : Math.round(g.y + g.h / 2);
  const paras = text.split(/\n{2,}/);
  const perColumn = Math.max(1, Math.ceil(paras.length / n));
  const height = frameHeightFor(Math.max(6, Math.ceil(estimateLines(text, size, width) / n)), size, leading);
  for (let i = 0; i < n; i += 1) {
    const slice = paras.slice(i * perColumn, (i + 1) * perColumn).join("\n\n") || paras[i % paras.length]!;
    r.push(
      "press.add_type_frame",
      {
        x: Math.round(g.colX(i)),
        y: top,
        w: width,
        h: height,
        text: slice,
        size,
        leading,
        align: "justify",
        fill: rgbaToHex(INK_RGBA),
        name: `Column ${i + 1} — body`,
      },
      `body column ${i + 1} of ${n}, one grid column wide at ${Math.round(width)} px on a ${leading} px leading so the columns register across the gutter`,
    );
  }
  r.say.push(`Set the copy as ${n} columns of ${Math.round(width)} px on a ${leading} px leading, justified, starting at y ${top}.`);
  r.notes.push(`Columns sit exactly on the page grid (${Math.round(g.gutter)} px gutters), so the two columns register line for line. Copy split by paragraph, ${perColumn} per column.`);
  return true;
}

/* ------------------------------------------------------------------ *
 * Shapes and rules (still needed — a designer does draw boxes)
 * ------------------------------------------------------------------ */

function strokeFrom(c: string, ppi: number): { color: string; width: number } | null {
  const m = new RegExp(`(${NUM})\\s*(${UNIT})\\s*(?:thick|weight|stroke|outline|border)|(?:stroke|outline|border)\\s*(?:of\\s*)?(${NUM})\\s*(${UNIT})`, "i").exec(c);
  const outlined = /\b(?:outlined?|stroked?|border|hairline)\b/.test(c);
  if (!m && !outlined) return null;
  const width = m ? round(toPx(Number(m[1] ?? m[3]), m[2] || m[4], ppi)) : 2;
  const colour = findColour(c);
  return { color: colour ? colour.hex : "#1A1A1A", width: width > 0 ? width : 1 };
}

function createBox(clause: string, c: string, shape: "rect" | "ellipse", ctx: Ctx, r: Reply): void {
  const ppi = ctx.doc.ppi;
  const g = ctx.grid;
  const equal = /\b(square|circle|dot|disc)\b/.test(c);
  let size = findSize(c, ppi);
  let sizeNote = "";
  if (!size) {
    const single = new RegExp(`\\b(${NUM})\\s*(${UNIT})\\s*(?:wide|across|square|circle|tall)\\b`, "i").exec(c);
    if (single) {
      const v = round(toPx(Number(single[1]), single[2], ppi));
      size = { w: v, h: v };
    }
  }
  const colSpan = /\b(?:across|spanning|over)?\s*(\d+)\s*columns?\b/.exec(c);
  if (!size && colSpan) {
    const n = Math.min(g.columns, Math.max(1, Number(colSpan[1])));
    const w = round(g.colSpan(0, n));
    size = { w, h: equal ? w : round(w * 0.62) };
    sizeNote = `${n} of ${g.columns} columns wide (${num(w)} px)${equal ? "" : ", 1:0.62"}`;
  }
  if (!size) {
    const w = round(g.colSpan(0, Math.max(1, Math.round(g.columns / 2))));
    size = { w, h: equal ? w : round(w * 0.62) };
    sizeNote = `no size given — half the grid (${num(w)} px)${equal ? "" : " on a 1:0.62 box"}`;
  }
  if (equal && size.w !== size.h) size = { w: size.w, h: size.w };

  const colour = findColour(c);
  const stroke = strokeFrom(c, ppi);
  if (!colour && !stroke) {
    r.refuse(
      clause,
      `a ${shape === "rect" ? "rectangle" : "an ellipse"} with neither a fill nor a stroke paints nothing. Give a colour (“a copper panel”) or an outline (“a 3px outlined box”).`,
      [shape === "rect" ? "press.add_rect" : "press.add_ellipse"],
    );
    return;
  }

  const rawPoint = findPoint(c, ppi);
  const point: Placement | null = rawPoint ? { ...rawPoint, label: "the coordinates you gave" } : null;
  const place = point ?? gridPlacement(c, g, ctx.page, size.w, size.h) ?? {
    x: Math.round(g.x),
    y: Math.round(g.y),
    label: "live-area origin",
  };

  const params: Record<string, unknown> = { x: place.x, y: place.y, w: size.w, h: size.h };
  if (colour) params.fill = colour.hex;
  if (stroke) params.stroke = stroke;
  const label = quoted(clause);
  params.name = label ?? (shape === "rect" ? "Panel" : equal ? "Disc" : "Ellipse");

  r.pushQ(shape === "rect" ? "press.add_rect" : "press.add_ellipse", params, clause);
  if (sizeNote) r.notes.push(`Size: ${sizeNote}. Everything is sized from the grid, never eyeballed.`);
  if (!point) r.notes.push(`No position given — placed at the ${place.label}, ${num(place.x)},${num(place.y)}.`);
  r.say.push(
    `Add a ${num(size.w)}×${num(size.h)} px ${equal && shape === "ellipse" ? "disc" : shape === "rect" ? "panel" : "ellipse"}` +
      `${colour ? ` in ${colour.word} ${colour.hex}` : ""}${stroke ? ` with a ${num(stroke.width)} px stroke` : ""} at ${num(place.x)},${num(place.y)}.`,
  );
}

function createLine(clause: string, c: string, ctx: Ctx, r: Reply): void {
  const ppi = ctx.doc.ppi;
  const g = ctx.grid;
  const from = new RegExp(`\\bfrom\\s*\\(?\\s*(${NUM})\\s*(${UNIT})\\s*,\\s*(${NUM})\\s*(${UNIT})\\s*\\)?\\s*(?:to|-|→|->)\\s*\\(?\\s*(${NUM})\\s*(${UNIT})\\s*,\\s*(${NUM})\\s*(${UNIT})`, "i").exec(c);
  const colour = findColour(c);
  const weight = new RegExp(`(${NUM})\\s*(${UNIT})\\s*(?:thick|weight|stroke|rule)`, "i").exec(c);
  const width = weight ? round(toPx(Number(weight[1]), weight[2], ppi)) : Math.max(2, Math.round(ctx.bodyPx * 0.12));
  const stroke = { color: colour ? colour.hex : "#1A1A1A", width: width > 0 ? width : 1 };

  let pts: { x1: number; y1: number; x2: number; y2: number };
  const notes: string[] = [];

  // "a rule under the masthead" — a real relationship to a real layer.
  const under = /\b(?:under|below|beneath|above|over)\s+(?:the\s+)?(.+?)(?:\s*$|,)/.exec(c);
  const relatives = under ? layersNamed(ctx, under[1]!) : [];
  if (under && relatives.length) {
    const l = relatives[0]!;
    const above = /\b(?:above|over)\b/.test(c);
    const gap = Math.round(ctx.baseline * 0.5);
    const y = above ? Math.round(l.transform.y - gap) : Math.round(l.transform.y + l.transform.h + gap);
    pts = { x1: Math.round(l.transform.x), y1: y, x2: Math.round(l.transform.x + l.transform.w), y2: y };
    notes.push(`Set ${above ? "above" : "under"} “${l.name}”, to its own measure (${Math.round(l.transform.w)} px), half a baseline clear (${gap} px).`);
  } else if (under && !relatives.length) {
    r.refuse(clause, `no layer named “${under[1]!.trim()}” to hang a rule off. Layers here: ${ctx.page.layers.map((l) => l.name).join(", ") || "none"}`, ["press.add_line", "press.select"]);
    return;
  } else if (from) {
    pts = {
      x1: round(toPx(Number(from[1]), from[2], ppi)),
      y1: round(toPx(Number(from[3]), from[4], ppi)),
      x2: round(toPx(Number(from[5]), from[6], ppi)),
      y2: round(toPx(Number(from[7]), from[8], ppi)),
    };
  } else {
    const atY = new RegExp(`\\b(?:at\\s+)?y\\s*=?\\s*(${NUM})\\s*(${UNIT})`, "i").exec(c);
    const atX = new RegExp(`\\b(?:at\\s+)?x\\s*=?\\s*(${NUM})\\s*(${UNIT})`, "i").exec(c);
    if (/\bvertical\b/.test(c)) {
      const x = atX ? round(toPx(Number(atX[1]), atX[2], ppi)) : Math.round(g.x + g.w / 2);
      pts = { x1: x, y1: Math.round(g.y), x2: x, y2: Math.round(g.y + g.h) };
      notes.push(`Vertical rule down the full live height at x ${num(x)}.`);
    } else {
      const y = atY ? round(toPx(Number(atY[1]), atY[2], ppi)) : Math.round(g.y + g.h / 2);
      pts = { x1: Math.round(g.x), y1: y, x2: Math.round(g.x + g.w), y2: y };
      notes.push(`Horizontal rule across the full ${Math.round(g.w)} px measure at y ${num(y)} — a rule that stops short of the margin reads as a mistake.`);
    }
  }
  if (pts.x1 === pts.x2 && pts.y1 === pts.y2) {
    r.refuse(clause, "the two ends are the same point — a line needs two distinct points", ["press.add_line"]);
    return;
  }
  const params: Record<string, unknown> = { ...pts, stroke, name: quoted(clause) ?? "Rule" };
  r.pushQ("press.add_line", params, clause);
  r.notes.push(...notes);
  if (!weight) r.notes.push(`No weight given — ${stroke.width} px, scaled from the ${Math.round(ctx.bodyPx)} px body size so the rule holds its own against the type.`);
  r.say.push(`Add a ${num(stroke.width)} px ${colour ? `${colour.word} ` : ""}rule from ${num(pts.x1)},${num(pts.y1)} to ${num(pts.x2)},${num(pts.y2)}.`);
}

/* ================================================================== *
 * The clause router
 * ================================================================== */

function handleClause(raw: string, ctx: Ctx, r: Reply): void {
  const clause = raw.trim();
  if (!clause) return;
  const c = clause.toLowerCase();
  const ppi = ctx.doc.ppi;

  /* ---- questions Anchor can answer from the document itself ---- */

  if (/^(?:what|which|how many|how much|list|show me|tell me)\b/.test(c) || /\bwhat can you do\b/.test(c) || /^help\b/.test(c) || /^\?+$/.test(c)) {
    if (/\bselect/.test(c)) {
      r.say.push(
        ctx.selection.length
          ? `Selected: ${ctx.selection.map((l) => `${l.name} (${l.kind}, ${Math.round(l.transform.w)}×${Math.round(l.transform.h)} at ${Math.round(l.transform.x)},${Math.round(l.transform.y)})`).join("; ")}.`
          : "Nothing is selected on this page.",
      );
      return;
    }
    if (/\blayer/.test(c)) {
      r.say.push(
        ctx.page.layers.length
          ? `${ctx.page.layers.length} layers on “${ctx.page.name}”: ${ctx.page.layers.map((l) => l.name).join(", ")}.`
          : `“${ctx.page.name}” has no layers yet.`,
      );
      return;
    }
    if (/\btemplate|design|compose|build\b/.test(c)) {
      r.say.push(`Designs I can compose: ${templateList().map((t) => t.name).join("; ")}.`);
      return;
    }
    if (/\bgrid|column|margin|page|document|size|big\b/.test(c)) {
      r.say.push(
        `Page “${ctx.page.name}” is ${Math.round(ctx.page.widthPx)}×${Math.round(ctx.page.heightPx)} px at ${ctx.doc.ppi} ppi, ${ctx.page.bleedPx} px bleed. ` +
          `Live area ${Math.round(ctx.grid.w)}×${Math.round(ctx.grid.h)} at ${Math.round(ctx.grid.x)},${Math.round(ctx.grid.y)}; ` +
          `${ctx.grid.columns} column(s) of ${Math.round(ctx.grid.columnWidth)} px with ${Math.round(ctx.grid.gutter)} px gutters; ${ctx.baseline} px baseline.`,
      );
      return;
    }
    if (/\bcan you do|help\b/.test(c)) {
      r.say.push(HELP_TEXT);
      return;
    }
  }

  /* ---- the five design verbs, in order of ambition ---- */

  if (tryGenerate(clause, c, ctx, r)) return;
  if (tryClean(clause, c, ctx, r)) return;
  if (tryColumns(clause, c, ctx, r)) return;
  if (tryAsset(clause, c, ctx, r)) return;
  if (tryMove(clause, c, ctx, r)) return;

  /* ---- vague aesthetic words: refuse by name, never approximate ---- */

  const vague = vagueWord(c);
  if (vague) {
    r.refuse(
      clause,
      `“${vague}” is not a property of this document, so I have nothing to change. Name a concrete move — a colour, a size in px/mm/pt, a grid position, an opacity — or ask me to clean the page up, which is arithmetic I can actually do.`,
      ["press.apply_fill", "press.set_transform", "press.set_character"],
    );
    return;
  }

  /* ---- selection ---- */

  if (/^(?:deselect|select nothing|clear the selection)\b/.test(c)) {
    r.pushQ("press.select", { layerIds: [] }, clause);
    r.say.push("Deselect everything.");
    return;
  }
  if (/^select (?:all|everything)\b/.test(c)) {
    const ids = ctx.page.layers.filter((l) => !l.parentId).map((l) => l.id);
    if (!ids.length) {
      r.refuse(clause, `“${ctx.page.name}” has no layers to select`, ["press.add_rect", "press.add_type_frame"]);
      return;
    }
    r.pushQ("press.select", { layerIds: ids }, clause);
    r.say.push(`Select all ${ids.length} top-level layer(s).`);
    return;
  }
  const sel = /^(?:select|choose|pick)\s+(?:the\s+)?(.+?)(?:\s+layers?)?$/.exec(c);
  if (sel) {
    const found = layersNamed(ctx, sel[1]!);
    if (!found.length) {
      r.refuse(
        clause,
        `no layer on “${ctx.page.name}” is named “${sel[1]!.trim()}”. Layers here: ${ctx.page.layers.map((l) => l.name).join(", ") || "none"}`,
        ["press.select", "press.select_in_region"],
      );
      return;
    }
    r.pushQ("press.select", { layerIds: found.map((l) => l.id) }, clause);
    r.say.push(`Select ${names(found)}.`);
    return;
  }

  /* ---- rename ---- */

  const ren = /^(?:rename|call)\s+(it|them|this|that|the selection|the layer)\s+(?:to\s+)?(.+)$/.exec(c);
  if (ren) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const label = (quoted(clause) ?? ren[2]!).trim().replace(/^["'“”]|["'“”]$/g, "");
    if (!label) {
      r.refuse(clause, "no new name in the sentence — try: rename it to “Masthead”", ["press.set_name"]);
      return;
    }
    for (const l of targets) r.pushQ("press.set_name", { layerId: l.id, name: label }, clause);
    r.say.push(`Rename ${names(targets)} to “${label}”.`);
    return;
  }
  const ren2 = /^rename\s+(?:the\s+)?(.+?)\s+to\s+(.+)$/.exec(c);
  if (ren2) {
    const found = layersNamed(ctx, ren2[1]!);
    if (!found.length) {
      r.refuse(clause, `no layer named “${ren2[1]!.trim()}” on this page`, ["press.set_name", "press.select"]);
      return;
    }
    const label = (quoted(clause) ?? ren2[2]!).trim().replace(/^["'“”]|["'“”]$/g, "");
    r.pushQ("press.set_name", { layerId: found[0]!.id, name: label }, clause);
    r.say.push(`Rename ${found[0]!.name} to “${label}”.`);
    return;
  }

  /* ---- lifecycle ---- */

  if (/^group\b/.test(c)) {
    const named = /^group\s+(?:the\s+)?(.+)$/.exec(c);
    let ids: string[] | undefined;
    let label: string;
    if (named && !PRONOUN.test(named[1]!.trim())) {
      const found = layersNamed(ctx, named[1]!);
      if (found.length < 2) {
        r.refuse(clause, `“${named[1]!.trim()}” matched ${found.length} layer(s); a group needs at least 2`, ["press.group", "press.select"]);
        return;
      }
      ids = found.map((l) => l.id);
      label = names(found);
    } else {
      const targets = targetLayers(ctx, r, clause);
      if (!targets) return;
      if (targets.length < 2) {
        r.refuse(clause, `only ${targets.length} layer is selected; a group needs at least 2`, ["press.group", "press.select"]);
        return;
      }
      label = names(targets);
    }
    r.pushQ("press.group", ids ? { layerIds: ids } : {}, clause);
    r.say.push(`Group ${label}.`);
    return;
  }
  if (/^ungroup\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    r.pushQ("press.ungroup", {}, clause);
    r.say.push(`Ungroup ${names(targets)}.`);
    return;
  }
  if (/^(?:duplicate|copy)\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    r.pushQ("press.duplicate", {}, clause);
    r.say.push(`Duplicate ${names(targets)}.`);
    return;
  }
  if (/^(?:delete|remove|get rid of)\b/.test(c)) {
    const named = /^(?:delete|remove|get rid of)\s+(?:the\s+)?(.+)$/.exec(c);
    if (named && !PRONOUN.test(named[1]!.trim())) {
      const found = layersNamed(ctx, named[1]!);
      if (!found.length) {
        r.refuse(clause, `no layer named “${named[1]!.trim()}” on this page`, ["press.delete", "press.select"]);
        return;
      }
      r.pushQ("press.delete", { layerIds: found.map((l) => l.id) }, clause);
      r.say.push(`Delete ${names(found)}.`);
      return;
    }
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    r.pushQ("press.delete", {}, clause);
    r.say.push(`Delete ${names(targets)}.`);
    return;
  }

  /* ---- pages and guides ---- */

  if (/^(?:add|create|insert|new)\s+(?:a\s+)?(?:new\s+)?page\b/.test(c) || /^new page\b/.test(c)) {
    r.pushQ("press.add_page", {}, clause);
    r.say.push("Append a page with this page's size, margins and columns.");
    return;
  }
  const goPage = /^(?:go to|switch to|open)\s+page\s+(\d+)\b/.exec(c);
  if (goPage) {
    const idx = Number(goPage[1]) - 1;
    const target = ctx.doc.pages[idx];
    if (!target) {
      r.refuse(clause, `this document has ${ctx.doc.pages.length} page(s); there is no page ${goPage[1]}`, ["press.set_active_page", "press.add_page"]);
      return;
    }
    r.pushQ("press.set_active_page", { pageId: target.id }, clause);
    r.say.push(`Make page ${goPage[1]} (“${target.name}”) active.`);
    return;
  }
  if (/\bcolumn guides?\b/.test(c) && /\b(?:add|show|draw|put|lay)\b/.test(c)) {
    for (let i = 0; i < ctx.grid.columns; i += 1) {
      r.push("press.add_guide", { axis: "v", offset: Math.round(ctx.grid.colX(i)) }, `column ${i + 1} left edge`);
      r.push("press.add_guide", { axis: "v", offset: Math.round(ctx.grid.colX(i) + ctx.grid.columnWidth) }, `column ${i + 1} right edge`);
    }
    r.say.push(`Lay the ${ctx.grid.columns}-column grid down as ${ctx.grid.columns * 2} guides, so the grid is document state you can see.`);
    return;
  }
  const guide = new RegExp(`(vertical|horizontal)?\\s*guide\\s*(?:at\\s*)?(?:(x|y)\\s*=?\\s*)?(${NUM})\\s*(${UNIT})`, "i").exec(c);
  if (guide && /\bguide\b/.test(c)) {
    const axis = guide[1] ? (guide[1] === "vertical" ? "v" : "h") : guide[2] === "x" ? "v" : guide[2] === "y" ? "h" : null;
    if (!axis) {
      r.refuse(clause, "say which way the guide runs — “a vertical guide at 200” or “a horizontal guide at y 400”", ["press.add_guide"]);
      return;
    }
    const offset = round(toPx(Number(guide[3]), guide[4], ppi));
    r.pushQ("press.add_guide", { axis, offset }, clause);
    r.say.push(`Add a ${axis === "v" ? "vertical" : "horizontal"} guide at ${num(offset)} px.`);
    return;
  }

  /* ---- text content ---- */

  const retext = /^(?:change|set|replace|edit)\s+(?:the\s+)?(?:text|copy|words|wording|story)\s+(?:of\s+.+?\s+)?to\s+(.+)$/.exec(c);
  if (retext) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const frame = targets.find((l) => l.kind === "type-frame");
    if (!frame) {
      r.refuse(clause, `the selection is ${targets.map((l) => l.kind).join(", ")}, not a type frame — only a type frame carries text`, ["press.set_story_text", "press.add_type_frame"]);
      return;
    }
    const value = (quoted(clause) ?? retext[1]!).trim().replace(/^["'“”]|["'“”]$/g, "");
    r.pushQ("press.set_story_text", { layerId: frame.id, text: value }, clause);
    r.say.push(`Set ${frame.name}'s story to “${value.slice(0, 60)}${value.length > 60 ? "…" : ""}”.`);
    return;
  }

  /* ---- create ---- */

  const typeWord = /\b(masthead|headline|heading|title|display|subhead|subtitle|standfirst|deck|kicker|caption|footnote|folio|paragraph|type frame|text frame|text box|label|body copy|body text)\b/.exec(c);
  const createVerb = /^(?:add|put|draw|create|insert|place|make|set|give me|lay)\b/.test(c);
  if (createVerb && typeWord) {
    createType(clause, c, typeWord[1]!.replace("body copy", "body").replace("body text", "body"), ctx, r);
    return;
  }
  if (createVerb && /\b(rectangle|rect|box|square|panel|block|bar|swatch)\b/.test(c)) {
    createBox(clause, c, "rect", ctx, r);
    return;
  }
  if (createVerb && /\b(ellipse|circle|oval|dot|disc)\b/.test(c)) {
    createBox(clause, c, "ellipse", ctx, r);
    return;
  }
  if (createVerb && /\b(line|rule|divider|underline|hairline)\b/.test(c)) {
    createLine(clause, c, ctx, r);
    return;
  }

  /* ---- position ---- */

  if (/^(?:centre|center)\b/.test(c) || /\b(?:centre|center) (?:it|them|the selection)\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const horizontalOnly = /\bhorizontal|across\b/.test(c);
    const verticalOnly = /\bvertical|down the page\b/.test(c);
    const onPage = /\bon the page|in the page|on the sheet\b/.test(c);
    const boxX = onPage ? 0 : ctx.grid.x;
    const boxY = onPage ? 0 : ctx.grid.y;
    const boxW = onPage ? ctx.page.widthPx : ctx.grid.w;
    const boxH = onPage ? ctx.page.heightPx : ctx.grid.h;
    for (const l of targets) {
      const params: Record<string, unknown> = { layerId: l.id };
      if (!verticalOnly) params.x = round(boxX + (boxW - l.transform.w) / 2);
      if (!horizontalOnly) params.y = round(boxY + (boxH - l.transform.h) / 2);
      r.pushQ("press.set_transform", params, clause);
    }
    r.say.push(
      `Centre ${names(targets)} ${horizontalOnly ? "horizontally " : verticalOnly ? "vertically " : ""}in the ${onPage ? "page box" : "live area"} ` +
        `(${Math.round(boxW)}×${Math.round(boxH)} at ${Math.round(boxX)},${Math.round(boxY)}).`,
    );
    return;
  }

  const moveTo = new RegExp(`^(?:move|put|position)\\s+(?:it|them|the selection|this|that)\\s+to\\s*\\(?\\s*(${NUM})\\s*(${UNIT})\\s*,\\s*(${NUM})\\s*(${UNIT})`, "i").exec(c);
  if (moveTo) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const x = round(toPx(Number(moveTo[1]), moveTo[2] || moveTo[4], ppi));
    const y = round(toPx(Number(moveTo[3]), moveTo[4] || moveTo[2], ppi));
    for (const l of targets) r.pushQ("press.set_transform", { layerId: l.id, x, y }, clause);
    r.say.push(`Move ${names(targets)} to ${num(x)},${num(y)}.`);
    return;
  }

  const nudge = new RegExp(`^(?:move|nudge|shift)\\s+(?:it|them|the selection)\\s+(left|right|up|down)\\s*(?:by\\s*)?(${NUM})?\\s*(${UNIT})`, "i").exec(c);
  if (nudge) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const dist = nudge[2] ? round(toPx(Number(nudge[2]), nudge[3], ppi)) : null;
    if (dist === null) {
      r.refuse(clause, "no distance given — “move it right by 40” or “move it down 12mm”", ["press.set_transform"]);
      return;
    }
    const dir = nudge[1]!.toLowerCase();
    for (const l of targets) {
      const params: Record<string, unknown> = { layerId: l.id };
      if (dir === "left") params.x = round(l.transform.x - dist);
      if (dir === "right") params.x = round(l.transform.x + dist);
      if (dir === "up") params.y = round(l.transform.y - dist);
      if (dir === "down") params.y = round(l.transform.y + dist);
      r.pushQ("press.set_transform", params, clause);
    }
    r.say.push(`Move ${names(targets)} ${dir} ${num(dist)} px.`);
    return;
  }

  /* ---- size ---- */

  const scaleWord = /\bmake\s+(?:it|them|the selection|this|that)\s+(bigger|larger|smaller|wider|narrower|taller|shorter)\b/.exec(c);
  if (scaleWord) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const word = scaleWord[1]!;
    const factor = /bigger|larger|wider|taller/.test(word) ? 1.25 : 0.8;
    const axis = /wider|narrower/.test(word) ? "w" : /taller|shorter/.test(word) ? "h" : "both";
    for (const l of targets) {
      const params: Record<string, unknown> = { layerId: l.id };
      if (axis === "w" || axis === "both") params.w = round(l.transform.w * factor);
      if (axis === "h" || axis === "both") params.h = round(l.transform.h * factor);
      r.pushQ("press.set_transform", params, clause);
    }
    r.notes.push(`“${word}” has no fixed size, so I used ±25 % of the current box — the exact numbers are on the card. Ask for a column span instead and it lands on the grid.`);
    r.say.push(`Scale ${names(targets)} to ${factor === 1.25 ? "125 %" : "80 %"} of ${axis === "both" ? "its box" : axis === "w" ? "its width" : "its height"}.`);
    return;
  }

  if (/^(?:resize|scale|set the size of)\b/.test(c) || /\bmake\s+(?:it|them)\s+\d/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const size = findSize(c, ppi);
    if (!size) {
      r.refuse(clause, "no size in the sentence — “resize it to 400x300” or “resize it to 90mm x 60mm”", ["press.set_transform"]);
      return;
    }
    for (const l of targets) r.pushQ("press.set_transform", { layerId: l.id, w: size.w, h: size.h }, clause);
    r.say.push(`Resize ${names(targets)} to ${num(size.w)}×${num(size.h)} px.`);
    return;
  }

  const dim = new RegExp(`^set\\s+(?:the\\s+)?(width|height)\\s+(?:of\\s+(?:it|them|the selection)\\s+)?(?:to\\s*)?(${NUM})\\s*(${UNIT})`, "i").exec(c);
  if (dim) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const v = round(toPx(Number(dim[2]), dim[3], ppi));
    for (const l of targets) r.pushQ("press.set_transform", { layerId: l.id, [dim[1]!.toLowerCase() === "width" ? "w" : "h"]: v }, clause);
    r.say.push(`Set ${names(targets)} ${dim[1]!.toLowerCase()} to ${num(v)} px.`);
    return;
  }

  const rot = new RegExp(`^rotate\\s+(?:it|them|the selection|this|that)?\\s*(?:by\\s*)?(${NUM})\\s*(?:°|deg|degrees)?`, "i").exec(c);
  if (rot && /\brotate\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const deg = round(Number(rot[1]));
    for (const l of targets) r.pushQ("press.set_transform", { layerId: l.id, rotation: deg }, clause);
    r.say.push(`Rotate ${names(targets)} to ${num(deg)}° clockwise.`);
    return;
  }

  /* ---- appearance ---- */

  const opacity = new RegExp(`\\bopacity\\b[^\\d]*(${NUM})\\s*(%?)|(${NUM})\\s*%\\s*opaque`, "i").exec(c);
  if (opacity && /\bopacit|opaque\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const rawValue = Number(opacity[1] ?? opacity[3]);
    const value = opacity[2] === "%" || opacity[3] !== undefined || rawValue > 1 ? rawValue / 100 : rawValue;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      r.refuse(clause, `opacity must be 0–100 % — read “${opacity[1] ?? opacity[3]}”`, ["press.set_opacity"]);
      return;
    }
    for (const l of targets) r.pushQ("press.set_opacity", { layerId: l.id, opacity: round(value) }, clause);
    r.say.push(`Set ${names(targets)} opacity to ${Math.round(value * 100)} %.`);
    return;
  }

  const blend = /\bblend(?:ing)?\s*mode\b.*?\b(srcover|normal|multiply|screen|overlay|darken|lighten|colordodge|colorburn|hardlight|softlight|difference|exclusion|hue|saturation|color|luminosity)\b/.exec(c);
  if (blend) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const map: Record<string, string> = {
      normal: "srcOver", srcover: "srcOver", multiply: "multiply", screen: "screen", overlay: "overlay",
      darken: "darken", lighten: "lighten", colordodge: "colorDodge", colorburn: "colorBurn",
      hardlight: "hardLight", softlight: "softLight", difference: "difference", exclusion: "exclusion",
      hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity",
    };
    const mode = map[blend[1]!]!;
    for (const l of targets) r.pushQ("press.set_blend", { layerId: l.id, blend: mode }, clause);
    r.say.push(`Set ${names(targets)} blend mode to ${mode}.`);
    return;
  }

  if (/^(?:hide|show)\b/.test(c) && /\b(?:it|them|the selection|this|that)\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const visible = c.startsWith("show");
    for (const l of targets) r.pushQ("press.set_visible", { layerId: l.id, visible }, clause);
    r.say.push(`${visible ? "Show" : "Hide"} ${names(targets)}.`);
    return;
  }
  if (/^(?:lock|unlock)\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const locked = c.startsWith("lock");
    for (const l of targets) r.pushQ("press.set_locked", { layerId: l.id, locked }, clause);
    r.say.push(`${locked ? "Lock" : "Unlock"} ${names(targets)}.`);
    return;
  }

  const order = /\b(bring (?:it |them )?(?:to the )?front|bring (?:it |them )?forward|send (?:it |them )?(?:to the )?back|send (?:it |them )?backward)\b/.exec(c);
  if (order) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const phrase = order[1]!;
    const direction = /front/.test(phrase) ? "front" : /forward/.test(phrase) ? "forward" : /backward/.test(phrase) ? "backward" : "back";
    for (const l of targets) r.pushQ("press.reorder", { layerId: l.id, direction }, clause);
    r.say.push(`Move ${names(targets)} ${direction} in the stack.`);
    return;
  }

  /* ---- paragraph alignment ---- */

  const align = /\b(?:align|set the alignment(?: of .+?)? to)\s+(?:the\s+)?(?:text\s+)?(left|right|centre|center|centred|centered|justified|justify)\b/.exec(c);
  if (align || /^justify\b/.test(c)) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const frames = targets.filter((l) => l.kind === "type-frame");
    if (!frames.length) {
      r.refuse(clause, `alignment is a paragraph property; the selection is ${targets.map((l) => l.kind).join(", ")}. To move a box, say “centre it”.`, ["press.set_paragraph_align", "press.set_transform"]);
      return;
    }
    const word = align ? align[1]!.toLowerCase() : "justify";
    const value = /just/.test(word) ? "justify" : /cent/.test(word) ? "center" : word;
    for (const l of frames) r.pushQ("press.set_paragraph_align", { layerId: l.id, align: value }, clause);
    r.say.push(`Set ${names(frames)} paragraph alignment to ${value}.`);
    return;
  }

  /* ---- type size on an existing frame ---- */

  const typeSize = new RegExp(`\\b(?:type size|font size|text size|point size)\\b[^\\d]*(${NUM})\\s*(${UNIT})|\\bmake the (?:type|text|font)\\s*(${NUM})\\s*(${UNIT})`, "i").exec(c);
  if (typeSize) {
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const frames = targets.filter((l) => l.kind === "type-frame");
    if (!frames.length) {
      r.refuse(clause, `type size only applies to a type frame; the selection is ${targets.map((l) => l.kind).join(", ")}`, ["press.set_character", "press.add_type_frame"]);
      return;
    }
    const value = round(toPx(Number(typeSize[1] ?? typeSize[3]), typeSize[2] || typeSize[4], ppi));
    for (const l of frames) r.pushQ("press.set_character", { layerId: l.id, size: value, leading: round(autoLeading(value)) }, clause);
    r.notes.push(`Leading set to 120 % of the size (${num(round(autoLeading(value)))} px) — the document's Auto leading.`);
    r.say.push(`Set ${names(frames)} type size to ${num(value)} px.`);
    return;
  }

  /* ---- fill an existing selection ---- */

  if (/^(?:make|colou?r|fill|paint|set the (?:fill|colou?r))\b/.test(c) && /\b(?:it|them|the selection|this|that)\b/.test(c)) {
    const colour = findColour(c);
    if (!colour) {
      r.refuse(
        clause,
        `no colour I hold in that sentence. Give a hex value (#E07A2F) or one of: ${Object.keys(COLOURS).slice(0, 16).join(", ")}…`,
        ["press.apply_fill", "press.set_character"],
      );
      return;
    }
    const targets = targetLayers(ctx, r, clause);
    if (!targets) return;
    const fillable = targets.filter((l) => l.kind === "vector" || l.kind === "type-frame");
    if (!fillable.length) {
      r.refuse(clause, `only vector and type-frame layers carry a fill; the selection is ${targets.map((l) => l.kind).join(", ")}`, ["press.apply_fill"]);
      return;
    }
    r.pushQ("press.apply_fill", { layerIds: fillable.map((l) => l.id), color: colour.hex }, clause);
    r.say.push(`Fill ${names(fillable)} with ${colour.word} ${colour.hex}.`);
    return;
  }

  /* ---- nothing matched ---- */

  r.refuse(clause, "I do not have a phrasing for this. Anchor's interpreter is a fixed grammar over a real op catalogue, not a language model — it reads only what it was built to read.");
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export const HELP_TEXT = [
  "I am a deterministic design engine over the press.* ops — not a language model. What I read:",
  "COMPOSE  make me a concert poster · build an A4 editorial opening · a square quote card saying “…” in moss",
  "BUILD    add a headline saying “Margin of Error” · a deck across 3 columns · add three body columns of “…”",
  "         a rule under the Title · a copper panel across 2 columns · a horizontal guide at 900 · column guides",
  "CLEAN    clean this up · snap it to the grid · align everything to the columns",
  "MOVE     move the Title to the top right · put the Issue disc in column 4 · centre it · move it down 40",
  "SOURCE   add a grainy backdrop in moss · place a register mark top right · lay newsprint stock · place my logo",
  "EDIT     select the Deck · rename it to “Kicker” · group them · make it copper · set the opacity to 60%",
  "         resize it to 400x300 · rotate it 15 degrees · set the type size to 48pt · justify it · delete it",
  "ASK      what layers are here · what is selected · what is the grid · what designs can you compose",
  "Units: px (default), pt, mm, cm, in — converted through the document's own ppi.",
].join("\n");

/**
 * Read a message against a document. Pure: returns proposals, applies nothing.
 */
export function interpret(message: string, doc: PressDocument, opts: InterpretOptions = {}): Interpretation {
  const ctx = makeCtx(doc, opts);
  const r = new Reply();
  const text = message.trim();
  if (!text) return { ops: [], say: [], notes: [], unread: [], zones: [], design: null };

  for (const clause of splitClauses(text)) handleClause(clause, ctx, r);

  return { ops: r.ops, say: r.say, notes: r.notes, unread: r.unread, zones: r.zones, design: r.design };
}
