/**
 * The import/export part of the agent contract (`hcasm.agent-api@1`):
 * method schemas (merged into `schema.ts` `METHODS`) and their handlers,
 * which `session.ts` runs with its own write/deliver/read helpers so every
 * change takes the same commit path (validation, undo, transactions) as
 * the other commands. The document edits themselves are shared with the UI
 * (`interop/importActions.ts`).
 */
import { parseDxfBytes, parseMeshFile, prepareMeshForSolid } from '../interop/importParsers.js';
import {
  bytesToBase64,
  describeMeshCheck,
  dxfSketchFeature,
  dxfUnits,
  importStepFeature,
  meshSolidFeature,
  referenceMeshWorldPositions,
  referenceMeshesFromImport,
} from '../interop/importActions.js';
import { writeDxf, type DxfVersion } from '../interop/dxf.js';
import { faceOutlineToDxfEntities, sketchToDxfEntities } from '../interop/dxfSketch.js';
import { fileRowsIntoFolders, notifyAssemblyImported } from '../interop/importFolders.js';
import { STEP_EXPORT_FORMATS, INTEROP_FORMATS } from '../interop/formats.js';
import { suggestStlUnitHint } from '../kernel/stlImport.js';
import type { StepExportOptions } from '../foundation/geometry-kernel/stepExport.js';
import type {
  EvaluationResult,
  KernelFormatCapabilities,
} from '../foundation/geometry-kernel/types.js';
import type { Feature, SketchPlaneRef } from '../foundation/document/document.js';
import { meshRowKey } from '../interface/shell-ui/items.js';
import { referenceMeshBodyId, referenceMeshIdOf } from '../model/referenceMesh.js';
import type { AssemblerState, SelectionItem } from '../foundation/commands/store.js';
import { detectRegions } from '../foundation/sketch-solver/regions.js';
import { ApiError } from '../foundation/commands/api/errors.js';
import { resolveFaceInput } from '../foundation/commands/api/references.js';

import type { MethodSpec } from '../foundation/commands/api/contract.js';
import type { JsonSchema } from '../foundation/commands/api/validate.js';

type Json = Record<string, unknown>;

const str: JsonSchema = { type: 'string', minLength: 1 };
const revision: JsonSchema = {
  type: 'integer',
  minimum: 0,
  description:
    'Optimistic concurrency: the command fails with `conflict` unless the document revision still equals this value.',
};
const scope: JsonSchema = {
  enum: ['auto', 'committed', 'staged'],
  default: 'auto',
  description: "`auto`: the open transaction's staged state if any, else the committed document.",
};
const filePath: JsonSchema = {
  type: 'string',
  minLength: 1,
  description: 'Headless only (filesystem.read).',
};
const outPath: JsonSchema = {
  type: 'string',
  minLength: 1,
  description: 'Headless only (capability filesystem.write). Omit to receive base64 bytes.',
};

/** Params of a file input: `path` (headless) or base64 `data` + `fileName`. */
function fileInput(extra: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties: {
      path: filePath,
      data: { type: 'string', minLength: 1, description: 'Base64 file bytes.' },
      fileName: str,
      ...extra,
    },
    additionalProperties: false,
    anyOf: [{ required: ['path'] }, { required: ['data', 'fileName'] }],
  };
}

export const STEP_IMPORT_STRUCTURE: JsonSchema = {
  enum: ['assembly', 'single'],
  default: 'assembly',
  description:
    '`assembly`: one body per placed part, named and coloured from the file, with its assembly folder path (`itemPath`; the app files them into Items folders). `single`: the whole file as one body (the behaviour before assemblies).',
};

export const STEP_EXPORT_PARAMS: Record<string, JsonSchema> = {
  schema: {
    enum: ['AP242', 'AP214'],
    default: 'AP242',
    description: 'Application protocol: AP242 DIS or AP214 IS (OCCT write.step.schema 5/4).',
  },
  unit: {
    enum: ['mm', 'cm', 'm', 'in'],
    default: 'mm',
    description: 'Length unit written to the file (geometry is converted, not rescaled).',
  },
  structure: {
    enum: ['flat', 'folders'],
    default: 'flat',
    description:
      '`flat`: every body a top-level part. `folders`: an assembly named after the project whose sub-assemblies are the Items folders (app).',
  },
  visibleOnly: {
    type: 'boolean',
    default: false,
    description: 'Leave out bodies hidden in the app (Items eye).',
  },
};

