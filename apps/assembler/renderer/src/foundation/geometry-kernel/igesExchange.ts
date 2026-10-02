/**
 * IGES import and export, available only with the HimmelCAD OCCT build
 * (`vendor/occt-wasm`, `IGESControl_Reader/Writer`; `kernel/occtExtras.ts`).
 *
 * Import: OCCT transfers every root; IGES usually carries trimmed surfaces
 * (type 144/143) rather than solids, so the faces are sewn
 * (`BRepBuilderAPI_Sewing`) and every closed shell becomes a solid
 * (`ShapeFix_Solid::SolidFromShell`, orientation fixed); open shells stay
 * surface bodies. Solids in the file (MSBO, type 186) are kept as they are.
 * The file's unit is converted to millimetres by OCCT.
 *
 * Export: plain `IGESControl_Writer` (the XCAF IGES writer is not bound), so
 * geometry and the length unit only — no names or colours. `faces` (default,
 * trimmed surfaces: what every IGES reader understands) or `brep` (MSBO
 * solids, IGES 5.3).
 */
import './occtArena.js';
import * as R from 'replicad';

import { occtExtras } from './occtExtras.js';

type OpenCascade = ReturnType<typeof R.getOC>;
type RawShape = R.Shape3D['wrapped'];
type Deletable = { delete(): void };

export class IgesUnavailableError extends Error {
  constructor(what: 'reader' | 'writer') {
    super(
      `IGES is not in this build: the CAD kernel (replicad-opencascadejs 1.1.0) has no IGES ${what}. It needs the HimmelCAD OCCT build.`,
    );
  }
}

export class IgesImportError extends Error {}

export type IgesLengthUnit = 'mm' | 'cm' | 'm' | 'in';
export type IgesWriteMode = 'faces' | 'brep';

export interface IgesExportOptions {
  unit?: IgesLengthUnit;
  mode?: IgesWriteMode;
}

export interface ImportedIgesPart {
  shape: R.Shape3D;
  name: string;
}

export interface IgesImportResult {
  parts: ImportedIgesPart[];
  warnings: string[];
}

const UNIT_CODE: Record<IgesLengthUnit, string> = { mm: 'MM', cm: 'CM', m: 'M', in: 'IN' };

let serial = 0;

function explore(
  oc: OpenCascade,
  shape: RawShape,
  kind: 'TopAbs_SOLID' | 'TopAbs_SHELL' | 'TopAbs_FACE' | 'TopAbs_VERTEX',
  avoid?: 'TopAbs_SOLID' | 'TopAbs_SHELL',
): RawShape[] {
  const e = oc.TopAbs_ShapeEnum as unknown as Record<string, unknown>;
  const explorer = new oc.TopExp_Explorer(
    shape as never,
    e[kind] as never,
    e[avoid ?? 'TopAbs_SHAPE'] as never,
  );
  const out: RawShape[] = [];
  try {
    for (; explorer.More(); explorer.Next()) out.push(explorer.Current() as RawShape);
  } finally {
    explorer.delete();
  }
  return out;
}

function baseName(fileName: string): string {
  return fileName.replace(/\.(igs|iges)$/i, '') || 'Import';
}

type Box = [[number, number, number], [number, number, number]];

function boxOf(shape: R.Shape3D): Box {
  const box = shape.boundingBox;
  try {
    return box.bounds as Box;
  } finally {
    box.delete();
  }
}

function boxContains(outer: Box, inner: Box, tolerance = 1e-6): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (inner[0][axis]! < outer[0][axis]! - tolerance) return false;
    if (inner[1][axis]! > outer[1][axis]! + tolerance) return false;
  }
  return true;
}

/**
 * Whether the closed shell of `inner` lies inside the solid `outer`. The
 * shells of one sewn surface set never cross, so one of its vertices tells:
 * OCCT's distance tool answers `InnerSolution` for a point inside a solid.
 */
function solidContains(oc: OpenCascade, outer: R.Shape3D, inner: R.Shape3D): boolean {
  const [vertex] = explore(oc, inner.wrapped, 'TopAbs_VERTEX');
  if (!vertex) return false;
  try {
    const dist = new oc.BRepExtrema_DistShapeShape(outer.wrapped as never, vertex as never, 1e-7);
    try {
      return dist.IsDone() && dist.InnerSolution();
    } finally {
      dist.delete();
    }
  } catch {
    return false;
  } finally {
    vertex.delete();
  }
}

