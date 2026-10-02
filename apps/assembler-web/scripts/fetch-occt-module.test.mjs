/** The pure parts of `fetch-occt-module.mjs` (the download itself is exercised by Workers Builds). */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { artifactHashes, sourceUrl, targetDir } from './fetch-occt-module.mjs';

test('hashes, cache directory and URL template match the build', () => {
  const hashes = artifactHashes(
    `${'a'.repeat(64)}  dist/himmelcad_occt.js\r\n${'B'.repeat(64)} *dist/himmelcad_occt.wasm\n`,
  );
  assert.equal(hashes.get('himmelcad_occt.js'), 'a'.repeat(64));
  assert.equal(hashes.get('himmelcad_occt.wasm'), 'b'.repeat(64));
  assert.equal(targetDir({ HIMMELCAD_OCCT_DIR: '/x/y' }, '1', 'linux'), resolve('/x/y'));
  assert.equal(
    targetDir({ HIMMELCAD_OCCT_CACHE: '/c' }, '8.0.1-hc.3', 'linux'),
    join(resolve('/c'), '8.0.1-hc.3'),
  );
  assert.match(
    targetDir({}, '8.0.1-hc.3', 'linux'),
    /\.cache[\\/]himmelcad[\\/]occt-wasm[\\/]8\.0\.1-hc\.3$/,
  );
  assert.equal(
    sourceUrl('https://h/generic/m/{version}/{file}', '8.0.1-hc.3', 'himmelcad_occt.wasm'),
    'https://h/generic/m/8.0.1-hc.3/himmelcad_occt.wasm',
  );
});
