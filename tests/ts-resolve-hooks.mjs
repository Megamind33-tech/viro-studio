/**
 * ESM resolve hook so node:test can import the app's TypeScript directly.
 *
 * The source uses extensionless relative imports ("./factory"), which Vite
 * resolves but node does not. Rewriting every import in src/ purely to satisfy
 * the test runner would be the tail wagging the dog, so the runner adapts
 * instead: on a failed relative resolution, try the .ts sibling.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
