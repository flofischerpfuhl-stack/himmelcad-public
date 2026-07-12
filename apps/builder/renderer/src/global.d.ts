import type { HimmelCADApi } from '../../electron/preload';

declare global {
  interface Window {
    himmelcad?: HimmelCADApi;
  }
}

export {};
