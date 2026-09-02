#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const workspace = resolve(import.meta.dirname, '..');
const platform = process.argv[2];
const unpackedRoot = resolve(process.argv[3] ?? '');
const modeArgument = process.argv.find((argument) => argument.startsWith('--mode='));
const mode = modeArgument?.slice('--mode='.length) ?? 'native';
if (!['linux-x64', 'win32-x64'].includes(platform ?? '')) usage();
if (!process.argv[3] || !existsSync(unpackedRoot)) usage();
if (!['static', 'native', 'wine-workers'].includes(mode)) usage();

const resources = join(unpackedRoot, 'resources');
const executable = join(
  unpackedRoot,
  platform === 'win32-x64' ? 'himmelcad-photolab.exe' : 'himmelcad-photolab',
);
if (!existsSync(resources) || !statSync(resources).isDirectory()) {
  fail(`packaged application resources directory is missing: ${resources}`);
}
for (const required of [
  join(resources, 'app.asar'),
  join(resources, 'LICENSE.txt'),
  join(resources, 'THIRD_PARTY_NOTICES.md'),
  executable,
]) {
  if (!existsSync(required) || !statSync(required).isFile()) {
    fail(`packaged application payload is missing or not a regular file: ${required}`);
  }
}
if (platform === 'linux-x64') {
  const executablePaths = [
    executable,
    join(resources, 'himmelcad-sidecar'),
    join(resources, 'himmelcad-portable-mvs'),
    join(resources, 'vendor/colmap/linux-x64/bin/colmap'),
    join(resources, 'vendor/brush/linux-x64/brush_app'),
    join(resources, 'vendor/potreeconverter/linux-x64/PotreeConverter'),
    join(resources, 'vendor/dedode/linux-x64/python/bin/python3'),
    join(resources, 'workers/geo/bin/projinfo'),
    join(resources, 'workers/geo/bin/gdalinfo'),
  ];
  for (const path of executablePaths) {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      fail(`packaged Linux executable bit is missing: ${path}`);
    }
  }
}
execFileSync(
  process.execPath,
  [join(workspace, 'scripts/check-photolab-packaged-runtime.mjs'), platform, resources],
  { stdio: 'inherit' },
);

if (mode === 'static') {
  passed('static package payload and immutable runtime inventory');
  process.exit(0);
}

const hostPlatform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
if (mode === 'native' && hostPlatform !== platform) {
  fail(
    `native ${platform} start smoke must run on ${platform}; use --mode=wine-workers only for a non-certifying Windows worker cross-check`,
  );
}

const environment = runtimeEnvironment(resources, platform);
if (mode === 'wine-workers') {
  if (platform !== 'win32-x64' || process.platform === 'win32') {
    fail('wine-workers is only a non-Windows cross-check of the win32-x64 worker payload');
  }
  const wine = process.env.HIMMELCAD_WINE ?? findCommand(['wine64', 'wine']);
  if (!wine) fail('Wine worker cross-check requested, but wine64/wine is unavailable');
  runWorkerProbes(resources, platform, environment, wine);
  passed('Windows workers under Wine (cross-runtime only; native install/start is still required)');
  process.exit(0);
}

