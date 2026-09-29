import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDocument } from '../../../renderer/src/model/document.js';
import {
  CURRENT_SCHEMA_VERSION,
  PROJECT_FORMAT_ID,
  ProjectFormatError,
  loadProjectFile,
  migrateAndValidate,
  saveProjectFile,
} from '../../../renderer/src/model/project/format.js';

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

void test('migration guard: v1 migrates to itself (no-op) and validates', () => {
  const body = JSON.parse(
    saveProjectFile({
      projectName: 'P',
      features: [],
      appVersion: '0.1.0-test',
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
  ) as Record<string, unknown>;
  const project = migrateAndValidate(1, body);
  assert.equal(project.schemaVersion, 1);
  assert.deepEqual(project.features, []);
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