export const INTEROP_METHODS: Record<string, MethodSpec> = {
  'interop.formats': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Import and export formats with what each keeps (structure, names, colours, units) and whether the loaded kernel supports it (IGES and the XCAF STEP reader only with the HimmelCAD OCCT build).',
    params: { type: 'object', properties: {}, additionalProperties: false },
    result:
      '{import: [{format, extensions, target, available, reason?, keeps}], export: [...], kernel}',
  },
  'import.iges': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Imports an IGES file as one "Import" history step: surfaces are sewn and every closed shell becomes a solid body (open ones stay surface bodies, with a warning); named after the file; unit converted to mm. Needs the HimmelCAD OCCT build (interop.formats reports it); `unsupported` otherwise.',
    params: fileInput({ expectedRevision: revision }),
    result:
      '{featureId, createdBodyIds, parts: [{bodyId, name, color}], warnings?, revision, committed, errors}',
  },
  'import.mesh': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Imports an STL, 3MF or OBJ file as reference meshes (shown, measured and exported, never kernel inputs; `mesh.toSolid` converts one). 3MF: one mesh per build item, transforms baked, the declared unit converted to mm, colours; OBJ: one mesh per group. Unitless formats get a `unitHint` when the size suggests metres or inches (never applied silently).',
    params: fileInput({}),
    result:
      '{format, meshes: [{meshId, bodyId, name, color?, folder, triangles, min, max}], declaredUnit, unitScale, unitHint?, warnings}',
  },
  'import.dxf': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Imports a DXF drawing (lines, arcs, circles, polylines with bulges, splines, ellipses, points, block inserts) as a new sketch on a plane or planar face; end points are connected (coincident) unless `connect: false`. Units: $INSUNITS, else read as mm (reported), or `unitScale` (mm per drawing unit).',
    params: fileInput({
      plane: { enum: ['XY', 'XZ', 'YZ'], default: 'XY' },
      offset: { type: 'number', default: 0, description: 'Plane offset, mm.' },
      face: { $ref: '#/$defs/FaceInput', description: 'A planar face instead of a plane.' },
      connect: { type: 'boolean', default: true },
      unitScale: { type: 'number', exclusiveMinimum: 0 },
      name: str,
      expectedRevision: revision,
    }),
    result:
      '{featureId, curves, points, connected, approximated, skipped, units: {scale, source, label}, regions, revision, committed}',
  },
  'export.dxf': {
    kind: 'command',
    capability: 'document.read',
    summary:
      'DXF (R2000 default, or R12) of a sketch (`sketchId`, in sketch coordinates; construction on layer CONSTRUCTION) or of a planar face outline (`face`, in the face sketch frame).',
    params: {
      type: 'object',
      properties: {
        sketchId: str,
        face: { $ref: '#/$defs/FaceInput' },
        version: { enum: ['R2000', 'R12'], default: 'R2000' },
        includeConstruction: { type: 'boolean', default: true },
        path: outPath,
        scope,
      },
      additionalProperties: false,
      oneOf: [{ required: ['sketchId'] }, { required: ['face'] }],
    },
    result: '{mediaType, byteLength, entities, data?: base64, path?}',
  },
  'mesh.toSolid': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Converts a closed, manifold reference mesh into a B-rep solid (one "Mesh to Solid" step; coplanar triangles merged into planar faces) so kernel tools can modify it. Refuses open, non-manifold, multi-part or too large meshes with the reason. The mesh is hidden, not deleted.',
    params: {
      type: 'object',
      properties: {
        meshId: { ...str, description: 'Reference mesh id (or its `mesh:` body id).' },
        name: str,
        hideMesh: { type: 'boolean', default: true },
        expectedRevision: revision,
      },
      required: ['meshId'],
      additionalProperties: false,
    },
    result:
      '{featureId, bodyId, check: {triangles, faces, flipped, inverted, volume}, summary, revision, committed}',
  },
};

/** What the handlers need of the session. */
export interface InteropContext {
  state(): AssemblerState;
  readFile(p: Json, fallbackName: string): Promise<{ bytes: Uint8Array; fileName: string }>;
  write(
    method: string,
    mutate: (features: Feature[], evaluation: EvaluationResult) => WriteLike | Promise<WriteLike>,
  ): Promise<Json>;
  deliver(bytes: Uint8Array, mediaType: string, path: unknown): Promise<Json>;
  readEvaluation(p: Json): Promise<EvaluationResult>;
  readFeatures(p: Json): Feature[];
  allocateFeatureId(kind: string): string;
  nextFeatureName(prefix: string, features: readonly Feature[]): string;
  ensureWritable(): void;
  capabilities(): KernelFormatCapabilities | null;
  /** Resolves once the kernel is loaded (capabilities are known then). */
  kernelReady(): Promise<void>;
}

