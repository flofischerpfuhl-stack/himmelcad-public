import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { KernelViewerSession, KernelViewerSessionError } from '../src/kernel/index.js';

const packageRoot = path.resolve(process.cwd());

void test('framework-free kernel entry is an explicit package export', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    readonly exports?: Readonly<
      Record<string, { readonly types?: string; readonly default?: string }>
    >;
  };
  assert.deepEqual(manifest.exports?.['./kernel'], {
    types: './src/kernel/index.ts',
    default: './src/kernel/index.ts',
  });
  assert.equal(typeof KernelViewerSession.create, 'function');
  assert.equal(new KernelViewerSessionError('disposed', 'disposed').code, 'disposed');
});

void test('kernel public entry has no React, Three, Electron or product dependency', async () => {
  const entry = path.join(packageRoot, 'src/kernel/index.ts');
  const visited = new Set<string>();
  const forbidden: { readonly file: string; readonly specifier: string }[] = [];

  const visit = async (file: string): Promise<void> => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    const imports = source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const specifier = match[1]!;
      if (
        specifier === 'react' ||
        specifier === 'three' ||
        specifier === 'electron' ||
        specifier.startsWith('@himmelcad/data') ||
        specifier.startsWith('@himmelcad/ui') ||
        specifier.includes('/apps/')
      ) {
        forbidden.push({ file: path.relative(packageRoot, file), specifier });
      }
      if (!specifier.startsWith('.')) continue;
      const sourceSpecifier = specifier.endsWith('.js')
        ? specifier.replace(/\.js$/, '.ts')
        : path.extname(specifier) === ''
          ? `${specifier}.ts`
          : specifier;
      const resolved = path.resolve(path.dirname(file), sourceSpecifier);
      await visit(resolved);
    }
  };

  await visit(entry);
  assert.deepEqual(forbidden, []);
  assert(visited.size > 100, 'the boundary gate must traverse generated canonical contracts too');
});
