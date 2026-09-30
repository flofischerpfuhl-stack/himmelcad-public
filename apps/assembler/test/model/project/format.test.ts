import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDocument } from '../../../renderer/src/foundation/document/document.js';
import {
  CURRENT_SCHEMA_VERSION,
  PROJECT_FORMAT_ID,
  ProjectFormatError,
  loadProjectFile,
  migrateAndValidate,
  saveProjectFile,
} from '../../../renderer/src/foundation/document/format.js';

void test('round trip: save then load reproduces the same features and project name', () => {
  const features = createDemoDocument();
  const text = saveProjectFile({
    projectName: 'Bracket',
    features,
    appVersion: '0.1.0-test',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const project = loadProjectFile(text);
  assert.equal(project.format, PROJECT_FORMAT_ID);
  assert.equal(project.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(project.units, 'mm');
  assert.equal(project.projectName, 'Bracket');
  assert.deepEqual(project.features, features);
});

void test('round trip preserves createdAt across save/load and bumps modifiedAt on save', () => {
  const text = saveProjectFile({
    projectName: 'P',
    features: [],
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-06-01T00:00:00.000Z',
  });
  const project = loadProjectFile(text);
  assert.equal(project.createdAt, '2020-01-01T00:00:00.000Z');
  assert.equal(project.modifiedAt, '2020-06-01T00:00:00.000Z');
});

void test('rejects a file that is not JSON', () => {
  assert.throws(() => loadProjectFile('not json'), ProjectFormatError);
});

void test('rejects a file with the wrong format id', () => {
  const text = JSON.stringify({ format: 'something-else', schemaVersion: 1 });
  assert.throws(() => loadProjectFile(text), /not a HimmelCAD Assembler project/);
});

void test('rejects a missing schemaVersion', () => {
  const text = JSON.stringify({ format: PROJECT_FORMAT_ID });
  assert.throws(() => loadProjectFile(text), /missing or invalid schemaVersion/);
});

void test('migration guard: a schema version newer than this app understands is rejected with a clear message', () => {
  assert.throws(
    () => migrateAndValidate(CURRENT_SCHEMA_VERSION + 1, { format: PROJECT_FORMAT_ID }),
    (error: unknown) =>
      error instanceof ProjectFormatError &&
      /newer version of HimmelCAD Assembler/.test(error.message),
  );
});

void test('migration guard: an empty v1 body migrates to the current schema and validates', () => {
  const body = JSON.parse(
    saveProjectFile({
      projectName: 'P',
      features: [],
      appVersion: '0.1.0-test',
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
  ) as Record<string, unknown>;
  const project = migrateAndValidate(1, body);
  assert.equal(project.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
  assert.deepEqual(project.features, []);
});

/** The demo bracket exactly as schema v1 stored it (rectangle/circle profiles, index-based keys). */
function demoV1Features(): unknown[] {
  const plate = 'body:feature-extrude-1';
  const plateTop = {
    bodyId: plate,
    key: 'feature-extrude-1:end:0',
    signature: {
      surface: 'plane',
      normal: [0, 0, 1],
      centroid: [40, 20, 6],
      area: 3360,
      adjacentFaces: 5,
    },
  };
  return [
    {
      id: 'feature-sketch-1',
      name: 'Sketch 1',
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 80, height: 50 }],
    },
    {
      id: 'feature-extrude-1',
      name: 'Extrude 1',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 'feature-sketch-1' },
      distance: 6,
      symmetric: false,
      operation: 'new',
      resultBodyName: 'Bracket',
    },
    {
      id: 'feature-sketch-2',
      name: 'Sketch 2',
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XY', offset: 6 },
      profiles: [{ kind: 'rectangle', x: 0, y: 42, width: 80, height: 8 }],
    },
    {
      id: 'feature-extrude-2',
      name: 'Extrude 2',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 'feature-sketch-2' },
      distance: 40,
      symmetric: false,
      operation: 'join',
      targetBodyId: plate,
    },
    {
      id: 'feature-fillet-3',
      name: 'Fillet 1',
      suppressed: false,
      kind: 'fillet',
      radius: 4,
      edges: [
        {
          bodyId: plate,
          key: 'feature-extrude-1:end:0|feature-extrude-2:side:0:0',
          signature: { curve: 'line', midpoint: [40, 42, 6], length: 80, direction: [1, 0, 0] },
        },
      ],
    },
    {
      id: 'feature-sketch-4',
      name: 'Sketch 3',
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'face', face: plateTop },
      profiles: [{ kind: 'circle', cx: 40, cy: 20, radius: 3 }],
    },
    {
      id: 'feature-extrude-5',
      name: 'Extrude 3',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 'feature-sketch-4' },
      distance: -8,
      symmetric: false,
      operation: 'cut',
      targetBodyId: plate,
    },
  ];
}