/** Why IGES is unavailable on the default OCCT module. */
export const IGES_UNAVAILABLE =
  'IGES is not in this build: the CAD kernel (replicad-opencascadejs 1.1.0) has no IGES reader or writer. It needs the HimmelCAD OCCT build (HIMMELCAD_OCCT=himmelcad).';

export interface WriteLike {
  features: Feature[];
  touched: string[];
  selection?: SelectionItem[];
  result: Json;
}

export async function interopFormats(ctx: InteropContext): Promise<Json> {
  // Capabilities are reported by the loaded kernel: wait for it, so an early
  // query does not report IGES as missing on the HimmelCAD build.
  await ctx.kernelReady().catch(() => undefined);
  const caps = ctx.capabilities();
  const importEntry = (f: (typeof INTEROP_FORMATS)[number]): Json => {
    if (f.format === 'iges') {
      return caps?.igesRead
        ? {
            ...f,
            keeps:
              'surfaces sewn into solids (open shells stay surface bodies); unit converted to mm; no names or colours',
            available: true,
          }
        : { ...f, available: false, reason: IGES_UNAVAILABLE };
    }
    if (f.format === 'step') {
      return {
        ...f,
        available: true,
        reader: caps?.stepXcafRead ? 'xcaf' : 'text',
      };
    }
    return { ...f, available: true };
  };
  return {
    import: INTEROP_FORMATS.map(importEntry),
    export: STEP_EXPORT_FORMATS.map((f) =>
      f.format === 'iges'
        ? caps?.igesWrite
          ? {
              ...f,
              keeps:
                'exact geometry as trimmed surfaces (or MSBO solids); length unit; no names or colours',
              available: true,
            }
          : { ...f, available: false, reason: IGES_UNAVAILABLE }
        : { ...f, available: true },
    ),
    kernel: caps,
  };
}

/** `import.iges`: one Import step (`format: "iges"`), bodies per solid / open surface. */
export async function importIges(ctx: InteropContext, p: Json): Promise<Json> {
  await ctx.kernelReady();
  if (!ctx.capabilities()?.igesRead) {
    throw new ApiError('unsupported', IGES_UNAVAILABLE, {
      hint: 'interop.formats reports which formats the loaded kernel supports; use STEP instead.',
    });
  }
  const { bytes, fileName } = await ctx.readFile(p, 'import.igs');
  const data = bytesToBase64(bytes);
  const result = await ctx.write('import.iges', (features) => {
    const id = ctx.allocateFeatureId('import');
    const feature = {
      id,
      name: ctx.nextFeatureName('Import', features),
      suppressed: false,
      kind: 'importStep' as const,
      format: 'iges' as const,
      data,
      fileName,
    };
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'feature', featureId: id }],
      result: { featureId: id, name: feature.name, kind: 'importStep', format: 'iges' },
    };
  });
  const featureId = result.featureId as string;
  const evaluation = await ctx.readEvaluation({});
  const created = evaluation.bodies.filter((b) => b.createdBy === featureId);
  return {
    ...result,
    createdBodyIds: created.map((b) => b.id),
    parts: created.map((b) => ({ bodyId: b.id, name: b.name, color: b.color })),
    ...(evaluation.warnings[featureId] ? { warnings: [evaluation.warnings[featureId]] } : {}),
  };
}

/** `import.step`: one Import step with the product structure (or one body with `single`). */
export async function importStep(ctx: InteropContext, p: Json): Promise<Json> {
  const { bytes, fileName } = await ctx.readFile(p, 'import.step');
  const data = bytesToBase64(bytes);
  const single = p.structure === 'single';
  const result = await ctx.write('import.step', (features) => {
    const id = ctx.allocateFeatureId('import');
    const feature = single
      ? {
          id,
          name: ctx.nextFeatureName('Import', features),
          suppressed: false,
          kind: 'importStep' as const,
          data,
          fileName,
        }
      : importStepFeature({ id, name: ctx.nextFeatureName('Import', features), data, fileName });
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'feature', featureId: id }],
      result: { featureId: id, name: feature.name, kind: 'importStep' },
    };
  });
  const featureId = result.featureId as string;
  if (!single && result.committed === true) notifyAssemblyImported(featureId);
  const evaluation = await ctx.readEvaluation({});
  const created = evaluation.bodies.filter((b) => b.createdBy === featureId);
  return {
    ...result,
    createdBodyIds: created.map((b) => b.id),
    parts: created.map((b) => ({
      bodyId: b.id,
      name: b.name,
      color: b.color,
      itemPath: b.itemPath ?? [],
    })),
    ...(evaluation.warnings[featureId] ? { warnings: [evaluation.warnings[featureId]] } : {}),
  };
}

