/**
 * Vector paint — solid RGBA or a real linear/radial gradient.
 *
 * A gradient fill is stored ON the vector (`VectorLayer.fill`), not as a
 * decorative overlay. The compositor builds a Skia shader from these stops;
 * the overlay effect (`gradient-overlay`) remains a separate silhouette tint.
 */
import type { GradientFill, GradientStop, Rgba, VectorFill } from "./types";

export function isGradientFill(fill: VectorFill | null | undefined): fill is GradientFill {
  return !!fill && typeof fill === "object" && "type" in fill && (fill.type === "linear" || fill.type === "radial");
}

export function isSolidFill(fill: VectorFill | null | undefined): fill is Rgba {
  return !!fill && !isGradientFill(fill) && typeof (fill as Rgba).r === "number";
}

/** Alpha used for PDF graphics state — start stop for a gradient, else the solid. */
export function fillAlpha(fill: VectorFill | null | undefined): number {
  if (!fill) return 0;
  if (isGradientFill(fill)) return fill.stops[0]?.color.a ?? 1;
  return fill.a;
}

/** The colour a vector PDF path uses when it cannot emit a shading. */
export function fillExportRgb(fill: VectorFill): Rgba {
  if (isGradientFill(fill)) return fill.stops[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 };
  return fill;
}

export function linearGradientFill(from: Rgba, to: Rgba, angle = 90): GradientFill {
  return {
    type: "linear",
    angle,
    stops: [
      { offset: 0, color: { ...from } },
      { offset: 1, color: { ...to } },
    ],
  };
}

export function cloneVectorFill(fill: VectorFill): VectorFill {
  if (isGradientFill(fill)) {
    return {
      type: fill.type,
      angle: fill.angle,
      stops: fill.stops.map((s) => ({ offset: s.offset, color: { ...s.color } })),
    };
  }
  return { ...fill };
}

export function cloneStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops.map((s) => ({ offset: s.offset, color: { ...s.color } }));
}
