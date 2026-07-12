// Himmelcad vendor patch: ambient module declarations for Vite's `?raw` and
// `?worker` import suffixes. Upstream three-loader used webpack's
// `require('./foo.vert')` pattern; we patched those to Vite-style imports so
// the source compiles under our Vite/tsc pipeline. tsc needs to see these
// wildcard modules as string-typed (`?raw`) or `Worker` constructors
// (`?worker`).
//
// We redeclare instead of `/// <reference types="vite/client" />` so this
// vendored package stays self-contained — it must compile against any
// downstream that doesn't ship vite client types.

declare module '*.vert?raw' {
  const src: string;
  export default src;
}

declare module '*.frag?raw' {
  const src: string;
  export default src;
}

declare module '*.glsl?raw' {
  const src: string;
  export default src;
}

declare module '*?worker' {
  const workerConstructor: { new (options?: WorkerOptions): Worker };
  export default workerConstructor;
}

declare module '*.worker.js?worker' {
  const workerConstructor: { new (options?: WorkerOptions): Worker };
  export default workerConstructor;
}
