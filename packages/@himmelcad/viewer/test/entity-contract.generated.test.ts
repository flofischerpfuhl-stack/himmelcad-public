import type {
  BuiltInEntityType,
  CanonicalEntity,
  GeometryObject,
} from '../src/kernel/generated/index.js';

const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const pointGeometry = {
  kind: 'point',
  position: { x: 10, y: 20, z: null },
} satisfies GeometryObject;

const entity = {
  id: 'point-1',
  revision: 1,
  typeId: 'hcad.point@1',
  name: 'Survey point',
  owner: null,
  layerIds: [],
  placement: null,
  representations: [
    {
      role: 'canonical',
      geometryRef: hash,
      authority: 'authoritative',
      dependencyHash: null,
    },
  ],
  componentsRef: hash,
  attributesRef: hash,
  relationsRef: hash,
  styleRef: null,
  schemaVersion: 1,
  versionHash: hash,
} satisfies CanonicalEntity;

const builtIn: BuiltInEntityType = 'hcad.elevation-surface@1';

// @ts-expect-error Unknown extension IDs remain EntityTypeId strings, not built-in IDs.
const invalidBuiltIn: BuiltInEntityType = 'vendor.custom@1';

// @ts-expect-error GeometryObject is a closed discriminated union from Rust.
const invalidGeometry: GeometryObject = { kind: 'triangle', indices: [] };

function pointX(geometry: GeometryObject): number {
  if (geometry.kind === 'point') {
    return geometry.position.x;
  }
  // @ts-expect-error Narrowing excludes point-only fields on every other variant.
  return geometry.position.x;
}

void pointGeometry;
void entity;
void builtIn;
void invalidBuiltIn;
void invalidGeometry;
void pointX;
