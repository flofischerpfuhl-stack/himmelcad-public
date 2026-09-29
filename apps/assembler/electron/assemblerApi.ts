/**
 * Shape of `window.assembler`, exposed by `preload.ts` via `contextBridge`.
 * Kept in its own module, deliberately without a `NodeJS` namespace
 * reference or an `electron` import, so the renderer's `global.d.ts` can
 * pull in the type without needing `@types/node` in the renderer's
 * TypeScript project.
 */
export type AssemblerPlatform =
  | 'aix'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'android'
  | 'cygwin'
  | 'netbsd'
  | 'haiku';

export interface AssemblerApi {
  readonly platform: AssemblerPlatform;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}