/** `outer`'s solid with the shells of `cavities` added reversed (voids), or `null`. */
function withCavities(
  oc: OpenCascade,
  outer: R.Shape3D,
  cavities: readonly R.Shape3D[],
): R.Shape3D | null {
  const owned: Deletable[] = [];
  const builder = new oc.BRepBuilderAPI_MakeSolid();
  try {
    for (const shape of [outer, ...cavities]) {
      const shells = explore(oc, shape.wrapped, 'TopAbs_SHELL');
      owned.push(...shells);
      if (shells.length !== 1) return null;
      const shell = shells[0]!;
      const oriented = (shape === outer ? shell : shell.Reversed()) as RawShape;
      if (oriented !== shell) owned.push(oriented);
      builder.Add(oc.TopoDS.Shell(oriented as never) as never);
    }
    if (!builder.IsDone()) return null;
    const solid = R.cast(builder.Solid() as never) as R.Shape3D;
    const expected =
      R.measureVolume(outer) - cavities.reduce((sum, c) => sum + R.measureVolume(c), 0);
    const volume = R.measureVolume(solid);
    // Volumes of B-spline faces are integrated numerically: compare relative to the outer solid.
    if (!(volume > 0) || Math.abs(volume - expected) > 1e-3 * Math.max(1, R.measureVolume(outer))) {
      solid.delete();
      return null;
    }
    return solid;
  } catch {
    return null;
  } finally {
    builder.delete();
    for (const object of owned) object.delete();
  }
}

/**
 * Rebuilds solids with cavities from the closed shells a sewing produced
 * (fuzzer finding F14, `assembler/ROBUSTNESS.md`: a revolved letter "O" is a
 * ring with a toroidal void; each shell used to become a solid of its own, so
 * the void came back filled). Nesting by containment: a shell inside an even
 * number of others is material, inside an odd number a cavity of the
 * smallest shell around it, which gets it as an inner (reversed) shell. If
 * that fails, both stay as they were (`failed`).
 */
