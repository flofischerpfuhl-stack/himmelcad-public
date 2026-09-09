import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { listProductImportCatalog } from '../electron/productImportCatalog.js';

const PROJECT = resolve(
  process.cwd(),
  '../..',
  '.build/photolab-e2e/g1a3-dsm-smoke/photolab-e2e.hcad',
);
const SPARSE = resolve(
  PROJECT,
  '.photolab/product-import-packages/product-9ad8b3224d97b1430358a6d3962cd7c0d55cb1f2c85cb89536b53f81a87c5be9',
);

test('G1b catalog lists the landed renderable packages (incl. the G1a-3b DSM) and refusal rows', async (context) => {
  try {
    await fs.access(PROJECT);
  } catch {
    context.skip('landed DSM smoke fixture is not present');
    return;
  }
  const catalog = await listProductImportCatalog(PROJECT);
  const ready = catalog.rows.filter((row) => row.readiness === 'ready');
  // G1a-3b (2026-09-09) republished the DSM package (directory product-2868864c…, package sha below) with tile-local validity masks; the
  // original DEM package stays on disk with a ready record (its masks are refused at admission).
  assert.equal(ready.length, 4);
  const readySet = new Set(ready.map((row) => `${row.productKind}:${row.packageSha256}`));
  for (const expected of [
    'sparse:6dce58464a1931fdbb7489c2ba0ca58e8de14d69df5cff45f8302183f8609298',
    'dense:dc6cf2f9e04648d4af75ed9e4f89a701c626a0246a45c8bc3b1681c95f559ef2',
    'dem:889e2ae68b4b9e35215bf5c050d7eaeb24b78fc682db0927e04601f5a731560a',
    'dem:e877d4b4e72409edb398fb442238b2445576fe541d4a4a142565272425288506',
  ]) {
    assert.ok(readySet.has(expected), `missing ready row ${expected}`);
  }
  assert.ok(catalog.rows.some((row) => row.readiness === 'notReady'));
});

test('G1b chooser detects a manifest changed after publication', async (context) => {
  try {
    await fs.access(SPARSE);
  } catch {
    context.skip('landed sparse fixture is not present');
    return;
  }
  const scratchRoot = resolve(process.cwd(), '../..', '.build/g1b');
  await fs.mkdir(scratchRoot, { recursive: true });
  const packagePath = await fs.mkdtemp(resolve(scratchRoot, 'tampered-sparse-'));
  context.after(async () => fs.rm(packagePath, { recursive: true, force: true }));
  await fs.cp(SPARSE, packagePath, { recursive: true });
  const manifestPath = resolve(packagePath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.tampered_for_g1b_test = true;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const catalog = await listProductImportCatalog(packagePath);
  assert.equal(catalog.rows.length, 1);
  assert.equal(catalog.rows[0]?.readiness, 'notReady');
  assert.equal(catalog.rows[0]?.reasonCode, 'invalid_package');
  assert.match(catalog.rows[0]?.reason ?? '', /ready record and manifest do not match/i);
});
