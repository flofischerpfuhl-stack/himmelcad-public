import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluate, moduleOf, ruleFor } from './check-assembler-modules.mjs';

const manifest = {
  layers: ['foundation', 'platform', 'domain', 'interface', 'product'],
  externalOnly: { replicad: ['kernel'] },
  desktopProcessPaths: ['electron/'],
  externalForbidden: { foundation: ['react'], domain: ['electron'] },
  modules: [
    { id: 'document', layer: 'foundation', paths: ['src/document/'] },
    { id: 'kernel', layer: 'foundation', paths: ['src/kernel/'] },
    { id: 'viewport', layer: 'platform', paths: ['src/viewport/'] },
    { id: 'print', layer: 'domain', paths: ['src/print/', 'electron/printIpc.ts'] },
    { id: 'measure', layer: 'domain', paths: ['src/measure/', 'src/print/measureBridge.ts'] },
    { id: 'shell', layer: 'interface', paths: ['src/shell/'] },
  ],
};
const files = [
  'src/document/a.ts',
  'src/kernel/k.ts',
  'src/viewport/v.ts',
  'src/print/p.ts',
  'src/print/measureBridge.ts',
  'src/measure/m.ts',
  'src/shell/s.ts',
  'electron/printIpc.ts',
];
const edge = (fromFile, target, external = false) => ({ fromFile, target, external });
const kinds = (edges, allowlist = { violations: [] }, fileList = files) =>
  evaluate({ manifest, files: fileList, edges, allowlist }).errors.map((e) => e.kind);

test('longest prefix wins', () => {
  assert.equal(moduleOf(manifest, 'src/print/measureBridge.ts').id, 'measure');
  assert.equal(moduleOf(manifest, 'src/print/p.ts').id, 'print');
});

test('downward imports and earlier modules of the same layer pass', () => {
  assert.deepEqual(
    kinds([
      edge('src/shell/s.ts', 'src/print/p.ts'),
      edge('src/print/p.ts', 'src/viewport/v.ts'),
      edge('src/viewport/v.ts', 'src/kernel/k.ts'),
      edge('src/kernel/k.ts', 'src/document/a.ts'),
      edge('src/kernel/k.ts', 'replicad', true),
      edge('electron/printIpc.ts', 'electron', true),
    ]),
    [],
  );
});

test('rules', () => {
  const byId = Object.fromEntries(manifest.modules.map((m) => [m.id, m]));
  assert.equal(ruleFor(manifest, byId.document, byId.kernel), 'layer-order');
  assert.equal(ruleFor(manifest, byId.kernel, byId.viewport), 'upward');
  assert.equal(ruleFor(manifest, byId.print, byId.measure), 'cross-domain');
  assert.equal(ruleFor(manifest, byId.shell, byId.document), null);
});

for (const [name, edges, expected] of [
  ['upward', [edge('src/kernel/k.ts', 'src/print/p.ts')], 'upward'],
  ['cross-domain', [edge('src/print/p.ts', 'src/measure/m.ts')], 'cross-domain'],
  ['layer-order', [edge('src/document/a.ts', 'src/kernel/k.ts')], 'layer-order'],
  ['external-owner', [edge('src/print/p.ts', 'replicad/sub', true)], 'external-owner'],
  ['external-layer', [edge('src/document/a.ts', 'react', true)], 'external-layer'],
  ['unassigned target', [edge('src/print/p.ts', 'src/other/x.ts')], 'unassigned-file'],
]) {
  test(`${name} fails`, () => {
    assert.ok(kinds(edges).includes(expected));
  });
}

test('allowlisted violations pass; stale entries and unassigned files fail', () => {
  const allowlist = {
    violations: [
      {
        from: 'kernel',
        to: 'print',
        rule: 'upward',
        reason: 'test',
        edges: ['src/kernel/k.ts -> src/print/p.ts'],
      },
    ],
  };
  assert.deepEqual(kinds([edge('src/kernel/k.ts', 'src/print/p.ts')], allowlist), []);
  assert.deepEqual(kinds([], allowlist), ['stale-allowlist']);
  assert.ok(kinds([], { violations: [] }, [...files, 'src/loose.ts']).includes('unassigned-file'));
});
