/**
 * STEP assembly import through OCCT's XCAF reader (`STEPCAFControl_Reader`),
 * available only in the HimmelCAD OCCT build (`vendor/occt-wasm`,
 * `HIMMELCAD_OCCT=himmelcad`). OCCT resolves the product structure, names,
 * colours and placements itself — including files whose structure the text
 * parser of `interop/step/stepStructure.ts` does not follow. The result has
 * the same shape and conventions as the text-parser route of
 * `stepImport.ts` (same part order: depth-first in file order; same names:
 * product name, else instance name; same "(2)" uniquing per folder; same
 * colour rule: a part/solid colour wins over face colours, among face
 * colours the most frequent), so a project replays to the same bodies on
 * either module.
 *
 * Labels are enumerated with the build's `HimmelcadXcaf` facade
 * (`build-config/wrappers/himmelcad-xcaf.cpp`): the stock bindings lack
 * `Standard_GUID` (attribute lookup, i.e. names) and the base class of
 * `TDF_LabelSequence` (`GetComponents`, `GetFreeShapes`).
 */
import './occtArena.js';
import type * as R from 'replicad';

import { isFatalKernelError } from './fatal.js';
import type { StepImportProgress, StepImportResult, ImportedStepPart } from './stepImport.js';

type OpenCascade = ReturnType<typeof R.getOC>;
type RawShape = R.Shape3D['wrapped'];

type Deletable = { delete(): void };
interface Label extends Deletable {
  IsNull(): boolean;
  IsEqual(other: Label): boolean;
}
interface Location extends Deletable {
  Multiplied(other: Location): Location;
}
interface QColor extends Deletable {
  Red(): number;
  Green(): number;
  Blue(): number;
}

/** The XCAF classes of the HimmelCAD build this reader uses (absent in replicad-opencascadejs). */
interface XcafClasses {
  STEPCAFControl_Reader: new () => Deletable & {
    SetColorMode(on: boolean): void;
    SetNameMode(on: boolean): void;
    ReadFile(path: string): unknown;
    Transfer(doc: unknown, range: Deletable): boolean;
  };
  HimmelcadXcaf: new () => Deletable & {
    Name(label: Label): string;
    ChildCount(label: Label): number;
    Child(label: Label, index: number): Label;
  };
  TDocStd_Document: new (format: Deletable) => Deletable & { Main(): Label };
  TCollection_ExtendedString: new (text: string, multiByte: boolean) => Deletable;
  TDF_Label: new () => Label;
  Quantity_Color: new () => QColor;
  XCAFDoc_ColorType: Record<string, unknown>;
  XCAFDoc_ShapeTool: {
    IsFree(label: Label): boolean;
    IsShape(label: Label): boolean;
    IsAssembly(label: Label): boolean;
    IsComponent(label: Label): boolean;
    IsSubShape(label: Label): boolean;
    GetShape(label: Label): RawShape;
    GetLocation(label: Label): Location;
    GetReferredShape(label: Label, referred: Label): boolean;
  };
  XCAFDoc_ColorTool: {
    GetColor(label: Label, type: unknown, color: QColor): boolean;
  };
}

/** The XCAF reader classes of `oc`, or `null` on a build without them. */
export function xcafClasses(oc: unknown): XcafClasses | null {
  const o = oc as Record<string, unknown>;
  const names = [
    'STEPCAFControl_Reader',
    'HimmelcadXcaf',
    'TDocStd_Document',
    'XCAFDoc_ShapeTool',
    'XCAFDoc_ColorTool',
  ];
  return names.every((n) => typeof o[n] === 'function') ? (oc as XcafClasses) : null;
}

/** Linear RGB (what `Quantity_Color` holds) → `#RRGGBB` sRGB, the inverse of `stepExport.ts`. */
function linearToHex(color: QColor): string {
  const channel = (c: number) => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  };
  return `#${channel(color.Red())}${channel(color.Green())}${channel(color.Blue())}`;
}

function uniqueIn(used: Map<string, number>, name: string): string {
  const n = (used.get(name) ?? 0) + 1;
  used.set(name, n);
  return n === 1 ? name : `${name} (${n})`;
}

function baseName(fileName: string): string {
  return fileName.replace(/\.(step|stp|p21)$/i, '') || 'Import';
}

export class StepXcafError extends Error {}

/**
 * Reads a STEP file with `STEPCAFControl_Reader` into located parts. Throws
 * {@link StepXcafError} when OCCT cannot read or transfer the file (the
 * caller then uses the text-parser route).
 */
