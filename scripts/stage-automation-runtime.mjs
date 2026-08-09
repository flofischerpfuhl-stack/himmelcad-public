import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repositoryRoot, 'runtime/automation-runtime-manifest.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const releaseMode = process.argv.includes('--release');
const requestedPlatform =
  process.argv.slice(2).find((argument) => !argument.startsWith('--')) ??
  `${process.platform}-${process.arch}`;
const platform = manifest.platforms[requestedPlatform];
if (!platform) throw new Error(`unsupported automation runtime platform: ${requestedPlatform}`);
if (manifest.schemaId !== 'hcad.automation-runtime-manifest@1') {
  throw new Error('unsupported automation runtime manifest');
}
await verifyManagedSources();

const destinationParent = resolve(repositoryRoot, '.build/automation-runtime');
await mkdir(destinationParent, { recursive: true });
const temporaryRoot = await mkdtemp(resolve(destinationParent, `.staging-${requestedPlatform}-`));
const stagingRoot = resolve(temporaryRoot, requestedPlatform);
const destination = resolve(destinationParent, requestedPlatform);
try {
  const releaseBlockers = [platform.archive, ...platform.wheels]
    .filter((asset) => asset.releaseEligible === false)
    .map((asset) => `${asset.assetName ?? basename(asset.path)}: ${asset.releaseBlocker}`);
  if (releaseMode && releaseBlockers.length > 0) {
    throw new Error(`automation runtime is not release-eligible:\n${releaseBlockers.join('\n')}`);
  }
  const archivePath = resolveVerifiedPath(platform.archive.path);
  await verifyAsset(archivePath, platform.archive);
  await mkdir(stagingRoot, { recursive: true });
  validateTarArchive(archivePath);
  run('tar', [
    '--extract',
    '--gzip',
    '--file',
    archivePath,
    '--directory',
    stagingRoot,
    '--no-same-owner',
    '--no-same-permissions',
    '--delay-directory-restore',
  ]);
  await validateExtractedTree(stagingRoot);
  const pythonRoot = resolve(stagingRoot, 'python');
  const python = resolve(
    pythonRoot,
    requestedPlatform.startsWith('win32') ? 'python.exe' : 'bin/python3',
  );
  const version = run(python, ['--version']).trim();
  if (version !== `Python ${manifest.pythonVersion}`) {
    throw new Error(`managed Python version mismatch: ${version}`);
  }
  const wheels = [];
  for (const wheel of platform.wheels) {
    const wheelPath = resolveVerifiedPath(wheel.path);
    await verifyAsset(wheelPath, wheel);
    wheels.push(wheelPath);
  }
  run(python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-index',
    '--no-deps',
    '--no-compile',
    ...wheels,
  ]);
  const sitePackages = requestedPlatform.startsWith('win32')
    ? resolve(pythonRoot, 'Lib/site-packages')
    : resolve(pythonRoot, 'lib/python3.12/site-packages');
  await cp(
    resolve(repositoryRoot, 'sdk/python/src/himmelcad'),
    resolve(sitePackages, 'himmelcad'),
    {
      recursive: true,
      force: false,
      errorOnExist: true,
    },
  );
  await cp(
    resolve(repositoryRoot, 'runtime/python/himmelcad_host.py'),
    resolve(sitePackages, 'himmelcad_host.py'),
    { force: false, errorOnExist: true },
  );
  await removeRuntimeInstallers(pythonRoot, sitePackages, requestedPlatform);
  run(python, [
    '-I',
    '-c',
    'import importlib.util; assert importlib.util.find_spec("pip") is None; assert importlib.util.find_spec("ensurepip") is None',
  ]);
  const packageProbe = run(python, [
    '-I',
    '-c',
    'import cv2,numpy,PIL,himmelcad; print(cv2.__version__,numpy.__version__,PIL.__version__)',
  ]).trim();
  const inventory = {
    schemaId: 'hcad.automation-runtime-inventory@1',
    runtimeVersion: manifest.runtimeVersion,
    pythonVersion: manifest.pythonVersion,
    automationSchemaSha256: manifest.automationSchemaSha256,
    generatorSha256: manifest.generatorSha256,
    generatorManifestSha256: manifest.generatorManifestSha256,
    hostTransportSha256: manifest.hostTransportSha256,
    manifestSha256: sha256(manifestBytes),
    platform: requestedPlatform,
    networkDuringRun: 'forbidden',
    releaseEligible: releaseBlockers.length === 0,
    releaseBlockers,
    installersPresent: false,
    capabilities: ['himmelcadSdk', 'numpy', 'pillow', 'opencvHeadless'],
    packageProbe,
    artifacts: [platform.archive, ...platform.wheels].map((asset) => ({
      name: asset.assetName ?? basename(asset.path),
      sha256: asset.sha256,
      ...(asset.version ? { version: asset.version } : {}),
      ...(asset.license ? { license: asset.license } : { licenses: asset.licenses }),
      ...(asset.noticePath ? { noticePath: asset.noticePath } : {}),
      releaseEligible: asset.releaseEligible !== false,
    })),
  };
  await writeFile(
    resolve(stagingRoot, 'runtime-inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
    { flag: 'wx' },
  );
  await publishAtomically(stagingRoot, destination);
  process.stdout.write(`${JSON.stringify(inventory)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
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
    if (!/^[a-f0-9]{64}$/u.test(expectedHash ?? '')) {
      throw new Error(`${label} has no valid runtime-manifest pin`);
    }
    await verifySourceHash(relativePath, expectedHash, label);
  }

  const generatorManifest = JSON.parse(
    await readFile(resolveVerifiedPath('sdk/python/generator-manifest.json'), 'utf8'),
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
  const path = resolveVerifiedPath(relativePath);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
  const observedHash = sha256(await readFile(path));
  if (observedHash !== expectedHash) {
    throw new Error(`${label} hash mismatch`);
  }
}

function resolveVerifiedPath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe runtime asset path: ${String(relativePath)}`);
  }
  const path = resolve(repositoryRoot, relativePath);
  if (!isWithin(path, repositoryRoot)) throw new Error('runtime asset escaped repository');
  return path;
}