function v1File(features: unknown[]): string {
  return JSON.stringify({
    format: PROJECT_FORMAT_ID,
    schemaVersion: 1,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'Bracket',
    features,
    createdAt: '2026-09-29T00:00:00.000Z',
    modifiedAt: '2026-09-29T00:00:00.000Z',
  });
}

void test('v1 -> v2 migration: the stored v1 demo bracket becomes exactly the v2 demo document', () => {
  const project = loadProjectFile(v1File(demoV1Features()));
  assert.equal(project.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(project.features, createDemoDocument());
});

void test('v1 -> v2 migration: profile indices become region keys and keys are renamed per profile', () => {
  const features = [
    {
      id: 's1',
      name: 'Sketch 1',
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [
        { kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
        { kind: 'circle', cx: 40, cy: 10, radius: 5 },
      ],
    },
    {
      id: 'e2',
      name: 'Extrude 2',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 's1', profileIndex: 1 },
      distance: 10,
      symmetric: false,
      operation: 'new',
    },
    {
      id: 'sh',
      name: 'Shell 1',
      suppressed: false,
      kind: 'shell',
      bodyId: 'body:e2',
      thickness: 1,
      faces: [
        {
          bodyId: 'body:e2',
          key: 'e2:end:1',
          signature: {
            surface: 'plane',
            normal: [0, 0, 1],
            centroid: [40, 10, 10],
            area: 78.5,
            adjacentFaces: 1,
          },
        },
        {
          bodyId: 'body:e2',
          key: 'e2:side:1:0#1',
          signature: {
            surface: 'cylinder',
            normal: null,
            centroid: [40, 10, 5],
            area: 314,
            adjacentFaces: 2,
          },
        },
      ],
    },
  ];
  const project = loadProjectFile(v1File(features));
  const sketch = project.features[0]!;
  assert.equal(sketch.kind, 'sketch');
  if (sketch.kind !== 'sketch') return;
  assert.equal(sketch.entities.filter((e) => e.kind === 'line').length, 4);
  assert.equal(sketch.entities.filter((e) => e.kind === 'circle').length, 1);
  assert.equal(sketch.dimensions.length, 4 + 3, 'rectangle x/y/width/height + circle x/y/diameter');
  const extrude = project.features[1]!;
  assert.deepEqual(extrude.kind === 'extrude' && extrude.profile, {
    kind: 'sketch',
    featureId: 's1',
    regions: ['c1'],
  });
  const shell = project.features[2]!;
  assert.deepEqual(shell.kind === 'shell' && shell.faces.map((f) => f.key), [
    'e2:end:0',
    'e2:side:0:c1#1',
  ]);
});

void test('v2 sketches are validated strictly (dangling references are rejected)', () => {
  const [sketch] = createDemoDocument();
  const broken = {
    ...sketch,
    entities: (sketch as { entities: unknown[] }).entities.map((e) =>
      (e as { id: string }).id === 'l1' ? { ...(e as object), b: 'nope' } : e,
    ),
  };
  const text = saveProjectFile({
    projectName: 'P',
    features: [broken as never],
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  assert.throws(() => loadProjectFile(text), /features\[0\]\.entities\[\d+\]\.b/);
});

void test('never partially loads a broken file: an invalid feature rejects the whole document', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 1,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'Broken',
    features: [
      {
        id: 'f1',
        name: 'Sketch 1',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
      },
      {
        id: 'f2',
        name: 'Extrude 1',
        suppressed: false,
        kind: 'extrude',
        profile: { kind: 'sketch', featureId: 'f1' },
        distance: 'not-a-number',
        symmetric: false,
        operation: 'new',
      },
    ],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /features\[1\]\.distance/);
});

void test('rejects duplicate feature ids', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 1,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'Dup',
    features: [
      {
        id: 'f1',
        name: 'Sketch 1',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
      },
      {
        id: 'f1',
        name: 'Sketch 2',
        suppressed: false,
        kind: 'sketch',
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
      },
    ],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /duplicate feature id/);
});

