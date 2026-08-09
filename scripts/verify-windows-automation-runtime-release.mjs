#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repositoryRoot, 'runtime/automation-runtime-manifest.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const platformName = 'win32-x64';
const platform = manifest.platforms?.[platformName];
if (manifest.schemaId !== 'hcad.automation-runtime-manifest@1' || !platform) {
  throw new Error('the managed Windows automation runtime manifest is absent or unsupported');
}
await verifyManagedSources();

const releaseBlockers = [platform.archive, ...platform.wheels]
  .filter((asset) => asset.releaseEligible === false)
  .map((asset) => `${asset.assetName ?? asset.path}: ${asset.releaseBlocker}`);
if (releaseBlockers.length > 0) {
  throw new Error(
    `Windows automation runtime is not release-eligible:\n${releaseBlockers.join('\n')}`,
  );
}

const wineExecutable = resolve(
  process.env.HIMMELCAD_WINE_EXECUTABLE ??
    resolve(repositoryRoot, '.build/wine-portable/wine-11.13-amd64-wow64/bin/wine'),
);
const xvfbRun = process.env.HIMMELCAD_XVFB_RUN ?? 'xvfb-run';
await requireFile(wineExecutable, 'pinned Wine executable');
const wineBasePrefix = resolve(
  process.env.HIMMELCAD_WINE_BASE_PREFIX ?? resolve(repositoryRoot, '.build/wine-prefix-headless'),
);
const wineBasePrefixMetadata = await stat(wineBasePrefix).catch(() => undefined);
if (!wineBasePrefixMetadata?.isDirectory()) {
  throw new Error(`initialized pinned-Wine base prefix is missing: ${wineBasePrefix}`);
}

const verificationParent = resolve(repositoryRoot, '.build');
await mkdir(verificationParent, { recursive: true });
const verificationRoot = await mkdtemp(
  resolve(verificationParent, 'windows-automation-runtime-release-gate-'),
);
const runtimeRoot = resolve(verificationRoot, 'runtime');
const pythonRoot = resolve(runtimeRoot, 'python');
const sitePackages = resolve(pythonRoot, 'Lib/site-packages');
const winePrefix = resolve(verificationRoot, 'wine-prefix');
await cp(wineBasePrefix, winePrefix, {
  recursive: true,
  force: false,
  errorOnExist: true,
  verbatimSymlinks: true,
});
const wineVersion = run(wineExecutable, ['--version']).trim();
if (wineVersion !== 'wine-11.13') {
  throw new Error(`pinned Windows release-gate Wine version mismatch: ${wineVersion}`);
}

const verifiedArtifacts = [];
for (const asset of [platform.archive, ...platform.wheels]) {
  const path = resolveAsset(asset.path);
  await verifyAsset(path, asset);
  verifiedArtifacts.push({
    path: asset.path,
    byteLength: (await stat(path)).size,
    sha256: asset.sha256,
  });
}

const archivePath = resolveAsset(platform.archive.path);
validateArchiveEntries(
  run('tar', ['--list', '--gzip', '--file', archivePath]),
  'managed CPython archive',
  (entry) => entry.startsWith('python/'),
);
await mkdir(runtimeRoot, { recursive: true });
run('tar', [
  '--extract',
  '--gzip',
  '--file',
  archivePath,
  '--directory',
  runtimeRoot,
  '--no-same-owner',
  '--no-same-permissions',
  '--delay-directory-restore',
]);
await validateExtractedTree(runtimeRoot);
await mkdir(sitePackages, { recursive: true });

for (const wheel of platform.wheels) {
  const wheelPath = resolveAsset(wheel.path);
  const entries = validateArchiveEntries(
    run('unzip', ['-Z1', wheelPath]),
    wheel.assetName ?? wheel.path,
    () => true,
  );
  if (entries.some((entry) => entry.includes('.data/'))) {
    throw new Error(`${wheel.path} uses a wheel .data relocation unsupported by this cross-gate`);
  }
  run('unzip', ['-q', wheelPath, '-d', sitePackages]);
}

await cp(resolve(repositoryRoot, 'sdk/python/src/himmelcad'), resolve(sitePackages, 'himmelcad'), {
  recursive: true,
  force: false,
  errorOnExist: true,
});
await cp(
  resolve(repositoryRoot, 'runtime/python/himmelcad_host.py'),
  resolve(sitePackages, 'himmelcad_host.py'),
  { force: false, errorOnExist: true },
);
await removeRuntimeInstallers();
await validateExtractedTree(runtimeRoot);

