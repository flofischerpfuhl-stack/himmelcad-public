/**
 * STEP import that keeps the product structure (Shapr3D: "STEP assemblies
 * are imported into nested Items folders", `assembler/research/2026-09-28/
 * notes/interaction.md` §I). The app's OCCT build (replicad-opencascadejs
 * 1.1.0) exposes the plain `STEPControl_Reader` but not the XCAF reader
 * (`STEPCAFControl_Reader`), so:
 *
 * 1. the product tree, names and colours come from the file text
 *    (`interop/step/stepStructure.ts`);
 * 2. OCCT transfers one `NEXT_ASSEMBLY_USAGE_OCCURRENCE` at a time
 *    (`XSControl_Reader::TransferEntity` of `StepModel::Entity(n)`): the
 *    result is the component placed in its parent assembly's coordinates;
 *    shared parts are transferred once (OCCT caches the product
 *    definition's shape), each instance only carries its `TopLoc_Location`;
 * 3. placements are composed down the tree here, so every part lands where
 *    the file puts it, and its name/colour/folder path are known by
 *    construction.
 *
 * When the file has no readable product structure (no PRODUCT records, or a
 * component OCCT cannot transfer) the importer falls back to the shape
 * hierarchy: all roots, one body per solid, and says so in a warning.
 * Units: OCCT converts the file's length unit to millimetres
 * (`xstep.cascade.unit`), including placements.
 */
import './occtArena.js';
import * as R from 'replicad';

import {
  parseStepStructure,
  type StepProductNode,
  type StepStructure,
} from '../interop/step/stepStructure.js';
import type { KernelFormatCapabilities } from './types.js';

type OpenCascade = ReturnType<typeof R.getOC>;
type RawShape = R.Shape3D['wrapped'];

export interface ImportedStepPart {
  shape: R.Shape3D;
  name: string;
  /** `#RRGGBB` from the file, `null` when it has none. */
  color: string | null;
  /** Assembly folders from the top-level product down (empty for a single part). */
  path: string[];
}

export interface StepImportResult {
  parts: ImportedStepPart[];
  warnings: string[];
  /** `products`: placed per the product structure; `shapes`: fell back to the shape hierarchy. */
  structure: 'products' | 'shapes';
  protocol: StepStructure['protocol'];
  lengthUnit: string | null;
}

export class StepImportError extends Error {}

/** Exchange classes present in the loaded OCCT build (`KernelFormatCapabilities`). */
export function occtFormatCapabilities(oc: OpenCascade): KernelFormatCapabilities {
  const has = (name: string) =>
    typeof (oc as unknown as Record<string, unknown>)[name] === 'function';
  return {
    stepRead: has('STEPControl_Reader'),
    stepWrite: has('STEPControl_Writer'),
    stepXcafWrite: has('STEPCAFControl_Writer'),
    stepXcafRead: has('STEPCAFControl_Reader'),
    igesRead: has('IGESControl_Reader'),
    igesWrite: has('IGESControl_Writer'),
  };
}

/** Called between transferred components (done/total instances). Throwing aborts the import. */
export type StepImportProgress = (done: number, total: number, label: string) => void;

let fileSerial = 0;

function baseName(fileName: string): string {
  return fileName.replace(/\.(step|stp|p21)$/i, '') || 'Import';
}

/** Makes `name` unique among the names already used in one folder: "Link", "Link (2)", … */
function uniqueIn(used: Map<string, number>, name: string): string {
  const n = (used.get(name) ?? 0) + 1;
  used.set(name, n);
  return n === 1 ? name : `${name} (${n})`;
}

function explore(oc: OpenCascade, shape: RawShape, kind: 'solid' | 'face'): RawShape[] {
  const e = oc.TopAbs_ShapeEnum as unknown as Record<string, unknown>;
  const explorer = new oc.TopExp_Explorer(
    shape as never,
    e[kind === 'solid' ? 'TopAbs_SOLID' : 'TopAbs_FACE'] as never,
    e.TopAbs_SHAPE as never,
  );
  const out: RawShape[] = [];
  try {
    for (; explorer.More(); explorer.Next()) {
      out.push(explorer.Current() as RawShape);
      if (kind === 'face') break; // only "has any face" is asked
    }
  } finally {
    explorer.delete();
  }
  return out;
}

