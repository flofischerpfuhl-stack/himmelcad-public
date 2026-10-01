/**
 * The platform host (contract in `host.ts`). {@link host} returns what the
 * product installed with {@link installHost}; without an install it picks
 * the desktop bridge when `window.assembler` exists (the Electron app) and
 * the plain browser host otherwise (`pnpm dev:web`, tests under Node).
 */
import { createBrowserHost } from './browserHost.js';
import { createDesktopHost, desktopBridge } from './desktopHost.js';
import type { AssemblerHost } from './host.js';

export type * from './host.js';
export {
  browserFiles,
  downloadBlob,
  inertWindow,
  localStorageRecovery,
  pickBinaryFile,
  pickTextFile,
} from './browserHost.js';

let installed: AssemblerHost | null = null;
let desktop: { bridge: NonNullable<ReturnType<typeof desktopBridge>>; host: AssemblerHost } | null =
  null;
let browser: AssemblerHost | null = null;

/**
 * Installs the product's host. The web product calls it from its first
 * import, before the module composition: stores read host capabilities
 * (`slicers`, `automation`) when they are created.
 */
export function installHost(next: AssemblerHost): void {
  installed = next;
}

/**
 * The current platform host. Without an install the choice follows
 * `window.assembler` on every call (tests stub the bridge after the modules
 * were imported), one adapter per bridge object.
 */
export function host(): AssemblerHost {
  if (installed) return installed;
  const bridge = desktopBridge();
  if (bridge) {
    if (desktop?.bridge !== bridge) desktop = { bridge, host: createDesktopHost(bridge) };
    return desktop.host;
  }
  browser ??= createBrowserHost();
  return browser;
}
