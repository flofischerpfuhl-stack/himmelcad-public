/**
 * The command gate's project-file fields (assembler/MODULES.md §3
 * `fileFormatFields`): the Items organisation (`items`, `items.ts`) and the
 * reference meshes (`referenceMeshes`, `referenceMesh.ts`) — their `.hcasm`
 * shape, strict validators and position in the file, and the Items section
 * of Save/Open. Imported for its registrations by the product compositions
 * (`app/composition.ts`) and by the project lifecycle.
 *
 * Reference meshes are core document state (`store.loadDocument` takes
 * them), so the project lifecycle encodes/decodes them itself with
 * {@link encodeReferenceMeshes}/{@link decodeReferenceMeshes}.
 */
import { registerProjectFileField, type FileFieldHelpers } from '../document/format.js';
import { decodeMeshPayload, encodeMeshPayload } from '../document/meshCodec.js';
import { registerProjectSection } from '../document/projectSections.js';
import {
  EMPTY_ITEMS_META,
  isEmptyItemsMeta,
  itemsMetaSnapshot,
  useItemsStore,
  withoutAbsentStepFolders,
  type ItemsMeta,
} from './items.js';
import { useAssemblerStore } from './store.js';
import type { ReferenceMesh } from './referenceMesh.js';

/**
 * Items organisation (`items.ts`): body display names and folders.
 * Optional and additive — files without it load unchanged, older apps
 * ignore it (no schema bump needed: it never affects geometry).
 */
export type ProjectItems = ItemsMeta;

/**
 * One imported STL, persisted as gzip+base64 mesh data (`meshCodec.ts`)
 * plus its document-level transform and visibility. Never a `Feature`: a
 * reference mesh is not a kernel/OCCT input (`apps/assembler/README.md`
 * "STL import").
 */
export interface ReferenceMeshRecordV1 {
  id: string;
  name: string;
  fileName: string;
  /** gzip+base64 of positions/normals/indices, see `meshCodec.ts`. */
  data: string;
  min: [number, number, number];
  max: [number, number, number];
  transform: { dx: number; dy: number; dz: number };
  hidden: boolean;
  /** `#RRGGBB` colour from the imported file (3MF/OBJ); optional and additive. */
  color?: string;
}

declare module '../document/format.js' {
  interface ProjectFileFields {
    referenceMeshes?: ReferenceMeshRecordV1[];
    items?: ProjectItems;
  }
}

// ---- validation ------------------------------------------------------------------

function validateVec3Tuple(
  v: unknown,
  path: string,
  h: FileFieldHelpers,
): [number, number, number] {
  if (!h.isVec3(v)) h.fail(path, 'expected a Vec3');
  return v;
}

