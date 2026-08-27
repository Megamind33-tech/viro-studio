/**
 * Anchor — composition. The part of the interpreter that makes *designs*
 * rather than shapes.
 *
 * Two jobs live here:
 *
 *  1. **Template → ops.** `src/library/catalog.ts` already holds ten complete,
 *     composed designs, each of which builds a whole `PressDocument`. A whole
 *     document is not something Anchor may hand back: Anchor's contract is op
 *     envelopes applied to the document the operator already has, as one undo
 *     step. So `opsFromTemplate` walks a built template and re-emits it as
 *     `press.*` ops mapped onto the *current* page's grid — every layer real
 *     and editable, nothing flattened, nothing replaced behind the operator's
 *     back.
 *
 *  2. **Grid arithmetic.** Snapping to columns and the baseline, resolving a
 *     named grid position, and sizing a type frame to its own copy. This is
 *     the arithmetic that separates "on the grid" from "near the grid", and it
 *     is the same arithmetic `tests/cover-composition.mjs` writes out by hand.
 *
 * Everything here is pure. It returns envelopes; `PressApp.applyAnchorDetailed`
 * is still the only thing that writes to a document.
 */

import type { Layer, Page, PressDocument, Rgba } from "../document/types";
import { frameHeightFor, pageGrid, rectNodes } from "../document/factory";
import { fillExportRgb } from "../document/paint";
import { documentFromTemplate, TEMPLATES } from "../library/catalog";
import type { AnchorOp } from "./tools";

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

