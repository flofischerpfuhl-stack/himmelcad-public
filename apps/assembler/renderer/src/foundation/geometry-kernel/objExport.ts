/**
 * Wavefront OBJ export (Shapr3D exports OBJ for rendering/visualisation
 * tools): the already-tessellated {@link BodyMesh}es, one `o` object per
 * body named after it, shared vertices with their normals (`f v//vn`).
 * OBJ has no unit field; coordinates are millimetres like everywhere in
 * the app. No material file: colours are not written (3MF and STEP carry
 * them).
 */
import type { BodyMesh } from './types.js';

/** Six decimals: 1 nm, far below the tessellation tolerance. */
function num(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** An object name OBJ readers keep on one line. */
function objectName(name: string, index: number): string {
  const clean = name.replace(/[\r\n]+/g, ' ').trim();
  return clean || `Body ${index + 1}`;
}

/** OBJ text of the meshes (`o` per body; indices are global, 1-based). */
export function objText(
  bodies: readonly { name: string; mesh: BodyMesh }[],
  header = 'HimmelCAD Assembler',
): string {
  const lines: string[] = [`# ${header}`, '# Units: millimetres'];
  let base = 1;
  bodies.forEach((body, index) => {
    const { positions, normals, indices } = body.mesh;
    const count = positions.length / 3;
    lines.push(`o ${objectName(body.name, index)}`);
    for (let i = 0; i < count; i += 1) {
      lines.push(
        `v ${num(positions[i * 3]!)} ${num(positions[i * 3 + 1]!)} ${num(positions[i * 3 + 2]!)}`,
      );
    }
    const withNormals = normals.length === positions.length;
    if (withNormals) {
      for (let i = 0; i < count; i += 1) {
        lines.push(
          `vn ${num(normals[i * 3]!)} ${num(normals[i * 3 + 1]!)} ${num(normals[i * 3 + 2]!)}`,
        );
      }
    }
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const [a, b, c] = [indices[t]! + base, indices[t + 1]! + base, indices[t + 2]! + base];
      lines.push(withNormals ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
    }
    base += count;
  });
  return `${lines.join('\n')}\n`;
}

/** UTF-8 bytes of {@link objText}. */
export function objBytes(bodies: readonly { name: string; mesh: BodyMesh }[]): Uint8Array {
  return new TextEncoder().encode(objText(bodies));
}