function validateReferenceMesh(
  v: unknown,
  index: number,
  h: FileFieldHelpers,
): ReferenceMeshRecordV1 {
  const path = `referenceMeshes[${index}]`;
  if (!h.isRecord(v)) h.fail(path, 'expected an object');
  const r = v;
  if (!h.isString(r.id) || r.id === '') h.fail(`${path}.id`, 'expected a non-empty string');
  if (!h.isString(r.name)) h.fail(`${path}.name`, 'expected a string');
  if (!h.isString(r.fileName)) h.fail(`${path}.fileName`, 'expected a string');
  if (!h.isString(r.data) || r.data === '') {
    h.fail(`${path}.data`, 'expected a non-empty string');
  }
  const min = validateVec3Tuple(r.min, `${path}.min`, h);
  const max = validateVec3Tuple(r.max, `${path}.max`, h);
  if (!h.isRecord(r.transform)) h.fail(`${path}.transform`, 'expected an object');
  const t = r.transform;
  for (const field of ['dx', 'dy', 'dz']) {
    if (!h.isNumber(t[field])) h.fail(`${path}.transform.${field}`, 'expected a number');
  }
  if (!h.isBoolean(r.hidden)) h.fail(`${path}.hidden`, 'expected a boolean');
  if (r.color !== undefined && (!h.isString(r.color) || !/^#[0-9a-fA-F]{6}$/.test(r.color))) {
    h.fail(`${path}.color`, 'expected a "#RRGGBB" string');
  }
  return {
    id: r.id,
    name: r.name,
    fileName: r.fileName,
    data: r.data,
    min,
    max,
    transform: { dx: t.dx as number, dy: t.dy as number, dz: t.dz as number },
    hidden: r.hidden,
    ...(r.color !== undefined ? { color: r.color as string } : {}),
  };
}

function validateStringRecord(
  v: unknown,
  path: string,
  h: FileFieldHelpers,
): Record<string, string> {
  if (!h.isRecord(v)) h.fail(path, 'expected an object');
  for (const [key, value] of Object.entries(v)) {
    if (!h.isString(value)) h.fail(`${path}.${key}`, 'expected a string');
  }
  return v as Record<string, string>;
}

function validateItems(v: unknown, h: FileFieldHelpers): ProjectItems {
  if (!h.isRecord(v)) h.fail('items', 'expected an object');
  const names = validateStringRecord(v.names ?? {}, 'items.names', h);
  const parent = validateStringRecord(v.parent ?? {}, 'items.parent', h);
  const folders = v.folders ?? [];
  if (!Array.isArray(folders)) h.fail('items.folders', 'expected an array');
  const ids = new Set<string>();
  const checked = folders.map((f: unknown, i) => {
    const path = `items.folders[${i}]`;
    if (!h.isRecord(f)) h.fail(path, 'expected an object');
    if (!h.isString(f.id) || f.id === '') h.fail(`${path}.id`, 'expected a non-empty string');
    if (ids.has(f.id)) h.fail(`${path}.id`, `duplicate folder id "${f.id}"`);
    ids.add(f.id);
    if (!h.isString(f.name)) h.fail(`${path}.name`, 'expected a string');
    if (f.collapsed !== undefined && !h.isBoolean(f.collapsed)) {
      h.fail(`${path}.collapsed`, 'expected a boolean');
    }
    // Optional, additive (Block 9): the step a folder was made for (Pattern copies).
    if (f.featureId !== undefined && (!h.isString(f.featureId) || f.featureId === '')) {
      h.fail(`${path}.featureId`, 'expected a non-empty string');
    }
    return {
      id: f.id,
      name: f.name,
      collapsed: f.collapsed === true,
      ...(f.featureId !== undefined ? { featureId: f.featureId as string } : {}),
    };
  });
  return { names, folders: checked, parent };
}

// Written before `viewState` (reference meshes) and after it (items), as always.
registerProjectFileField({
  key: 'referenceMeshes',
  module: 'commands',
  order: 100,
  validate: (raw: unknown, h: FileFieldHelpers) => {
    if (!Array.isArray(raw)) h.fail('referenceMeshes', 'expected an array');
    const meshes = raw.map((m, i) => validateReferenceMesh(m, i, h));
    const ids = new Set<string>();
    for (const m of meshes) {
      if (ids.has(m.id)) h.fail('referenceMeshes', `duplicate reference mesh id "${m.id}"`);
      ids.add(m.id);
    }
    return meshes;
  },
  include: (meshes) => meshes.length > 0,
});

registerProjectFileField({
  key: 'items',
  module: 'commands',
  order: 300,
  validate: validateItems,
});

// ---- reference mesh payloads ------------------------------------------------------

/** Encodes every reference mesh's triangle data (gzip+base64, `meshCodec.ts`) for the `.hcasm` file. */
export async function encodeReferenceMeshes(
  meshes: readonly ReferenceMesh[],
): Promise<ReferenceMeshRecordV1[]> {
  return Promise.all(
    meshes.map(async (m) => ({
      id: m.id,
      name: m.name,
      fileName: m.fileName,
      data: await encodeMeshPayload({
        positions: m.positions,
        normals: m.normals,
        indices: m.indices,
      }),
      min: m.min,
      max: m.max,
      transform: { ...m.transform },
      hidden: m.hidden,
      ...(m.color ? { color: m.color } : {}),
    })),
  );
}

/**
 * Inverse of {@link encodeReferenceMeshes}; propagates `MeshPayloadTooLargeError`
 * so a load that exceeds the size limit is rejected with a clear message,
 * never a silent partial load.
 */
export async function decodeReferenceMeshes(
  records: readonly ReferenceMeshRecordV1[],
): Promise<ReferenceMesh[]> {
  return Promise.all(
    records.map(async (r) => {
      const buffers = await decodeMeshPayload(r.data);
      return {
        id: r.id,
        name: r.name,
        fileName: r.fileName,
        positions: buffers.positions,
        normals: buffers.normals,
        indices: buffers.indices,
        min: r.min,
        max: r.max,
        transform: { ...r.transform },
        hidden: r.hidden,
        ...(r.color ? { color: r.color } : {}),
      } satisfies ReferenceMesh;
    }),
  );
}

// ---- the Items section of Save/Open -----------------------------------------------

registerProjectSection({
  id: 'commands.items',
  order: 150,
  save: () => {
    // Folders of steps that are gone (undone/deleted) are not written: no undo brings them back.
    const live = new Set(useAssemblerStore.getState().features.map((f) => f.id));
    const items = withoutAbsentStepFolders(itemsMetaSnapshot(useItemsStore.getState()), live);
    return isEmptyItemsMeta(items) ? {} : { fields: { items } };
  },
  load: (project) => useItemsStore.getState().setItemsMeta(project?.items ?? EMPTY_ITEMS_META),
  subscribe: (onChange) =>
    useItemsStore.subscribe((state, prev) => {
      if (
        state.names !== prev.names ||
        state.folders !== prev.folders ||
        state.parent !== prev.parent
      ) {
        onChange();
      }
    }),
});