/** `import.mesh`: reference meshes from STL/3MF/OBJ (document-level, not a History step). */
export async function importMesh(ctx: InteropContext, p: Json): Promise<Json> {
  ctx.ensureWritable();
  const { bytes, fileName } = await ctx.readFile(p, 'import.stl');
  let parsed;
  try {
    parsed = await parseMeshFile(bytes, fileName);
  } catch (error) {
    throw new ApiError('invalidParams', error instanceof Error ? error.message : String(error), {
      hint: 'Supported: .stl (binary/ASCII), .3mf, .obj.',
    });
  }
  const meshes = referenceMeshesFromImport(parsed, fileName);
  const state = ctx.state();
  for (const { mesh } of meshes) state.importReferenceMesh(mesh);
  fileRowsIntoFolders(
    meshes.map(({ mesh, folder }) => ({ key: meshRowKey(mesh.id), path: folder })),
  );
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { mesh } of meshes) {
    min = [
      Math.min(min[0], mesh.min[0]),
      Math.min(min[1], mesh.min[1]),
      Math.min(min[2], mesh.min[2]),
    ];
    max = [
      Math.max(max[0], mesh.max[0]),
      Math.max(max[1], mesh.max[1]),
      Math.max(max[2], mesh.max[2]),
    ];
  }
  const hint = parsed.declaredUnit === null ? suggestStlUnitHint(min, max) : null;
  return {
    format: parsed.format,
    meshes: meshes.map(({ mesh, folder }) => ({
      meshId: mesh.id,
      bodyId: referenceMeshBodyId(mesh.id),
      name: mesh.name,
      ...(mesh.color ? { color: mesh.color } : {}),
      folder,
      triangles: mesh.indices.length / 3,
      min: mesh.min,
      max: mesh.max,
    })),
    declaredUnit: parsed.declaredUnit,
    unitScale: parsed.unitScale,
    ...(hint ? { unitHint: hint } : {}),
    warnings: parsed.warnings,
  };
}

/** `import.dxf`: one new sketch step. */
export async function importDxf(ctx: InteropContext, p: Json): Promise<Json> {
  const { bytes, fileName } = await ctx.readFile(p, 'drawing.dxf');
  let drawing;
  try {
    drawing = parseDxfBytes(bytes);
  } catch (error) {
    throw new ApiError('invalidParams', error instanceof Error ? error.message : String(error));
  }
  const units = dxfUnits(drawing, typeof p.unitScale === 'number' ? p.unitScale : null);
  let stats: Json = {};
  const result = await ctx.write('import.dxf', (features, evaluation) => {
    let plane: SketchPlaneRef;
    if (p.face !== undefined) {
      const [face] = resolveFaceInput(p.face, evaluation, features, 'face', { single: true });
      if (!face) throw new ApiError('invalidParams', 'face: no face given');
      if (face.signature.surface !== 'plane') {
        throw new ApiError('invalidParams', 'face: a DXF can only be placed on a planar face');
      }
      plane = { kind: 'face', face };
    } else {
      plane = {
        kind: 'plane',
        plane: (p.plane as 'XY' | 'XZ' | 'YZ' | undefined) ?? 'XY',
        offset: typeof p.offset === 'number' ? p.offset : 0,
      };
    }
    const id = ctx.allocateFeatureId('sketch');
    let built;
    try {
      built = dxfSketchFeature({
        id,
        name: typeof p.name === 'string' ? p.name : ctx.nextFeatureName('Sketch', features),
        plane,
        drawing,
        scaleToMm: units.scale,
        connect: p.connect !== false,
      });
    } catch (error) {
      throw new ApiError('invalidParams', error instanceof Error ? error.message : String(error));
    }
    stats = {
      curves: built.stats.curves,
      points: built.stats.points,
      connected: built.stats.connected,
      approximated: built.stats.approximated,
      dropped: built.stats.dropped,
      regions: detectRegions(built.feature).length,
    };
    return {
      features: [...features, built.feature],
      touched: [id],
      selection: [{ kind: 'sketchProfile', featureId: id }],
      result: { featureId: id, name: built.feature.name, kind: 'sketch', fileName },
    };
  });
  const evaluation = await ctx.readEvaluation({});
  const sketchWarning = evaluation.warnings[String(result.featureId)];
  return {
    ...result,
    ...stats,
    skipped: drawing.skipped,
    warnings: [...drawing.warnings, ...(sketchWarning ? [sketchWarning] : [])],
    units,
  };
}

