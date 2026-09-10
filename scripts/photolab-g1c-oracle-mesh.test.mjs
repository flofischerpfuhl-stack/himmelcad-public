import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildOracle, renderOracleMarkdown } from './photolab-g1c-oracle.mjs';

const execFileAsync = promisify(execFile);
const SCRATCH_ROOT = path.resolve('.build/codex-scratch/g1c-mesh');

function makeGlb(document, binary) {
  const source = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(source.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const result = Buffer.alloc(12 + 8 + jsonLength + 8 + binaryLength);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(0x20, 20, 20 + jsonLength);
  source.copy(result, 20);
  const binaryHeader = 20 + jsonLength;
  result.writeUInt32LE(binaryLength, binaryHeader);
  result.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(result, binaryHeader + 8);
  return result;
}

function makeDensePly() {
  const points = [
    [0.025, 0.125, 1],
    [0.075, 0.125, 2],
    [0.125, 0.125, 3],
    [0.025, 0.075, 4],
    [0.075, 0.075, 5],
    [0.125, 0.075, 6],
    [0.025, 0.025, 7],
    [0.075, 0.025, 8],
    [0.125, 0.025, 9],
  ];
  const header = Buffer.from(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n`,
  );
  const body = Buffer.alloc(points.length * 24);
  points.forEach((point, pointIndex) => {
    point.forEach((value, axis) => body.writeDoubleLE(value, pointIndex * 24 + axis * 8));
  });
  return Buffer.concat([header, body]);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('mesh oracle emits exact identity, DEM surface, NoData, and transformed vertex rows', async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(SCRATCH_ROOT, 'oracle-'));
  try {
    const project = path.join(directory, 'synthetic.hcad');
    const packages = path.join(project, '.photolab', 'product-import-packages');
    const demPackage = path.join(packages, 'product-dem');
    const meshPackage = path.join(packages, 'product-mesh');
    const rasterDirectory = path.join(project, 'datasets', 'raster', 'dem-job');
    const denseDirectory = path.join(project, 'datasets', 'mvs');
    await Promise.all([
      mkdir(demPackage, { recursive: true }),
      mkdir(path.join(meshPackage, 'dataset', 'tiles'), { recursive: true }),
      mkdir(path.join(meshPackage, 'dataset', 'textures'), { recursive: true }),
      mkdir(rasterDirectory, { recursive: true }),
      mkdir(denseDirectory, { recursive: true }),
    ]);

    const asciiRaster = path.join(rasterDirectory, 'dem.asc');
    const rasterPath = path.join(rasterDirectory, 'base.tif');
    await writeFile(
      asciiRaster,
      'ncols 3\nnrows 3\nxllcorner 0\nyllcorner 0\ncellsize 0.05\nNODATA_value -9999\n1 2 3\n4 -9999 6\n7 8 9\n',
    );
    await execFileAsync('/usr/bin/gdal_translate', [
      '-q',
      '-of',
      'GTiff',
      '-ot',
      'Float32',
      asciiRaster,
      rasterPath,
    ]);
    await writeFile(path.join(denseDirectory, 'dense.ply'), makeDensePly());

    const commonLineage = {
      source_alignment_entity_id: 'project:compute:alignment:1',
      processing_set_choice: { kind: 'all_imported_cameras' },
      source_project_fingerprint: 'synthetic-project',
      reference_frame: {
        project_reference_frame: {
          target: { horizontal: { crs: { value: 'EPSG:9999' } } },
        },
      },
    };
    await writeJson(path.join(demPackage, 'manifest.json'), {
      manifest_id: 'product-dem',
      package_sha256: 'dem-sha256',
      source: { project_fingerprint: 'synthetic-project' },
      product: { kind: 'dem', entity_id: 'project:raster:dem-job' },
      lineage: {
        payload: {
          ...commonLineage,
          product_kind: 'dem',
          normalized_format_id: 'himmelcad-prepared-hierarchy@1',
          product_entity_id: 'project:raster:dem-job',
          raster_path: 'datasets/raster/dem-job/base.tif',
          dense_path: 'datasets/mvs/dense.ply',
          dem_facts: { source_no_data: { kind: 'numeric', value: '-9999' } },
        },
      },
    });
    await writeJson(path.join(demPackage, 'ready.json'), {
      manifest_id: 'product-dem',
      publication_generation: 1,
      package_sha256: 'dem-sha256',
    });

    const positions = Buffer.alloc(36);
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((value, index) => positions.writeFloatLE(value, index * 4));
    const gltf = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: positions.length }],
      bufferViews: [{ buffer: 0, byteLength: positions.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ translation: [10, 20, 30], mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
    await writeFile(
      path.join(meshPackage, 'dataset', 'tiles', 'first.glb'),
      makeGlb(gltf, positions),
    );
    await writeFile(path.join(meshPackage, 'dataset', 'textures', 'first.png'), Buffer.alloc(0));
    await writeJson(path.join(meshPackage, 'dataset', 'preparation.json'), {
      interpolateHoles: false,
    });
    await writeJson(path.join(meshPackage, 'dataset', 'kernel-manifest.json'), {
      tileIndex: [
        {
          id: 'first',
          extent: { minimum: [0, 0, 1], maximum: [0.15, 0.15, 9] },
          contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1],
          contents: [{ kind: 'gltf', uri: 'tiles/first.glb', primitiveCount: 1 }],
        },
      ],
    });
    await writeJson(path.join(meshPackage, 'manifest.json'), {
      manifest_id: 'product-mesh',
      package_sha256: 'mesh-sha256',
      source: { project_fingerprint: 'synthetic-project' },
      product: { kind: 'mesh', entity_id: 'project:mesh:mesh-job' },
      datasets: [
        {
          content_kind: 'gltf',
          format_id: 'himmelcad-prepared-hierarchy@1',
          root_path: 'dataset/kernel-manifest.json',
        },
      ],
      lineage: {
        payload: {
          ...commonLineage,
          product_kind: 'mesh',
          normalized_format_id: 'himmelcad-prepared-hierarchy@1',
          product_entity_id: 'project:mesh:mesh-job',
        },
      },
    });
    await writeJson(path.join(meshPackage, 'ready.json'), {
      manifest_id: 'product-mesh',
      publication_generation: 2,
      package_sha256: 'mesh-sha256',
    });

    const oracle = await buildOracle(project, { generatedAt: '2026-09-10T00:00:00.000Z' });
    const mesh = oracle.packages.find((item) => item.kind === 'mesh');
    assert.deepEqual(
      {
        sha256: mesh.sha256,
        tile_count: mesh.tile_count,
        texture_count: mesh.texture_count,
        bounds_keys: mesh.kernel_manifest.bounds_keys,
        triangle_count_key: mesh.kernel_manifest.triangle_count_key,
        total_triangle_count: mesh.kernel_manifest.total_triangle_count,
        source_dem_resolution_basis: mesh.source_dem_resolution_basis,
        tolerance: mesh.tolerances.elevation,
      },
      {
        sha256: 'mesh-sha256',
        tile_count: 1,
        texture_count: 1,
        bounds_keys: ['tileIndex[].extent'],
        triangle_count_key: 'tileIndex[].contents[].primitiveCount',
        total_triangle_count: 1,
        source_dem_resolution_basis: 'matching source alignment and processing set',
        tolerance: 0.05,
      },
    );
    assert.deepEqual(
      mesh.samples.map(({ label, xy, value, no_data, elevation_asserted, note }) => ({
        label,
        xy,
        value,
        no_data,
        elevation_asserted,
        note,
      })),
      [
        {
          label: 'dense point 0',
          xy: [0.025, 0.125],
          value: 1,
          no_data: false,
          elevation_asserted: true,
          note: undefined,
        },
        {
          label: 'dense point 1',
          xy: [0.075, 0.125],
          value: 2,
          no_data: false,
          elevation_asserted: true,
          note: undefined,
        },
        {
          label: 'dense point 2',
          xy: [0.125, 0.125],
          value: 3,
          no_data: false,
          elevation_asserted: true,
          note: undefined,
        },
        {
          label: 'dense point 4',
          xy: [0.075, 0.075],
          value: null,
          no_data: true,
          elevation_asserted: false,
          note: undefined,
        },
        {
          label: 'dense point 6',
          xy: [0.025, 0.025],
          value: 7,
          no_data: false,
          elevation_asserted: true,
          note: undefined,
        },
        {
          label: 'dense point 7',
          xy: [0.075, 0.025],
          value: 8,
          no_data: false,
          elevation_asserted: true,
          note: undefined,
        },
        {
          label: 'dense point 8',
          xy: [0.125, 0.025],
          value: 9,
          no_data: false,
          elevation_asserted: true,
          note: undefined,
        },
        {
          label: 'centre',
          xy: [0.07500000000000001, 0.07499999999999998],
          value: null,
          no_data: true,
          elevation_asserted: false,
          note: undefined,
        },
      ],
    );
    assert.deepEqual(
      mesh.vertex_sample.samples.map((sample) => sample.xyz),
      [
        [111, 222, 333],
        [114, 225, 336],
        [117, 228, 339],
      ],
    );
    await writeJson(path.join(meshPackage, 'dataset', 'preparation.json'), {
      interpolateHoles: true,
    });
    const interpolatedOracle = await buildOracle(project, {
      generatedAt: '2026-09-10T00:00:00.000Z',
    });
    const interpolatedMesh = interpolatedOracle.packages.find((item) => item.kind === 'mesh');
    assert.deepEqual(
      interpolatedMesh.samples
        .filter((sample) => sample.source_dem_no_data)
        .map(({ no_data, elevation_asserted, note }) => ({
          no_data,
          elevation_asserted,
          note,
        })),
      [
        {
          no_data: false,
          elevation_asserted: false,
          note: 'filled by interpolation, elevation not asserted',
        },
        {
          no_data: false,
          elevation_asserted: false,
          note: 'filled by interpolation, elevation not asserted',
        },
      ],
    );
    const markdown = renderOracleMarkdown(interpolatedOracle);
    assert.match(markdown, /\| mesh-sha256 \| 1 \| 1 \| 1 \|/u);
    assert.match(markdown, /filled by interpolation, elevation not asserted/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
