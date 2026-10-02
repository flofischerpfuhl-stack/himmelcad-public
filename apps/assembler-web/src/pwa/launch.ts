/**
 * How the installed app is started besides its plain URL (manifest, assembler/WEB.md §4):
 *
 * - shortcuts: `./?action=new` (empty project, Home closed) and `./?action=home`;
 * - share target: the service worker keeps shared files in a cache and opens
 *   `./?share-target=<n>`; they are imported (a project opens);
 * - file handlers: STEP/STL/3MF files launched with the app (`host/webHost.ts`
 *   opens projects itself and hands the rest to {@link importLaunchedFiles}).
 *
 * The query is removed from the address afterwards, so a reload does not repeat it.
 */
import { useAssemblerStore } from '../../../assembler/renderer/src/foundation/commands/store.js';
import { useInteropStore } from '../../../assembler/renderer/src/modules/interop/interopStore.js';
import { useWorkspaceStore } from '../../../assembler/renderer/src/interface/shell-ui/workspace.js';
import { setLaunchImporter, type LaunchedFile } from '../host/webHost.js';

/** The service worker's cache for shared files (`sw/sw.js`). */
export const SHARE_CACHE = 'hc-shared-files';

/** Resolves once the CAD kernel has loaded (or failed): imports need it. */
function kernelSettled(): Promise<void> {
  return new Promise((resolve) => {
    if (useAssemblerStore.getState().kernelStatus !== 'loading') {
      resolve();
      return;
    }
    const unsubscribe = useAssemblerStore.subscribe((state) => {
      if (state.kernelStatus === 'loading') return;
      unsubscribe();
      resolve();
    });
  });
}

/** Imports launched or shared files: a project opens; model files are added to the open project. */
export async function importLaunchedFiles(files: LaunchedFile[]): Promise<void> {
  if (files.length === 0) return;
  await kernelSettled();
  // The user asked for these files: Home steps aside (opening a project closes it as well).
  useWorkspaceStore.getState().setHomeOpen(false);
  await useInteropStore.getState().importFiles(files);
}

async function takeSharedFiles(): Promise<LaunchedFile[]> {
  if (!('caches' in window)) return [];
  const cache = await caches.open(SHARE_CACHE);
  const files: LaunchedFile[] = [];
  const keys = [...(await cache.keys())];
  keys.sort((a, b) => a.url.localeCompare(b.url, 'en', { numeric: true }));
  for (const request of keys) {
    const response = await cache.match(request);
    if (!response) continue;
    const name = decodeURIComponent(response.headers.get('X-File-Name') ?? 'Shared file');
    files.push({ name, bytes: new Uint8Array(await response.arrayBuffer()) });
  }
  await caches.delete(SHARE_CACHE);
  return files;
}

/** Applies the start URL's action and wires file-handler imports; call once at start. */
export function handleLaunch(): void {
  setLaunchImporter((files) => void importLaunchedFiles(files));
  const url = new URL(location.href);
  const action = url.searchParams.get('action');
  const shared = url.searchParams.has('share-target');
  if (!action && !shared) return;
  if (action === 'new') useWorkspaceStore.getState().setHomeOpen(false);
  else if (action === 'home') useWorkspaceStore.getState().setHomeOpen(true);
  url.searchParams.delete('action');
  url.searchParams.delete('share-target');
  history.replaceState(history.state, '', url.href);
  if (shared) void takeSharedFiles().then(importLaunchedFiles, () => undefined);
}