export function nestCavities(
  oc: OpenCascade,
  solids: readonly R.Shape3D[],
): { shapes: R.Shape3D[]; cavities: number; failed: number } {
  if (solids.length < 2) return { shapes: [...solids], cavities: 0, failed: 0 };
  const items = solids
    .map((shape) => ({ shape, volume: R.measureVolume(shape), box: boxOf(shape) }))
    .sort((a, b) => b.volume - a.volume);
  const parent = items.map(() => -1);
  for (let k = 1; k < items.length; k += 1) {
    // The smallest larger shell around it is its immediate container.
    for (let j = k - 1; j >= 0; j -= 1) {
      const outer = items[j]!;
      const inner = items[k]!;
      if (!(outer.volume > inner.volume) || !boxContains(outer.box, inner.box)) continue;
      if (solidContains(oc, outer.shape, inner.shape)) {
        parent[k] = j;
        break;
      }
    }
  }
  const depth = parent.map(() => 0);
  for (let k = 0; k < items.length; k += 1) {
    depth[k] = parent[k]! < 0 ? 0 : depth[parent[k]!]! + 1;
  }
  const shapes: R.Shape3D[] = [];
  let cavities = 0;
  let failed = 0;
  for (let k = 0; k < items.length; k += 1) {
    if (depth[k]! % 2 === 1) continue; // a cavity: handled with its owner
    const own = items.filter((_, i) => parent[i] === k && depth[i]! % 2 === 1).map((i) => i.shape);
    if (own.length === 0) {
      shapes.push(items[k]!.shape);
      continue;
    }
    const solid = withCavities(oc, items[k]!.shape, own);
    if (solid) {
      shapes.push(solid);
      items[k]!.shape.delete();
      for (const cavity of own) cavity.delete();
      cavities += own.length;
    } else {
      shapes.push(items[k]!.shape, ...own);
      failed += own.length;
    }
  }
  return { shapes, cavities, failed };
}
/** Reads an IGES file into bodies (solids where the surfaces close; cavities cut out). */
export function readIges(oc: OpenCascade, bytes: Uint8Array, fileName: string): IgesImportResult {
  const extras = occtExtras(oc);
  if (!extras) throw new IgesUnavailableError('reader');
  const owned: Deletable[] = [];
  const own = <T extends Deletable>(object: T): T => {
    owned.push(object);
    return object;
  };
  serial += 1;
  const path = `/iges-import-${serial}-${Date.now().toString(36)}.igs`;
  oc.FS.writeFile(path, bytes);
  const warnings: string[] = [];
  const shapes: R.Shape3D[] = [];
  try {
    oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
    const reader = own(new extras.IGESControl_Reader());
    const status = reader.ReadFile(path.slice(1));
    const retDone = (oc.IFSelect_ReturnStatus as unknown as Record<string, unknown>)
      .IFSelect_RetDone;
    if (status !== retDone) {
      throw new IgesImportError('This is not a readable IGES file');
    }
    const range = own(new oc.Message_ProgressRange());
    if (reader.TransferRoots(range) <= 0) {
      throw new IgesImportError('The IGES file has no transferable geometry');
    }
    const all = own(reader.OneShape());
    if (all.IsNull()) throw new IgesImportError('The IGES file has no geometry');

    // Solids already in the file.
    for (const solid of explore(oc, all, 'TopAbs_SOLID')) {
      shapes.push(R.cast(solid as never) as R.Shape3D);
      solid.delete();
    }
    // Faces outside solids: sew, then close shells into solids.
    const loose = explore(oc, all, 'TopAbs_FACE', 'TopAbs_SOLID');
    if (loose.length > 0) {
      const sewing = own(new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false));
      for (const face of loose) {
        sewing.Add(face as never);
        face.delete();
      }
      sewing.Perform(own(new oc.Message_ProgressRange()));
      const sewn = own(sewing.SewedShape() as RawShape);
      let open = 0;
      let insideOut = 0;
      let degenerate = 0;
      const closedSolids: R.Shape3D[] = [];
      // Shells of the sewing, plus every face it left alone wrapped in a shell of its own: a
      // face closed in itself (a revolved circle or letter "O": a torus-like surface) is a
      // closed shell too (F14, `assembler/ROBUSTNESS.md`; such faces used to be dropped).
      const shells: { shell: RawShape; closed: boolean }[] = explore(oc, sewn, 'TopAbs_SHELL').map(
        (shell) => ({ shell, closed: (shell as unknown as { Closed(): boolean }).Closed() }),
      );
      const builder = own(new oc.TopoDS_Builder());
      for (const face of explore(oc, sewn, 'TopAbs_FACE', 'TopAbs_SHELL')) {
        // IGES keeps no natural bounds or seams of a face closed in itself: repair them first.
        const fixer = new oc.ShapeFix_Face(oc.TopoDS.Face(face as never) as never);
        let fixed: RawShape = face;
        try {
          fixer.Perform(own(new oc.Message_ProgressRange()));
          fixed = fixer.Face() as unknown as RawShape;
        } catch {
          fixed = face;
        } finally {
          fixer.delete();
        }
        const shell = new oc.TopoDS_Shell();
        builder.MakeShell(shell);
        builder.Add(shell, fixed as never);
        if (fixed !== face) fixed.delete();
        face.delete();
        // A face closed in both directions (torus-like: a revolved circle or letter "O") comes
        // back from OCCT's IGES exchange with its boundary collapsed to nothing (F14): no area.
        const probe = R.cast(shell as never);
        const empty = !(R.measureArea(probe as R.Shape3D) > 1e-6);
        probe.delete();
        if (empty) {
          degenerate += 1;
          shell.delete();
          continue;
        }
        shells.push({ shell: shell as unknown as RawShape, closed: oc.BRep_Tool.IsClosed(shell) });
      }
      for (const { shell, closed } of shells) {
        const fix = own(new oc.ShapeFix_Solid());
        let made: RawShape | null = null;
        if (closed) {
          try {
            made = fix.SolidFromShell(oc.TopoDS.Shell(shell as never) as never) as RawShape;
          } catch {
            made = null;
          }
        }
        if (made && !made.IsNull()) {
          const solid = R.cast(made as never) as R.Shape3D;
          // Surfaces of touching or overlapping bodies can sew into one inside-out shell
          // (fuzzer finding F10, `assembler/ROBUSTNESS.md`): keep it, but say so.
          if (!(R.measureVolume(solid) > 0)) {
            insideOut += 1;
            shapes.push(solid);
          } else closedSolids.push(solid);
          made.delete();
        } else {
          open += 1;
          const cast = R.cast(shell as never);
          if (R.isShape3D(cast)) shapes.push(cast);
          else cast.delete();
        }
        shell.delete();
      }
      // A closed shell inside another one is a cavity of it (IGES faces carry no shell
      // structure): it becomes an inner shell of that solid, not a solid of its own.
      const nested = nestCavities(oc, closedSolids);
      shapes.push(...nested.shapes);
      if (nested.failed > 0) {
        warnings.push(
          `${nested.failed} inner ${nested.failed === 1 ? 'surface' : 'surfaces'} could not be made a cavity; imported as separate ${nested.failed === 1 ? 'body' : 'bodies'}`,
        );
      }
      if (degenerate > 0) {
        warnings.push(
          `${degenerate} ${degenerate === 1 ? 'surface has' : 'surfaces have'} no extent in the IGES file and ${degenerate === 1 ? 'was' : 'were'} skipped (faces closed in both directions, such as revolved circles, lose their boundary in IGES); export such parts as IGES solids (MSBO) or STEP`,
        );
      }
      if (open > 0) {
        warnings.push(
          `${open} open surface ${open === 1 ? 'body' : 'bodies'}: the IGES surfaces do not close into a solid`,
        );
      }
      if (insideOut > 0) {
        warnings.push(
          `${insideOut} imported ${insideOut === 1 ? 'solid is' : 'solids are'} not valid (inside out): surfaces of touching or overlapping bodies were sewn together; export such parts as IGES solids (MSBO) or STEP`,
        );
      }
    }
    if (shapes.length === 0)
      throw new IgesImportError('The IGES file has no surface or solid geometry');
    const base = baseName(fileName);
    return {
      parts: shapes.map((shape, i) => ({
        shape,
        name: shapes.length > 1 ? `${base} ${i + 1}` : base,
      })),
      warnings,
    };
  } catch (error) {
    for (const shape of shapes) shape.delete();
    throw error;
  } finally {
    for (const object of owned.reverse()) {
      try {
        object.delete();
      } catch {
        // already released
      }
    }
    try {
      oc.FS.unlink(path);
    } catch {
      // already gone
    }
  }
}

