export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent("export default new Proxy({}, { get: (_, key) => String(key) });")}`,
    };
  }
  return nextResolve(specifier, context);
}
