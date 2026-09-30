/**
 * 3MF import (3MF Core Specification 1.3; Materials and Properties 1.2 for
 * colours; Production 1.1 `p:path` components, which Bambu Studio,
 * OrcaSlicer and PrusaSlicer use to keep objects in separate model parts).
 *
 * Every build `<item>` becomes one reference mesh: its object's mesh and
 * components flattened, with component and item transforms baked into the
 * vertices (3MF places objects by these transforms, so this is where the
 * file puts them). The model `unit` is honoured: coordinates are converted
 * to millimetres (the file states its unit, so this is not a guess). The
 * item's colour is the colour most of its triangles have (object
 * `pid`/`pindex` or triangle `pid`/`p1` → `<basematerials>` `displaycolor`
 * or `<colorgroup>` colour); per-triangle colours are not kept (a reference
 * mesh has one colour).
 */
import { listZip, readZipEntry, type ZipEntry } from './zipReader.js';
import { scanXml } from './xmlScan.js';
import {
  MeshBuilder,
  MeshImportError,
  normalizeHexColor,
  type ImportedMeshObject,
  type MeshImportResult,
} from './meshObjects.js';

/** 3MF `ST_Matrix3D` as 12 numbers m00..m32 (row-vector convention: p' = p · M). */
type Matrix = number[];

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

function parseMatrix(value: string | undefined): Matrix {
  if (!value) return IDENTITY;
  const numbers = value.trim().split(/\s+/).map(Number);
  if (numbers.length !== 12 || numbers.some((v) => !Number.isFinite(v))) {
    throw new MeshImportError(`Invalid 3MF transform "${value}"`);
  }
  return numbers;
}

/** `a` applied first, then `b`. */
function compose(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(12);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let v = r === 3 ? b[9 + c]! : 0;
      for (let k = 0; k < 3; k += 1) v += a[r * 3 + k]! * b[k * 3 + c]!;
      out[r * 3 + c] = v;
    }
  }
  return out;
}

interface ObjectDef {
  id: string;
  name: string;
  pid?: string;
  pindex?: number;
  vertices: number[];
  /** v1, v2, v3 per triangle. */
  triangles: number[];
  /** Per triangle: property group id and index (or undefined). */
  triPid: (string | undefined)[];
  triP1: (number | undefined)[];
  components: { objectid: string; transform: Matrix; path?: string }[];
}

interface ModelPart {
  unit: string;
  objects: Map<string, ObjectDef>;
  items: { objectid: string; transform: Matrix; path?: string; partnumber?: string }[];
  /** Property groups: id → colour per index (`#RRGGBB`, or null). */
  properties: Map<string, (string | null)[]>;
}

function parseModelPart(text: string, onProgress?: (f: number) => void): ModelPart {
  const part: ModelPart = {
    unit: 'millimeter',
    objects: new Map(),
    items: [],
    properties: new Map(),
  };
  let object: ObjectDef | null = null;
  let group: (string | null)[] | null = null;
  scanXml(
    text,
    {
      open(name, a) {
        switch (name) {
          case 'model':
            if (a.unit) part.unit = a.unit;
            break;
          case 'object':
            object = {
              id: a.id ?? '',
              name: a.name ?? '',
              ...(a.pid !== undefined ? { pid: a.pid } : {}),
              ...(a.pindex !== undefined ? { pindex: Number(a.pindex) } : {}),
              vertices: [],
              triangles: [],
              triPid: [],
              triP1: [],
              components: [],
            };
            part.objects.set(object.id, object);
            break;
          case 'vertex':
            if (object) object.vertices.push(Number(a.x), Number(a.y), Number(a.z));
            break;
          case 'triangle':
            if (object) {
              object.triangles.push(Number(a.v1), Number(a.v2), Number(a.v3));
              object.triPid.push(a.pid);
              object.triP1.push(a.p1 !== undefined ? Number(a.p1) : undefined);
            }
            break;
          case 'component':
            if (object && a.objectid !== undefined) {
              object.components.push({
                objectid: a.objectid,
                transform: parseMatrix(a.transform),
                ...(a.path ? { path: a.path } : {}),
              });
            }
            break;
          case 'item':
            if (a.objectid !== undefined) {
              part.items.push({
                objectid: a.objectid,
                transform: parseMatrix(a.transform),
                ...(a.path ? { path: a.path } : {}),
                ...(a.partnumber ? { partnumber: a.partnumber } : {}),
              });
            }
            break;
          case 'basematerials':
          case 'colorgroup':
            group = [];
            if (a.id !== undefined) part.properties.set(a.id, group);
            break;
          case 'base':
            group?.push(normalizeHexColor(a.displaycolor));
            break;
          case 'color':
            group?.push(normalizeHexColor(a.color));
            break;
          default:
            break;
        }
      },
      close(name) {
        if (name === 'object') object = null;
        if (name === 'basematerials' || name === 'colorgroup') group = null;
      },
    },
    onProgress,
  );
  return part;
}

function rootModelPath(rels: string | null): string {
  if (rels) {
    const m =
      /<Relationship\b[^>]*Type="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/2013\/01\/3dmodel"[^>]*>/.exec(
        rels,
      );
    const target = m ? /Target="([^"]+)"/.exec(m[0]) : null;
    if (target) return target[1]!.replace(/^\/+/, '');
  }
  return '3D/3dmodel.model';
}

