import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockedRoot = path.join(repoRoot, 'target/viewer-real-fixtures');
const extractedRoot = path.join(repoRoot, 'target/viewer-real-dgm-section');
const cargo = '/home/oem/.cargo/bin/cargo';

await run('node', [
  path.join(repoRoot, 'scripts/fetch-viewer-real-fixtures.mjs'),
  '--gate=realDgmSection',
]);
await mkdir(extractedRoot, { recursive: true });
await extractLockedTiff(
  'dgm_33250-5888.zip',
  'dgm_33250-5888.tif',
  '317e318c073222cd5a3422b40864013f69a7231387b065448db621871975d710',
);
await extractLockedTiff(
  'dgm_33251-5888.zip',
  'dgm_33251-5888.tif',
  '28b53610f53d70ad8c40fe08d025af1a369f3a4d2c5d4d12c697f7a101a9163d',
);
await deriveWindow('dgm_33250-5888.tif', 'dgm_33250-5888.window.f32', 488);
await deriveWindow('dgm_33251-5888.tif', 'dgm_33251-5888.window.f32', 0);
await verifyWindow(
  'dgm_33250-5888.window.f32',
  '2a047b522fde77524016f77926b15a1ac4fc603bff082260d8f2bdffa955b73d',
);
await verifyWindow(
  'dgm_33251-5888.window.f32',
  'fe3913c51f6478590a14008783ce5082e093cb91a47b95451b814a7415a7b9f9',
);
await run(
  cargo,
  [
    'test',
    '-p',
    'himmelcad-sidecar',
    'mesh_tiler::tests::real_brandenburg_dgm_section_is_exact_across_the_source_tile_seam',
    '--',
    '--ignored',
    '--exact',
    '--nocapture',
  ],
  { HCAD_REAL_DGM_FIXTURE_ROOT: extractedRoot },
);

process.stdout.write(
  `real DGM seam gate passed · GeoBasis-DE/LGB · Daten geändert · ${extractedRoot}\n`,
);

async function extractLockedTiff(zipName, tiffName, expectedSha256) {
  const bytes = await capture('unzip', ['-p', path.join(lockedRoot, zipName), tiffName]);
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== expectedSha256) {
    throw new Error(`${tiffName} does not match its immutable source hash`);
  }
  await writeFile(path.join(extractedRoot, tiffName), bytes);
}

async function deriveWindow(tiffName, outputName, sourceX) {
  const output = path.join(extractedRoot, outputName);
  await rm(output, { force: true });
  await rm(output.replace(/\.f32$/, '.hdr'), { force: true });
  await run('gdal_translate', [
    '-q',
    '-of',
    'ENVI',
    '-ot',
    'Float32',
    '-srcwin',
    String(sourceX),
    '244',
    '512',
    '512',
    path.join(extractedRoot, tiffName),
    output,
  ]);
}

async function verifyWindow(fileName, expectedSha256) {
  const bytes = await readFile(path.join(extractedRoot, fileName));
  if (bytes.byteLength !== 512 * 512 * 4) {
    throw new Error(`${fileName} has an unexpected derived byte length`);
  }
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== expectedSha256) {
    throw new Error(`${fileName} does not match its deterministic derivation hash`);
  }
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} failed (${signal ?? String(code)})`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} failed (${signal ?? String(code)})`));
        return;
      }
      resolve();
    });
  });
}
