/**
 * Named Anchor batches — automated layouts that produce real, editable layers.
 * Every recipe is a list of `press.*` ops the command bus already runs; nothing
 * is flattened, nothing is faked. One Apply is one undo step.
 */
import type { AnchorOp } from "../anchor/tools";
import type { Rgba } from "../document/types";

export interface WorkflowContext {
  width: number;
  height: number;
  fg: Rgba;
}

export interface Workflow {
  id: string;
  name: string;
  blurb: string;
  /** Optional post-pass the desk may run (effects that have no Anchor op yet). */
  after?: "long-shadow-type";
  build: (ctx: WorkflowContext) => AnchorOp[];
}

function copper(ctx: WorkflowContext): { r: number; g: number; b: number; a: number } {
  return { r: ctx.fg.r, g: ctx.fg.g, b: ctx.fg.b, a: ctx.fg.a };
}

export const WORKFLOWS: Workflow[] = [
  {
    id: "headline-lockup",
    name: "Headline lockup",
    blurb: "Kicker rule, display type, and a deck. Real type frames — HarfBuzz shapes them.",
    build: (ctx) => {
      const x = Math.round(ctx.width * 0.12);
      const w = Math.round(ctx.width * 0.76);
      const y = Math.round(ctx.height * 0.28);
      return [
        {
          op: "press.add_line",
          params: { x1: x, y1: y, x2: x + Math.min(180, w * 0.28), y2: y, stroke: { color: "#E07A2F", width: 8 } },
          reason: "kicker rule under the masthead",
        },
        {
          op: "press.add_type_frame",
          params: { x, y: y + 28, w, h: 200, text: "THE PRESS", size: 92, leading: 100, name: "Headline" },
          reason: "display headline for the lockup",
        },
        {
          op: "press.add_type_frame",
          params: {
            x,
            y: y + 240,
            w,
            h: 90,
            text: "A layout the compositor actually draws.",
            size: 28,
            leading: 36,
            name: "Deck",
          },
          reason: "supporting deck under the headline",
        },
      ];
    },
  },
  {
    id: "social-card",
    name: "Social card",
    blurb: "Rounded plate, title, and subtitle — a starting card you can restyle.",
    build: (ctx) => {
      const inset = Math.round(Math.min(ctx.width, ctx.height) * 0.08);
      const w = ctx.width - inset * 2;
      const h = ctx.height - inset * 2;
      return [
        {
          op: "press.add_round_rect",
          params: { x: inset, y: inset, w, h, radius: Math.round(Math.min(w, h) * 0.06), fill: "#1F1F24", name: "Plate" },
          reason: "card plate behind the type",
        },
        {
          op: "press.add_type_frame",
          params: {
            x: inset + 48,
            y: inset + Math.round(h * 0.32),
            w: w - 96,
            h: 140,
            text: "Your headline",
            size: 64,
            leading: 72,
            fill: { r: 1, g: 1, b: 1, a: 1 },
            name: "Card title",
          },
          reason: "card title on the plate",
        },
        {
          op: "press.add_type_frame",
          params: {
            x: inset + 48,
            y: inset + Math.round(h * 0.32) + 150,
            w: w - 96,
            h: 80,
            text: "Edit this. It is live type, not a picture.",
            size: 22,
            leading: 30,
            fill: { r: 0.88, g: 0.48, b: 0.18, a: 1 },
            name: "Card subtitle",
          },
          reason: "card subtitle in copper",
        },
      ];
    },
  },
  {
    id: "star-badge",
    name: "Star badge",
    blurb: "A five-point star with a label. Pathfinder-ready geometry.",
    build: (ctx) => {
      const s = Math.round(Math.min(ctx.width, ctx.height) * 0.42);
      const x = Math.round((ctx.width - s) / 2);
      const y = Math.round(ctx.height * 0.18);
      return [
        {
          op: "press.add_star",
          params: { x, y, w: s, h: s, points: 5, fill: copper(ctx), name: "Badge" },
          reason: "badge star behind the label",
        },
        {
          op: "press.add_type_frame",
          params: {
            x: Math.round(ctx.width * 0.15),
            y: y + s + 24,
            w: Math.round(ctx.width * 0.7),
            h: 72,
            text: "NEW",
            size: 48,
            leading: 56,
            align: "center",
            name: "Badge label",
          },
          reason: "label under the star",
        },
      ];
    },
  },
  {
    id: "3d-type-plate",
    name: "3D type plate",
    blurb: "Display type plus a long shadow on that layer after the batch (compositor extrusion).",
    after: "long-shadow-type",
    build: (ctx) => {
      const x = Math.round(ctx.width * 0.1);
      const y = Math.round(ctx.height * 0.38);
      const w = Math.round(ctx.width * 0.8);
      return [
        {
          op: "press.add_type_frame",
          params: { x, y, w, h: 180, text: "EXTRUDE", size: 110, leading: 120, name: "3D type" },
          reason: "display type that will take a long shadow",
        },
      ];
    },
  },
];

export function workflowById(id: string): Workflow | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}
