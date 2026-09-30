/**
 * 3MF package writer (3MF Core Specification 1.3, Materials and Properties
 * Extension 1.2). Package: `[Content_Types].xml`, the root relationship to
 * `/3D/3dmodel.model`, and the model part with `unit="millimeter"`.
 *
 * Model part:
 * - model-level metadata (`Title`, `Application`, optional `Designer`,
 *   `CreationDate`), all well-known core names;
 * - one `<m:basematerials>` group with one `<m:base>` per body (its name
 *   and colour, `displaycolor` as `#RRGGBBAA`);
 * - one `<m:colorgroup>` per body that has per-face colours
 *   (`faceColors`), referenced per triangle (`pid`/`p1`); triangles without
 *   a face colour inherit the object's base material;
 * - one `<object type="model">` per body: its display name, `partnumber` =
 *   the stable body id, a `<metadatagroup>` with the body id under the
 *   app's own declared namespace, and a **welded** mesh (the render mesh
 *   duplicates vertices per B-rep face; 3MF requires a manifold mesh with
 *   shared vertices and no degenerate triangles). Vertices are stored
 *   relative to the body's footprint centre / lowest point;
 * - one `<item>` per object in `<build>` with the translation back to the
 *   modelled position as its `transform`, so slicers keep the arrangement.
 *
 * Deterministic for identical input (no timestamps unless given). Built on
 * {@link buildZip} (store-only ZIP; no `jszip` in the lockfile). No
 * proprietary slicer project files are written (see `assembler/PRINTING.md`).
 */
import { weldMesh } from '../print/meshTools.js';
import { buildZip, type ZipEntryInput } from './zipWriter.js';

export const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
/** The app's own namespace for its per-object metadata (not a required extension). */
export const HCASM_NS = 'https://himmelcad.local/3mf/assembler/2026';
export const MODEL_REL_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
export const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
export const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>
  <Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="${MODEL_REL_TYPE}"/>
</Relationships>
`;

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );
}

/** `#RRGGBB` / `#RRGGBBAA` → `#RRGGBBAA`; anything else becomes a neutral grey. */
export function toSrgb(color: string): string {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(color);
  return m ? `#${m[1]!.toUpperCase()}${(m[2] ?? 'FF').toUpperCase()}` : '#B8BCC2FF';
}

/** 3MF `ST_Number`: plain decimal, micrometre resolution, no `-0`. */
function num(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) || rounded === 0 ? '0' : String(rounded);
}

/** What the writer needs of a body (`kernel/types.ts` `Body` satisfies it). */
export interface ThreeMfBodyInput {
  id: string;
  name: string;
  color: string;
  mesh: {
    positions: ArrayLike<number> & { length: number };
    indices: Uint32Array;
    /** Face index of every triangle (for `faceColors`). */
    triangleFaces?: Uint32Array;
  };
  faces?: readonly { key: string }[];
  /** Optional per-face colours by face key (`#RRGGBB`). */
  faceColors?: Readonly<Record<string, string>>;
}

export interface ThreeMfOptions {
  /** Bodies to include, in order; defaults to all. */
  bodyIds?: readonly string[];
  /** Model title (`Title` metadata). */
  title?: string;
  designer?: string;
  /** ISO 8601 date/time (`CreationDate` metadata); omitted by default for reproducible files. */
  creationDate?: string;
}