const version = runWine(['--version']).trim();
if (version !== `Python ${manifest.pythonVersion}`) {
  throw new Error(`managed Windows Python version mismatch: ${version}`);
}

const packageProbe = runWine([
  '-I',
  '-X',
  'utf8',
  '-c',
  [
    'import importlib.util, io',
    'assert importlib.util.find_spec("pip") is None',
    'assert importlib.util.find_spec("ensurepip") is None',
    'import cv2, numpy, PIL, himmelcad, himmelcad_host',
    'from PIL import Image',
    'assert cv2.__version__ == "4.13.0"',
    'assert numpy.__version__ == "2.2.6"',
    'assert PIL.__version__ == "11.3.0"',
    'assert himmelcad.HimmelcadClient is not None',
    'assert himmelcad_host.HostTransport is not None',
    'buffer = io.BytesIO()',
    'Image.new("RGB", (4, 3), (17, 91, 203)).save(buffer, format="PNG")',
    'assert buffer.getvalue().startswith(b"\\x89PNG\\r\\n\\x1a\\n")',
    'print(cv2.__version__, numpy.__version__, PIL.__version__, "himmelcad-sdk-host-ok")',
  ].join(';'),
]).trim();

run('python3', [
  resolve(repositoryRoot, 'scripts/smoke-windows-automation-runtime.py'),
  '--python-root',
  pythonRoot,
  '--wine-executable',
  wineExecutable,
  '--wine-prefix',
  winePrefix,
  '--xvfb-run',
  xvfbRun,
  '--timeout-seconds',
  '180',
]);

const result = {
  schemaId: 'hcad.windows-automation-runtime-release-gate@1',
  platform: platformName,
  runtimeVersion: manifest.runtimeVersion,
  pythonVersion: manifest.pythonVersion,
  wineVersion,
  manifestSha256: sha256(manifestBytes),
  automationSchemaSha256: manifest.automationSchemaSha256,
  generatorSha256: manifest.generatorSha256,
  generatorManifestSha256: manifest.generatorManifestSha256,
  hostTransportSha256: manifest.hostTransportSha256,
  releaseEligible: true,
  installersPresent: false,
  packageProbe,
  dynamicSmoke: 'passed',
  artifacts: verifiedArtifacts,
};
const resultPath = resolve(verificationRoot, 'verification-result.json');
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ ...result, verificationRoot, resultPath })}\n`);

function resolveAsset(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe managed runtime asset path: ${String(relativePath)}`);
  }
  const path = resolve(repositoryRoot, relativePath);
  if (!isWithin(path, repositoryRoot)) throw new Error('managed runtime asset escaped repository');
  return path;
}

async function verifyAsset(path, expected) {
  await requireFile(path, 'managed runtime asset');
  const metadata = await stat(path);
  if (expected.byteLength !== undefined && metadata.size !== expected.byteLength) {
    throw new Error(`managed runtime asset length mismatch: ${expected.path}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) {
    throw new Error(`managed runtime asset hash mismatch: ${expected.path}`);
  }
}

async function verifyManagedSources() {
  const sourcePins = [
    [
      'schemas/automation/himmelcad-automation-v1.schema.json',
      manifest.automationSchemaSha256,
      'automation schema',
    ],
    ['scripts/generate-automation-sdk.py', manifest.generatorSha256, 'SDK generator'],
    [
      'sdk/python/generator-manifest.json',
      manifest.generatorManifestSha256,
      'SDK generator manifest',
    ],
    ['runtime/python/himmelcad_host.py', manifest.hostTransportSha256, 'Python host transport'],
  ];
  for (const [relativePath, expectedHash, label] of sourcePins) {
    await verifySourceHash(relativePath, expectedHash, label);
  }

  const generatorManifest = JSON.parse(
    await readFile(resolveAsset('sdk/python/generator-manifest.json'), 'utf8'),
  );
  if (
    generatorManifest.schemaSha256 !== manifest.automationSchemaSha256 ||
    generatorManifest.generatorSha256 !== manifest.generatorSha256 ||
    generatorManifest.minimumPython !== '3.12'
  ) {
    throw new Error('generated Python SDK manifest does not match the managed runtime pins');
  }
  for (const [relativePath, expectedHash] of Object.entries(
    requireHashInventory(generatorManifest.contractInputs, 'SDK contract input'),
  )) {
    await verifySourceHash(relativePath, expectedHash, `SDK contract input ${relativePath}`);
  }
  for (const [relativePath, expectedHash] of Object.entries(
    requireHashInventory(generatorManifest.outputs, 'generated SDK output'),
  )) {
    await verifySourceHash(
      `sdk/python/${relativePath}`,
      expectedHash,
      `generated SDK output ${relativePath}`,
    );
  }
}

function requireHashInventory(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} inventory is missing`);
  }
  for (const [path, hash] of Object.entries(value)) {
    if (typeof path !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(`${label} inventory contains an invalid entry`);
    }
  }
  return value;
}

