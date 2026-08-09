#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const platform = process.argv[2] ?? (process.platform === 'win32' ? 'win32-x64' : 'linux-x64');
if (!['linux-x64', 'win32-x64'].includes(platform)) fail(`unsupported platform: ${platform}`);
const pinnedObjdump = join(
  workspace,
  '.build/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64/bin/llvm-objdump',
);
const objdump =
  process.env.HIMMELCAD_OBJDUMP ?? (existsSync(pinnedObjdump) ? pinnedObjdump : 'objdump');
const approvedDedodeManifestSha256 =
  '747d3a26c54d24b46acee82c05c51913987d2e8b0b5ea231767e7e7197ea366b';
const runtimeRoot = join(workspace, `.build/photolab-runtime/${platform}`);
const dedodeRoot = join(runtimeRoot, 'workers/dedode');
const dedodeModelRoot = join(dedodeRoot, 'models');
const dedodeManifestPath = join(dedodeRoot, 'ONNX_MODELS.json');
const geoRoot = join(runtimeRoot, 'workers/geo');
const colmapRoot = join(runtimeRoot, 'workers/colmap');
const colmapManifestPath = join(colmapRoot, 'VENDOR.json');
const approvedArtifactHashes = new Map([
  [
    join(workspace, 'vendor/photolab-models/colmap-4.1.0/aliked-n16rot.onnx'),
    '39c423d0a6f03d39ec89d3d1d61853765c2fb6a8b8381376c703e5758778a547',
  ],
  [
    join(workspace, 'vendor/photolab-models/colmap-4.1.0/aliked-n32.onnx'),
    'a077728a02d2de1a775c66df6de8cfeb7c6b51ca57572c64c680131c988c8b3c',
  ],
  [
    join(workspace, 'vendor/photolab-models/colmap-4.1.0/aliked-lightglue.onnx'),
    'b9a5de7204648b18a8cf5dcac819f9d30de1a5961ef03756803c8b86c2dceb8d',
  ],
  [
    join(workspace, 'vendor/photolab-models/colmap-4.1.0/sift-lightglue.onnx'),
    'e0500228472b43f92b3d36881a09b3310d3b058b56187b246cc7b9ab6429096e',
  ],
  [
    join(workspace, `vendor/brush/${platform}/brush_app${platform === 'win32-x64' ? '.exe' : ''}`),
    platform === 'win32-x64'
      ? '37e46cbf808b9983dd15a5f9a25328dbe43e7e06d53c4f59fbeaeb10e3a5b34a'
      : '13d28ee06a388bc4e987774e890b594d60a75bba26064e82b4ee338a78f158a4',
  ],
  [
    join(
      workspace,
      `vendor/potreeconverter/${platform}/PotreeConverter${platform === 'win32-x64' ? '.exe' : ''}`,
    ),
    platform === 'win32-x64'
      ? '6698bd0ddf65b6f12264720f6efc8f02e279a221028224f2365c7427447ea755'
      : '60c7b51f228c784fcae19b26928276acfba8fdb191e14819c1cc975737f8bc9f',
  ],
]);
if (platform === 'win32-x64') {
  const vcRuntimeHashes = new Map([
    ['msvcp140.dll', '0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9'],
    ['msvcp140_1.dll', 'bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d'],
    ['vcruntime140.dll', 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066'],
    ['vcruntime140_1.dll', '1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f'],
    [
      'LICENSE-Microsoft-VC-Runtime.rtf',
      '8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b',
    ],
  ]);
  for (const [name, hash] of vcRuntimeHashes) {
    approvedArtifactHashes.set(join(dedodeRoot, 'python', name), hash);
  }
}
const approvedProjDataHashes = [
  '46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2',
  '598f18324dea7f8e72421d18add7ac6228259adf91eeb335cc9c27d98484f7ac',
  '529acdef6f5634669087de3dfc7923ab0100a9a7d94fa5e5b4aadb7ec4226c6c',
];

const roots = [
  colmapRoot,
  join(workspace, `vendor/brush/${platform}`),
  join(workspace, `vendor/potreeconverter/${platform}`),
  join(workspace, 'vendor/photolab-models'),
  dedodeRoot,
  geoRoot,
];
const requiredExecutables = [
  join(
    workspace,
    platform === 'win32-x64'
      ? 'target/x86_64-pc-windows-gnullvm/release/himmelcad-sidecar.exe'
      : 'target/release/himmelcad-sidecar',
  ),
  join(
    workspace,
    platform === 'win32-x64'
      ? 'target/x86_64-pc-windows-gnullvm/release/himmelcad-portable-mvs.exe'
      : 'target/release/himmelcad-portable-mvs',
  ),
];
if (platform === 'win32-x64') {
  requiredExecutables.push(
    join(workspace, 'target/x86_64-pc-windows-gnullvm/release/libunwind.dll'),
  );
}

const executableSuffix = platform === 'win32-x64' ? '.exe' : '';
const dedodePython = join(dedodeRoot, 'python');
const geoTools = [
  'gdal_grid',
  'gdal_rasterize',
  'gdalwarp',
  'gdalbuildvrt',
  'gdal_translate',
  'gdalinfo',
  'ogrinfo',
  'ogr2ogr',
  'cct',
  'projinfo',
].map((tool) => join(geoRoot, 'bin', `${tool}${executableSuffix}`));
const bundledProjData = [
  'de_adv_BETA2007.tif',
  'de_bkg_gcg2016.tif',
  'de_lgvl_saarland_SeTa2016.tif',
].map((file) => join(geoRoot, 'share/proj', file));
const requiredReleaseInputs = [
  ...requiredExecutables,
  colmapManifestPath,
  join(workspace, `vendor/colmap/${platform}/bin/colmap${executableSuffix}`),
  join(workspace, `vendor/brush/${platform}/brush_app${executableSuffix}`),
  join(workspace, `vendor/potreeconverter/${platform}/PotreeConverter${executableSuffix}`),
  join(workspace, 'vendor/photolab-models/colmap-4.1.0/aliked-n16rot.onnx'),
  join(workspace, 'vendor/photolab-models/colmap-4.1.0/aliked-n32.onnx'),
  join(workspace, 'vendor/photolab-models/colmap-4.1.0/aliked-lightglue.onnx'),
  join(workspace, 'vendor/photolab-models/colmap-4.1.0/sift-lightglue.onnx'),
  dedodeManifestPath,
  join(dedodeRoot, 'dedode_onnx_worker.py'),
  join(dedodePython, platform === 'win32-x64' ? 'python.exe' : 'bin/python3'),
  join(
    dedodePython,
    platform === 'win32-x64'
      ? 'Lib/site-packages/onnxruntime/capi/onnxruntime_pybind11_state.pyd'
      : 'lib/python3.12/site-packages/onnxruntime/capi/onnxruntime_pybind11_state.cpython-312-x86_64-linux-gnu.so',
  ),
  join(
    dedodePython,
    platform === 'win32-x64'
      ? 'Lib/site-packages/numpy/_core/_multiarray_umath.pyd'
      : 'lib/python3.12/site-packages/numpy/_core/_multiarray_umath.cpython-312-x86_64-linux-gnu.so',
  ),
  join(geoRoot, 'share/proj/proj.db'),
  join(geoRoot, 'share/gdal/gdalvrt.xsd'),
  ...geoTools,
  ...bundledProjData,
];
if (platform === 'win32-x64') {
  requiredReleaseInputs.push(
    join(colmapRoot, 'bin/libc++.dll'),
    join(colmapRoot, 'bin/libunwind.dll'),
    join(colmapRoot, 'bin/libwinpthread-1.dll'),
    join(colmapRoot, 'bin/LICENSE-winpthreads.txt'),
    join(colmapRoot, 'bin/msvcp140.dll'),
    join(colmapRoot, 'bin/msvcp140_1.dll'),
    join(colmapRoot, 'bin/vcruntime140.dll'),
    join(colmapRoot, 'bin/vcruntime140_1.dll'),
    join(colmapRoot, 'bin/LICENSE-Microsoft-VC-Runtime.rtf'),
    join(dedodePython, 'msvcp140.dll'),
    join(dedodePython, 'msvcp140_1.dll'),
    join(dedodePython, 'vcruntime140.dll'),
    join(dedodePython, 'vcruntime140_1.dll'),
    join(dedodePython, 'LICENSE-Microsoft-VC-Runtime.rtf'),
  );
}

for (const path of [...roots, ...requiredReleaseInputs]) {
  if (!existsSync(path)) fail(`required release input is missing: ${relative(workspace, path)}`);
}
verifyDedodeReleaseShape();

const forbiddenNames =
  /(?:^|[-_.])(gomp|gfortran|quadmath|iomp5)(?:[-_.]|$)|(?:^|[-_.])(gpl|agpl|lgpl)(?:[-_.]|$)/i;
const forbiddenDependency = /lib(?:gomp|gfortran|quadmath|iomp5)(?:\.so|\.dll|\.dylib)/i;
const files = [...new Set([...requiredExecutables, ...roots.flatMap(collectFiles)])].sort();
const inventory = [];

for (const path of files) {
  const relativePath = relative(workspace, path);
  if (forbiddenNames.test(basename(path)))
    fail(`forbidden runtime or license family in release input: ${relativePath}`);
  const bytes = readFileSync(path);
  const record = {
    path: relativePath,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (
    platform === 'linux-x64' &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    const dependencies = dynamicDependencies(path);
    const forbidden = dependencies.find((dependency) => forbiddenDependency.test(dependency));
    if (forbidden) fail(`${relativePath} links forbidden runtime ${forbidden}`);
    record.dynamicDependencies = dependencies;
  } else if (
    platform === 'win32-x64' &&
    bytes.length >= 2 &&
    bytes[0] === 0x4d &&
    bytes[1] === 0x5a
  ) {
    const dependencies = peDependencies(path);
    const forbidden = dependencies.find((dependency) => forbiddenDependency.test(dependency));
    if (forbidden) fail(`${relativePath} links forbidden runtime ${forbidden}`);
    const unresolved = dependencies.find(
      (dependency) =>
        !windowsSystemDependency(dependency) && !windowsRuntimeDependencyExists(path, dependency),
    );
    if (unresolved) fail(`${relativePath} has unbundled Windows dependency ${unresolved}`);
    record.dynamicDependencies = dependencies;
  }
  inventory.push(record);
}

function windowsRuntimeDependencyExists(importer, dependency) {
  const pythonRoot = join(dedodeRoot, 'python');
  const sitePackages = join(pythonRoot, 'Lib', 'site-packages');
  const searchDirectories = [dirname(importer), join(geoRoot, 'bin')];
  if (importer.startsWith(dedodeRoot)) {
    searchDirectories.push(
      pythonRoot,
      join(pythonRoot, 'DLLs'),
      join(sitePackages, 'onnxruntime', 'capi'),
    );
  }
  if (requiredExecutables.some((path) => path === importer)) {
    searchDirectories.push(dirname(requiredExecutables[0]));
  }
  return searchDirectories.some((directory) => existsSync(join(directory, dependency)));
}

verifyDedodeModels(inventory);
verifyPinnedArtifacts(inventory);
verifyColmapManifest(inventory);

const outputDirectory = join(workspace, '.build/release-inventory');
mkdirSync(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, `photolab-${platform}.json`);
writeFileSync(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, product: 'HimmelCAD PhotoLab', platform, files: inventory }, null, 2)}\n`,
);
process.stdout.write(
  `PhotoLab release inventory passed: ${inventory.length} files · ${relative(workspace, outputPath)}\n`,
);

function collectFiles(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output;
}

function verifyDedodeReleaseShape() {
  const forbidden = collectFiles(dedodePython).find((path) => {
    const normalized = relative(dedodePython, path).replaceAll('\\', '/');
    return (
      /(?:^|\/)__pycache__(?:\/|$)/.test(normalized) ||
      /(?:^|\/)ensurepip(?:\/|$)/.test(normalized) ||
      /(?:^|\/)pip(?:3(?:\.12)?)?(?:\.exe)?$/i.test(normalized) ||
      /\.(?:pyc|pyo)$/i.test(normalized)
    );
  });
  if (forbidden) {
    fail(`development-only Python payload is staged: ${relative(workspace, forbidden)}`);
  }

  const manifestBytes = readFileSync(dedodeManifestPath);
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestHash !== approvedDedodeManifestSha256) {
    fail(
      `DeDoDe model manifest is not the approved full-quality export: expected ${approvedDedodeManifestSha256}, got ${manifestHash}`,
    );
  }
}

function verifyDedodeModels(inventory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(dedodeManifestPath, 'utf8'));
  } catch (error) {
    fail(`DeDoDe model manifest is invalid JSON: ${error.message}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    fail('DeDoDe model manifest has an unsupported schema or empty inventory');
  }

  const inventoryByPath = new Map(inventory.map((record) => [record.path, record]));
  const expectedPaths = new Set();
  for (const model of manifest.files) {
    if (
      typeof model.path !== 'string' ||
      typeof model.bytes !== 'number' ||
      !/^[a-f0-9]{64}$/.test(model.sha256)
    ) {
      fail('DeDoDe model manifest contains an invalid record');
    }
    const path = join(dedodeModelRoot, model.path);
    const relativePath = relative(workspace, path);
    expectedPaths.add(relativePath);
    const record = inventoryByPath.get(relativePath);
    if (!record || record.bytes !== model.bytes || record.sha256 !== model.sha256) {
      fail(`DeDoDe model payload differs from its approved manifest: ${model.path}`);
    }
  }

  const stagedPaths = collectFiles(dedodeModelRoot).map((path) => relative(workspace, path));
  const unexpected = stagedPaths.find((path) => !expectedPaths.has(path));
  if (unexpected) fail(`unmanifested DeDoDe model payload is staged: ${unexpected}`);
  if (stagedPaths.length !== expectedPaths.size) {
    fail(
      `DeDoDe model inventory is incomplete: expected ${expectedPaths.size}, found ${stagedPaths.length}`,
    );
  }
}