export function readStepAssemblyXcaf(
  oc: OpenCascade,
  x: XcafClasses,
  bytes: Uint8Array,
  fileName: string,
  bodiesOf: (raw: RawShape) => R.Shape3D[],
  onProgress?: StepImportProgress,
): Pick<StepImportResult, 'parts' | 'warnings'> {
  const owned: Deletable[] = [];
  const own = <T extends Deletable>(object: T): T => {
    owned.push(object);
    return object;
  };
  const tool = x.XCAFDoc_ShapeTool;
  const types = x.XCAFDoc_ColorType;
  const path = `/xcaf-import-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}.step`;
  oc.FS.writeFile(path, bytes);
  const parts: ImportedStepPart[] = [];
  try {
    const facade = own(new x.HimmelcadXcaf());
    const children = (label: Label): Label[] => {
      const out: Label[] = [];
      const n = facade.ChildCount(label);
      for (let i = 0; i < n; i += 1) {
        const child = own(facade.Child(label, i));
        if (!child.IsNull()) out.push(child);
      }
      return out;
    };
    const referred = (component: Label): Label | null => {
      const target = own(new x.TDF_Label());
      return tool.GetReferredShape(component, target) ? target : null;
    };
    const colorOn = (label: Label): string | null => {
      const color = own(new x.Quantity_Color());
      for (const type of ['XCAFDoc_ColorSurf', 'XCAFDoc_ColorGen']) {
        if (x.XCAFDoc_ColorTool.GetColor(label, types[type], color)) return linearToHex(color);
      }
      return null;
    };
    /** Part colour: on the label, else a solid/shell sub-shape's, else the most frequent face colour. */
    const partColor = (label: Label): string | null => {
      const direct = colorOn(label);
      if (direct) return direct;
      const e = oc.TopAbs_ShapeEnum as unknown as Record<string, unknown>;
      const votes = new Map<string, number>();
      let solid: string | null = null;
      for (const sub of children(label)) {
        if (!tool.IsSubShape(sub)) continue;
        const c = colorOn(sub);
        if (!c) continue;
        const shape = own(tool.GetShape(sub));
        const type = shape.ShapeType();
        if (type === e.TopAbs_SOLID || type === e.TopAbs_SHELL || type === e.TopAbs_COMPOUND) {
          solid ??= c;
        } else {
          votes.set(c, (votes.get(c) ?? 0) + 1);
        }
      }
      if (solid) return solid;
      let best: string | null = null;
      let bestVotes = 0;
      for (const [c, n] of votes) {
        if (n > bestVotes) {
          best = c;
          bestVotes = n;
        }
      }
      return best;
    };
    const nameOf = (label: Label): string => facade.Name(label).trim();

    const reader = own(new x.STEPCAFControl_Reader());
    reader.SetColorMode(true);
    reader.SetNameMode(true);
    const retDone = (oc.IFSelect_ReturnStatus as unknown as Record<string, unknown>)
      .IFSelect_RetDone;
    if (reader.ReadFile(path.slice(1)) !== retDone) {
      throw new StepXcafError('OCCT could not read this STEP file (syntax or schema error)');
    }
    const doc = own(new x.TDocStd_Document(own(new x.TCollection_ExtendedString('XmlOcaf', true))));
    const range = own(new oc.Message_ProgressRange());
    if (!reader.Transfer(doc, range)) {
      throw new StepXcafError('OCCT could not transfer this STEP file');
    }
    const main = own(doc.Main());
    // XCAFDoc_DocumentTool::ShapesLabel = Main:1; its direct children are the top-level shapes.
    const shapesLabel = own(
      (main as unknown as { FindChild(tag: number, create: boolean): Label }).FindChild(1, false),
    );
    const roots = shapesLabel.IsNull()
      ? []
      : children(shapesLabel).filter((l) => tool.IsShape(l) && tool.IsFree(l));

    // Count leaves first for progress (done/total instances).
    const countLeaves = (label: Label): number => {
      if (!tool.IsAssembly(label)) return 1;
      let n = 0;
      for (const c of children(label)) {
        if (!tool.IsComponent(c)) continue;
        const target = referred(c);
        n += target ? countLeaves(target) : 0;
      }
      return n;
    };
    const total = Math.max(
      1,
      roots.reduce((sum, r) => sum + countLeaves(r), 0),
    );
    let done = 0;
    const warnings: string[] = [];

    const addPart = (
      raw: RawShape,
      label: Label,
      name: string,
      folder: string[],
      color: string | null,
    ) => {
      const bodies = bodiesOf(raw);
      if (bodies.length === 0) warnings.push(`"${name}" has no solid or surface geometry`);
      bodies.forEach((shape, i) => {
        parts.push({
          shape,
          name: bodies.length > 1 ? `${name} (${i + 1})` : name,
          color: color ?? partColor(label),
          path: folder,
        });
      });
      done += 1;
      onProgress?.(done, total, name);
    };

    const visit = (assembly: Label, world: Location | null, folder: string[]) => {
      const names = new Map<string, number>();
      const folders = new Map<string, number>();
      for (const component of children(assembly)) {
        if (!tool.IsComponent(component)) continue;
        const target = referred(component);
        if (!target) {
          warnings.push(`Component "${nameOf(component) || 'Part'}" has no referred shape`);
          continue;
        }
        const label = nameOf(target) || nameOf(component) || 'Part';
        const local = own(tool.GetLocation(component));
        if (tool.IsAssembly(target)) {
          const next = world ? own(world.Multiplied(local)) : local;
          visit(target, next, [...folder, uniqueIn(folders, label)]);
        } else {
          const placement = world ? own(world.Multiplied(local)) : local;
          const bare = own(tool.GetShape(target));
          const placed = own(bare.Moved(placement as never, false) as RawShape);
          addPart(placed, target, uniqueIn(names, label), folder, colorOn(component));
        }
      }
    };

    const rootNames = new Map<string, number>();
    for (const root of roots) {
      const rootName = nameOf(root) || baseName(fileName);
      if (tool.IsAssembly(root)) {
        visit(root, null, [uniqueIn(rootNames, rootName)]);
      } else {
        const raw = own(tool.GetShape(root));
        addPart(raw, root, uniqueIn(rootNames, rootName), [], null);
      }
    }
    if (parts.length === 0) throw new StepXcafError('no part had geometry');
    return { parts, warnings };
  } catch (error) {
    for (const part of parts) part.shape.delete();
    throw error instanceof StepXcafError || isFatalKernelError(error)
      ? error
      : new StepXcafError(error instanceof Error ? error.message : String(error));
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