/** Parses a 3MF package into one mesh per build item (millimetres, transforms baked). */
export async function parseThreeMf(
  bytes: Uint8Array,
  fileName: string,
  onProgress?: (fraction: number) => void,
): Promise<MeshImportResult> {
  let entries: Map<string, ZipEntry>;
  try {
    entries = listZip(bytes);
  } catch (error) {
    throw new MeshImportError(
      `This is not a readable 3MF package (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const decoder = new TextDecoder('utf-8');
  const readText = async (path: string): Promise<string | null> => {
    const entry = entries.get(path.replace(/^\/+/, ''));
    return entry ? decoder.decode(await readZipEntry(bytes, entry)) : null;
  };
  const rootPath = rootModelPath(await readText('_rels/.rels'));
  const rootText = await readText(rootPath);
  if (rootText === null)
    throw new MeshImportError(`The 3MF package has no model part (${rootPath})`);
  const parts = new Map<string, ModelPart>();
  const root = parseModelPart(rootText, (f) => onProgress?.(f * 0.5));
  parts.set(rootPath, root);
  const warnings: string[] = [];
  const scale = UNIT_TO_MM[root.unit];
  if (scale === undefined) throw new MeshImportError(`Unknown 3MF unit "${root.unit}"`);

  const partFor = async (
    path: string | undefined,
    current: string,
  ): Promise<{ part: ModelPart; path: string }> => {
    const key = path ? path.replace(/^\/+/, '') : current;
    let part = parts.get(key);
    if (!part) {
      const text = await readText(key);
      if (text === null)
        throw new MeshImportError(`The 3MF package references a missing part "${key}"`);
      part = parseModelPart(text);
      parts.set(key, part);
    }
    return { part, path: key };
  };

  const objects: ImportedMeshObject[] = [];
  const usedNames = new Map<string, number>();
  const base = fileName.replace(/\.3mf$/i, '') || '3MF';
  let itemIndex = 0;
  for (const item of root.items) {
    itemIndex += 1;
    const builder = new MeshBuilder();
    const votes = new Map<string, number>();
    let firstName = '';
    const addObject = async (
      objectid: string,
      matrix: Matrix,
      path: string | undefined,
      current: string,
      depth: number,
    ) => {
      if (depth > 16) throw new MeshImportError('3MF components are nested too deeply (a cycle?)');
      const resolved = await partFor(path, current);
      const object = resolved.part.objects.get(objectid);
      if (!object)
        throw new MeshImportError(`The 3MF build references a missing object ${objectid}`);
      if (!firstName && object.name) firstName = object.name;
      const m = compose(matrix, [scale, 0, 0, 0, scale, 0, 0, 0, scale, 0, 0, 0]);
      const v = object.vertices;
      const count = v.length / 3;
      const tx = new Float64Array(v.length);
      for (let i = 0; i < count; i += 1) {
        const x = v[i * 3]!;
        const y = v[i * 3 + 1]!;
        const z = v[i * 3 + 2]!;
        tx[i * 3] = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
        tx[i * 3 + 1] = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
        tx[i * 3 + 2] = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
      }
      // A mirroring transform flips the winding; keep triangles facing outwards.
      const det =
        m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
        m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
        m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
      const t = object.triangles;
      for (let k = 0; k + 2 < t.length; k += 3) {
        const a = t[k]!;
        const b = det < 0 ? t[k + 2]! : t[k + 1]!;
        const c = det < 0 ? t[k + 1]! : t[k + 2]!;
        if (a >= count || b >= count || c >= count || a < 0 || b < 0 || c < 0) {
          throw new MeshImportError(
            `Object ${objectid} has a triangle with an invalid vertex index`,
          );
        }
        builder.add(
          tx[a * 3]!,
          tx[a * 3 + 1]!,
          tx[a * 3 + 2]!,
          tx[b * 3]!,
          tx[b * 3 + 1]!,
          tx[b * 3 + 2]!,
          tx[c * 3]!,
          tx[c * 3 + 1]!,
          tx[c * 3 + 2]!,
        );
        const tri = k / 3;
        const pid = object.triPid[tri] ?? object.pid;
        const index =
          object.triPid[tri] !== undefined
            ? (object.triP1[tri] ?? object.pindex ?? 0)
            : (object.pindex ?? 0);
        const colour =
          pid !== undefined ? (resolved.part.properties.get(pid)?.[index] ?? null) : null;
        if (colour) votes.set(colour, (votes.get(colour) ?? 0) + 1);
      }
      for (const component of object.components) {
        await addObject(
          component.objectid,
          compose(component.transform, matrix),
          component.path,
          resolved.path,
          depth + 1,
        );
      }
    };
    await addObject(item.objectid, item.transform, item.path, rootPath, 0);
    onProgress?.(0.5 + (0.5 * itemIndex) / Math.max(1, root.items.length));
    const mesh = builder.finish();
    if (mesh.triangleCount === 0) {
      warnings.push(`Object ${item.objectid} has no triangles and was skipped`);
      continue;
    }
    let color: string | null = null;
    let best = 0;
    for (const [c, n] of votes) {
      if (n > best) {
        best = n;
        color = c;
      }
    }
    if (votes.size > 1) {
      warnings.push(
        `"${firstName || item.partnumber || `Object ${item.objectid}`}" has several colours; the most common one is used`,
      );
    }
    const rawName = firstName || item.partnumber || `${base} ${itemIndex}`;
    const n = (usedNames.get(rawName) ?? 0) + 1;
    usedNames.set(rawName, n);
    objects.push({
      name: n === 1 ? rawName : `${rawName} (${n})`,
      color,
      folder: [],
      mesh,
    });
  }
  if (objects.length === 0) throw new MeshImportError('The 3MF package has no printable objects');
  if (objects.length > 1) for (const o of objects) o.folder = [base];
  if (scale !== 1)
    warnings.push(`Converted from ${root.unit} to millimetres (×${scale}), as the file declares`);
  return { format: '3mf', objects, declaredUnit: root.unit, unitScale: scale, warnings };
}
