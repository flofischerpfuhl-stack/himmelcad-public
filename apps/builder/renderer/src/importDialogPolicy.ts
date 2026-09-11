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

export interface ImportPlacementMetadata {
  readonly declaredCrs: string | null;
  readonly declaredUnits: string | null;
}

/** Reads declared coordinate truth from the canonical import preview. */
export function importPlacementMetadata(sourcePreview: unknown): ImportPlacementMetadata {
  const package_ = isRecord(sourcePreview) ? sourcePreview : {};
  const objects = Array.isArray(package_.objects) ? package_.objects : [];
  for (const object of objects.filter(isRecord)) {
    const value = isRecord(object.value) ? object.value : {};
    const pointCloud = isRecord(value['hcad.point-cloud-import@1'])
      ? value['hcad.point-cloud-import@1']
      : null;
    const source = pointCloud && isRecord(pointCloud.source) ? pointCloud.source : null;
    if (source) {
      return {
        declaredCrs: stringValue(source.declaredCrs),
        declaredUnits: stringValue(source.declaredUnits),
      };
    }
    const landXml = isRecord(value['hcad.landxml-import@1'])
      ? value['hcad.landxml-import@1']
      : null;
    const document = landXml && isRecord(landXml.document) ? landXml.document : null;
    const units = document && isRecord(document.units) ? document.units : null;
    if (units) {
      return {
        declaredCrs: null,
        declaredUnits: stringValue(units.linearUnit),
      };
    }
  }
  return { declaredCrs: null, declaredUnits: null };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
