import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import {
  KernelViewerSession,
  KernelViewerSessionError,
  type CanonicalEntity,
  type KernelCanonicalRenderAdmission,
  type KernelPotreeDatasetAdmission,
  type KernelRasterDepthMeasurement,
  type KernelSectionMutation,
  type KernelSectionRequest,
  type KernelViewerEntityHandle,
  type KernelViewerLoadOptions,
  type KernelViewerSessionDiagnostics,
  type KernelViewerSessionEvent,
} from '../src/kernel/index.js';

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

void test('kernel public API surface is exact and runtime internals stay private', async () => {
  const entry = path.join(packageRoot, 'src/kernel/index.ts');
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    [],
  );

  const source = program.getSourceFile(entry);
  assert(source !== undefined);
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert(moduleSymbol !== undefined);
  const surface = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const marker = [
        target.flags & ts.SymbolFlags.Value ? 'v' : '',
        target.flags & ts.SymbolFlags.Type ? 't' : '',
        target.flags & ts.SymbolFlags.Namespace ? 'n' : '',
      ].join('');
      return `${symbol.name}:${marker}`;
    })
    .sort();
  assert.equal(surface.length, 199);
  assert.equal(
    createHash('sha256').update(surface.join('\n')).digest('hex'),
    '5a6f3f01e24a0967ee7b0faa84e006b48d8c44a74fe02b17326071a8a20bd59f',
    `kernel API changed; review the stable contract before updating this gate:\n${surface.join('\n')}`,
  );

  const runtime = await import('../src/kernel/index.js');
  assert.deepEqual(Object.keys(runtime).sort(), [
    'KernelCameraController',
    'KernelCanonicalDocument',
    'KernelDecodeWorkerError',
    'KernelViewerEntityHandle',
    'KernelViewerScene',
    'KernelViewerSession',
    'KernelViewerSessionError',
    'assertValidKernelLocalOrthographicViewFrame',
    'localSectionClipVolume',
  ]);
});

void test('kernel entry is directly consumable without internal escape hatches', () => {
  type ProductSession = {
    readonly loadCanonical: (
      admissions: readonly KernelCanonicalRenderAdmission[],
    ) => readonly KernelViewerEntityHandle[];
    readonly loadPotree: (
      input: KernelPotreeDatasetAdmission,
      options?: KernelViewerLoadOptions,
    ) => Promise<KernelViewerEntityHandle>;
    readonly registerImageResource: (
      objectHash: string,
      width: number,
      height: number,
      rgba8: Uint8Array,
    ) => void;
    readonly measureRasterDepthSample: (
      entityId: string,
      column: number,
      row: number,
    ) => KernelRasterDepthMeasurement;
    readonly upsertSection: (request: KernelSectionRequest) => KernelSectionMutation;
    readonly subscribe: (listener: (event: KernelViewerSessionEvent) => void) => () => void;
    readonly diagnostics: () => KernelViewerSessionDiagnostics;
    readonly dispose: () => void;
  };
  const consumeSession = (session: KernelViewerSession): ProductSession => session;
  const consumeEntity = (entity: CanonicalEntity): string => entity.id;
  const noInternalEscapeHatches: Extract<
    keyof KernelViewerSession,
    'viewer' | 'streaming'
  > extends never
    ? true
    : false = true;

  assert.equal(typeof consumeSession, 'function');
  assert.equal(typeof consumeEntity, 'function');
  assert.equal(noInternalEscapeHatches, true);
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
