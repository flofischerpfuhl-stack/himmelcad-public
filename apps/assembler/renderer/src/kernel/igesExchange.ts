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
  kind: 'TopAbs_SOLID' | 'TopAbs_SHELL' | 'TopAbs_FACE',
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

/** Reads an IGES file into bodies (solids where the surfaces close). */
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
      const shells = explore(oc, sewn, 'TopAbs_SHELL');
      for (const shell of shells) {
        const closed = (shell as unknown as { Closed(): boolean }).Closed();
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
          if (!(R.measureVolume(solid) > 0)) insideOut += 1;
          shapes.push(solid);
          made.delete();
        } else {
          open += 1;
          const cast = R.cast(shell as never);
          if (R.isShape3D(cast)) shapes.push(cast);
          else cast.delete();
        }
        shell.delete();
      }
      // Faces the sewing left without a shell.
      for (const face of explore(oc, sewn, 'TopAbs_FACE', 'TopAbs_SHELL')) {
        const cast = R.cast(face as never);
        if (R.isShape3D(cast)) {
          shapes.push(cast);
          open += 1;
        } else cast.delete();
        face.delete();
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
