import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

assert.equal(
  existsSync(resolve(root, 'apps/cap')),
  false,
  'the separately licensed HimmelCAD Cap application must not be restored to this repository',
);

const electronMain = read('apps/photolab/electron/main.ts');
const preload = read('apps/photolab/electron/preload.ts');
const renderer = read('apps/photolab/renderer/src/App.tsx');
const sidecar = read('crates/himmelcad-sidecar/src/main.rs');
const importer = read('crates/himmelcad-io/src/hcap_import.rs');

for (const method of [
  'photolab.himmelcap.inspect',
  'photolab.himmelcap.cancel',
  'photolab.himmelcap.release',
]) {
  assert.match(electronMain, new RegExp(`['"]${method.replaceAll('.', '\\.')}['"]`));
  assert.match(sidecar, new RegExp(`"${method.replaceAll('.', '\\.')}"`));
}

assert.match(preload, /himmelcap:\s*\{\s*selectFile:/s);
assert.match(renderer, /api\.sidecar\.call<HcapImportPreview>\('photolab\.himmelcap\.inspect'/);
assert.match(renderer, /'photolab\.images\.commit'/);
assert.match(renderer, /'photolab\.project\.captureGroup\.create'/);
assert.match(importer, /verify_archive_checksums/);
assert.match(importer, /SchemaTooNew/);
assert.match(importer, /rejects_checksum_mismatch/);
assert.match(importer, /rejects_path_traversal/);

console.log('PhotoLab HimmelCAD Cap import architecture contract passed.');
