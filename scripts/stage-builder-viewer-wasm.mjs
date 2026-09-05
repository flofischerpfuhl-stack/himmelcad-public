import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveCargoExecutable } from './verification/cargo-resolver.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const outputRoot = path.join(repoRoot, '.build/builder-viewer/public');
const recordPath = path.join(outputRoot, '.wasm-stage-key.json');
const lockPath = path.join(outputRoot, '.wasm-stage.lock');
const packages = [
  {
    name: 'himmelcad-wasm',
    cratePath: 'crates/himmelcad-wasm',
    cargoArtifact: 'himmelcad_wasm.wasm',
    outputPath: 'viewer-wasm',
    outputArtifacts: ['himmelcad_wasm.js', 'himmelcad_wasm_bg.wasm'],
  },
  {
    name: 'himmelcad-decode-wasm',
    cratePath: 'crates/himmelcad-decode-wasm',
    cargoArtifact: 'himmelcad_decode_wasm.wasm',
    outputPath: 'viewer-decode-wasm',
    outputArtifacts: ['himmelcad_decode_wasm.js', 'himmelcad_decode_wasm_bg.wasm'],
  },
];

export function parseStageArguments(args) {
  let force = false;
  let profile = 'release';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--force') {
      force = true;
      continue;
    }
    if (argument === '--profile') {
      profile = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--profile=')) {
      profile = argument.slice('--profile='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (!['dev', 'release'].includes(profile)) {
      throw new Error('--profile must be dev or release');
    }
  }
  return { force, profile };
}

export async function computeStageKeys({ root, profile, stagingScriptPath }) {
  const sharedFiles = await expandInputPaths(root, [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    stagingScriptPath,
    'crates/himmelcad-core',
    'crates/himmelcad-render',
  ]);
  const entries = await Promise.all(
    packages.map(async ({ name, cratePath }) => {
      const crateFiles = await expandInputPaths(root, [cratePath]);
      return [name, await hashFiles(root, profile, [...sharedFiles, ...crateFiles])];
    }),
  );
  return Object.fromEntries(entries);
}

export function decideStagePackages({ force, profile, keys, record, artifactsPresent }) {
  return packages
    .map(({ name }) => name)
    .filter(
      (name) =>
        force ||
        record?.version !== 1 ||
        record.profile !== profile ||
        record.keys?.[name] !== keys[name] ||
        !artifactsPresent[name],
    );
}

async function main() {
  const options = parseStageArguments(process.argv.slice(2));
  const releaseLock = await acquireStageLock();
  try {
    await stage(options);
  } finally {
    await releaseLock();
  }
}

async function stage(options) {
  const keys = await computeStageKeys({
    root: repoRoot,
    profile: options.profile,
    stagingScriptPath: path.relative(repoRoot, scriptPath),
  });
  const record = await readStageRecord();
  const artifactsPresent = Object.fromEntries(
    packages.map((entry) => [
      entry.name,
      entry.outputArtifacts.every((artifact) =>
        existsSync(path.join(outputRoot, entry.outputPath, artifact)),
      ),
    ]),
  );
  const stalePackages = decideStagePackages({
    force: options.force,
    profile: options.profile,
    keys,
    record,
    artifactsPresent,
  });
  if (stalePackages.length === 0) {
    console.log(
      `WASM staging unchanged (profile ${options.profile}); skipping Cargo and wasm-bindgen.`,
    );
    return;
  }

  const cargo = resolveCargoExecutable();
  const bindgen = executable(
    'WASM_BINDGEN',
    path.join(userHome(), '.cargo/bin/wasm-bindgen'),
    'wasm-bindgen',
  );
  await Promise.all(
    packages
      .filter(({ name }) => stalePackages.includes(name))
      .map(({ outputPath }) => mkdir(path.join(outputRoot, outputPath), { recursive: true })),
  );

  const cargoArgs = ['build'];
  for (const packageName of stalePackages) cargoArgs.push('-p', packageName);
  cargoArgs.push('--target', 'wasm32-unknown-unknown');
  if (options.profile === 'release') cargoArgs.push('--release');
  run(cargo, cargoArgs);

  const cargoTargetRoot = process.env.CARGO_TARGET_DIR
    ? path.resolve(repoRoot, process.env.CARGO_TARGET_DIR)
    : path.join(repoRoot, 'target');
  const cargoProfile = options.profile === 'release' ? 'release' : 'debug';
  for (const entry of packages.filter(({ name }) => stalePackages.includes(name))) {
    run(bindgen, [
      path.join(cargoTargetRoot, 'wasm32-unknown-unknown', cargoProfile, entry.cargoArtifact),
      '--out-dir',
      path.join(outputRoot, entry.outputPath),
      '--target',
      'web',
      '--no-typescript',
    ]);
  }

  await writeStageRecord({ version: 1, profile: options.profile, keys });
}

async function acquireStageLock() {
  await mkdir(outputRoot, { recursive: true });
  const temporaryLockPath = `${lockPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryLockPath,
    `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
    { flag: 'wx' },
  );
  let reportedWait = false;
  while (true) {
    try {
      await link(temporaryLockPath, lockPath);
      await unlink(temporaryLockPath);
      return async () => {
        await unlink(lockPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        await unlink(temporaryLockPath).catch(() => {});
        throw error;
      }
      if (await removeAbandonedLock()) continue;
      if (!reportedWait) {
        console.log('WASM staging is already running; waiting for it to finish.');
        reportedWait = true;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  }
}

async function removeAbandonedLock() {
  try {
    const { pid } = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
      await unlink(lockPath);
      return true;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    await unlink(lockPath);
    return true;
  }
}

async function expandInputPaths(root, inputPaths) {
  const files = [];
  for (const inputPath of inputPaths) {
    const absolutePath = path.resolve(root, inputPath);
    const relativePath = path.relative(root, absolutePath);
    const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      files.push(relativePath);
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) files.push(...(await expandInputPaths(root, [childPath])));
      else if (entry.isFile()) files.push(childPath);
    }
  }
  return files.sort();
}

async function hashFiles(root, profile, files) {
  const hash = createHash('sha256');
  hash.update('himmelcad-wasm-stage-v1\0');
  hash.update(profile);
  for (const file of files) {
    hash.update('\0');
    hash.update(file.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(path.resolve(root, file)));
  }
  return hash.digest('hex');
}

async function readStageRecord() {
  try {
    return JSON.parse(await readFile(recordPath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeStageRecord(record) {
  await mkdir(outputRoot, { recursive: true });
  const temporaryPath = `${recordPath}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, recordPath);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function executable(variable, preferred, fallback) {
  if (process.env[variable]) return process.env[variable];
  return existsSync(preferred) ? preferred : fallback;
}

function userHome() {
  const value = process.env.HOME ?? process.env.USERPROFILE;
  if (!value) throw new Error('A home directory is required to locate Rust tools');
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