void test('rejects an unknown feature kind', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 1,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'P',
    features: [{ id: 'f1', name: 'X', suppressed: false, kind: 'teleport' }],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /unknown feature kind/);
});

void test('rejects wrong units', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 1,
    appVersion: '0.1.0-test',
    units: 'cm',
    projectName: 'P',
    features: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /units/);
});

void test('round trip preserves viewState (display mode, camera, section, panels)', () => {
  const text = saveProjectFile({
    projectName: 'P',
    features: [],
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
    viewState: {
      displayMode: 'xray',
      camera: { preset: 'iso' },
      section: { enabled: true, axis: 'Y', offset: 12.5, flipped: true },
      panels: { items: false, history: true },
    },
  });
  const project = loadProjectFile(text);
  assert.deepEqual(project.viewState, {
    displayMode: 'xray',
    camera: { preset: 'iso' },
    section: { enabled: true, axis: 'Y', offset: 12.5, flipped: true },
    panels: { items: false, history: true },
  });
});

void test('a file with no viewState loads with viewState left undefined (no invented defaults)', () => {
  const text = saveProjectFile({
    projectName: 'P',
    features: [],
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const project = loadProjectFile(text);
  assert.equal(project.viewState, undefined);
});

void test('round trip of a reference mesh preserves its transform, bbox and hidden flag', () => {
  const referenceMeshes = [
    {
      id: 'refmesh-1',
      name: 'Bracket scan',
      fileName: 'bracket.stl',
      data: 'Z2FyYmFnZS1nemlwLWJhc2U2NA==', // opaque to format.ts — decoding is meshCodec.ts's job
      min: [0, 0, 0] as [number, number, number],
      max: [10, 20, 30] as [number, number, number],
      transform: { dx: 1, dy: 2, dz: 3 },
      hidden: true,
    },
  ];
  const text = saveProjectFile({
    projectName: 'P',
    features: [],
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
    referenceMeshes,
  });
  const project = loadProjectFile(text);
  assert.deepEqual(project.referenceMeshes, referenceMeshes);
});

void test('rejects duplicate reference mesh ids', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 1,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'P',
    features: [],
    referenceMeshes: [
      {
        id: 'm1',
        name: 'A',
        fileName: 'a.stl',
        data: 'AA==',
        min: [0, 0, 0],
        max: [1, 1, 1],
        transform: { dx: 0, dy: 0, dz: 0 },
        hidden: false,
      },
      {
        id: 'm1',
        name: 'B',
        fileName: 'b.stl',
        data: 'AA==',
        min: [0, 0, 0],
        max: [1, 1, 1],
        transform: { dx: 0, dy: 0, dz: 0 },
        hidden: false,
      },
    ],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /duplicate reference mesh id/);
});

void test('rejects a reference mesh with an empty data field', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 1,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'P',
    features: [],
    referenceMeshes: [
      {
        id: 'm1',
        name: 'A',
        fileName: 'a.stl',
        data: '',
        min: [0, 0, 0],
        max: [1, 1, 1],
        transform: { dx: 0, dy: 0, dz: 0 },
        hidden: false,
      },
    ],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /referenceMeshes\[0\]\.data/);
});

