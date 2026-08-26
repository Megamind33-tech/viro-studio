/**
 * Resolve a file from `public/` so it works under Vite's `base: "./"` and
 * under Electron `file://` loads. An absolute `/fonts/…` fetch from a file URL
 * lands on `file:///fonts/…` and silently 404s — which is how the type engine
 * used to boot with no face at all.
 */
export function publicAsset(path: string): string {
  const rel = path.replace(/^\/+/, "");
  if (typeof window === "undefined") return rel;
  return new URL(rel, window.location.href).href;
}
