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
  type KernelNavigationCallbacks,
  type KernelNavigationController,
  type KernelPotreeDatasetAdmission,
  type KernelRasterDepthMeasurement,
  type KernelRgbaCaptureRequest,
  type KernelRgbaCaptureResult,
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

void test('legacy React and Three surface is isolated behind an explicit compatibility entry', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    readonly exports?: Readonly<
      Record<string, { readonly types?: string; readonly default?: string }>
    >;
  };
  assert.deepEqual(manifest.exports?.['./legacy'], {
    types: './src/legacy.ts',
    default: './src/legacy.ts',
  });
  assert.equal(
    (await readFile(path.join(packageRoot, 'src/index.ts'), 'utf8')).trim(),
    "/** @deprecated Compatibility shim; new hosts import `@himmelcad/viewer/kernel`. */\nexport * from './legacy.js';",
  );
  const legacy = await readFile(path.join(packageRoot, 'src/legacy.ts'), 'utf8');
  assert.match(legacy, /@deprecated Product hosts must migrate/);
  assert.match(legacy, /\.\/Viewport\.js/);
  assert.doesNotMatch(legacy, /export \* from ['"]\.\/kernel\/index/);
});

void test('browser release runners resolve tools for Linux, Windows and macOS', async () => {
  const files = [
    'test/browser/kernel-browser-e2e.mjs',
    'test/browser/webgpu-map-range-probe.mjs',
    'test/consumer/public-process-hosts.mjs',
    'test/scale/viewer-scale-gate.mjs',
  ];
  const runnerSources: string[] = [];
  for (const file of files) {
    const source = await readFile(path.join(packageRoot, file), 'utf8');
    runnerSources.push(source);
    assert.match(source, /support\/platform-tools\.mjs/);
    assert.doesNotMatch(source, /\/home\/oem|\/usr\/bin\/google-chrome/);
  }
  assert.match(runnerSources.join('\n'), /WASM_BINDGEN/);
  const support = await readFile(path.join(packageRoot, 'test/support/platform-tools.mjs'), 'utf8');
  assert.match(support, /process\.platform === 'win32'/);
  assert.match(support, /process\.platform === 'darwin'/);
  assert.match(support, /HCAD_CHROME_PATH/);
  assert.match(support, /HCAD_ELECTRON_PATH/);
  assert.match(support, /HCAD_ESBUILD_PATH/);
  assert.match(support, /HCAD_HEADLESS/);
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
  assert.equal(surface.length, 226);
  assert.equal(
    createHash('sha256').update(surface.join('\n')).digest('hex'),
    'f963f7788b1adf9a82e8187d18515ccc0e342d31691e7e6df48d92da45482e23',
    `kernel API changed; review the stable contract before updating this gate:\n${surface.join('\n')}`,
  );

  const runtime = await import('../src/kernel/index.js');
  assert.deepEqual(Object.keys(runtime).sort(), [
    'KernelCameraController',
    'KernelCanonicalDocument',
    'KernelDecodeWorkerError',
    'KernelNavigationController',
    'KernelViewerEntityHandle',
    'KernelViewerScene',
    'KernelViewerSession',
    'KernelViewerSessionError',
    'assertValidKernelLocalOrthographicViewFrame',
    'assertViewingBox',
    'isPlanViewMode',
    'localSectionClipVolume',
    'moveViewingBox',
    'placeViewingBoxCenter',
    'projectPickCandidateForViewMode',
    'projectTargetPlaneCoordinate',
    'resizeViewingBox',
    'rotateViewingBox',
    'setViewingBoxMode',
    'viewingBoxAxes',
    'viewingBoxClipVolume',
    'viewingBoxFromViewport',
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
    readonly attachNavigation: (
      callbacks?: KernelNavigationCallbacks,
    ) => KernelNavigationController;
    readonly captureRgba: (request: KernelRgbaCaptureRequest) => Promise<KernelRgbaCaptureResult>;
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

void test('React viewport is a thin session adapter without engine ownership', async () => {
  const source = await readFile(path.join(packageRoot, 'src/kernel/KernelViewport.tsx'), 'utf8');
  assert.match(source, /KernelViewerSession\.create/);
  for (const forbidden of [
    'WgpuKernelViewer.create',
    'new KernelStreamingDriver',
    'new KernelDecodeWorkerPool',
    'readonly viewer:',
    'readonly streaming:',
  ]) {
    assert.equal(source.includes(forbidden), false, `React adapter owns ${forbidden}`);
  }
});

void test('shared headless, browser and Electron fixture consumes only the public entry', async () => {
  const consumer = await readFile(
    path.join(packageRoot, 'test/consumer/public-mixed-scene.ts'),
    'utf8',
  );
  const specifiers = [...consumer.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(specifiers, ['../../src/kernel/index.js']);
  for (const host of ['browser', 'electron']) {
    const source = await readFile(
      path.join(packageRoot, `test/${host}/public-session-host.ts`),
      'utf8',
    );
    assert.equal(
      source.trim(),
      `export { loadPublicMixedScene as load${host === 'browser' ? 'Browser' : 'Electron'}MixedScene } from '../consumer/public-mixed-scene.js';`,
    );
  }
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
        (specifier.startsWith('@himmelcad/data') && specifier !== '@himmelcad/data/canonical') ||
        specifier.startsWith('@himmelcad/ui') ||
        specifier.includes('/apps/')
      ) {
        forbidden.push({ file: path.relative(packageRoot, file), specifier });
      }
      if (specifier === '@himmelcad/data/canonical') {
        await visit(path.resolve(packageRoot, '../data/src/generated/index.ts'));
        continue;
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