/** `export.dxf`: a sketch or a planar face outline. */
export async function exportDxf(ctx: InteropContext, p: Json): Promise<Json> {
  const version = (p.version as DxfVersion | undefined) ?? 'R2000';
  const features = ctx.readFeatures(p);
  let entities;
  if (typeof p.sketchId === 'string') {
    const sketch = features.find((f) => f.id === p.sketchId);
    if (!sketch || sketch.kind !== 'sketch') {
      throw new ApiError('notFound', `No sketch "${String(p.sketchId)}"`, {
        hint: 'sketches.list gives the sketch feature ids.',
      });
    }
    entities = sketchToDxfEntities(sketch, {
      includeConstruction: p.includeConstruction !== false,
    });
    if (entities.length === 0) throw new ApiError('invalidParams', 'The sketch has no geometry');
  } else {
    const evaluation = await ctx.readEvaluation(p);
    const [face] = resolveFaceInput(p.face, evaluation, features, 'face', { single: true });
    if (!face) throw new ApiError('invalidParams', 'face: no face given');
    const body = evaluation.bodies.find((b) => b.id === face.bodyId)!;
    const index = body.faces.findIndex((f) => f.key === face.key || f.aliases.includes(face.key));
    try {
      entities = faceOutlineToDxfEntities(body, index);
    } catch (error) {
      throw new ApiError('invalidParams', error instanceof Error ? error.message : String(error));
    }
  }
  const text = writeDxf(entities, version);
  return {
    ...(await ctx.deliver(new TextEncoder().encode(text), 'image/vnd.dxf', p.path)),
    entities: entities.length,
    version,
  };
}

/** `mesh.toSolid`: one Mesh to Solid step from a reference mesh. */
export async function meshToSolid(ctx: InteropContext, p: Json): Promise<Json> {
  const raw = String(p.meshId);
  const meshId = referenceMeshIdOf(raw) ?? raw;
  const mesh = ctx.state().referenceMeshes.find((m) => m.id === meshId);
  if (!mesh) {
    throw new ApiError('notFound', `No reference mesh "${raw}"`, {
      hint: 'import.mesh returns meshIds; bodies.list shows them as mesh:<id> bodies.',
    });
  }
  let prepared;
  try {
    prepared = prepareMeshForSolid(referenceMeshWorldPositions(mesh));
  } catch (error) {
    throw new ApiError('unsupported', error instanceof Error ? error.message : String(error), {
      hint: 'Only closed, manifold, single-part meshes within the size limit convert to a solid.',
    });
  }
  const result = await ctx.write('mesh.toSolid', (features) => {
    const id = ctx.allocateFeatureId('meshSolid');
    const feature = meshSolidFeature({
      id,
      name: typeof p.name === 'string' ? p.name : ctx.nextFeatureName('Mesh to Solid', features),
      sourceName: mesh.name,
      mesh: prepared.mesh,
    });
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'body', bodyId: `body:${id}` }],
      result: { featureId: id, name: feature.name, kind: 'meshSolid', bodyId: `body:${id}` },
    };
  });
  if (result.committed === true && p.hideMesh !== false) {
    ctx.state().setReferenceMeshHidden(mesh.id, true);
  }
  return {
    ...result,
    check: {
      triangles: prepared.check.triangles,
      faces: prepared.check.faces,
      flipped: prepared.check.flipped,
      inverted: prepared.check.inverted,
      volume: prepared.check.volume,
    },
    summary: describeMeshCheck(prepared.check),
  };
}

/** Kernel STEP export options from `export.step` params. */
export function stepExportOptions(
  p: Json,
  names: Record<string, string>,
  assembly: StepExportOptions['assembly'] | undefined,
): StepExportOptions {
  return {
    ...(p.schema === 'AP214' || p.schema === 'AP242' ? { schema: p.schema } : {}),
    ...(p.unit === 'mm' || p.unit === 'cm' || p.unit === 'm' || p.unit === 'in'
      ? { unit: p.unit }
      : {}),
    names,
    ...(assembly ? { assembly } : {}),
  };
}
