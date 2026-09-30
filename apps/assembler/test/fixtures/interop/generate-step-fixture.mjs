// Generates `robot-assembly.step`, the STEP assembly fixture of the interop
// tests: run `node test/fixtures/interop/generate-step-fixture.mjs` from
// apps/assembler. Written with OCCT's XCAF writer (the same writer as
// Export STEP) but with non-identity, nested placements and a sub-assembly
// used twice, which the app's own exporter never writes.
//
// Robot (assembly)
// ├─ Base plate   box 40 × 30 × 5, red, identity
// ├─ Arm:1        Arm, translated (10, 5, 5)
// └─ Arm:2        Arm, rotated 90° about Z, then translated (30, 5, 5)
// Arm (assembly)
// ├─ Link         box 4 × 4 × 20, blue, identity
// └─ Pin          cylinder r 1 × 6, green #33AA55, translated (2, 2, 20)
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { default: init } = await import('replicad-opencascadejs');
const oc = await init({ locateFile: () => require.resolve('replicad-opencascadejs/wasm') });

const text = (s) => new oc.TCollection_ExtendedString(s, true);
const doc = new oc.TDocStd_Document(text('XmlOcaf'));
oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
const main = doc.Main();
const tool = oc.XCAFDoc_DocumentTool.ShapeTool(main);
const colors = oc.XCAFDoc_DocumentTool.ColorTool(main);
const surf = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;

// Quantity_Color holds linear RGB; the STEP writer stores sRGB (like the app's exporter).
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function part(shape, name, [r, g, b]) {
  const label = tool.AddShape(shape, false, false);
  oc.TDataStd_Name.Set(label, text(name));
  colors.SetColor(label, new oc.Quantity_ColorRGBA(linear(r), linear(g), linear(b), 1), surf);
  return label;
}
function place(parent, child, name, trsf) {
  const loc = trsf ? new oc.TopLoc_Location(trsf) : new oc.TopLoc_Location();
  const component = tool.AddComponent(parent, child, loc);
  oc.TDataStd_Name.Set(component, text(name));
}
function translation(x, y, z) {
  const t = new oc.gp_Trsf();
  t.SetTranslation(new oc.gp_Vec(x, y, z));
  return t;
}

const plate = part(
  new oc.BRepPrimAPI_MakeBox(new oc.gp_Pnt(0, 0, 0), 40, 30, 5).Shape(),
  'Base plate',
  [1, 0, 0],
);
const link = part(
  new oc.BRepPrimAPI_MakeBox(new oc.gp_Pnt(0, 0, 0), 4, 4, 20).Shape(),
  'Link',
  [0, 0, 1],
);
const pin = part(new oc.BRepPrimAPI_MakeCylinder(1, 6).Shape(), 'Pin', [
  0x33 / 255,
  0xaa / 255,
  0x55 / 255,
]);

const arm = tool.NewShape();
oc.TDataStd_Name.Set(arm, text('Arm'));
place(arm, link, 'Link:1');
place(arm, pin, 'Pin:1', translation(2, 2, 20));

const robot = tool.NewShape();
oc.TDataStd_Name.Set(robot, text('Robot'));
place(robot, plate, 'Base plate:1');
place(robot, arm, 'Arm:1', translation(10, 5, 5));
const rotated = new oc.gp_Trsf();
rotated.SetRotation(new oc.gp_Ax1(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1)), Math.PI / 2);
const moved = translation(30, 5, 5);
moved.Multiply(rotated); // rotate first, then translate
place(robot, arm, 'Arm:2', moved);
tool.UpdateAssemblies();

oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
oc.Interface_Static.SetCVal('write.step.unit', 'MM');
oc.Interface_Static.SetIVal('write.step.assembly', 1);
oc.Interface_Static.SetIVal('write.step.schema', 4);
const writer = new oc.STEPCAFControl_Writer(new oc.XSControl_WorkSession(), false);
writer.SetColorMode(true);
writer.SetNameMode(true);
if (!writer.Perform(doc, 'fixture.step', new oc.Message_ProgressRange()))
  throw new Error('write failed');
const bytes = oc.FS.readFile('/fixture.step');
// Stable header: drop the write timestamp so regenerating does not change the file needlessly.
const out = new TextDecoder()
  .decode(bytes)
  .replace(/FILE_NAME\('([^']*)','[^']*'/, "FILE_NAME('robot-assembly.step','2026-09-30T00:00:00'");
const target = join(dirname(fileURLToPath(import.meta.url)), 'robot-assembly.step');
writeFileSync(target, out);
console.log(`wrote ${target} (${out.length} bytes)`);