/** The 3D bodies of a transferred part: its solids, or the whole shape when it only has faces (a surface part). */
function bodiesOf(oc: OpenCascade, raw: RawShape): R.Shape3D[] {
  const solids = explore(oc, raw, 'solid');
  if (solids.length > 0) {
    return solids.map((solid) => {
      const shape = R.cast(solid as never) as R.Shape3D;
      solid.delete();
      return shape;
    });
  }
  const faces = explore(oc, raw, 'face');
  if (faces.length === 0) return [];
  for (const f of faces) f.delete();
  // `cast` downcasts into a new handle; the caller still owns (and deletes) `raw`.
  const shape = R.cast(raw as never);
  if (R.isShape3D(shape)) return [shape];
  shape.delete();
  return [];
}

/**
 * Reads a STEP file into located parts with names, colours and folder
 * paths. Throws {@link StepImportError} for an unreadable file.
 */
export function readStepAssembly(
  oc: OpenCascade,
  bytes: Uint8Array,
  fileName: string,
  onProgress?: StepImportProgress,
): StepImportResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  let structure: StepStructure | null = null;
  const warnings: string[] = [];
  try {
    structure = parseStepStructure(text);
  } catch (error) {
    throw new StepImportError(
      `This is not a readable STEP file (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  fileSerial += 1;
  const path = `/import-${fileSerial}-${Date.now().toString(36)}.step`;
  oc.FS.writeFile(path, bytes);
  const reader = new oc.STEPControl_Reader();
  const progressRange = new oc.Message_ProgressRange();
  try {
    const status = reader.ReadFile(path.slice(1));
    const retDone = (oc.IFSelect_ReturnStatus as unknown as Record<string, unknown>)
      .IFSelect_RetDone;
    if (status !== retDone) {
      throw new StepImportError('OCCT could not read this STEP file (syntax or schema error)');
    }
    const model = reader.StepModel();
    const entityCache = new Map<number, unknown>();
    let labelsChecked = false;
    let byLabel: Map<number, number> | null = null;
    const entityFor = (id: number, index: number): unknown => {
      const cached = entityCache.get(id);
      if (cached) return cached;
      let position = index;
      if (!labelsChecked) {
        labelsChecked = true;
        const probe = model.Entity(index);
        if (model.IdentLabel(probe) !== id) {
          // Records not numbered in file order in OCCT's model: map labels once.
          byLabel = new Map();
          for (let k = 1; k <= structure!.recordCount; k += 1) {
            byLabel.set(model.IdentLabel(model.Entity(k)), k);
          }
        }
      }
      if (byLabel) position = (byLabel as Map<number, number>).get(id) ?? -1;
      if (position < 1) return null;
      const entity = model.Entity(position);
      entityCache.set(id, entity);
      return entity;
    };
    const transfer = (id: number, index: number): RawShape | null => {
      const entity = entityFor(id, index);
      if (!entity) return null;
      const before = reader.NbShapes();
      const ok = reader.TransferEntity(entity as never, progressRange);
      if (!ok || reader.NbShapes() <= before) return null;
      const shape = reader.Shape(reader.NbShapes()) as RawShape;
      if (shape.IsNull()) {
        shape.delete();
        return null;
      }
      return shape;
    };

    const parts: ImportedStepPart[] = [];
    const total = Math.max(1, structure.instanceCount);
    let done = 0;
    const addPart = (raw: RawShape, node: StepProductNode, name: string, folder: string[]) => {
      const bodies = bodiesOf(oc, raw);
      if (bodies.length === 0) warnings.push(`"${name}" has no solid or surface geometry`);
      bodies.forEach((shape, i) => {
        parts.push({
          shape,
          name: bodies.length > 1 ? `${name} (${i + 1})` : name,
          color: node.color,
          path: folder,
        });
      });
      done += 1;
      onProgress?.(done, total, name);
    };

    let failed = false;
    const visit = (
      node: StepProductNode,
      world: InstanceType<OpenCascade['TopLoc_Location']> | null,
      folder: string[],
    ) => {
      const names = new Map<string, number>();
      const folders = new Map<string, number>();
      for (const child of node.children) {
        if (failed) return;
        const label = child.node.name || child.instanceName || 'Part';
        const raw = transfer(child.nauo, child.nauoIndex);
        if (!raw) {
          failed = true;
          warnings.push(`Component "${label}" could not be transferred`);
          return;
        }
        try {
          if (child.node.children.length > 0) {
            const local = raw.Location();
            const next = world ? world.Multiplied(local) : new oc.TopLoc_Location(local);
            local.delete();
            try {
              visit(child.node, next, [...folder, uniqueIn(folders, label)]);
            } finally {
              next.delete();
            }
          } else {
            const placed = world ? (raw.Moved(world, false) as RawShape) : raw;
            try {
              addPart(placed, child.node, uniqueIn(names, label), folder);
            } finally {
              if (placed !== raw) placed.delete();
            }
          }
        } finally {
          raw.delete();
        }
      }
    };

    const rootNames = new Map<string, number>();
    for (const root of structure.roots) {
      if (failed) break;
      const rootName = root.name || baseName(fileName);
      if (root.children.length > 0) {
        visit(root, null, [uniqueIn(rootNames, rootName)]);
      } else {
        const raw = transfer(root.pd, root.pdIndex);
        if (!raw) {
          failed = true;
          warnings.push(`Part "${rootName}" could not be transferred`);
          break;
        }
        try {
          addPart(raw, root, uniqueIn(rootNames, rootName), []);
        } finally {
          raw.delete();
        }
      }
    }

    if (failed || structure.roots.length === 0 || parts.length === 0) {
      for (const part of parts) part.shape.delete();
      const reason =
        structure.roots.length === 0
          ? 'the file has no product structure'
          : failed
            ? warnings[warnings.length - 1]!.toLowerCase()
            : 'no part had geometry';
      return {
        ...shapeHierarchyFallback(oc, reader, fileName, progressRange),
        warnings: [
          `Imported by shape hierarchy (${reason}): names and colours from the file are not applied`,
        ],
        protocol: structure.protocol,
        lengthUnit: structure.lengthUnit,
      };
    }
    return {
      parts,
      warnings,
      structure: 'products',
      protocol: structure.protocol,
      lengthUnit: structure.lengthUnit,
    };
  } finally {
    progressRange.delete();
    reader.delete();
    try {
      oc.FS.unlink(path);
    } catch {
      // already gone
    }
  }
}

/** Every root transferred, one body per solid, named after the file. */
function shapeHierarchyFallback(
  oc: OpenCascade,
  reader: InstanceType<OpenCascade['STEPControl_Reader']>,
  fileName: string,
  progressRange: InstanceType<OpenCascade['Message_ProgressRange']>,
): { parts: ImportedStepPart[]; structure: 'shapes' } {
  reader.ClearShapes();
  reader.TransferRoots(progressRange);
  const raw = reader.OneShape() as RawShape;
  try {
    if (raw.IsNull()) throw new StepImportError('The STEP file has no geometry');
    const bodies = bodiesOf(oc, raw);
    if (bodies.length === 0)
      throw new StepImportError('The STEP file has no solid or surface geometry');
    const base = baseName(fileName);
    return {
      structure: 'shapes',
      parts: bodies.map((shape, i) => ({
        shape,
        name: bodies.length > 1 ? `${base} ${i + 1}` : base,
        color: null,
        path: [],
      })),
    };
  } finally {
    raw.delete();
  }
}
