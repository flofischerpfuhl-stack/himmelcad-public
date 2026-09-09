import type { RegistrationRecipeMethod } from '@himmelcad/app';

export interface ImportFormatDescriptor {
  readonly extensions: readonly string[];
}

/** Stable, dialog-safe extension catalog derived from the registered readers. */
export function registeredImportExtensions(
  formats: readonly ImportFormatDescriptor[],
): readonly string[] {
  return [
    ...new Set(
      formats
        .flatMap((format) => format.extensions)
        .map((extension) => extension.replace(/^\./, '').toLowerCase())
        .filter((extension) => /^[a-z0-9]{1,12}$/.test(extension)),
    ),
  ].sort();
}

/** Electron 32+ resolves dropped File objects through webUtils, not File.path. */
export function droppedImportPaths(
  files: readonly File[],
  pathForFile: (file: File) => string,
): readonly string[] {
  return files.map(pathForFile).filter((path) => path.trim().length > 0);
}

/** The modal remains only while the registration workflow still needs user input. */
export function importStageNeedsFurtherInput(
  methodKind: RegistrationRecipeMethod['kind'],
): boolean {
  return methodKind !== 'sourceCoordinates';
}
