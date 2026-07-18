import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'scripts/fixtures/viewer-real-data.json');
const outputRoot = path.join(repoRoot, 'target/viewer-real-fixtures');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const requestedGate = process.argv
  .find((argument) => argument.startsWith('--gate='))
  ?.slice('--gate='.length);

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
  throw new Error('viewer real-data manifest is invalid');
}
await mkdir(outputRoot, { recursive: true });

for (const asset of manifest.assets) {
  if (asset.explicitGate !== undefined && asset.explicitGate !== requestedGate) continue;
  const output = path.join(outputRoot, asset.fileName);
  if (await matchesLock(output, asset)) {
    process.stdout.write(`verified ${asset.id}: ${output}\n`);
    continue;
  }

  const temporary = `${output}.download`;
  await rm(temporary, { force: true });
  const response = await fetch(asset.sourceUrl, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`failed to fetch ${asset.id}: HTTP ${response.status}`);
  }
  const sourceBytes = new Uint8Array(await response.arrayBuffer());
  verifySourceLock(asset, sourceBytes);
  const bytes = applyDeclaredDerivation(asset, sourceBytes);
  await writeFile(temporary, bytes);
  if (!(await matchesLock(temporary, asset))) {
    await rm(temporary, { force: true });
    throw new Error(`downloaded bytes do not match the lock for ${asset.id}`);
  }
  await rename(temporary, output);
  process.stdout.write(`fetched ${asset.id}: ${output}\n`);
}

function verifySourceLock(asset, bytes) {
  if (asset.sourceByteLength === undefined && asset.sourceSha256 === undefined) return;
  if (asset.sourceByteLength !== bytes.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sourceSha256) {
    throw new Error(`downloaded source bytes do not match the source lock for ${asset.id}`);
  }
}

function applyDeclaredDerivation(asset, sourceBytes) {
  if (asset.transform === undefined) return sourceBytes;
  if (asset.transform.kind !== 'replaceTrailingNulWithSpace') {
    throw new Error(`unknown real-fixture transform for ${asset.id}`);
  }
  if (sourceBytes.byteLength === 0 || sourceBytes[sourceBytes.byteLength - 1] !== 0) {
    throw new Error(`trailing-NUL normalization precondition failed for ${asset.id}`);
  }
  const derived = sourceBytes.slice();
  derived[derived.byteLength - 1] = 0x20;
  return derived;
}

async function matchesLock(file, asset) {
  try {
    const info = await stat(file);
    if (info.size !== asset.byteLength) return false;
    const bytes = await readFile(file);
    return createHash('sha256').update(bytes).digest('hex') === asset.sha256;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}