export function rgbaToHex(c: Rgba): string {
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

/** Perceptual distance, good enough to tell one ink from another. */
function inkDistance(a: string, b: string): number {
  const p = (h: string) => [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  return Math.abs(ar! - br!) + Math.abs(ag! - bg!) + Math.abs(ab! - bb!);
}

/* ------------------------------------------------------------------ *
 * Grid helpers — shared by the interpreter's build / clean / move verbs
 * ------------------------------------------------------------------ */

export type Grid = ReturnType<typeof pageGrid>;

/**
 * The document's baseline step. Anchor has no baseline-grid primitive, so this
 * is derived from the body size the document itself was created with — the
 * same 120 % Auto leading every type frame is born with.
 */
export function baselineStep(bodyPx: number): number {
  return Math.round(bodyPx * 1.2);
}

/** Snap a page x to the nearest column edge (left or right) within tolerance. */
export function snapX(g: Grid, x: number, tolerance: number): { x: number; moved: number } | null {
  const candidates: number[] = [g.x, g.x + g.w];
  for (let i = 0; i < g.columns; i += 1) {
    candidates.push(g.colX(i), g.colX(i) + g.columnWidth);
  }
  let best = candidates[0]!;
  for (const c of candidates) if (Math.abs(c - x) < Math.abs(best - x)) best = c;
  const moved = best - x;
  if (Math.abs(moved) > tolerance || Math.abs(moved) < 0.5) return null;
  return { x: Math.round(best * 100) / 100, moved };
}

/** Snap a width to the nearest whole column span within tolerance. */
export function snapSpan(g: Grid, w: number, tolerance: number): { w: number; moved: number } | null {
  let best = g.columnWidth;
  for (let n = 1; n <= g.columns; n += 1) {
    const span = g.colSpan(0, n);
    if (Math.abs(span - w) < Math.abs(best - w)) best = span;
  }
  const moved = best - w;
  if (Math.abs(moved) > tolerance || Math.abs(moved) < 0.5) return null;
  return { w: Math.round(best * 100) / 100, moved };
}

/** Snap a page y onto the baseline ladder measured from the top margin. */
export function snapBaseline(g: Grid, y: number, step: number, tolerance: number): { y: number; moved: number } | null {
  if (step <= 0) return null;
  const k = Math.round((y - g.y) / step);
  const target = g.y + k * step;
  const moved = target - y;
  if (Math.abs(moved) > tolerance || Math.abs(moved) < 0.5) return null;
  return { y: Math.round(target * 100) / 100, moved };
}

export interface Placement {
  x: number;
  y: number;
  label: string;
}

/** Named destinations that are real page geometry, not taste. */
export function gridPlacement(phrase: string, g: Grid, page: Page, w: number, h: number): Placement | null {
  const p = phrase.toLowerCase();
  const right = Math.round(g.x + g.w - w);
  const bottom = Math.round(g.y + g.h - h);
  const midX = Math.round(g.x + (g.w - w) / 2);
  const midY = Math.round(g.y + (g.h - h) / 2);
  const col = /\bcolumn\s+(\d+)\b/.exec(p);
  if (col) {
    const i = Number(col[1]) - 1;
    if (i < 0 || i >= g.columns) return null;
    return { x: Math.round(g.colX(i)), y: Math.round(g.y), label: `column ${i + 1}` };
  }
  if (/\btop[-\s]?left\b/.test(p)) return { x: Math.round(g.x), y: Math.round(g.y), label: "top left of the live area" };
  if (/\btop[-\s]?right\b/.test(p)) return { x: right, y: Math.round(g.y), label: "top right of the live area" };
  if (/\bbottom[-\s]?left\b/.test(p)) return { x: Math.round(g.x), y: bottom, label: "bottom left of the live area" };
  if (/\bbottom[-\s]?right\b/.test(p)) return { x: right, y: bottom, label: "bottom right of the live area" };
  if (/\bcentre|center|middle\b/.test(p)) return { x: midX, y: midY, label: "centre of the live area" };
  if (/\btop\b/.test(p)) return { x: midX, y: Math.round(g.y), label: "top of the live area" };
  if (/\bbottom\b/.test(p)) return { x: midX, y: bottom, label: "bottom of the live area" };
  if (/\bleft\b/.test(p)) return { x: Math.round(g.x), y: midY, label: "left margin" };
  if (/\bright\b/.test(p)) return { x: right, y: midY, label: "right margin" };
  void page;
  return null;
}

/* ------------------------------------------------------------------ *
 * Template translation
 * ------------------------------------------------------------------ */

export interface TemplateMatch {
  id: string;
  name: string;
  blurb: string;
}

/**
 * Which composed design a request is asking for. A closed keyword table — an
 * unmatched request is refused with the list, never approximated with the
 * nearest thing.
 */
const TEMPLATE_WORDS: { id: string; words: RegExp }[] = [
  { id: "poster-a2-concert", words: /\b(concert|gig|band|show|music)?\s*poster\b|\bgig\b/ },
  { id: "flyer-a5-event", words: /\b(flyer|flier|leaflet|handout|handbill)\b/ },
  { id: "card-business-us", words: /\b(business|calling|name|contact)\s*card\b|\bbusiness card\b/ },
  { id: "letterhead-us", words: /\b(letterhead|letter head|stationery|letter paper)\b/ },
  { id: "editorial-a4", words: /\b(editorial|magazine|spread|article|feature|opening spread|journal)\b/ },
  { id: "social-quote-square", words: /\b(quote card|quote post|square (?:social|post|card)|pull quote)\b|\bquote\b/ },
  { id: "social-story-launch", words: /\b(story|stories|9:16|vertical (?:post|video)|reel)\b/ },
  { id: "social-product-portrait", words: /\b(product (?:post|shot|card)|4:5|portrait post)\b/ },
  { id: "web-landing-hero", words: /\b(landing (?:page|hero)|hero section|web ?page|website|marketing page)\b/ },
  { id: "app-screen-ios", words: /\b(app screen|mobile screen|ios screen|phone screen|app ui)\b/ },
];

export function matchTemplate(text: string): TemplateMatch | null {
  const t = text.toLowerCase();
  for (const row of TEMPLATE_WORDS) {
    if (row.words.test(t)) {
      const spec = TEMPLATES.find((x) => x.id === row.id);
      if (spec) return { id: spec.id, name: spec.name, blurb: spec.blurb };
    }
  }
  return null;
}

export function templateList(): TemplateMatch[] {
  return TEMPLATES.map((t) => ({ id: t.id, name: t.name, blurb: t.blurb }));
}

export interface TemplateOptions {
  /** Replace the largest type frame's copy with the operator's own words. */
  headline?: string | null;
  /** Re-ink every use of the template's accent with this hex. */
  accent?: string | null;
  /** Which page of a multi-page template to lay down. */
  pageIndex?: number;
  reason: string;
}

export interface ComposedDesign {
  ops: AnchorOp[];
  /** Zone name → the envelope ids that belong to it, for the assemble pass. */
  zones: { name: string; ids: string[] }[];
  notes: string[];
  /** Plain description of the composition, for the reply. */
  summary: string;
  layerCount: number;
  pages: number;
}

const COPPER_HEX = "#E07A2F";

/**
 * Re-emit a built template as ops against the current page.
 *
 * Mapping rule: one uniform scale `s = min(liveW/tplLiveW, liveH/tplLiveH)`,
 * then the template's live area is centred inside the current one. Uniform,
 * because a non-uniform scale would distort type — a 240 pt title stretched
 * 1.3× in x is not a design decision anyone made. The scale is reported.
 */
export function opsFromTemplate(target: PressDocument, templateId: string, opts: TemplateOptions): ComposedDesign | null {
  const src = documentFromTemplate(templateId);
  if (!src) return null;
  const spec = TEMPLATES.find((t) => t.id === templateId)!;
  const pageIndex = Math.min(Math.max(0, opts.pageIndex ?? 0), src.pages.length - 1);
  const srcPage = src.pages[pageIndex]!;
  const srcGrid = pageGrid(srcPage);

  const dstPage = target.pages.find((p) => p.id === target.activePageId) ?? target.pages[0]!;
  const dstGrid = pageGrid(dstPage);
  const bleed = dstPage.bleedPx;

  const s = Math.min(dstGrid.w / srcGrid.w, dstGrid.h / srcGrid.h);
  const usedW = srcGrid.w * s;
  const usedH = srcGrid.h * s;
  const offX = dstGrid.x + (dstGrid.w - usedW) / 2;
  const offY = dstGrid.y + (dstGrid.h - usedH) / 2;

  const X = (x: number) => Math.round((offX + (x - srcGrid.x) * s) * 100) / 100;
  const Y = (y: number) => Math.round((offY + (y - srcGrid.y) * s) * 100) / 100;
  const S = (v: number) => Math.round(v * s * 100) / 100;

  /** Does this layer run to the template's trim on both axes? Then it is the ground. */
  const isFullBleed = (l: Layer): boolean =>
    l.transform.x <= 1 - srcPage.bleedPx &&
    l.transform.y <= 1 - srcPage.bleedPx &&
    l.transform.w >= srcPage.widthPx - 1 &&
    l.transform.h >= srcPage.heightPx - 1;

  /** Runs edge to edge horizontally but not vertically — a bleeding band. */
  const isBleedBand = (l: Layer): boolean =>
    l.transform.x <= 1 - srcPage.bleedPx && l.transform.w >= srcPage.widthPx - 1 && !isFullBleed(l);

  const ops: AnchorOp[] = [];
  const notes: string[] = [];
  const zoneMap = new Map<string, string[]>();
  let seq = 0;
  const nextId = () => `t${(seq += 1)}`;

  const reInk = (hexValue: string): string => {
    if (!opts.accent) return hexValue;
    return inkDistance(hexValue, COPPER_HEX) < 40 ? opts.accent : hexValue;
  };

  const push = (op: string, params: Record<string, unknown>, reason: string, group: string | null): string => {
    const id = nextId();
    ops.push({ id, op, params, reason });
    if (group) {
      const list = zoneMap.get(group) ?? [];
      list.push(id);
      zoneMap.set(group, list);
    }
    return id;
  };

  /* --- ground ------------------------------------------------------ */

  const layers = srcPage.layers;
  const groundAlready = layers.some((l) => l.kind === "vector" && isFullBleed(l));
  const bg = srcPage.background;
  if (!groundAlready && bg.a > 0 && rgbaToHex(bg) !== "#FFFFFF") {
    push(
      "press.add_rect",
      {
        x: -bleed,
        y: -bleed,
        w: dstPage.widthPx + bleed * 2,
        h: dstPage.heightPx + bleed * 2,
        fill: reInk(rgbaToHex(bg)),
        name: "Ground — full bleed",
      },
      `${spec.name} is set on a ${rgbaToHex(bg)} ground; page background is not an Anchor op, so the ground is laid as a full-bleed rectangle you can select and re-ink`,
      "Ground",
    );
    notes.push(`The template's ${rgbaToHex(bg)} page background became a real full-bleed rectangle — Anchor has no page-background op, and a layer is editable where a page property is not.`);
  }

  /* --- the layers -------------------------------------------------- */

  const groupNameOf = (l: Layer): string | null => {
    if (!l.parentId) return null;
    const parent = layers.find((p) => p.id === l.parentId);
    return parent ? parent.name : null;
  };

  let biggestType: Layer | null = null;
  let biggestSize = 0;
  for (const l of layers) {
    if (l.kind !== "type-frame") continue;
    const story = src.stories.find((st) => st.id === l.storyId);
    if (story && story.character.size > biggestSize) {
      biggestSize = story.character.size;
      biggestType = l;
    }
  }

  let skipped = 0;
  for (const l of layers) {
    if (l.kind === "group") continue;
    if (l.kind === "adjustment" || l.kind === "raster") {
      skipped += 1;
      continue;
    }
    const zone = groupNameOf(l) ?? sectionOf(l, srcGrid);
    const full = isFullBleed(l);
    const band = isBleedBand(l);
    const box = full
      ? { x: -bleed, y: -bleed, w: dstPage.widthPx + bleed * 2, h: dstPage.heightPx + bleed * 2 }
      : band
        ? { x: -bleed, y: Y(l.transform.y), w: dstPage.widthPx + bleed * 2, h: S(l.transform.h) }
        : { x: X(l.transform.x), y: Y(l.transform.y), w: S(l.transform.w), h: S(l.transform.h) };

    if (l.kind === "type-frame") {
      const story = src.stories.find((st) => st.id === l.storyId);
      if (!story) {
        skipped += 1;
        continue;
      }
      const isHeadline = biggestType !== null && l.id === biggestType.id;
      const text = isHeadline && opts.headline ? opts.headline : story.text;
      const size = S(story.character.size);
      const leading = S(story.character.leading);
      const lines = text.split("\n").length;
      const h = isHeadline && opts.headline ? Math.max(box.h, frameHeightFor(lines, size, leading)) : box.h;
      push(
        "press.add_type_frame",
        {
          x: box.x,
          y: box.y,
          w: box.w,
          h,
          text,
          size,
          leading,
          tracking: Math.round(story.character.tracking),
          align: story.paragraph.align,
          fill: reInk(rgbaToHex(story.character.fill)),
          name: l.name,
        },
        `${l.name}: ${Math.round(size)} px on ${Math.round(leading)} px leading, ${Math.round(box.w)} px measure — the template's own hierarchy, scaled ${s.toFixed(3)}× to this page`,
        zone,
      );
      continue;
    }

    if (l.kind === "image-frame") {
      const asset = l.assetId ? src.assets[l.assetId] : undefined;
      if (!asset) {
        skipped += 1;
        continue;
      }
      push(
        "press.place_image",
        {
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          dataUrl: asset.dataUrl,
          width: asset.width,
          height: asset.height,
          name: asset.name,
          fit: l.fit,
        },
        `${l.name}: a press-generated two-ink field from the local library, sized to the frame so a "${l.fit}" fit does not crop it — replace it with a real picture when you have one`,
        zone,
      );
      continue;
    }

    if (l.kind === "vector") {
      const fill = l.fill ? reInk(rgbaToHex(fillExportRgb(l.fill))) : null;
      const stroke = l.stroke ? { color: reInk(rgbaToHex(l.stroke.color)), width: Math.max(0.25, S(l.stroke.width)) } : null;
      if (!fill && !stroke) {
        skipped += 1;
        continue;
      }
      const isRect = l.closed && isRectPath(l);
      const isRule = !l.closed && l.nodes.length === 2;
      if (isRect) {
        const params: Record<string, unknown> = { x: box.x, y: box.y, w: box.w, h: box.h, name: l.name };
        if (fill) params.fill = fill;
        if (stroke) params.stroke = stroke;
        push("press.add_rect", params, ruleReason(l, full || band), zone);
      } else if (isRule && stroke) {
        const a = l.nodes[0]!;
        const b = l.nodes[1]!;
        push(
          "press.add_line",
          {
            x1: box.x + S(a.x),
            y1: box.y + S(a.y),
            x2: box.x + S(b.x),
            y2: box.y + S(b.y),
            stroke,
            name: l.name,
          },
          ruleReason(l, false),
          zone,
        );
      } else {
        const params: Record<string, unknown> = {
          x: box.x,
          y: box.y,
          w: Math.max(4, box.w),
          h: Math.max(4, box.h),
          nodes: l.nodes.map((nd) => ({
            x: S(nd.x),
            y: S(nd.y),
            inX: S(nd.inX),
            inY: S(nd.inY),
            outX: S(nd.outX),
            outY: S(nd.outY),
          })),
          closed: l.closed,
          name: l.name,
        };
        if (fill) params.fill = fill;
        if (stroke) params.stroke = stroke;
        push("press.add_path", params, `${l.name}: kept as an editable ${l.nodes.length}-node path, not a picture of one`, zone);
      }
    }
  }

  /* --- guides ------------------------------------------------------ */

  for (let i = 0; i < dstGrid.columns; i += 1) {
    ops.push({
      op: "press.add_guide",
      params: { axis: "v", offset: Math.round(dstGrid.colX(i)) },
      reason: `column ${i + 1} left edge — the grid this composition is set on, as document state you can see`,
    });
    if (dstGrid.columns > 1) {
      ops.push({
        op: "press.add_guide",
        params: { axis: "v", offset: Math.round(dstGrid.colX(i) + dstGrid.columnWidth) },
        reason: `column ${i + 1} right edge`,
      });
    }
  }

  ops.push({
    op: "press.select",
    params: { layerIds: [] },
    reason: "drop the selection so the finished page is judged without handles on it",
  });

  if (skipped) notes.push(`${skipped} layer(s) in the template have no Anchor create op and were left out.`);
  if (Math.abs(s - 1) > 0.005) {
    notes.push(
      `${spec.name} is cut for a ${Math.round(srcPage.widthPx)}×${Math.round(srcPage.heightPx)} px page; yours is ` +
        `${Math.round(dstPage.widthPx)}×${Math.round(dstPage.heightPx)}. Scaled ${s.toFixed(3)}× uniformly and re-registered on your margins ` +
        `(live area ${Math.round(dstGrid.w)}×${Math.round(dstGrid.h)} at ${Math.round(dstGrid.x)},${Math.round(dstGrid.y)}).`,
    );
  }
  const srcRatio = srcPage.widthPx / srcPage.heightPx;
  const dstRatio = dstPage.widthPx / dstPage.heightPx;
  if (Math.abs(srcRatio - dstRatio) > 0.08) {
    notes.push(
      `Aspect differs (${srcRatio.toFixed(2)} vs ${dstRatio.toFixed(2)}), so the composition is centred in your live area with the ` +
        `difference falling as ${srcRatio > dstRatio ? "space above and below" : "space left and right"}. It is not stretched — stretching type is not a design decision.`,
    );
  }
  if (src.pages.length > 1) {
    notes.push(`${spec.name} has ${src.pages.length} pages; this lays down page ${pageIndex + 1} (“${srcPage.name}”).`);
  }
  if (opts.headline && biggestType) notes.push(`Your words replaced the display copy in “${biggestType.name}”; the frame, size and leading are the template's.`);
  if (opts.accent) notes.push(`Every copper accent re-inked to ${opts.accent}. The other two inks are left alone — the palette stays at three.`);

  const zones = [...zoneMap.entries()].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids }));

  return {
    ops,
    zones,
    notes,
    summary: spec.blurb,
    layerCount: ops.filter((o) => /add_|place_image/.test(o.op)).length,
    pages: src.pages.length,
  };
}