function verifyPinnedArtifacts(inventory) {
  const inventoryByPath = new Map(inventory.map((record) => [record.path, record]));
  for (const [path, expectedHash] of approvedArtifactHashes) {
    const record = inventoryByPath.get(relative(workspace, path));
    if (!record || record.sha256 !== expectedHash) {
      fail(`release artifact differs from its approved pin: ${relative(workspace, path)}`);
    }
  }
  bundledProjData.forEach((path, index) => {
    const record = inventoryByPath.get(relative(workspace, path));
    if (!record || record.sha256 !== approvedProjDataHashes[index]) {
      fail(`bundled PROJ grid differs from its approved pin: ${relative(workspace, path)}`);
    }
  });
}

function verifyColmapManifest(inventory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(colmapManifestPath, 'utf8'));
  } catch (error) {
    fail(`COLMAP vendor manifest is invalid JSON: ${error.message}`);
  }
  if (
    manifest.name !== 'HimmelCAD COLMAP worker' ||
    manifest.version !== '4.1.0' ||
    manifest.commit !== 'fa8e3b3ff591552855f8ad2806723c80f963f69c' ||
    manifest.patchSha256 !== 'da8074b603ab616e273f219e1e913ae0388dd83048dd15cb1f713dc23aa41e36' ||
    manifest.vcpkgCommit !== '03e366fb91e38b9432ebd5f8cc79f7c8f55e96ab' ||
    manifest.platform !== platform ||
    manifest.license !== 'BSD-3-Clause and permissive audited transitive closure' ||
    !Array.isArray(manifest.files)
  ) {
    fail('COLMAP vendor manifest differs from the approved source and toolchain contract');
  }

  const inventoryByPath = new Map(inventory.map((record) => [record.path, record]));
  const expectedPaths = new Set();
  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      typeof file.bytes !== 'number' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      fail('COLMAP vendor manifest contains an invalid file record');
    }
    const relativePath = relative(workspace, join(colmapRoot, file.path));
    expectedPaths.add(relativePath);
    const record = inventoryByPath.get(relativePath);
    if (!record || record.bytes !== file.bytes || record.sha256 !== file.sha256) {
      fail(`COLMAP payload differs from its vendor manifest: ${file.path}`);
    }
  }
  const installedPaths = collectFiles(colmapRoot)
    .filter((path) => path !== colmapManifestPath)
    .map((path) => relative(workspace, path));
  const unexpected = installedPaths.find((path) => !expectedPaths.has(path));
  if (unexpected || installedPaths.length !== expectedPaths.size) {
    fail(
      `COLMAP vendor manifest does not cover the complete installed payload: ${unexpected ?? 'missing file'}`,
    );
  }
}

