/**
 * STEP export through OCCT's XCAF writer (`STEPCAFControl_Writer`, present
 * in the app's OCCT build): bodies with names and surface colours, either
 * as free top-level parts (flat) or as a product tree that mirrors the
 * user's Items folders (assembly: every folder a sub-assembly, every body a
 * part placed with an identity transform, since bodies are already in model
 * coordinates). Options: application protocol (AP214 IS or AP242 DIS, OCCT
 * `write.step.schema` 4/5) and the file's length unit (`write.step.unit`;
 * the model unit stays millimetres, OCCT converts on write).
 */
import './occtArena.js';
import type * as R from 'replicad';

type OpenCascade = ReturnType<typeof R.getOC>;

export type StepSchema = 'AP214' | 'AP242';
export type StepLengthUnit = 'mm' | 'cm' | 'm' | 'in';

/** A folder of the exported product tree; leaves are body ids. */
export interface StepAssemblyTree {
  name: string;
  children: (StepAssemblyTree | { bodyId: string })[];
}

export interface StepExportOptions {
  /** Default AP242 (what the app always wrote before these options existed). */
  schema?: StepSchema;
  /** Length unit written to the file; default `mm`. */
  unit?: StepLengthUnit;
  /** Export as this product tree instead of flat top-level parts. */
  assembly?: StepAssemblyTree;
  /** Display names per body id (Items names); default the kernel body name. */
  names?: Record<string, string>;
}

export interface StepExportBody {
  id: string;
  name: string;
  color: string;
  shape: R.Shape3D;
}

const SCHEMA_CODE: Record<StepSchema, number> = { AP214: 4, AP242: 5 };
const UNIT_CODE: Record<StepLengthUnit, string> = { mm: 'MM', cm: 'CM', m: 'M', in: 'INCH' };

/** sRGB component (0..1) → linear RGB, the space `Quantity_Color` holds. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The body colour as OCCT wants it. `Quantity_Color` stores linear RGB and
 * the STEP writer converts to sRGB on output, so a `#RRGGBB` (sRGB) colour
 * must be linearized first — otherwise every mid-tone is written brighter
 * (replicad's `exportSTEP`, used before, wrote `#9AAE9B` as ≈ `#CAD6CB`).
 */
function rgba(oc: OpenCascade, hex: string): InstanceType<OpenCascade['Quantity_ColorRGBA']> {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  const [r, g, b] = m ? [m[1], m[2], m[3]].map((h) => parseInt(h!, 16) / 255) : [0.7, 0.7, 0.7];
  return new oc.Quantity_ColorRGBA(srgbToLinear(r!), srgbToLinear(g!), srgbToLinear(b!), 1);
}

let exportSerial = 0;

/** Writes `bodies` as one STEP file (bytes). Throws when OCCT fails to write. */
export function exportStepDocument(
  oc: OpenCascade,
  bodies: readonly StepExportBody[],
  options: StepExportOptions = {},
): Uint8Array {
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(object: T): T => {
    owned.push(object);
    return object;
  };
  const text = (value: string) => own(new oc.TCollection_ExtendedString(value, true));
  try {
    const doc = own(new oc.TDocStd_Document(text('XmlOcaf')));
    oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
    const main = own(doc.Main());
    const tool = oc.XCAFDoc_DocumentTool.ShapeTool(main);
    const colors = oc.XCAFDoc_DocumentTool.ColorTool(main);
    const surf = (oc.XCAFDoc_ColorType as unknown as Record<string, unknown>)
      .XCAFDoc_ColorSurf as never;
    const byId = new Map(bodies.map((b) => [b.id, b]));
    const nameOf = (body: StepExportBody) => options.names?.[body.id]?.trim() || body.name;

    /**
     * The body's shape without a `TopLoc_Location`: XCAF turns a located shape
     * into an assembly referencing an unnamed part ("Open CASCADE STEP
     * translator …"), which other readers show as an extra level. Imported
     * STEP parts are located (shared geometry per instance), so their
     * placement is baked into a copy here.
     */
    const unlocated = (body: StepExportBody) => {
      const raw = body.shape.wrapped as unknown as InstanceType<OpenCascade['TopoDS_Shape']>;
      const location = own(raw.Location());
      if (location.IsIdentity()) return raw;
      const bare = own(raw.Located(own(new oc.TopLoc_Location()), false));
      const move = own(
        new oc.BRepBuilderAPI_Transform(bare, own(location.Transformation()), true, false),
      );
      return own(move.Shape());
    };
    const addPart = (body: StepExportBody) => {
      const label = own(tool.AddShape(unlocated(body) as never, false, false));
      oc.TDataStd_Name.Set(label, text(nameOf(body)));
      colors.SetColor(label, own(rgba(oc, body.color)), surf);
      return label;
    };

    if (options.assembly) {
      const used = new Set<string>();
      const identity = own(new oc.TopLoc_Location());
      const build = (node: StepAssemblyTree): InstanceType<OpenCascade['TDF_Label']> | null => {
        const label = own(tool.NewShape());
        oc.TDataStd_Name.Set(label, text(node.name || 'Assembly'));
        let count = 0;
        for (const child of node.children) {
          if ('bodyId' in child) {
            const body = byId.get(child.bodyId);
            if (!body || used.has(body.id)) continue;
            used.add(body.id);
            const part = addPart(body);
            const component = own(tool.AddComponent(label, part, identity));
            oc.TDataStd_Name.Set(component, text(nameOf(body)));
            count += 1;
          } else {
            const sub = build(child);
            if (!sub) continue;
            const component = own(tool.AddComponent(label, sub, identity));
            oc.TDataStd_Name.Set(component, text(child.name || 'Assembly'));
            count += 1;
          }
        }
        return count > 0 ? label : null;
      };
      if (!build(options.assembly)) throw new Error('Nothing to export');
      // Bodies not placed in the tree are still exported (top-level parts).
      for (const body of bodies) if (!used.has(body.id)) addPart(body);
    } else {
      for (const body of bodies) addPart(body);
    }
    tool.UpdateAssemblies();

    const unit = UNIT_CODE[options.unit ?? 'mm'];
    oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
    oc.Interface_Static.SetCVal('write.step.unit', unit);
    oc.Interface_Static.SetIVal('write.surfacecurve.mode', 1);
    oc.Interface_Static.SetIVal('write.precision.mode', 0);
    oc.Interface_Static.SetIVal('write.step.assembly', options.assembly ? 1 : 2);
    oc.Interface_Static.SetIVal('write.step.schema', SCHEMA_CODE[options.schema ?? 'AP242']);
    const session = own(new oc.XSControl_WorkSession());
    const writer = own(new oc.STEPCAFControl_Writer(session, false));
    writer.SetColorMode(true);
    writer.SetNameMode(true);
    writer.SetLayerMode(true);
    exportSerial += 1;
    const file = `export-${exportSerial}.step`;
    const progress = own(new oc.Message_ProgressRange());
    if (!writer.Perform(doc, file, progress)) throw new Error('OCCT could not write the STEP file');
    const bytes = oc.FS.readFile(`/${file}`) as Uint8Array;
    oc.FS.unlink(`/${file}`);
    return new Uint8Array(bytes);
  } finally {
    for (const object of owned.reverse()) {
      try {
        object.delete();
      } catch {
        // already released by its owner
      }
    }
  }
}