async function verifyAsset(path, expected) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`runtime asset is not a file: ${basename(path)}`);
  if (expected.byteLength !== undefined && metadata.size !== expected.byteLength) {
    throw new Error(`runtime asset length mismatch: ${basename(path)}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const observed = hash.digest('hex');
  if (observed !== expected.sha256) {
    throw new Error(`runtime asset hash mismatch: ${basename(path)}`);
  }
}

function validateTarArchive(archivePath) {
  const entries = run('tar', ['--list', '--gzip', '--file', archivePath])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (entries.length === 0 || entries.length > 200_000) {
    throw new Error('runtime archive has an invalid entry count');
  }
  for (const entry of entries) {
    if (entry.includes('\0') || entry.includes('\\') || !entry.startsWith('python/')) {
      throw new Error(`unsafe runtime archive entry: ${entry.slice(0, 200)}`);
    }
    const segments = entry.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      throw new Error(`unsafe runtime archive traversal: ${entry.slice(0, 200)}`);
    }
  }
}

async function validateExtractedTree(root) {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current);
    visited += 1;
    if (visited > 200_001) throw new Error('runtime archive expanded beyond its entry limit');
    if (metadata.isSymbolicLink()) {
      const target = await readlink(current);
      if (
        target.includes('\0') ||
        target.includes('\\') ||
        isAbsolute(target) ||
        !isWithinOrEqual(resolve(dirname(current), target), root)
      ) {
        throw new Error(`runtime archive contains an escaping symlink: ${relative(root, current)}`);
      }
      continue;
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(current)) pending.push(resolve(current, entry));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`runtime archive contains a special file: ${relative(root, current)}`);
    }
  }
}

async function removeRuntimeInstallers(pythonRoot, sitePackages, platformName) {
  const installerTargets = [
    resolve(sitePackages, 'pip'),
    resolve(
      pythonRoot,
      platformName.startsWith('win32') ? 'Lib/ensurepip' : 'lib/python3.12/ensurepip',
    ),
  ];
  for (const entry of await readdir(sitePackages)) {
    if (/^pip-.*\.dist-info$/iu.test(entry)) installerTargets.push(resolve(sitePackages, entry));
  }
  const scriptsDirectory = resolve(
    pythonRoot,
    platformName.startsWith('win32') ? 'Scripts' : 'bin',
  );
  for (const entry of await readdir(scriptsDirectory)) {
    if (/^pip(?:3(?:\.12)?)?(?:\.exe)?$/iu.test(entry)) {
      installerTargets.push(resolve(scriptsDirectory, entry));
    }
  }
  for (const target of installerTargets) {
    assertWithin(target, pythonRoot, 'installer removal target');
    await rm(target, { recursive: true, force: true });
  }
}

async function publishAtomically(source, destinationPath) {
  assertWithin(source, destinationParent, 'staged runtime');
  assertWithin(destinationPath, destinationParent, 'runtime destination');
  const backup = resolve(destinationParent, `.previous-${requestedPlatform}-${process.pid}`);
  assertWithin(backup, destinationParent, 'runtime backup');
  await rm(backup, { recursive: true, force: true });
  let movedPrevious = false;
  try {
    await rename(destinationPath, backup);
    movedPrevious = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(source, destinationPath);
  } catch (error) {
    if (movedPrevious) await rename(backup, destinationPath);
    throw error;
  }
  if (movedPrevious) await rm(backup, { recursive: true, force: true });
}

function assertWithin(path, parent, label) {
  if (!isWithin(path, parent)) {
    throw new Error(`${label} escaped its narrow root`);
  }
}

function isWithin(path, parent) {
  const difference = relative(parent, path);
  return (
    difference !== '' &&
    difference !== '..' &&
    !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(difference)
  );
}

function isWithinOrEqual(path, parent) {
  return path === parent || isWithin(path, parent);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PIP_NO_INDEX: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    },
    encoding: 'utf8',
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${String(result.status)}): ${result.stderr.slice(0, 4096)}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}
