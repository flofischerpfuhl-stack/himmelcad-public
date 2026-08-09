import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargo = process.env.CARGO || '/home/oem/.cargo/bin/cargo';
const bindgen = process.env.WASM_BINDGEN || '/home/oem/.cargo/bin/wasm-bindgen';
const wasmOpt = process.env.WASM_OPT || 'wasm-opt';
const outputRoot = path.join(repoRoot, 'target/decode-wasm-artifact-gate');
const bindgenRoot = path.join(outputRoot, 'bindgen');
const rawWasm = path.join(
  repoRoot,
  'target/wasm32-unknown-unknown/release/himmelcad_decode_wasm.wasm',
);
const bindgenWasm = path.join(bindgenRoot, 'himmelcad_decode_wasm_bg.wasm');
const optimizedWasm = path.join(outputRoot, 'himmelcad_decode_wasm_bg.opt.wasm');
const reportFile = path.join(outputRoot, 'artifact-report.json');

await mkdir(bindgenRoot, { recursive: true });
await run(cargo, [
  'build',
  '-p',
  'himmelcad-decode-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--release',
]);
await run(bindgen, [rawWasm, '--out-dir', bindgenRoot, '--target', 'web', '--no-typescript']);
await run(wasmOpt, [
  '--enable-bulk-memory',
  '--enable-nontrapping-float-to-int',
  '-Oz',
  bindgenWasm,
  '-o',
  optimizedWasm,
]);

const [rawBytes, bindgenBytes, optimizedBytes] = await Promise.all([
  size(rawWasm),
  size(bindgenWasm),
  size(optimizedWasm),
]);
const [rawGzipBytes, optimizedGzipBytes] = await Promise.all([
  gzipSize(rawWasm),
  gzipSize(optimizedWasm),
]);
const report = {
  schemaVersion: 1,
  limits: {
    rawBytes: 6 * 1024 * 1024,
    bindgenBytes: 5 * 1024 * 1024,
    optimizedBytes: 4 * 1024 * 1024,
    rawGzipBytes: 2 * 1024 * 1024,
    optimizedGzipBytes: (3 * 1024 * 1024) / 2,
  },
  measured: { rawBytes, bindgenBytes, optimizedBytes, rawGzipBytes, optimizedGzipBytes },
};

for (const [metric, limit] of Object.entries(report.limits)) {
  const measured = report.measured[metric];
  assert(
    measured <= limit,
    `decode worker ${metric} ${String(measured)} exceeds release ceiling ${String(limit)}`,
  );
}
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function size(file) {
  return (await stat(file)).size;
}

async function gzipSize(file) {
  return gzipSync(await readFile(file), { level: 9 }).byteLength;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    child.once('error', (error) => {
      reject(
        new Error(`${command} is required for the decode-WASM release gate: ${error.message}`),
      );
    });
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)} (${signal ?? 'no signal'})`));
    });
  });
}
