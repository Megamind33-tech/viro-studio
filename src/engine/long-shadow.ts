/**
 * Long-shadow extrusion sampling. Shared by the compositor and tests so a
 * 400px extrusion cannot issue 400 saveLayers.
 */
export function longShadowSteps(length: number): number {
  if (!(length > 0) || !Number.isFinite(length)) return 0;
  return Math.max(1, Math.min(12, Math.ceil(length / 4)));
}
