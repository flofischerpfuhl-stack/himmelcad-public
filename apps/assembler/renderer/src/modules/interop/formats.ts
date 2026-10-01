/**
 * The exchange formats of the Assembler, what each import creates and what
 * it keeps — one table for the File menu, the drop target, `interop.formats`
 * and `assembler/INTEROP.md`.
 */

export interface FormatInfo {
  format: 'hcasm' | 'step' | 'iges' | 'stl' | '3mf' | 'obj' | 'dxf';
  label: string;
  extensions: string[];
  /** What an import becomes. */
  target: string;
  /** What survives the trip. */
  keeps: string;
}

export const INTEROP_FORMATS: readonly FormatInfo[] = [
  {
    format: 'step',
    label: 'STEP',
    extensions: ['step', 'stp'],
    target: 'bodies (one Import step)',
    keeps:
      'exact B-rep, product structure as nested Items folders, part names, part colours, placements; units converted to mm',
  },
  {
    format: 'iges',
    label: 'IGES',
    extensions: ['igs', 'iges'],
    target: 'bodies (one Import step)',
    keeps: 'needs an OCCT build with IGESControl (not in replicad-opencascadejs 1.1.0)',
  },
  {
    format: 'stl',
    label: 'STL',
    extensions: ['stl'],
    target: 'reference mesh',
    keeps:
      'triangles (binary or ASCII); no unit in the format: a rescale is offered, never applied silently',
  },
  {
    format: '3mf',
    label: '3MF',
    extensions: ['3mf'],
    target: 'reference meshes (one per build item)',
    keeps:
      'object names, item and component transforms, production-extension parts, colour/material (most common per object), declared unit converted to mm',
  },
  {
    format: 'obj',
    label: 'OBJ',
    extensions: ['obj'],
    target: 'reference meshes (one per group, in a folder)',
    keeps: 'polygons (triangulated), groups/objects, vertex colours; no .mtl materials, no unit',
  },
  {
    format: 'dxf',
    label: 'DXF',
    extensions: ['dxf'],
    target: 'a sketch on a plane or planar face',
    keeps:
      'lines, arcs, circles, polylines (bulges as arcs), splines, ellipses, points, block inserts; $INSUNITS; connected end points. No text, dimensions, hatches, layers or colours',
  },
];

export const STEP_EXPORT_FORMATS: readonly (Omit<FormatInfo, 'target'> & { source: string })[] = [
  {
    format: 'step',
    label: 'STEP',
    extensions: ['step'],
    source: 'bodies',
    keeps:
      'exact B-rep, names, colours, Items folders as sub-assemblies (optional); AP242 or AP214; mm, cm, m or in',
  },
  {
    format: 'iges',
    label: 'IGES',
    extensions: ['igs'],
    source: 'bodies',
    keeps: 'needs an OCCT build with IGESControl_Writer',
  },
  {
    format: 'stl',
    label: 'STL',
    extensions: ['stl'],
    source: 'bodies and visible reference meshes',
    keeps: 'triangles at a chosen resolution, one file or one per body',
  },
  {
    format: '3mf',
    label: '3MF',
    extensions: ['3mf'],
    source: 'bodies and visible reference meshes',
    keeps: 'welded manifold objects, names, colours, placements',
  },
  {
    format: 'obj',
    label: 'OBJ',
    extensions: ['obj'],
    source: 'bodies and visible reference meshes',
    keeps: 'one object per body with its name, shared vertices and normals, mm; no materials',
  },
  {
    format: 'dxf',
    label: 'DXF',
    extensions: ['dxf'],
    source: 'a sketch or a planar face outline',
    keeps:
      'lines, arcs, circles, ellipses, splines (R2000; polylines in R12), construction on its own layer',
  },
];

/** `accept` string of a file input for every importable format. */
export function importAccept(includeIges: boolean): string {
  return INTEROP_FORMATS.filter((f) => includeIges || f.format !== 'iges')
    .flatMap((f) => f.extensions.map((e) => `.${e}`))
    .join(',');
}
