// Generates the mesh fixtures of the interop tests (run from apps/assembler:
// `node test/fixtures/interop/generate-mesh-fixtures.mjs`):
//
// - `parts.3mf`: model unit centimetre; item 1 = object "Cube" (1 cm cube,
//   base material red) lifted by 1 cm; item 2 = object "Pair" whose
//   components are the cube moved 2 cm along X and "Remote cube" (0.5 cm)
//   from a second model part `/3D/Objects/part.model` (Production extension
//   `p:path`, as Bambu Studio/OrcaSlicer write); item 3 = "Wedge", a
//   tetrahedron whose triangles use a colour group (#33AA55), mirrored in X.
//   Deflate-compressed ZIP entries.
// - `l-bracket.stl`: ASCII STL of a closed L-shaped prism (40 × 30 × 10 mm,
//   the vertical leg 10 mm thick): 8 coplanar-merge candidates.
// - `open-box.stl`: a box with its top missing (not closed: mesh → solid must refuse it).
import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---- ZIP writer (deflate) --------------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

function cubeMesh(size, extra = '') {
  const v = [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
    [0, 0, size],
    [size, 0, size],
    [size, size, size],
    [0, size, size],
  ];
  const t = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"${extra}/>`)
    .join('')}</triangles></mesh>`;
}

const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="centimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>
    <basematerials id="1"><base name="Red PLA" displaycolor="#FF0000FF"/><base name="Blue PLA" displaycolor="#0000FFFF"/></basematerials>
    <m:colorgroup id="4"><m:color color="#33AA55"/></m:colorgroup>
    <object id="2" type="model" name="Cube" pid="1" pindex="0">${cubeMesh(1)}</object>
    <object id="3" type="model" name="Wedge"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
    </vertices><triangles>
      <triangle v1="0" v2="2" v3="1" pid="4" p1="0"/><triangle v1="0" v2="1" v3="3" pid="4" p1="0"/>
      <triangle v1="0" v2="3" v3="2" pid="4" p1="0"/><triangle v1="1" v2="2" v3="3" pid="4" p1="0"/>
    </triangles></mesh></object>
    <object id="5" type="model" name="Pair"><components>
      <component objectid="2" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>
      <component objectid="6" p:path="/3D/Objects/part.model"/>
    </components></object>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 1"/>
    <item objectid="5"/>
    <item objectid="3" transform="-1 0 0 0 1 0 0 0 1 5 0 0"/>
  </build>
</model>
`;
const part = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="6" type="model" name="Remote cube">${cubeMesh(0.5)}</object></resources>
  <build/>
</model>
`;
const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
writeFileSync(
  join(here, 'parts.3mf'),
  zip([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rels],
    ['3D/3dmodel.model', model],
    ['3D/Objects/part.model', part],
  ]),
);

// ---- STL ----------------------------------------------------------------------------------
function asciiStl(name, triangles) {
  const lines = [`solid ${name}`];
  for (const [a, b, c] of triangles) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (const p of [a, b, c]) lines.push(`      vertex ${p[0]} ${p[1]} ${p[2]}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  return lines.join('\n');
}
/** Prism of a CCW polygon (xy) from z0 to z1, fan-triangulated caps (convex pieces given). */
function prism(outline, capTriangles, z0, z1) {
  const tris = [];
  for (const [i, j, k] of capTriangles) {
    const P = (n, z) => [outline[n][0], outline[n][1], z];
    tris.push([P(i, z0), P(k, z0), P(j, z0)]); // bottom, facing -Z
    tris.push([P(i, z1), P(j, z1), P(k, z1)]); // top, facing +Z
  }
  for (let n = 0; n < outline.length; n += 1) {
    const a = outline[n];
    const b = outline[(n + 1) % outline.length];
    tris.push([
      [a[0], a[1], z0],
      [b[0], b[1], z0],
      [b[0], b[1], z1],
    ]);
    tris.push([
      [a[0], a[1], z0],
      [b[0], b[1], z1],
      [a[0], a[1], z1],
    ]);
  }
  return tris;
}
// L outline, CCW: (0,0) (40,0) (40,10) (10,10) (10,30) (0,30).
const L = [
  [0, 0],
  [40, 0],
  [40, 10],
  [10, 10],
  [10, 30],
  [0, 30],
];
const lCaps = [
  [0, 1, 2],
  [0, 2, 3],
  [0, 3, 4],
  [0, 4, 5],
];
writeFileSync(join(here, 'l-bracket.stl'), asciiStl('l-bracket', prism(L, lCaps, 0, 10)));
const boxTris = prism(
  [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
  ],
  [
    [0, 1, 2],
    [0, 2, 3],
  ],
  0,
  20,
);
// Drop the two top triangles (indices 1 and 3 of the cap pairs).
writeFileSync(
  join(here, 'open-box.stl'),
  asciiStl(
    'open-box',
    boxTris.filter((_, i) => i !== 1 && i !== 3),
  ),
);
console.log('wrote parts.3mf, l-bracket.stl, open-box.stl');
