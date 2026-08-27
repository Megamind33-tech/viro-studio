/**
 * Feature flags (GOVERNOR.md §12B, ADR 0004).
 *
 * Flags gate incomplete or externally-dependent capabilities so nothing fake
 * ships. `platform.enabled` (local multi-project + dashboard) is real and
 * tested, so it defaults ON. `platform.cloud` (Supabase-backed sync/auth) and
 * `platform.billing` (Lenco) stay OFF until their accounts/secrets and
 * acceptance tests exist — see ADR 0004.
 *
 * Resolution order (last wins): DEFAULTS → build-time `VITE_FLAG_<NAME>` →
 * localStorage `viro.flags` JSON → in-memory overrides (tests/runtime toggles).
 * Kept pure and dependency-free so it is unit-testable under node.
 */

export type FlagName = "platform.enabled" | "platform.cloud" | "platform.billing";

export type FlagMap = Record<FlagName, boolean>;

const DEFAULTS: FlagMap = {
  "platform.enabled": true,
  "platform.cloud": false,
  "platform.billing": false,
};

const overrides: Partial<FlagMap> = {};

function coerce(v: unknown): boolean | undefined {
  if (v === true || v === false) return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

function fromEnv(name: FlagName): boolean | undefined {
  // e.g. platform.enabled -> VITE_FLAG_PLATFORM_ENABLED
  const key = `VITE_FLAG_${name.replace(/[.-]/g, "_").toUpperCase()}`;
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    if (env && key in env) return coerce(env[key]);
  } catch {
    /* import.meta.env unavailable (e.g. plain node) */
  }
  return undefined;
}

function fromLocalStorage(name: FlagName): boolean | undefined {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return undefined;
    const raw = ls.getItem("viro.flags");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return coerce(parsed[name]);
  } catch {
    return undefined;
  }
}

export function flag(name: FlagName): boolean {
  if (name in overrides) return overrides[name]!;
  const ls = fromLocalStorage(name);
  if (ls !== undefined) return ls;
  const env = fromEnv(name);
  if (env !== undefined) return env;
  return DEFAULTS[name];
}

export function flags(): FlagMap {
  return {
    "platform.enabled": flag("platform.enabled"),
    "platform.cloud": flag("platform.cloud"),
    "platform.billing": flag("platform.billing"),
  };
}

/** Runtime/test override. Pass `undefined` to clear a single flag. */
export function setFlag(name: FlagName, value: boolean | undefined): void {
  if (value === undefined) delete overrides[name];
  else overrides[name] = value;
}

/** Clear all in-memory overrides (test hygiene). */
export function resetFlags(): void {
  for (const k of Object.keys(overrides) as FlagName[]) delete overrides[k];
}
