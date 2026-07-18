import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PhotolabPreferencesService, type GcpCsvImportDefaults } from './preferences';

const CUSTOM_DEFAULTS: GcpCsvImportDefaults = {
  delimiter: ',',
  decimalSeparator: 'point',
  hasHeader: false,
  columns: { name: '4', east: '2', north: '1', height: '3' },
  role: 'checkpointXyz',
  horizontalStddev: 0.015,
  heightStddev: 0.025,
};

test('migrates schema v1 and atomically persists GCP CSV defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photolab-preferences-'));
  const path = join(directory, 'preferences.json');
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      lastProjectPath: join(directory, 'survey.hcadx'),
      directories: {
        project: directory,
        image: null,
        export: null,
        batch: null,
        verticalGrid: null,
        horizontalGrid: null,
      },
    }),
  );
  const service = new PhotolabPreferencesService(path);

  assert.deepEqual(await service.gcpCsvImportDefaults(), {
    delimiter: ';',
    decimalSeparator: 'comma',
    hasHeader: true,
    columns: { name: '0', east: '1', north: '2', height: '3' },
    role: 'controlXyz',
    horizontalStddev: 0.02,
    heightStddev: 0.03,
  });
  await service.rememberGcpCsvImportDefaults(CUSTOM_DEFAULTS);

  const persisted = JSON.parse(await readFile(path, 'utf8')) as {
    schemaVersion: unknown;
    directories: { project: unknown };
    gcpCsvImportDefaults: unknown;
  };
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.directories.project, directory);
  assert.deepEqual(persisted.gcpCsvImportDefaults, CUSTOM_DEFAULTS);
  assert.deepEqual(
    await new PhotolabPreferencesService(path).gcpCsvImportDefaults(),
    CUSTOM_DEFAULTS,
  );
  assert.deepEqual(await readdir(directory), ['preferences.json']);
});

test('rejects malformed renderer values without changing persisted preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photolab-preferences-'));
  const path = join(directory, 'preferences.json');
  const service = new PhotolabPreferencesService(path);
  await service.rememberGcpCsvImportDefaults(CUSTOM_DEFAULTS);
  const before = await readFile(path, 'utf8');

  await assert.rejects(
    service.rememberGcpCsvImportDefaults({ ...CUSTOM_DEFAULTS, delimiter: ';;' }),
    /Invalid GCP CSV import preferences/,
  );
  await assert.rejects(
    service.rememberGcpCsvImportDefaults({ ...CUSTOM_DEFAULTS, horizontalStddev: Number.NaN }),
    /Invalid GCP CSV import preferences/,
  );
  assert.equal(await readFile(path, 'utf8'), before);
});