function ruleReason(l: Layer, bleeds: boolean): string {
  if (l.kind !== "vector") return l.name;
  if (!l.closed && l.nodes.length === 2) return `${l.name}: a stroked rule, the horizontal that holds the block together`;
  return `${l.name}${bleeds ? ", run past the trim so it survives the cut" : ""}`;
}

/** Is this closed path exactly the rectangle of its own box? */
function isRectPath(l: Layer): boolean {
  if (l.kind !== "vector" || !l.closed || l.nodes.length !== 4) return false;
  const want = rectNodes(Math.max(1, l.transform.w), Math.max(1, l.transform.h));
  return l.nodes.every((nd, i) => {
    const w = want[i]!;
    return Math.abs(nd.x - w.x) < 0.75 && Math.abs(nd.y - w.y) < 0.75 && Math.abs(nd.inX - nd.x) < 0.75 && Math.abs(nd.outX - nd.x) < 0.75;
  });
}

/** Fallback zone for a layer the template did not group: which third of the page it sits in. */
function sectionOf(l: Layer, g: Grid): string {
  const mid = l.transform.y + l.transform.h / 2;
  const t = (mid - g.y) / Math.max(1, g.h);
  if (t < 0.3) return "Head";
  if (t < 0.72) return "Middle";
  return "Foot";
}