/** Writes `shapes` as one IGES file (bytes). */
export function writeIges(
  oc: OpenCascade,
  shapes: readonly R.Shape3D[],
  options: IgesExportOptions = {},
): Uint8Array {
  const extras = occtExtras(oc);
  if (!extras) throw new IgesUnavailableError('writer');
  if (shapes.length === 0) throw new Error('Nothing to export');
  const owned: Deletable[] = [];
  const own = <T extends Deletable>(object: T): T => {
    owned.push(object);
    return object;
  };
  serial += 1;
  const file = `/iges-export-${serial}.igs`;
  try {
    oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
    const writer = own(
      new extras.IGESControl_Writer(
        UNIT_CODE[options.unit ?? 'mm'],
        options.mode === 'brep' ? 1 : 0,
      ),
    );
    const range = own(new oc.Message_ProgressRange());
    for (const shape of shapes) {
      if (!writer.AddShape(shape.wrapped as never, range)) {
        throw new Error('OCCT could not convert a body to IGES');
      }
    }
    writer.ComputeModel();
    if (!writer.Write(file, false)) throw new Error('OCCT could not write the IGES file');
    const bytes = oc.FS.readFile(file) as Uint8Array;
    return new Uint8Array(bytes);
  } finally {
    for (const object of owned.reverse()) {
      try {
        object.delete();
      } catch {
        // already released
      }
    }
    try {
      oc.FS.unlink(file);
    } catch {
      // already gone
    }
  }
}
