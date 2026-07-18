import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = executable('CARGO', path.join(userHome(), '.cargo/bin/cargo'), 'cargo');
const bindgen = executable(
  'WASM_BINDGEN',
  path.join(userHome(), '.cargo/bin/wasm-bindgen'),
  'wasm-bindgen',
);
const outputRoot = path.join(repoRoot, '.build/builder-viewer/public');
const viewerRoot = path.join(outputRoot, 'viewer-wasm');
const decodeRoot = path.join(outputRoot, 'viewer-decode-wasm');

await Promise.all([mkdir(viewerRoot, { recursive: true }), mkdir(decodeRoot, { recursive: true })]);

run(cargo, [
  'build',
  '-p',
  'himmelcad-wasm',
  '-p',
  'himmelcad-decode-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--release',
]);
run(bindgen, [
  path.join(repoRoot, 'target/wasm32-unknown-unknown/release/himmelcad_wasm.wasm'),
  '--out-dir',
  viewerRoot,
  '--target',
  'web',
  '--no-typescript',
]);
run(bindgen, [
  path.join(repoRoot, 'target/wasm32-unknown-unknown/release/himmelcad_decode_wasm.wasm'),
  '--out-dir',
  decodeRoot,
  '--target',
  'web',
  '--no-typescript',
]);

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
