/**
 * Reference mesh: an imported STL shown and measured alongside kernel
 * bodies, but never an input to OCCT/kernel operations
 * (`apps/assembler/README.md` "STL import"). Lives outside `features` /
 * the undo-tracked feature history — importing, hiding or moving one is a
 * document-level edit, not a modelling step.
 */
import type { Body } from '../foundation/geometry-kernel/types.js';
import type { ParsedStl } from '../kernel/stlImport.js';

export interface ReferenceMeshTransform {
  dx: number;
  dy: number;
  dz: number;
}

export const IDENTITY_TRANSFORM: ReferenceMeshTransform = { dx: 0, dy: 0, dz: 0 };

export interface ReferenceMesh {
  id: string;
  name: string;
  fileName: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Bounding box of the mesh in its own (untransformed) coordinates. */
  min: [number, number, number];
  max: [number, number, number];
  transform: ReferenceMeshTransform;
  hidden: boolean;
  /** Display colour from the file (3MF material, OBJ vertex colours), `#RRGGBB`; absent = the reference slate. */
  color?: string;
}

/** Colour of reference meshes without their own. */
export const REFERENCE_MESH_COLOR = '#8890a0';

/** `body:` id prefix reserved for kernel bodies; reference meshes use this one so the two id spaces never collide. */
export const REFERENCE_MESH_ID_PREFIX = 'mesh:';

export function referenceMeshBodyId(id: string): string {
  return id.startsWith(REFERENCE_MESH_ID_PREFIX) ? id : `${REFERENCE_MESH_ID_PREFIX}${id}`;
}

export function isReferenceMeshBodyId(bodyId: string): boolean {
  return bodyId.startsWith(REFERENCE_MESH_ID_PREFIX);
}

/** The reference mesh id behind a rendered `mesh:` body id, or `null` for a kernel body. */
export function referenceMeshIdOf(bodyId: string): string | null {
  return isReferenceMeshBodyId(bodyId) ? bodyId.slice(REFERENCE_MESH_ID_PREFIX.length) : null;
}

export function referenceMeshFromParsedStl(input: {
  id: string;
  name: string;
  fileName: string;
  parsed: ParsedStl;
}): ReferenceMesh {
  return {
    id: input.id,
    name: input.name,
    fileName: input.fileName,
    positions: input.parsed.positions,
    normals: input.parsed.normals,
    indices: input.parsed.indices,
    min: input.parsed.min,
    max: input.parsed.max,
    transform: { ...IDENTITY_TRANSFORM },
    hidden: false,
  };
}

/** World-space (transform-applied) bounding box, for measurement panels. */
export function referenceMeshWorldBounds(mesh: ReferenceMesh): {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
} {
  const { dx, dy, dz } = mesh.transform;
  const min: [number, number, number] = [mesh.min[0] + dx, mesh.min[1] + dy, mesh.min[2] + dz];
  const max: [number, number, number] = [mesh.max[0] + dx, mesh.max[1] + dy, mesh.max[2] + dz];
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, size };
}

/**
 * Renders/exports a reference mesh through the same pipelines as a kernel
 * `Body` (viewport draw, STL/3MF export): a synthetic `Body` with the
 * transform baked into its positions, one whole-mesh "face" (so picking
 * resolves to the whole mesh, never a single triangle) and no edges (no
 * edge selection on a reference mesh). `faces`/`edges`/`valid`/`volume` are
 * placeholders — nothing downstream reads them for a `mesh:`-id body except
 * `expandBody`'s single full-mesh face range.
 */
export function referenceMeshToBody(mesh: ReferenceMesh): Body {
  // Memoized per (immutable) mesh record: the viewport keys its GPU buffers and
  // derived data by the body's mesh identity, so a new body every frame would
  // re-upload and re-derive a large STL on every redraw.
  const cached = bodyCache.get(mesh);
  if (cached) return cached;
  const body = buildReferenceMeshBody(mesh);
  bodyCache.set(mesh, body);
  return body;
}

const bodyCache = new WeakMap<ReferenceMesh, Body>();

function buildReferenceMeshBody(mesh: ReferenceMesh): Body {
  const { dx, dy, dz } = mesh.transform;
  const positions =
    dx === 0 && dy === 0 && dz === 0 ? mesh.positions : translateFlat(mesh.positions, dx, dy, dz);
  const { min, max } = referenceMeshWorldBounds(mesh);
  const triangleCount = mesh.indices.length / 3;
  return {
    id: referenceMeshBodyId(mesh.id),
    name: mesh.name,
    // A distinct, slightly desaturated slate — deliberately unlike the
    // saturated per-body palette kernel solids get, so a reference mesh
    // reads as "not a solid" at a glance — unless the file gave it a colour.
    color: mesh.color ?? REFERENCE_MESH_COLOR,
    createdBy: mesh.id,
    min,
    max,
    volume: 0,
    valid: true,
    mesh: {
      positions,
      normals: mesh.normals,
      indices: mesh.indices,
      triangleFaces: new Uint32Array(triangleCount),
    },
    faces: [
      {
        key: `${mesh.id}#mesh`,
        aliases: [],
        surface: 'other',
        normal: null,
        centroid: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        area: 0,
        triangleStart: 0,
        triangleCount,
        edgeIndices: [],
        adjacentFaces: 0,
      },
    ],
    edges: [],
  };
}

function translateFlat(positions: Float32Array, dx: number, dy: number, dz: number): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! + dx;
    out[i + 1] = positions[i + 1]! + dy;
    out[i + 2] = positions[i + 2]! + dz;
  }
  return out;
}
