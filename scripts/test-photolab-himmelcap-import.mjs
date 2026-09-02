import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

// Cap ships in this repository as its own Flutter product (docs/CURRENT-DIRECTION.md).
// The invariant is therefore not absence but separation: PhotoLab and the Rust
// crates integrate with Cap only through the `.hcap` archive contract, never by
// reaching into the Flutter sources or by vendoring them into the desktop app.
assert.ok(
  existsSync(resolve(root, 'apps/cap/pubspec.yaml')),
  'apps/cap must stay a self-contained Flutter product with its own manifest',
);

const capBoundaryRoots = [
  'apps/photolab/electron',
  'apps/photolab/renderer/src',
  'crates/himmelcad-sidecar/src',
  'crates/himmelcad-io/src',
];
for (const relative of capBoundaryRoots) {
  for (const entry of readdirSync(resolve(root, relative), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|rs)$/.test(entry.name)) continue;
    const file = join(entry.parentPath ?? entry.path, entry.name);
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /apps[/\\]cap[/\\]/,
      `${relative}/${entry.name} must not reach into the Cap Flutter sources; use the .hcap archive contract`,
    );
  }
}

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