/** Builds a 3MF package (as bytes) from evaluated bodies, one object per body. */
export function buildThreeMf(
  bodies: readonly ThreeMfBodyInput[],
  options: ThreeMfOptions = {},
): Uint8Array {
  const wanted = options.bodyIds ? new Set(options.bodyIds) : null;
  const selected = wanted ? bodies.filter((b) => wanted.has(b.id)) : bodies;
  if (selected.length === 0) throw new Error('Nothing to export: no bodies selected');

  const BASE_ID = 1;
  let nextId = BASE_ID + 1;
  const materials = selected
    .map((b) => `      <m:base name="${xmlEscape(b.name)}" displaycolor="${toSrgb(b.color)}"/>`)
    .join('\n');

  const colorGroups: string[] = [];
  const objects: string[] = [];
  const items: string[] = [];

  selected.forEach((body, index) => {
    const welded = weldMesh({
      positions: Float64Array.from(body.mesh.positions as ArrayLike<number>),
      indices: body.mesh.indices,
    });
    const p = welded.positions;
    // Item placement: footprint centre and lowest point; vertices are stored relative to it.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]!);
      maxX = Math.max(maxX, p[i]!);
      minY = Math.min(minY, p[i + 1]!);
      maxY = Math.max(maxY, p[i + 1]!);
      minZ = Math.min(minZ, p[i + 2]!);
    }
    const origin =
      p.length > 0
        ? [
            Math.round(((minX + maxX) / 2) * 1e6) / 1e6,
            Math.round(((minY + maxY) / 2) * 1e6) / 1e6,
            Math.round(minZ * 1e6) / 1e6,
          ]
        : [0, 0, 0];

    // Per-face colours → one colour group for this object.
    let colorGroupId: number | null = null;
    const triangleColor: (number | null)[] = [];
    if (body.faceColors && body.mesh.triangleFaces && body.faces) {
      const palette: string[] = [];
      const paletteIndex = new Map<string, number>();
      for (const source of welded.sourceTriangles) {
        const face = body.faces[body.mesh.triangleFaces[source]!];
        const color = face ? body.faceColors[face.key] : undefined;
        if (!color) {
          triangleColor.push(null);
          continue;
        }
        const srgb = toSrgb(color);
        let i = paletteIndex.get(srgb);
        if (i === undefined) {
          i = palette.length;
          palette.push(srgb);
          paletteIndex.set(srgb, i);
        }
        triangleColor.push(i);
      }
      if (palette.length > 0) {
        colorGroupId = nextId++;
        colorGroups.push(
          `    <m:colorgroup id="${colorGroupId}">\n${palette
            .map((c) => `      <m:color color="${c}"/>`)
            .join('\n')}\n    </m:colorgroup>`,
        );
      }
    }

    const objectId = nextId++;
    const vertices: string[] = [];
    for (let v = 0; v < p.length; v += 3) {
      vertices.push(
        `          <vertex x="${num(p[v]! - origin[0]!)}" y="${num(p[v + 1]! - origin[1]!)}" z="${num(p[v + 2]! - origin[2]!)}"/>`,
      );
    }
    const triangles: string[] = [];
    const idx = welded.indices;
    for (let t = 0; t < idx.length / 3; t += 1) {
      const colour = colorGroupId !== null ? triangleColor[t] : null;
      const props =
        colour !== null && colour !== undefined ? ` pid="${colorGroupId}" p1="${colour}"` : '';
      triangles.push(
        `          <triangle v1="${idx[t * 3]}" v2="${idx[t * 3 + 1]}" v3="${idx[t * 3 + 2]}"${props}/>`,
      );
    }
    objects.push(`    <object id="${objectId}" type="model" name="${xmlEscape(body.name)}" partnumber="${xmlEscape(body.id)}" pid="${BASE_ID}" pindex="${index}">
      <metadatagroup>
        <metadata name="hcasm:bodyId" preserve="1">${xmlEscape(body.id)}</metadata>
      </metadatagroup>
      <mesh>
        <vertices>
${vertices.join('\n')}
        </vertices>
        <triangles>
${triangles.join('\n')}
        </triangles>
      </mesh>
    </object>`);
    items.push(
      `    <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 ${num(origin[0]!)} ${num(origin[1]!)} ${num(origin[2]!)}"/>`,
    );
  });

  const metadata = [
    ['Title', options.title ?? selected.map((b) => b.name).join(', ')],
    ['Application', 'HimmelCAD Assembler'],
    ...(options.designer ? [['Designer', options.designer]] : []),
    ...(options.creationDate ? [['CreationDate', options.creationDate]] : []),
  ]
    .map(([name, value]) => `  <metadata name="${name}">${xmlEscape(value!)}</metadata>`)
    .join('\n');

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:m="${MATERIAL_NS}" xmlns:hcasm="${HCASM_NS}">
${metadata}
  <resources>
    <m:basematerials id="${BASE_ID}">
${materials}
    </m:basematerials>
${[...colorGroups, ...objects].join('\n')}
  </resources>
  <build>
${items.join('\n')}
  </build>
</model>
`;

  const entries: ZipEntryInput[] = [
    { path: '[Content_Types].xml', data: new TextEncoder().encode(CONTENT_TYPES) },
    { path: '_rels/.rels', data: new TextEncoder().encode(ROOT_RELS) },
    { path: '3D/3dmodel.model', data: new TextEncoder().encode(model) },
  ];
  return buildZip(entries);
}
