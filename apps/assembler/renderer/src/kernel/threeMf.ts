/**
 * Minimal, spec-valid 3MF package writer: content types, root relationship,
 * `3D/3dmodel.model` with `unit="millimeter"`, one `<object>` (mesh) per
 * body, body colours as base materials (3MF Materials/Properties extension,
 * `<m:basematerials>` + `pid`/`pindex`), and a `<build>` item per object.
 * Built on {@link buildZip} (store-only ZIP; no `jszip` in the lockfile).
 */
import type { Body } from './types.js';
import { buildZip, type ZipEntryInput } from './zipWriter.js';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );
}

/** `#RRGGBB` (defaults alpha to opaque) or falls back to a neutral grey for an unparsable color. */
function toSrgb(color: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  return m ? `#${m[1]!.toUpperCase()}FF` : '#B8BCC2FF';
}

export interface ThreeMfOptions {
  /** Bodies to include, in order; defaults to all. */
  bodyIds?: readonly string[];
}

/** Builds a 3MF package (as bytes) from evaluated bodies, one object per body. */
export function buildThreeMf(bodies: readonly Body[], options: ThreeMfOptions = {}): Uint8Array {
  const wanted = options.bodyIds ? new Set(options.bodyIds) : null;
  const selected = wanted ? bodies.filter((b) => wanted.has(b.id)) : bodies;
  if (selected.length === 0) throw new Error('Nothing to export: no bodies selected');

  const materials = selected
    .map((b) => `      <m:base name="${xmlEscape(b.name)}" displaycolor="${toSrgb(b.color)}"/>`)
    .join('\n');

  const objects = selected
    .map((body, index) => {
      const vertexCount = body.mesh.positions.length / 3;
      const vertices: string[] = [];
      for (let v = 0; v < vertexCount; v += 1) {
        const x = body.mesh.positions[v * 3]!;
        const y = body.mesh.positions[v * 3 + 1]!;
        const z = body.mesh.positions[v * 3 + 2]!;
        vertices.push(`        <vertex x="${x}" y="${y}" z="${z}"/>`);
      }
      const triangleCount = body.mesh.indices.length / 3;
      const triangles: string[] = [];
      for (let t = 0; t < triangleCount; t += 1) {
        const v1 = body.mesh.indices[t * 3]!;
        const v2 = body.mesh.indices[t * 3 + 1]!;
        const v3 = body.mesh.indices[t * 3 + 2]!;
        triangles.push(`        <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`);
      }
      return `    <object id="${index + 2}" type="model" name="${xmlEscape(body.name)}" pid="1" pindex="${index}">
      <mesh>
        <vertices>
${vertices.join('\n')}
        </vertices>
        <triangles>
${triangles.join('\n')}
        </triangles>
      </mesh>
    </object>`;
    })
    .join('\n');

  const items = selected.map((_, index) => `    <item objectid="${index + 2}"/>`).join('\n');

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:basematerials id="1">
${materials}
    </m:basematerials>
${objects}
  </resources>
  <build>
${items}
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