runWorkerProbes(resources, platform, environment, null);
const temporary = mkdtempSync(join(tmpdir(), 'himmelcad-photolab-package-smoke-'));
const reportPath = join(temporary, 'start-report.json');
try {
  const appEnvironment = {
    ...process.env,
    HIMMELCAD_PHOTOLAB_CLEAN_BOOT: '1',
    HIMMELCAD_RELEASE_SMOKE_REPORT: reportPath,
    HIMMELCAD_RELEASE_SMOKE_MODE: 'native',
  };
  const launcher =
    platform === 'linux-x64' && !process.env.DISPLAY && findCommand(['xvfb-run'])
      ? { command: findCommand(['xvfb-run']), args: ['-a', executable] }
      : { command: executable, args: [] };
  if (!launcher.command) fail('native application launcher is unavailable');
  const result = spawnSync(launcher.command, launcher.args, {
    env: appEnvironment,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`packaged application could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `packaged application start smoke exited ${String(result.status)}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  if (!existsSync(reportPath)) fail('packaged application did not publish its start-smoke report');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (
    report.schemaVersion !== 1 ||
    report.product !== 'HimmelCAD PhotoLab' ||
    report.packaged !== true ||
    report.rendererLoaded !== true ||
    report.sidecarRunning !== true ||
    report.error
  ) {
    fail(`packaged application start-smoke report is invalid: ${JSON.stringify(report)}`);
  }
  passed('native package payload, workers, renderer and sidecar start');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function runtimeEnvironment(resourcesRoot, target) {
  const suffix = target === 'win32-x64' ? '.exe' : '';
  const geoRoot = join(resourcesRoot, 'workers', 'geo');
  const dedodeRoot = join(resourcesRoot, 'vendor', 'dedode', target);
  const pythonRoot = join(dedodeRoot, 'python');
  const sitePackages =
    target === 'win32-x64'
      ? join(pythonRoot, 'Lib', 'site-packages')
      : join(pythonRoot, 'lib', 'python3.12', 'site-packages');
  const pathEntries =
    target === 'win32-x64'
      ? [
          join(geoRoot, 'bin'),
          pythonRoot,
          join(pythonRoot, 'DLLs'),
          join(sitePackages, 'onnxruntime', 'capi'),
        ]
      : [
          join(pythonRoot, 'lib'),
          join(sitePackages, 'onnxruntime', 'capi'),
          join(sitePackages, 'numpy.libs'),
          join(sitePackages, 'pillow.libs'),
        ];
  return {
    ...process.env,
    HIMMELCAD_WORKSPACE_ROOT: resourcesRoot,
    HIMMELCAD_COLMAP_EXECUTABLE: join(
      resourcesRoot,
      'vendor',
      'colmap',
      target,
      'bin',
      `colmap${suffix}`,
    ),
    HIMMELCAD_POTREE_CONVERTER: join(
      resourcesRoot,
      'vendor',
      'potreeconverter',
      target,
      `PotreeConverter${suffix}`,
    ),
    HIMMELCAD_BRUSH_EXECUTABLE: join(
      resourcesRoot,
      'vendor',
      'brush',
      target,
      `brush_app${suffix}`,
    ),
    HIMMELCAD_DEDODE_PYTHON: join(
      pythonRoot,
      target === 'win32-x64' ? 'python.exe' : 'bin/python3',
    ),
    HIMMELCAD_DEDODE_ROOT: dedodeRoot,
    HIMMELCAD_GDAL_ROOT: geoRoot,
    HIMMELCAD_PROJ_ROOT: geoRoot,
    PROJ_NETWORK: 'OFF',
    PROJ_DATA: join(geoRoot, 'share', 'proj'),
    GDAL_DATA: join(geoRoot, 'share', 'gdal'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    ...(target === 'win32-x64'
      ? { PATH: [...pathEntries, process.env.PATH].filter(Boolean).join(';') }
      : {
          LD_LIBRARY_PATH: [...pathEntries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        }),
  };
}

function runWorkerProbes(resourcesRoot, target, environment, prefix) {
  const suffix = target === 'win32-x64' ? '.exe' : '';
  const dedodePython = environment.HIMMELCAD_DEDODE_PYTHON;
  const probes = [
    [environment.HIMMELCAD_COLMAP_EXECUTABLE, ['--version'], /COLMAP\s+4\.1\.0/i],
    [environment.HIMMELCAD_POTREE_CONVERTER, ['--help'], /PotreeConverter/i],
    [environment.HIMMELCAD_BRUSH_EXECUTABLE, ['--version'], /brush-cli\s+0\.3\.0/i],
    [
      join(resourcesRoot, 'workers', 'geo', 'bin', `projinfo${suffix}`),
      ['EPSG:4326'],
      /GEOGCRS\["WGS 84"|\+datum=WGS84/i,
    ],
    [
      join(resourcesRoot, 'workers', 'geo', 'bin', `gdalinfo${suffix}`),
      ['--version'],
      /GDAL\s+3\./i,
    ],
    [
      dedodePython,
      [
        '-I',
        '-s',
        '-c',
        'import json,numpy,onnxruntime; print(json.dumps({"numpy":numpy.__version__,"onnxruntime":onnxruntime.__version__}))',
      ],
      /"numpy"\s*:\s*"2\.2\.6".*"onnxruntime"\s*:\s*"1\.24\.4"/s,
    ],
  ];
  for (const [command, args, expected] of probes) {
    if (!existsSync(command)) fail(`worker probe executable is missing: ${command}`);
    const executableCommand = prefix ?? command;
    const executableArgs = prefix ? [command, ...args] : args;
    const result = spawnSync(executableCommand, executableArgs, {
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      fail(
        `worker probe failed for ${basename(command)}: ${result.error?.message ?? (result.stderr || result.stdout).trim()}`,
      );
    }
    const output = `${result.stdout}\n${result.stderr}`;
    if (!expected.test(output)) {
      fail(
        `worker probe returned an unexpected version for ${basename(command)}: ${output.trim()}`,
      );
    }
  }
}

function findCommand(candidates) {
  for (const candidate of candidates) {
    try {
      const command = process.platform === 'win32' ? 'where.exe' : 'which';
      const output = execFileSync(command, [candidate], { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0];
      if (output) return output;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function passed(scope) {
  process.stdout.write(`PhotoLab package smoke passed: ${platform} · ${scope}\n`);
}

function usage() {
  fail(
    'usage: photolab-package-smoke.mjs <linux-x64|win32-x64> <unpacked-root> [--mode=static|native|wine-workers]',
  );
}

function fail(message) {
  process.stderr.write(`PhotoLab package smoke failed: ${message}\n`);
  process.exit(1);
}