async function verifySourceHash(relativePath, expectedHash, label) {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash ?? '')) {
    throw new Error(`${label} has no valid managed-runtime pin`);
  }
  const path = resolveAsset(relativePath);
  await requireFile(path, label);
  const observedHash = sha256(await readFile(path));
  if (observedHash !== expectedHash) throw new Error(`${label} hash mismatch`);
}

async function requireFile(path, label) {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`${label} is missing: ${path}`);
}

function validateArchiveEntries(listing, label, extraPredicate) {
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0 || entries.length > 200_000) {
    throw new Error(`${label} has an invalid entry count`);
  }
  for (const entry of entries) {
    const segments = entry.split('/');
    if (
      entry.includes('\0') ||
      entry.includes('\\') ||
      entry.startsWith('/') ||
      segments.some((segment) => segment === '.' || segment === '..') ||
      !extraPredicate(entry)
    ) {
      throw new Error(`${label} contains an unsafe entry: ${entry.slice(0, 200)}`);
    }
  }
  return entries;
}

async function validateExtractedTree(root) {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current);
    visited += 1;
    if (visited > 200_001) throw new Error('Windows runtime expanded beyond its entry limit');
    if (metadata.isSymbolicLink()) {
      const target = await readlink(current);
      if (target.includes('\0') || target.includes('\\') || isAbsolute(target)) {
        throw new Error(`Windows runtime contains an unsafe symlink: ${relative(root, current)}`);
      }
      const resolvedTarget = resolve(dirname(current), target);
      if (resolvedTarget !== root && !isWithin(resolvedTarget, root)) {
        throw new Error(`Windows runtime contains an escaping symlink: ${relative(root, current)}`);
      }
      continue;
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(current)) pending.push(resolve(current, entry));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Windows runtime contains a special file: ${relative(root, current)}`);
    }
  }
}

async function removeRuntimeInstallers() {
  const targets = [resolve(sitePackages, 'pip'), resolve(pythonRoot, 'Lib/ensurepip')];
  for (const entry of await readdir(sitePackages)) {
    if (/^pip-.*\.dist-info$/iu.test(entry)) targets.push(resolve(sitePackages, entry));
  }
  const scripts = resolve(pythonRoot, 'Scripts');
  for (const entry of await readdir(scripts)) {
    if (/^pip(?:3(?:\.12)?)?(?:\.exe)?$/iu.test(entry)) targets.push(resolve(scripts, entry));
  }
  for (const target of targets) {
    if (!isWithin(target, pythonRoot)) throw new Error('installer removal target escaped runtime');
    await rm(target, { recursive: true, force: true });
  }
}

function runWine(arguments_) {
  return run(xvfbRun, [
    '-a',
    wineExecutable,
    toWindowsPath(resolve(pythonRoot, 'python.exe')),
    ...arguments_,
  ]);
}

function toWindowsPath(path) {
  return `Z:${path.replaceAll('/', '\\')}`;
}

function isWithin(path, parent) {
  const difference = relative(parent, path);
  return (
    difference !== '' &&
    difference !== '..' &&
    !difference.startsWith('../') &&
    !isAbsolute(difference)
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args) {
  const completed = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: '',
      PYTHONDONTWRITEBYTECODE: '1',
      PIP_NO_INDEX: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      WINEPREFIX: winePrefix,
      WINEARCH: 'win64',
      WINEDEBUG: '-all',
      WINEDLLOVERRIDES: 'winemenubuilder.exe=d;winedbg.exe=d',
    },
    encoding: 'utf8',
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(
      `${command} failed (${String(completed.status)}): ${completed.stderr.slice(0, 8192)}`,
    );
  }
  return `${completed.stdout}${completed.stderr}`;
}
