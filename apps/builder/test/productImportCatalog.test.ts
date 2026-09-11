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
const DTM_PROJECT = resolve(
  process.cwd(),
  '../..',
  '.build/photolab-e2e/g1a3-dtm-smoke/photolab-e2e.hcad',
);
const DTM_PACKAGE = 'product-00e33bcd9b10cdb78c509648562488508c5263bfa8ed0dd249fec77ffb46a06c';

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
  assert.ok(ready.length >= 4, `expected at least 4 ready rows, got ${ready.length}`);
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

test('PL-B1b catalog admits the current DTM package with frozen DEM provenance', async (context) => {
  try {
    await fs.access(resolve(DTM_PROJECT, '.photolab/product-import-packages', DTM_PACKAGE));
  } catch {
    context.skip('landed DTM smoke fixture is not present');
    return;
  }
  const catalog = await listProductImportCatalog(DTM_PROJECT);
  const row = catalog.rows.find((candidate) => candidate.packagePath?.endsWith(DTM_PACKAGE));
  assert.ok(row, `missing DTM package ${DTM_PACKAGE}`);
  assert.equal(row.readiness, 'ready');
  assert.equal(row.reasonCode, 'available');
  assert.equal(row.productKind, 'dem');
  assert.equal(
    row.packageSha256,
    '7579d65aed2260712ece0834bfe817c58d4dcd24ff83d5e5c5b24ff66fa83a05',
  );
});