/* ------------------------------------------------------------------ *
 * Assemble — the second batch, built from the first batch's audit trail
 * ------------------------------------------------------------------ */

/**
 * Group each zone and name it, exactly as `tests/cover-composition.mjs` does.
 * This has to be a second batch: no op can name a layer that a *later* op in
 * the same batch is going to create, so the ids only exist once batch one has
 * been applied. Two batches means two undo steps, and the panel says so rather
 * than pretending otherwise.
 */
export function assembleOps(
  zones: { name: string; ids: string[] }[],
  layerIdFor: (envelopeId: string) => string | undefined,
): AnchorOp[] {
  const ops: AnchorOp[] = [];
  for (const zone of zones) {
    const layerIds = zone.ids.map(layerIdFor).filter((v): v is string => typeof v === "string");
    if (layerIds.length < 2) continue;
    ops.push({
      op: "press.group",
      params: { layerIds },
      reason: `collect the ${zone.name.toLowerCase()} into one group so the Layers panel reads by zone`,
    });
    ops.push({
      op: "press.set_name",
      params: { name: zone.name },
      reason: "name the group just made — press.group leaves it selected",
    });
  }
  if (ops.length) {
    ops.push({ op: "press.select", params: { layerIds: [] }, reason: "drop the selection once the zones are named" });
  }
  return ops;
}
