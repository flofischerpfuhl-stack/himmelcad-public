import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const version = process.argv[2]?.trim() ?? '';
if (!/^0\.1\.[1-9]\d*$/.test(version)) {
  throw new Error(`Expected an alpha version like 0.1.42, received '${version}'`);
}

const workspace = resolve(
  process.env.HIMMELCAD_RELEASE_WORKSPACE ?? resolve(import.meta.dirname, '..'),
);
for (const product of ['builder', 'photolab']) {
  const path = join(workspace, 'apps', product, 'package.json');
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
    throw new Error(`Desktop package manifest is invalid: ${path}`);
  }
  const manifest = parsed;
  manifest.version = version;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(`Desktop release version set to ${version}.\n`);
