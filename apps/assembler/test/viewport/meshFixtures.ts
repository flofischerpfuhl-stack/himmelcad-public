/**
 * Synthetic kernel bodies for renderer/measure tests: a box (six planar
 * faces, twelve line edges) and an open cylinder side (one curved face with
 * smooth radial normals, two circle edges). Same data layout as the kernel
 * (`kernel/types.ts`: per-face vertex blocks, `triangleFaces`, edge segments).
 */
import type { Body, EdgeInfo, FaceInfo } from '../../renderer/src/kernel/types.js';

type V = [number, number, number];

function face(
  key: string,
  surface: FaceInfo['surface'],
  normal: V | null,
  centroid: V,
  area: number,
  triangleStart: number,
  triangleCount: number,
  edgeIndices: number[],
): FaceInfo {
  return {
    key,
    aliases: [],
    surface,
    normal,
    centroid,
    area,
    triangleStart,
    triangleCount,
    edgeIndices,
    adjacentFaces: 4,
  };
}

function lineEdge(key: string, a: V, b: V, faceIndices: number[]): EdgeInfo {
  const d: V = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...d);
  return {
    key,
    faceIndices,
    curve: 'line',
    midpoint: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    length,
    direction: [d[0] / length, d[1] / length, d[2] / length],
    radius: null,
    segments: new Float32Array([...a, ...b]),
  };
}

/** Axis-aligned box from `min` to `max`, id `body:<id>`. */
export function boxBody(id: string, min: V, max: V, color = '#C9CDD3'): Body {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const corners: V[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  // Each face: 4 corner indices (counter-clockwise seen from outside) and a normal.
  const quads: { c: [number, number, number, number]; n: V; key: string }[] = [
    { c: [0, 3, 2, 1], n: [0, 0, -1], key: 'bottom' },
    { c: [4, 5, 6, 7], n: [0, 0, 1], key: 'top' },
    { c: [0, 1, 5, 4], n: [0, -1, 0], key: 'front' },
    { c: [2, 3, 7, 6], n: [0, 1, 0], key: 'back' },
    { c: [1, 2, 6, 5], n: [1, 0, 0], key: 'right' },
    { c: [3, 0, 4, 7], n: [-1, 0, 0], key: 'left' },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const triangleFaces: number[] = [];
  const faces: FaceInfo[] = [];
  quads.forEach((q, fi) => {
    const base = positions.length / 3;
    for (const ci of q.c) {
      positions.push(...corners[ci]!);
      normals.push(...q.n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    triangleFaces.push(fi, fi);
    const pts = q.c.map((ci) => corners[ci]!);
    const centroid: V = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k]!, 0) / 4) as V;
    const size = (k: number) =>
      Math.max(...pts.map((p) => p[k]!)) - Math.min(...pts.map((p) => p[k]!));
    const dims = [0, 1, 2].filter((k) => q.n[k] === 0).map(size);
    faces.push(face(`${id}:${q.key}`, 'plane', q.n, centroid, dims[0]! * dims[1]!, fi * 2, 2, []));
  });
  const edgePairs: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const edges = edgePairs.map(([a, b], i) => lineEdge(`${id}:e${i}`, corners[a]!, corners[b]!, []));
  // Face borders: every edge whose both ends lie on the face's plane.
  faces.forEach((f, fi) => {
    const n = quads[fi]!.n;
    const k = n.findIndex((v) => v !== 0);
    const level = f.centroid[k]!;
    f.edgeIndices = edgePairs
      .map(([a, b], ei) => ({ ei, on: corners[a]![k] === level && corners[b]![k] === level }))
      .filter((e) => e.on)
      .map((e) => e.ei);
  });
  return {
    id: `body:${id}`,
    name: id,
    color,
    createdBy: id,
    min: [...min],
    max: [...max],
    volume: (x1 - x0) * (y1 - y0) * (z1 - z0),
    valid: true,
    mesh: {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      triangleFaces: new Uint32Array(triangleFaces),
    },
    faces,
    edges,
  };
}

/** Open cylinder side of radius `r`, height `h` about the Z axis (`segments` around). */
export function cylinderBody(id: string, r: number, h: number, segments = 48): Body {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    positions.push(r * c, r * s, 0, r * c, r * s, h);
    normals.push(c, s, 0, c, s, 0);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    const b = ((i + 1) % segments) * 2;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const ring = (z: number) => {
    const s: number[] = [];
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      s.push(r * Math.cos(a0), r * Math.sin(a0), z, r * Math.cos(a1), r * Math.sin(a1), z);
    }
    return new Float32Array(s);
  };
  const circle = (key: string, z: number): EdgeInfo => ({
    key,
    faceIndices: [0],
    curve: 'circle',
    midpoint: [-r, 0, z],
    length: 2 * Math.PI * r,
    direction: null,
    radius: r,
    segments: ring(z),
  });
  const triangles = indices.length / 3;
  return {
    id: `body:${id}`,
    name: id,
    color: '#C9CDD3',
    createdBy: id,
    min: [-r, -r, 0],
    max: [r, r, h],
    volume: Math.PI * r * r * h,
    valid: true,
    mesh: {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      triangleFaces: new Uint32Array(triangles),
    },
    faces: [
      face(
        `${id}:side`,
        'cylinder',
        null,
        [0, 0, h / 2],
        2 * Math.PI * r * h,
        0,
        triangles,
        [0, 1],
      ),
    ],
    edges: [circle(`${id}:bottom`, 0), circle(`${id}:top`, h)],
  };
}
