/**
 * Module resolution hook for Node.js native ESM.
 * Resolves extensionless TypeScript and JavaScript imports from generated bindings.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const recoverable =
      error &&
      typeof error === 'object' &&
      (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT');
    if (recoverable) {
      // Generated bindings sometimes import a bare directory name ("../types") that
      // has both a .ts file and a directory of the same name; Node ESM refuses the
      // directory, so try the file, then an index inside it.
      const candidates = ['.ts', '.js', '/index.ts', '/index.js'];
      for (const extension of candidates) {
        try {
          return await nextResolve(specifier + extension, context);
        } catch {}
      }
    }
    throw error;
  }
}
