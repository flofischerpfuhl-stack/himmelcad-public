import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  chmodSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stdout } from 'node:process';

const workspace = resolve(import.meta.dirname, '..');
const stage = readFileSync(join(workspace, 'scripts/stage-photolab-runtime.mjs'), 'utf8');
const inventory = readFileSync(
  join(workspace, 'scripts/check-photolab-release-inventory.mjs'),
  'utf8',
);
const packaged = readFileSync(
  join(workspace, 'scripts/check-photolab-packaged-runtime.mjs'),
  'utf8',
);
const packageSmoke = readFileSync(join(workspace, 'scripts/photolab-package-smoke.mjs'), 'utf8');
const installSmoke = readFileSync(join(workspace, 'scripts/photolab-install-smoke.mjs'), 'utf8');
const sidecar = readFileSync(join(workspace, 'apps/photolab/electron/sidecar.ts'), 'utf8');
const linuxBuilder = readFileSync(
  join(workspace, 'apps/photolab/electron-builder.linux.yml'),
  'utf8',
);
const windowsBuilder = readFileSync(
  join(workspace, 'apps/photolab/electron-builder.win.yml'),
  'utf8',
);

for (const target of ['linux-x64', 'win32-x64']) {
  assert.match(stage, new RegExp(`stageColmapRuntime\\('${target.replace('-', '\\-')}'\\)`));
  assert.match(stage, new RegExp(`stageDedodeRuntime\\('${target.replace('-', '\\-')}'\\)`));
}
assert.doesNotMatch(
  stage,
  /copyRequired\([^\n]+join\(root,\s*'vendor',\s*'colmap'/,
  'staging must not add generated DLLs to immutable vendor/colmap',
);
assert.match(inventory, /workers\/colmap/);
assert.match(inventory, /LICENSE-Microsoft-VC-Runtime\.rtf/);
assert.match(inventory, /LICENSE-winpthreads\.txt/);
assert.match(packaged, /runtimePrefix}colmap/);
assert.match(linuxBuilder, /photolab-runtime\/linux-x64\/workers\/colmap/);
assert.match(windowsBuilder, /photolab-runtime\/win32-x64\/workers\/colmap/);
for (const contract of [
  'PROJ_NETWORK',
  'PROJ_DATA',
  'GDAL_DATA',
  'PYTHONNOUSERSITE',
  'PYTHONDONTWRITEBYTECODE',
]) {
  assert.match(sidecar, new RegExp(contract));
}
assert.match(packageSmoke, /cross-runtime only/);
assert.match(packageSmoke, /native .* start smoke must run/);
assert.match(installSmoke, /Wine is deliberately not accepted/);
assert.match(installSmoke, /NSIS installation/);

const fixture = mkdtempSync(join(tmpdir(), 'photolab-release-contract-'));
try {
  const unpacked = join(fixture, 'linux-unpacked');
  const resources = join(unpacked, 'resources');
  const records = [
    ['.build/photolab-runtime/linux-x64/workers/colmap/bin/colmap', 'colmap'],
    ['.build/photolab-runtime/linux-x64/workers/dedode/models/model.onnx', 'dedode'],
    ['.build/photolab-runtime/linux-x64/workers/dedode/python/bin/python3', 'python'],
    ['.build/photolab-runtime/linux-x64/workers/geo/bin/projinfo', 'proj'],
    ['.build/photolab-runtime/linux-x64/workers/geo/bin/gdalinfo', 'gdal'],
    ['vendor/brush/linux-x64/brush_app', 'brush'],
    ['vendor/potreeconverter/linux-x64/PotreeConverter', 'potree'],
    ['target/release/himmelcad-sidecar', 'sidecar'],
    ['target/release/himmelcad-portable-mvs', 'mvs'],
  ].map(([path, value]) => ({ path, value }));
  for (const [path, value] of [
    [join(resources, 'vendor/colmap/linux-x64/bin/colmap'), 'colmap'],
    [join(resources, 'vendor/dedode/linux-x64/models/model.onnx'), 'dedode'],
    [join(resources, 'vendor/dedode/linux-x64/python/bin/python3'), 'python'],
    [join(resources, 'workers/geo/bin/projinfo'), 'proj'],
    [join(resources, 'workers/geo/bin/gdalinfo'), 'gdal'],
    [join(resources, 'vendor/brush/linux-x64/brush_app'), 'brush'],
    [join(resources, 'vendor/potreeconverter/linux-x64/PotreeConverter'), 'potree'],
    [join(resources, 'himmelcad-sidecar'), 'sidecar'],
    [join(resources, 'himmelcad-portable-mvs'), 'mvs'],
    [join(resources, 'app.asar'), 'asar'],
    [join(resources, 'LICENSE.txt'), 'license'],
    [join(resources, 'THIRD_PARTY_NOTICES.md'), 'notices'],
    [join(unpacked, 'himmelcad-photolab'), 'application'],
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }
  for (const path of [
    join(unpacked, 'himmelcad-photolab'),
    join(resources, 'himmelcad-sidecar'),
    join(resources, 'himmelcad-portable-mvs'),
    join(resources, 'vendor/colmap/linux-x64/bin/colmap'),
    join(resources, 'vendor/brush/linux-x64/brush_app'),
    join(resources, 'vendor/potreeconverter/linux-x64/PotreeConverter'),
    join(resources, 'vendor/dedode/linux-x64/python/bin/python3'),
    join(resources, 'workers/geo/bin/projinfo'),
    join(resources, 'workers/geo/bin/gdalinfo'),
  ]) {
    chmodSync(path, 0o755);
  }
  writeFileSync(
    join(resources, 'RELEASE_INVENTORY.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: 'HimmelCAD PhotoLab',
        platform: 'linux-x64',
        files: records.map(({ path, value }) => ({
          path,
          bytes: Buffer.byteLength(value),
          sha256: createHash('sha256').update(value).digest('hex'),
        })),
      },
      null,
      2,
    )}\n`,
  );
  const valid = spawnSync(
    process.execPath,
    [
      join(workspace, 'scripts/photolab-package-smoke.mjs'),
      'linux-x64',
      unpacked,
      '--mode=static',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /static package payload and immutable runtime inventory/);

  writeFileSync(join(resources, 'workers/geo/bin/projinfo'), 'corrupt');
  const corrupt = spawnSync(
    process.execPath,
    [
      join(workspace, 'scripts/photolab-package-smoke.mjs'),
      'linux-x64',
      unpacked,
      '--mode=static',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /size differs|hash differs/);

  if (process.platform !== 'win32') {
    const fakeWindowsInstaller = join(fixture, 'HimmelCAD-PhotoLab-fixture-x64-setup.exe');
    writeFileSync(fakeWindowsInstaller, 'not an installer');
    const foreignInstall = spawnSync(
      process.execPath,
      [
        join(workspace, 'scripts/photolab-install-smoke.mjs'),
        'win32-x64',
        fakeWindowsInstaller,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(foreignInstall.status, 0);
    assert.match(foreignInstall.stderr, /must run on a native win32-x64 host/);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

stdout.write('PhotoLab release/packaging contract tests passed.\n');
