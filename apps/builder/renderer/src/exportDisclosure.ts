import type { EntityKind } from '@himmelcad/data';

import type { IoFormatDescriptor } from '@himmelcad/app';

interface ExportFormatChoiceShape {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

interface ExportPlanRowShape {
  readonly entityKind: string;
  readonly count: number;
  readonly writtenAs: string;
  readonly lossNote: string | null;
  readonly lossCodes: readonly string[];
}

export interface ExportDisclosureEntity {
  readonly kind: EntityKind;
  readonly label?: string;
}

export function exportFormatChoices(
  descriptors: readonly IoFormatDescriptor[],
  kinds: readonly EntityKind[],
): readonly ExportFormatChoiceShape[] {
  const order = ['DXF', 'LandXML', 'IFC', 'GeoTIFF', 'splat'];
  const choices = descriptors.flatMap((descriptor) =>
    descriptor.formatIds.map((id) => {
      const label = exportFormatLabel(id);
      const reason = disabledReason(label, kinds);
      return {
        id,
        label,
        enabled: reason === null,
        ...(reason ? { disabledReason: reason } : {}),
      };
    }),
  );
  return choices
    .filter(
      (choice, index) =>
        choices.findIndex((candidate) => candidate.label === choice.label) === index,
    )
    .sort((left, right) => order.indexOf(left.label) - order.indexOf(right.label));
}

export function exportDisclosureRows(
  entities: readonly ExportDisclosureEntity[],
  formatId: string,
  losses: readonly string[],
): readonly ExportPlanRowShape[] {
  const counts = new Map<string, { kind: EntityKind; label: string; count: number }>();
  for (const entity of entities) {
    const label = entity.label ?? humanKind(entity.kind);
    const key = `${entity.kind}\u0000${label}`;
    const current = counts.get(key);
    counts.set(key, { kind: entity.kind, label, count: (current?.count ?? 0) + 1 });
  }
  const omitted = losses.filter((loss) =>
    /omitted|unsupported-entity|not-passthrough|selection/u.test(loss),
  );
  const shared = losses.filter((loss) => !omitted.includes(loss));
  const hasOmittedRow = [...counts.values()].some(
    (entity) => writtenAsKind(formatId, entity.kind) === 'not written',
  );
  return [...counts.values()].map(({ kind, label, count }, index) => {
    const writtenAs = writtenAsKind(formatId, kind);
    const rowLosses = [
      ...(writtenAs === 'not written' || (index === 0 && !hasOmittedRow) ? omitted : []),
      ...(index === 0 ? shared : []),
    ];
    return {
      entityKind: label,
      count,
      writtenAs,
      lossNote: rowLosses.length > 0 ? rowLosses.map(lossSentence).join('; ') : null,
      lossCodes: rowLosses,
    };
  });
}

export function exportFormatLabel(formatId: string): string {
  const value = formatId.toLowerCase();
  if (value.includes('landxml')) return 'LandXML';
  if (value.includes('dxf')) return 'DXF';
  if (value.includes('ifc')) return 'IFC';
  if (value.includes('geotiff')) return 'GeoTIFF';
  if (value.includes('splat')) return 'splat';
  return formatId;
}

function disabledReason(format: string, kinds: readonly EntityKind[]): string | null {
  const has = (...supported: EntityKind[]): boolean =>
    kinds.some((kind) => supported.includes(kind));
  if (
    format === 'DXF' &&
    !has('SinglePoint', 'Polyline3D', 'Surface', 'Mesh', 'TexturedMesh', 'Text')
  ) {
    return 'DXF writes points, curves, text, and triangulated surfaces; this scope contains none.';
  }
  if (
    format === 'LandXML' &&
    !has('SinglePoint', 'Polyline3D', 'Surface', 'DigitalElevationModel', 'AlignmentElement')
  ) {
    return 'LandXML writes survey points, plan features, alignments, and elevation surfaces.';
  }
  if (format === 'IFC' && !has('IfcElement'))
    return 'IFC export is available only for an unchanged IFC import scope.';
  if (format === 'GeoTIFF' && !has('Orthomosaic', 'DigitalElevationModel')) {
    return 'GeoTIFF export is available only for an unchanged GeoTIFF raster import scope.';
  }
  if (format === 'splat' && !has('GaussianSplatCloud')) {
    return 'Splat export is available only for an unchanged Gaussian-splat import scope.';
  }
  return null;
}

function writtenAsKind(formatId: string, kind: EntityKind): string {
  const format = exportFormatLabel(formatId);
  if (format === 'DXF') {
    if (kind === 'SinglePoint') return 'POINT';
    if (kind === 'Polyline3D') return '3D POLYLINE';
    if (kind === 'Text') return 'TEXT / MTEXT';
    if (kind === 'Surface' || kind === 'Mesh' || kind === 'TexturedMesh')
      return '3DFACE + breaklines';
    return 'not written';
  }
  if (format === 'LandXML') {
    if (kind === 'SinglePoint') return 'CgPoint';
    if (kind === 'Polyline3D') return 'PlanFeature';
    if (kind === 'Surface' || kind === 'DigitalElevationModel') return 'TIN Surface';
    if (kind === 'AlignmentElement') return 'Alignment';
    return 'not written';
  }
  if (format === 'IFC') return kind === 'IfcElement' ? 'original IFC entity' : 'not written';
  if (format === 'GeoTIFF') {
    return kind === 'Orthomosaic' || kind === 'DigitalElevationModel'
      ? 'original raster'
      : 'not written';
  }
  if (format === 'splat') {
    return kind === 'GaussianSplatCloud' ? 'original splat' : 'not written';
  }
  return 'not written';
}

function lossSentence(code: string): string {
  if (/entity-omitted|export-unsupported-entity/u.test(code))
    return 'Geometry is not representable and is omitted';
  if (/metadata-not-representable|export-metadata/u.test(code)) {
    return code.includes('.dxf.')
      ? 'CRS metadata, layers, styles, recipes, and provenance are dropped'
      : 'Non-format styles, recipes, and provenance are dropped';
  }
  if (/canonical-identity/u.test(code)) {
    return 'Coordinates are written without a CRS transform; canonical IDs and revisions are dropped';
  }
  if (/mesh-entity-partition/u.test(code)) return 'TIN is written as separate faces';
  if (/composite-identity/u.test(code)) return 'Composite curve identity is flattened';
  if (/not-passthrough|selection/u.test(code)) return 'Exact source passthrough is unavailable';
  return code;
}

function humanKind(kind: EntityKind): string {
  return kind.replace(/([a-z])([A-Z])/gu, '$1 $2');
}
