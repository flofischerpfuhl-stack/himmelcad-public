import { spawnSync } from 'node:child_process';

const argument = process.argv.slice(2).find((value) => value.startsWith('--triangles='));
const triangleCount = argument?.slice('--triangles='.length) ?? '2000000';
if (!/^[1-9][0-9]*$/.test(triangleCount)) {
  throw new Error('--triangles must be a positive integer');
}

const result = spawnSync(
  process.env.CARGO ?? 'cargo',
  [
    'test',
    '-p',
    'himmelcad-sidecar',
    'prepared_triangle_mesh::tests::large_synthetic_mesh_is_partitioned_without_materializing_the_source',
    '--lib',
    '--',
    '--ignored',
    '--exact',
    '--nocapture',
  ],
  {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HCAD_LARGE_MESH_TRIANGLES: triangleCount },
    encoding: 'utf8',
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`large prepared-mesh gate passed · ${triangleCount} streamed triangles`);
