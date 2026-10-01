/**
 * The parts of the File System Access API the web host uses (Chromium:
 * Chrome, Edge, Opera, desktop and Android). TypeScript's DOM library does
 * not declare the pickers and the permission calls yet, so they are typed
 * here. Safari and Firefox lack the pickers; the host then uses upload and
 * download instead (`foundation/host/browserHost.ts`).
 */

export interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface OpenPickerOptions {
  id?: string;
  types?: PickerType[];
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
}

interface SavePickerOptions {
  id?: string;
  suggestedName?: string;
  types?: PickerType[];
  excludeAcceptAllOption?: boolean;
}

type PermissionMode = { mode: 'read' | 'readwrite' };

/** A file handle with the permission calls Chromium implements. */
export interface FileHandle extends FileSystemFileHandle {
  queryPermission?(descriptor: PermissionMode): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionMode): Promise<PermissionState>;
}

interface PickerWindow {
  showOpenFilePicker?(options?: OpenPickerOptions): Promise<FileHandle[]>;
  showSaveFilePicker?(options?: SavePickerOptions): Promise<FileHandle>;
}

function pickerWindow(): PickerWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as PickerWindow);
}

/** `true` where the open and save pickers exist (and the page is a secure context). */
export function hasFileSystemAccess(): boolean {
  const w = pickerWindow();
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof w?.showOpenFilePicker === 'function' &&
    typeof w.showSaveFilePicker === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

/** The user dismissed a picker. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * The browser refused a picker because the click that started the action is
 * too long ago (transient user activation, ~5 s in Chromium), or the page is
 * not allowed to show one (cross-origin frame). The caller falls back to a
 * download.
 */
export function isActivationError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'SecurityError' || error.name === 'NotAllowedError')
  );
}

export const PROJECT_TYPES: PickerType[] = [
  {
    description: 'Himmel:CAD Assembler project',
    accept: { 'application/vnd.himmelcad.assembler+json': ['.hcasm'] },
  },
];

/** Picker types for an export from the host's `{ name, extensions }` filters. */
export function exportTypes(
  filters: { name: string; extensions: string[] }[],
  mimeType: string,
): PickerType[] {
  return filters
    .filter((filter) => filter.extensions.length > 0)
    .map((filter) => ({
      description: filter.name,
      accept: { [mimeType || 'application/octet-stream']: filter.extensions.map((e) => `.${e}`) },
    }));
}

export async function showOpenPicker(options: OpenPickerOptions): Promise<FileHandle | null> {
  try {
    const [handle] = await pickerWindow()!.showOpenFilePicker!(options);
    return handle ?? null;
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}

export async function showSavePicker(options: SavePickerOptions): Promise<FileHandle | null> {
  try {
    return await pickerWindow()!.showSaveFilePicker!(options);
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
}

/**
 * Read/write permission for a remembered handle. Asking needs a user
 * gesture (the click on a recent project, Save); `false` when refused.
 */
export async function ensurePermission(
  handle: FileHandle,
  mode: 'read' | 'readwrite',
): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  try {
    return (await handle.requestPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

/** Writes `data` through the handle; the browser replaces the file atomically on close. */
export async function writeHandle(handle: FileHandle, data: string | Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(typeof data === 'string' ? data : new Uint8Array(data));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}
