import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { writeOracle } from './photolab-g1c-oracle.mjs';

const execFileAsync = promisify(execFile);

function tinyDensePly() {
  const header = Buffer.from(`ply
format binary_little_endian 1.0
element vertex 9
property double x
property double y
property double z
property uchar red
property uchar green
property uchar blue
property float confidence
property float nx
property float ny
property float nz
end_header
`);
  const body = Buffer.alloc(9 * 43);
  for (let index = 0; index < 9; index += 1) {
    const offset = index * 43;
    body.writeDoubleLE(0.5 + (index % 3), offset);
    body.writeDoubleLE(2.5 - Math.floor(index / 3), offset + 8);
    body.writeDoubleLE(100 + index, offset + 16);
    body.writeUInt8(10 + index, offset + 24);
    body.writeUInt8(20 + index, offset + 25);
    body.writeUInt8(30 + index, offset + 26);
    body.writeFloatLE(1, offset + 27);
    body.writeFloatLE(0, offset + 31);
    body.writeFloatLE(0, offset + 35);
    body.writeFloatLE(1, offset + 39);
  }
  return Buffer.concat([header, body]);
}

test('writes the exact oracle for a synthetic DEM package', async () => {
  const scratchRoot = path.join(process.cwd(), '.build', 'codex-scratch', 'g1c-oracle');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'oracle-test-'));
  try {
    const projectPath = path.join(directory, 'fixture.hcad');
    const denseRelative = 'datasets/mvs/dense-fixture/output/dense.ply';
    const rasterRelative = 'datasets/raster/dem-fixture/product.cog.tif';
    const packagePath = path.join(
      projectPath,
      '.photolab',
      'product-import-packages',
      'product-fixture',
    );
    await mkdir(path.join(projectPath, path.dirname(denseRelative)), { recursive: true });
    await mkdir(path.join(projectPath, path.dirname(rasterRelative)), { recursive: true });
    await mkdir(packagePath, { recursive: true });
    await writeFile(path.join(projectPath, denseRelative), tinyDensePly());

    const baseRaster = path.join(directory, 'base.tif');
    await execFileAsync('/usr/bin/gdal_create', [
      '-of',
      'GTiff',
      '-outsize',
      '3',
      '3',
      '-ot',
      'Float32',
      '-burn',
      '42',
      '-a_srs',
      'EPSG:3857',
      '-a_ullr',
      '0',
      '3',
      '3',
      '0',
      '-a_nodata',
      '-9999',
      baseRaster,
    ]);
    await execFileAsync('/usr/bin/gdal_translate', [
      '-q',
      '-of',
      'COG',
      baseRaster,
      path.join(projectPath, rasterRelative),
    ]);

    const manifest = {
      schema_id: 'hcad.product-import-package-manifest@1',
      manifest_id: 'product-fixture',
      package_sha256: 'fixture-package-sha256',
      source: { project_fingerprint: 'fixture-project-fingerprint' },
      product: { kind: 'dem', entity_id: 'fixture:raster:dem-fixture' },
      lineage: {
        payload: {
          product_kind: 'dem',
          normalized_format_id: 'himmelcad-prepared-hierarchy@1',
          product_entity_id: 'fixture:raster:dem-fixture',
          dense_dataset_reference: denseRelative,
          raster_artifact_reference: rasterRelative,
          reference_frame: {
            project_reference_frame: {
              target: { horizontal: { crs: { kind: 'authority', value: 'EPSG:3857' } } },
            },
          },
          dem_facts: {
            source_no_data: { kind: 'numeric', value: '-9999' },
            surface: 'dsm',
            ground_classification: { kind: 'none' },
          },
        },
      },
    };
    await writeFile(path.join(packagePath, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(
      path.join(packagePath, 'ready.json'),
      JSON.stringify({
        manifest_id: 'product-fixture',
        package_sha256: 'fixture-package-sha256',
        normalized_format_id: 'himmelcad-prepared-hierarchy@1',
        publication_generation: 1,
      }),
    );

    const outputPath = path.join(directory, 'output');
    await writeOracle(projectPath, outputPath, { generatedAt: '2026-09-09T00:00:00.000Z' });
    const actual = JSON.parse(await readFile(path.join(outputPath, 'oracle.json'), 'utf8'));
    const denseIndices = [0, 1, 2, 4, 6, 7, 8];
    const denseSamples = denseIndices.map((index) => ({
      label: `dense point ${index}`,
      point_index: index,
      xy: [0.5 + (index % 3), 2.5 - Math.floor(index / 3)],
      value: 42,
      no_data: false,
    }));
    assert.deepEqual(actual, {
      schema_id: 'hcad.photolab-g1c-oracle@1',
      project_fingerprint: 'fixture-project-fingerprint',
      generated_at: '2026-09-09T00:00:00.000Z',
      packages: [
        {
          id: 'product-fixture',
          sha256: 'fixture-package-sha256',
          kind: 'dem',
          format: 'himmelcad-prepared-hierarchy@1',
          source: rasterRelative,
          crs: 'EPSG:3857',
          resolution: { x: 1, y: 1, unit: 'metre' },
          data_type: 'Float32',
          source_no_data: { kind: 'numeric', value: '-9999' },
          validity: null,
          surface: 'dsm',
          ground_classification: { kind: 'none' },
          samples: [
            ...denseSamples,
            { label: 'upper-left interior', xy: [0.5, 2.5], value: 42, no_data: false },
            { label: 'upper-right interior', xy: [2.5, 2.5], value: 42, no_data: false },
            { label: 'lower-left interior', xy: [0.5, 0.5], value: 42, no_data: false },
            { label: 'lower-right interior', xy: [2.5, 0.5], value: 42, no_data: false },
            { label: 'centre', xy: [1.5, 1.5], value: 42, no_data: false },
          ],
          tolerances: {
            elevation: 0.01,
            vertical_quantum: 1.1920928955078125e-7,
            minimum: 0.01,
            basis: 'maximum of half the raster data-type quantum and 0.01 metre',
          },
        },
      ],
    });
    assert.match(await readFile(path.join(outputPath, 'oracle.md'), 'utf8'), /centre/);

    const firstBytes = await readFile(path.join(outputPath, 'oracle.json'), 'utf8');
    await writeOracle(projectPath, outputPath, { generatedAt: '2026-09-09T00:00:01.000Z' });
    const secondBytes = await readFile(path.join(outputPath, 'oracle.json'), 'utf8');
    assert.equal(
      firstBytes.replace('2026-09-09T00:00:00.000Z', '<generated-at>'),
      secondBytes.replace('2026-09-09T00:00:01.000Z', '<generated-at>'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
