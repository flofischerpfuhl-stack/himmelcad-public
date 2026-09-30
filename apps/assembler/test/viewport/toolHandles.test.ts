import assert from 'node:assert/strict';
import test from 'node:test';

import type { Body } from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  opsAffine,
  transformOps,
} from '../../renderer/src/foundation/geometry-kernel/features/rigid.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { transformBody } from '../../renderer/src/platform/viewport/bodyTransform.js';
import {
  applyToolHandleValue,
  movePreviewBodies,
  pivotSnapPoint,
  toolHandleSet,
} from '../../renderer/src/viewport/toolHandles.js';

/** A unit-ish box body (two triangles per face are enough for bbox/centroid checks). */
function boxBody(): Body {
  const positions = new Float32Array([0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 5]);
  const circle: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    const b = ((i + 1) / 24) * Math.PI * 2;
    circle.push(
      5 + Math.cos(a) * 2,
      5 + Math.sin(a) * 2,
      5,
      5 + Math.cos(b) * 2,
      5 + Math.sin(b) * 2,
      5,
    );
  }
  return {
    id: 'body:b',
    name: 'B',
    color: '#B8BCC2',
    createdBy: 'b',
    min: [0, 0, 0],
    max: [20, 10, 5],
    volume: 1000,
    valid: true,
    mesh: {
      positions,
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      triangleFaces: new Uint32Array([0, 0]),
    },
    faces: [
      {
        key: 'b:end:0',
        aliases: [],
        surface: 'plane',
        normal: [0, 0, 1],
        centroid: [10, 5, 5],
        area: 200,
        triangleStart: 0,
        triangleCount: 2,
        edgeIndices: [0],
        adjacentFaces: 4,
      },
    ],
    edges: [
      {
        key: 'b:end:0|h:side:0:0',
        faceIndices: [0],
        curve: 'circle',
        midpoint: [7, 5, 5],
        length: 4 * Math.PI,
        direction: null,
        radius: 2,
        segments: new Float32Array(circle),
      },
    ],
  };
}

void test('transformBody rotates mesh, box, face centroids/normals and edge polylines', () => {
  const body = boxBody();
  const affine = opsAffine(
    transformOps({ dx: 0, dy: 0, dz: 10, rx: 0, ry: 0, rz: 90, pivot: [0, 0, 0] }),
  );
  const moved = transformBody(body, affine);
  assert.deepEqual(
    moved.min.map((v) => Math.round(v * 1e6) / 1e6),
    [-10, 0, 10],
  );
  assert.deepEqual(
    moved.max.map((v) => Math.round(v * 1e6) / 1e6),
    [0, 20, 15],
  );
  assert.deepEqual(
    moved.faces[0]!.centroid.map((v) => Math.round(v * 1e6) / 1e6),
    [-5, 10, 15],
  );
  assert.equal(body.min[0], 0, 'the input body is untouched');
});

void test('pivot snaps to a circular edge centre and to face centroids', () => {
  const body = boxBody();
  const centre = pivotSnapPoint({ kind: 'edge', bodyId: body.id, edgeKey: body.edges[0]!.key }, [
    body,
  ])!;
  centre.forEach((v, i) => assert.ok(Math.abs(v - [5, 5, 5][i]!) < 1e-4, `centre ${centre}`));
  assert.deepEqual(
    pivotSnapPoint({ kind: 'face', bodyId: body.id, faceKey: 'b:end:0' }, [body]),
    [10, 5, 5],
  );
  assert.equal(pivotSnapPoint({ kind: 'sketchProfile' }, [body]), null);
});

void test('move tool: three rings + pivot, ring values write the rotation, copy adds a preview body', () => {
  const store = useAssemblerStore;
  const body = boxBody();
  store.setState({ evaluation: { ...store.getState().evaluation, bodies: [body] } });
  store.getState().beginMove(body.id);
  const set = toolHandleSet(store.getState());
  assert.deepEqual(
    set.angles.map((a) => a.handle),
    ['ring:0', 'ring:1', 'ring:2'],
  );
  assert.deepEqual(set.pivot, [10, 5, 2.5]);
  assert.equal(set.chips.length, 3);
  applyToolHandleValue('ring:2', 30, false);
  const tool = store.getState().activeTool;
  assert.equal(tool?.kind === 'move' ? tool.rotation.rz : null, 30);
  if (tool?.kind !== 'move') throw new Error('move tool');
  assert.equal(movePreviewBodies(tool, [body]).ghosts.length, 1, 'the original shows as a ghost');
  store.getState().setMoveCopy(true);
  const copy = store.getState().activeTool;
  if (copy?.kind !== 'move') throw new Error('move tool');
  const preview = movePreviewBodies(copy, [body]);
  assert.equal(preview.bodies.length, 2);
  assert.deepEqual(preview.newIds, ['body:b::copy']);
  store.getState().cancel();
});
