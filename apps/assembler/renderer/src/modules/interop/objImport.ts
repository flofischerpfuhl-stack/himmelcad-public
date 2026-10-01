/**
 * Wavefront OBJ import (geometry subset of the Wavefront "Object Files"
 * appendix): `v` (optionally with the common `v x y z r g b` vertex colour
 * extension), `f` with `v`, `v/vt`, `v//vn`, `v/vt/vn` and negative
 * (relative) indices, polygons fan-triangulated, `o` objects and `g` groups.
 *
 * Every group becomes its own reference mesh (Items: filed under a folder
 * named after the file, and after its `o` object when groups are nested in
 * objects). Vertex colours give the group's average colour. Not read:
 * `mtllib`/`usemtl` materials (a separate `.mtl` file the import does not
 * have), texture coordinates, normals (recomputed per triangle), curves
 * and surfaces (`curv`, `surf`), lines and points. OBJ has no unit: like
 * STL, the result is offered a one-time rescale when its size suggests
 * metres or inches, never rescaled silently.
 */
import {
  MeshBuilder,
  MeshImportError,
  hexFromRgb01,
  type ImportedMeshObject,
  type MeshImportResult,
} from './meshObjects.js';

interface Group {
  object: string;
  name: string;
  builder: MeshBuilder;
  colour: [number, number, number, number];
}

export function parseObj(
  text: string,
  fileName: string,
  onProgress?: (fraction: number) => void,
): MeshImportResult {
  const positions: number[] = [];
  const colours: number[] = [];
  let hasColours = false;
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  let object = '';
  let groupName = '';
  let current: Group | null = null;
  const warnings: string[] = [];
  let skipped = 0;
  const ensure = (): Group => {
    if (current) return current;
    const key = `${object}\u0000${groupName}`;
    let g = byKey.get(key);
    if (!g) {
      g = { object, name: groupName, builder: new MeshBuilder(), colour: [0, 0, 0, 0] };
      byKey.set(key, g);
      groups.push(g);
    }
    current = g;
    return g;
  };
  const vertexIndex = (token: string): number => {
    const raw = Number(token.split('/')[0]);
    if (!Number.isInteger(raw) || raw === 0)
      throw new MeshImportError(`Invalid face index "${token}"`);
    const count = positions.length / 3;
    const index = raw > 0 ? raw - 1 : count + raw;
    if (index < 0 || index >= count)
      throw new MeshImportError(`Face index ${raw} refers to a missing vertex`);
    return index;
  };
  const n = text.length;
  let start = 0;
  let line = 0;
  let nextReport = 1 << 20;
  while (start < n) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    let row = text.slice(start, end);
    start = end + 1;
    line += 1;
    // Line continuation.
    while (row.endsWith('\\') && start < n) {
      let next = text.indexOf('\n', start);
      if (next < 0) next = n;
      row = row.slice(0, -1) + ' ' + text.slice(start, next);
      start = next + 1;
    }
    const hash = row.indexOf('#');
    const content = (hash >= 0 ? row.slice(0, hash) : row).trim();
    if (!content) continue;
    const parts = content.split(/\s+/);
    const keyword = parts[0]!;
    try {
      if (keyword === 'v') {
        const [x, y, z] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
        positions.push(x, y, z);
        if (parts.length >= 7) {
          colours.push(Number(parts[4]), Number(parts[5]), Number(parts[6]));
          hasColours = true;
        } else colours.push(NaN, NaN, NaN);
      } else if (keyword === 'f') {
        const idx = parts.slice(1).map(vertexIndex);
        if (idx.length < 3) throw new MeshImportError('A face needs at least three vertices');
        const g = ensure();
        const p = positions;
        for (let k = 1; k + 1 < idx.length; k += 1) {
          const a = idx[0]!;
          const b = idx[k]!;
          const c = idx[k + 1]!;
          g.builder.add(
            p[a * 3]!,
            p[a * 3 + 1]!,
            p[a * 3 + 2]!,
            p[b * 3]!,
            p[b * 3 + 1]!,
            p[b * 3 + 2]!,
            p[c * 3]!,
            p[c * 3 + 1]!,
            p[c * 3 + 2]!,
          );
        }
        if (hasColours) {
          for (const i of idx) {
            const r = colours[i * 3]!;
            if (Number.isFinite(r)) {
              g.colour[0] += r;
              g.colour[1] += colours[i * 3 + 1]!;
              g.colour[2] += colours[i * 3 + 2]!;
              g.colour[3] += 1;
            }
          }
        }
      } else if (keyword === 'o') {
        object = parts.slice(1).join(' ');
        groupName = '';
        current = null;
      } else if (keyword === 'g') {
        groupName = parts.slice(1).join(' ');
        current = null;
      } else if (['vt', 'vn', 'vp', 's', 'usemtl', 'mtllib', 'l', 'p'].includes(keyword)) {
        // Not needed for a reference mesh.
      } else {
        skipped += 1;
      }
    } catch (error) {
      if (error instanceof MeshImportError)
        throw new MeshImportError(`Line ${line}: ${error.message}`);
      throw error;
    }
    if (onProgress && start >= nextReport) {
      nextReport = start + (1 << 20);
      onProgress(start / n);
    }
  }
  if (skipped > 0)
    warnings.push(
      `${skipped} line${skipped === 1 ? '' : 's'} with unsupported OBJ statements (curves, surfaces) were skipped`,
    );
  const base = fileName.replace(/\.obj$/i, '') || 'OBJ';
  const objects: ImportedMeshObject[] = [];
  const used = new Map<string, number>();
  const nonEmpty = groups.filter((g) => g.builder.triangles > 0);
  const multiple = nonEmpty.length > 1;
  const objectsWithGroups = new Set(
    nonEmpty.filter((g) => g.name && g.object).map((g) => g.object),
  );
  for (const g of nonEmpty) {
    const raw = g.name || g.object || base;
    const k = (used.get(raw) ?? 0) + 1;
    used.set(raw, k);
    const folder = multiple ? [base, ...(objectsWithGroups.has(g.object) ? [g.object] : [])] : [];
    objects.push({
      name: k === 1 ? raw : `${raw} (${k})`,
      color:
        g.colour[3] > 0
          ? hexFromRgb01(
              g.colour[0] / g.colour[3],
              g.colour[1] / g.colour[3],
              g.colour[2] / g.colour[3],
            )
          : null,
      folder,
      mesh: g.builder.finish(),
    });
  }
  if (objects.length === 0) throw new MeshImportError('The OBJ file has no faces');
  return { format: 'obj', objects, declaredUnit: null, unitScale: 1, warnings };
}
