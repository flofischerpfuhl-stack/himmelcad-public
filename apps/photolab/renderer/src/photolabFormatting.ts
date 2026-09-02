import type { EntitySnapshot } from '@himmelcad/data';

const NATURAL_COLLATOR = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base',
});
const NATURALLY_SORTED_TREE_KINDS = new Set(['CameraImage', 'GroundControlPoint']);

export function naturalNameCompare(left: string, right: string): number {
  return NATURAL_COLLATOR.compare(left, right);
}

export function splitImageImportPaths(paths: readonly string[]): {
  himmelcapPaths: string[];
  imagePaths: string[];
} {
  const himmelcapPaths: string[] = [];
  const imagePaths: string[] = [];
  for (const path of paths) {
    (path.toLocaleLowerCase('en-US').endsWith('.hcap') ? himmelcapPaths : imagePaths).push(path);
  }
  return { himmelcapPaths, imagePaths };
}

export function comparePhotolabTreeEntities(left: EntitySnapshot, right: EntitySnapshot): number {
  if (left.kind !== right.kind || !NATURALLY_SORTED_TREE_KINDS.has(left.kind)) return 0;
  return naturalNameCompare(left.name || left.id, right.name || right.id);
}

export function humanizeEnum(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}

export interface YawPitchRollDegrees {
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * Converts PhotoLab's row-major camera-to-world matrix to the same north-based
 * yaw, elevation pitch, and optical-axis roll convention used by DJI metadata.
 */
export function cameraRotationToYawPitchRoll(
  matrix: readonly number[],
): YawPitchRollDegrees | null {
  if (matrix.length !== 9 || matrix.some((value) => !Number.isFinite(value))) return null;
  const forward = normalize([matrix[2]!, matrix[5]!, matrix[8]!]);
  const right = normalize([matrix[0]!, matrix[3]!, matrix[6]!]);
  if (!forward || !right) return null;
  const yaw = Math.atan2(forward[0], forward[1]);
  const pitch = Math.asin(clamp(forward[2], -1, 1));
  const unrolledRight = [Math.cos(yaw), -Math.sin(yaw), 0] as const;
  const unrolledUp = normalize(cross(unrolledRight, forward));
  if (!unrolledUp) return null;
  const roll = Math.atan2(dot(right, unrolledUp), dot(right, unrolledRight));
  const toDegrees = 180 / Math.PI;
  return { yaw: yaw * toDegrees, pitch: pitch * toDegrees, roll: roll * toDegrees };
}

function normalize(value: readonly [number, number, number]): [number, number, number] | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > Number.EPSILON ? [value[0] / length, value[1] / length, value[2] / length] : null;
}

function cross(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