void test('round trip of an importStep feature preserves embedded data', () => {
  const features = [
    {
      id: 'feature-import-1',
      name: 'Import 1',
      suppressed: false,
      kind: 'importStep' as const,
      data: Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;').toString('base64'),
      fileName: 'part.step',
    },
  ];
  const text = saveProjectFile({
    projectName: 'P',
    features,
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const project = loadProjectFile(text);
  assert.deepEqual(project.features, features);
});

// ---- schema v3: document parameters ----------------------------------------------

void test('round trip preserves parameters (value, unit, expression)', () => {
  const parameters = [
    { id: 'p1', name: 'wall', unit: 'mm' as const, value: 2 },
    { id: 'p2', name: 'hole_d', unit: 'mm' as const, value: 4, expression: 'wall * 2' },
  ];
  const text = saveProjectFile({
    projectName: 'P',
    features: [],
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
    parameters,
  });
  const project = loadProjectFile(text);
  assert.deepEqual(project.parameters, parameters);
});

void test('a file with no parameters loads with an empty array', () => {
  const text = saveProjectFile({
    projectName: 'P',
    features: [],
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const project = loadProjectFile(text);
  assert.deepEqual(project.parameters, []);
});

void test('v2 -> v3 migration: a schema-2 file with no parameters field gets an empty array', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 2,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'P',
    features: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  const project = loadProjectFile(JSON.stringify(raw));
  assert.equal(project.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(project.parameters, []);
});

void test('rejects a parameter with an invalid identifier name', () => {
  const raw = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 3,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'P',
    features: [],
    parameters: [{ id: 'p1', name: '2bad', unit: 'mm', value: 1 }],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /parameters\[0\]\.name/);
});

void test('rejects duplicate parameter ids and duplicate parameter names', () => {
  const base = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: 3,
    appVersion: '0.1.0-test',
    units: 'mm',
    projectName: 'P',
    features: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    modifiedAt: '2020-01-01T00:00:00.000Z',
  };
  assert.throws(
    () =>
      loadProjectFile(
        JSON.stringify({
          ...base,
          parameters: [
            { id: 'p1', name: 'a', unit: 'mm', value: 1 },
            { id: 'p1', name: 'b', unit: 'mm', value: 2 },
          ],
        }),
      ),
    /duplicate parameter id/,
  );
  assert.throws(
    () =>
      loadProjectFile(
        JSON.stringify({
          ...base,
          parameters: [
            { id: 'p1', name: 'a', unit: 'mm', value: 1 },
            { id: 'p2', name: 'a', unit: 'mm', value: 2 },
          ],
        }),
      ),
    /duplicate parameter name/,
  );
});

void test('round trip preserves an extrude distanceExpression alongside its resolved distance', () => {
  const features = [
    {
      id: 'feature-extrude-1',
      name: 'Extrude 1',
      suppressed: false,
      kind: 'extrude' as const,
      profile: { kind: 'sketch' as const, featureId: 'nope' },
      distance: 4,
      distanceExpression: 'wall * 2',
      symmetric: false,
      operation: 'new' as const,
    },
  ];
  const text = saveProjectFile({
    projectName: 'P',
    features,
    appVersion: '0.1.0-test',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const project = loadProjectFile(text);
  const extrude = project.features[0]!;
  assert.equal(extrude.kind === 'extrude' && extrude.distanceExpression, 'wall * 2');
  assert.equal(extrude.kind === 'extrude' && extrude.distance, 4);
});

void test('thumbnail: a PNG data URL is saved right after the project name and kept on load; a bad one is dropped', () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const text = saveProjectFile({
    projectName: 'Box',
    features: createDemoDocument(),
    appVersion: 'test',
    thumbnail: png,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const keys = Object.keys(JSON.parse(text) as object);
  assert.equal(keys.indexOf('thumbnail'), keys.indexOf('projectName') + 1);
  assert.equal(loadProjectFile(text).thumbnail, png);
  const bad = JSON.parse(text) as Record<string, unknown>;
  bad.thumbnail = 'data:text/html;base64,PGgxPg==';
  const loaded = loadProjectFile(JSON.stringify(bad));
  assert.equal(
    loaded.thumbnail,
    undefined,
    'an invalid thumbnail is dropped, the project still loads',
  );
  assert.equal(loaded.features.length, createDemoDocument().length);
});