function dynamicDependencies(path) {
  let output;
  try {
    const pythonRoot = join(workspace, `.build/photolab-runtime/${platform}/workers/dedode/python`);
    const sitePackages = join(pythonRoot, 'lib', 'python3.12', 'site-packages');
    const libraryPath = [
      join(pythonRoot, 'lib'),
      join(sitePackages, 'onnxruntime', 'capi'),
      join(sitePackages, 'numpy.libs'),
      join(sitePackages, 'pillow.libs'),
      process.env.LD_LIBRARY_PATH,
    ]
      .filter(Boolean)
      .join(':');
    output = execFileSync('ldd', [path], {
      encoding: 'utf8',
      env: { ...process.env, LD_LIBRARY_PATH: libraryPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString() ?? '';
    if (stderr.includes('not a dynamic executable')) return [];
    fail(`ldd failed for ${relative(workspace, path)}: ${stderr.trim()}`);
  }
  if (/=>\s+not found\b/.test(output)) {
    fail(`unresolved dynamic dependency for ${relative(workspace, path)}: ${output.trim()}`);
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((value) => value && value !== 'statically');
}

function peDependencies(path) {
  let output;
  try {
    output = execFileSync(objdump, ['-p', path], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || 'unknown error';
    fail(`${objdump} failed for ${relative(workspace, path)}: ${detail}`);
  }
  return [...output.matchAll(/DLL Name:\s*([^\s]+)/g)]
    .map((match) => match[1])
    .filter(Boolean)
    .sort();
}

function windowsSystemDependency(name) {
  return /^(?:api-ms-win-|ext-ms-win-)|^(?:kernel32|kernelbase|user32|gdi32|advapi32|shell32|ole32|oleaut32|combase|uuid|comdlg32|comctl32|winspool|shlwapi|version|ws2_32|bcrypt|bcryptprimitives|crypt32|secur32|ncrypt|ntdll|rpcrt4|setupapi|imm32|dwmapi|dwrite|dxgi|d3d11|d3d12|dcomp|uxtheme|winmm|dbghelp|normaliz|iphlpapi|netapi32|userenv|powrprof|propsys|winhttp|wininet|urlmon|msimg32|mpr|cfgmgr32|hid|opengl32|vulkan-1|ucrtbase|msvcrt|cabinet|msi|psapi)\.dll$/i.test(
    name,
  );
}

function fail(message) {
  process.stderr.write(`PhotoLab release inventory failed: ${message}\n`);
  process.exit(1);
}
