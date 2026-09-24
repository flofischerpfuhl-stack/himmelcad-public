#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'release',
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function edgeKey({ ecosystem, from, to }) {
  return `${ecosystem}:${from}->${to}`;
}

function validateConfiguration(layerMap, allowlist) {
  const knownLayers = new Set(layerMap.layers);
  for (const [name, layer] of Object.entries(layerMap.rust)) {
    if (!knownLayers.has(layer)) throw new Error(`unknown Rust layer for ${name}: ${layer}`);
  }
  for (const [name, definition] of Object.entries(layerMap.typescript)) {
    for (const layer of [definition.layer, ...Object.values(definition.subpaths ?? {})]) {
      if (!knownLayers.has(layer))
        throw new Error(`unknown TypeScript layer for ${name}: ${layer}`);
    }
  }
  for (const entry of layerMap.exactForbiddenEdges ?? []) {
    if (entry.from.includes('*') || entry.to.includes('*')) {
      throw new Error(`wildcards are forbidden in exact module constraints: ${edgeKey(entry)}`);
    }
  }
  const keys = new Set();
  for (const entry of allowlist.edges) {
    if (!entry.reason || !Number.isInteger(entry.removeInStep)) {
      throw new Error(`allowlist entries need a reason and removeInStep: ${JSON.stringify(entry)}`);
    }
    if (entry.from.includes('*') || entry.to.includes('*')) {
      throw new Error(`wildcards are forbidden in the module allowlist: ${edgeKey(entry)}`);
    }
    const key = edgeKey(entry);
    if (keys.has(key)) throw new Error(`duplicate module allowlist entry: ${key}`);
    keys.add(key);
  }
  const includeKeys = new Set();
  for (const entry of allowlist.sourceIncludes ?? []) {
    if (!entry.crate || !entry.file || !entry.target || !entry.reason) {
      throw new Error(`source include allowlist entries need crate, file, target, and reason: ${JSON.stringify(entry)}`);
    }
    const key = `${entry.crate}:${entry.file}->${entry.target}`;
    if (includeKeys.has(key)) throw new Error(`duplicate source include allowlist entry: ${key}`);
    includeKeys.add(key);
  }
}

function isDisallowedLayerEdge(fromLayer, toLayer) {
  if (fromLayer === 'domain' && toLayer === 'domain') return 'domain-to-domain';
  if (
    fromLayer === 'foundation' &&
    ['domain', 'product', 'interface', 'command', 'display', 'electron'].includes(toLayer)
  )
    return 'upward';
  if (
    fromLayer === 'display' &&
    ['domain', 'product', 'interface', 'command', 'electron'].includes(toLayer)
  )
    return 'upward';
  if (fromLayer === 'interface' && ['domain', 'product', 'electron'].includes(toLayer))
    return toLayer === 'electron' ? 'ui-to-electron' : 'upward';
  if (fromLayer === 'command' && ['product', 'interface'].includes(toLayer)) return 'upward';
  if (
    fromLayer === 'domain' &&
    ['product', 'interface', 'command', 'display', 'electron'].includes(toLayer)
  )
    return 'upward';
  return undefined;
}

export function evaluateEdges({ edges, layers, allowlist, forced = new Set() }) {
  const allowedKeys = new Set(allowlist.map(edgeKey));
  const seenAllowlist = new Set();
  const errors = [];
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const key = edgeKey(edge);
    const fromLayer = layers.get(edge.from);
    const toLayer = layers.get(edge.to);
    if (!fromLayer) {
      errors.push({ kind: 'unknown-module', edge, message: `unknown module ${edge.from}` });
      continue;
    }
    if (!toLayer) {
      errors.push({ kind: 'unknown-module', edge, message: `unknown module ${edge.to}` });
      continue;
    }
    const violation = forced.has(key)
      ? 'temporary-architecture-edge'
      : isDisallowedLayerEdge(fromLayer, toLayer);
    if (!violation) continue;
    if (allowedKeys.has(key)) seenAllowlist.add(key);
    else
      errors.push({
        kind: violation,
        edge,
        message: `${edge.from} (${fromLayer}) -> ${edge.to} (${toLayer})`,
      });
  }
  for (const entry of allowlist) {
    const key = edgeKey(entry);
    if (!seenAllowlist.has(key)) {
      errors.push({ kind: 'stale-allowlist', edge: entry, message: key });
    }
  }
  return errors;
}

function cargoGraph(layerMap) {
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CARGO_TARGET_DIR: '/media/oem/ZusatzSSD1/himmelcad-target/split',
      },
    }),
  );
  const members = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter(({ id }) => members.has(id));
  const names = new Set(packages.map(({ name }) => name));
  const unknown = [...names].filter((name) => !layerMap.rust[name]).sort();
  const edges = [];
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      if (dependency.path && names.has(dependency.name)) {
        edges.push({ ecosystem: 'rust', from: pkg.name, to: dependency.name });
      }
    }
  }
  return { packages, unknown, edges: uniqueEdges(edges) };
}

function rustSourceFiles(directory) {
  const result = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        result.push(join(current, entry.name));
      }
    }
  };
  visit(directory);
  return result;
}

function includeKey(entry) {
  return `${entry.crate}:${entry.file}->${entry.target}`;
}

export function evaluateRustSourceRules({ includes = [], macroExports = [], allowlist = [] }) {
  const allowed = new Set(allowlist.map(includeKey));
  const seen = new Set();
  const errors = [];
  for (const entry of includes) {
    if (!entry.leavesCrate) continue;
    const key = includeKey(entry);
    if (allowed.has(key)) seen.add(key);
    else errors.push({ kind: 'cross-crate-source-include', message: key });
  }
  for (const entry of macroExports) {
    errors.push({
      kind: 'domain-macro-export',
      message: `${entry.crate}:${entry.file}`,
    });
  }
  for (const entry of allowlist) {
    const key = includeKey(entry);
    if (!seen.has(key)) errors.push({ kind: 'stale-source-include-allowlist', message: key });
  }
  return errors;
}

function rustSourceRules(packages, layerMap) {
  const includes = [];
  const macroExports = [];
  const directInclude = /\binclude(?:_str|_bytes)?!\s*\(\s*"([^"]+)"\s*\)/gu;
  const manifestInclude = /\binclude(?:_str|_bytes)?!\s*\(\s*concat!\(\s*env!\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,\s*"([^"]+)"\s*\)\s*\)/gu;
  const anyInclude = /\binclude(?:_str|_bytes)?!\s*\(/gu;
  const macroExport = /#\s*\[\s*macro_export\s*\]/gu;
  for (const pkg of packages) {
    const crateDirectory = realpathSync(dirname(pkg.manifest_path));
    for (const filePath of rustSourceFiles(crateDirectory)) {
      const source = readFileSync(filePath, 'utf8');
      const file = relative(crateDirectory, filePath).replaceAll(sep, '/');
      const matches = [];
      for (const match of source.matchAll(directInclude)) {
        matches.push({ index: match.index, target: match[1], base: dirname(filePath) });
      }
      for (const match of source.matchAll(manifestInclude)) {
        matches.push({ index: match.index, target: match[1], base: crateDirectory });
      }
      const parsed = new Set(matches.map(({ index }) => index));
      for (const match of source.matchAll(anyInclude)) {
        if (!parsed.has(match.index)) {
          includes.push({
            crate: pkg.name,
            file,
            target: '<non-literal>',
            leavesCrate: true,
          });
        }
      }
      for (const match of matches) {
        const lexicalTarget = resolve(match.base, `.${sep}${match.target}`);
        const resolvedTarget = existsSync(lexicalTarget) ? realpathSync(lexicalTarget) : lexicalTarget;
        includes.push({
          crate: pkg.name,
          file,
          target: match.target,
          leavesCrate:
            resolvedTarget !== crateDirectory && !resolvedTarget.startsWith(`${crateDirectory}${sep}`),
        });
      }
      if (layerMap.rust[pkg.name] === 'domain' && macroExport.test(source)) {
        macroExports.push({ crate: pkg.name, file });
      }
      macroExport.lastIndex = 0;
    }
  }
  return { includes, macroExports };
}

function packageDirectories() {
  const result = [];
  for (const parent of ['packages/@himmelcad', 'apps']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json'))) {
        result.push(join(root, parent, entry.name));
      }
    }
  }
  return result;
}

function sourceFiles(directory) {
  const result = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(join(current, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        result.push(join(current, entry.name));
      }
    }
  };
  visit(directory);
  return result;
}

function importSpecifiers(path) {
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const imports = [];
  const addLiteral = (node) => {
    if (node && ts.isStringLiteralLike(node)) imports.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      addLiteral(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        addLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function packageForFile(packages, path) {
  const normalized = resolve(path);
  return [...packages.values()].find(
    ({ directory }) => normalized === directory || normalized.startsWith(`${directory}${sep}`),
  );
}

function moduleSubpath(pkg, path) {
  const local = relative(pkg.directory, path)
    .replaceAll(sep, '/')
    .replace(/\.(?:d\.)?[cm]?[jt]sx?$/u, '');
  if (pkg.name === '@himmelcad/viewer') {
    if (/^src\/index$/u.test(local)) return '.';
    if (/^src\/legacy(?:\.js)?$/u.test(local)) return 'legacy';
    if (/^src\/kernel\/KernelViewport$/u.test(local)) return 'kernel/react';
    if (/^src\/kernel(?:\/|$)/u.test(local)) return 'kernel';
  }
  if (pkg.name === '@himmelcad/automation-host') {
    if (/^(?:electron|src\/electron)/u.test(local)) return 'electron';
    if (/^(?:provider-credentials|src\/provider-credentials)/u.test(local))
      return 'provider-credentials';
  }
  return '.';
}

function moduleId(name, subpath = '.') {
  return `${name}:${subpath || '.'}`;
}

function layerFor(layerMap, name, subpath) {
  const definition = layerMap.typescript[name];
  if (!definition) return undefined;
  if (subpath === '.') return definition.layer;
  const candidates = Object.entries(definition.subpaths ?? {}).sort(
    (a, b) => b[0].length - a[0].length,
  );
  return (
    candidates.find(([prefix]) => subpath === prefix || subpath.startsWith(`${prefix}/`))?.[1] ??
    definition.layer
  );
}

function canonicalSubpath(layerMap, name, subpath) {
  if (subpath === '.') return '.';
  const configured = Object.keys(layerMap.typescript[name]?.subpaths ?? {}).sort(
    (a, b) => b.length - a.length,
  );
  return configured.find((prefix) => subpath === prefix || subpath.startsWith(`${prefix}/`)) ?? '.';
}

function workspaceSpecifier(packages, specifier) {
  for (const pkg of [...packages.values()].sort((a, b) => b.name.length - a.name.length)) {
    if (specifier === pkg.name) return { pkg, subpath: '.' };
    if (specifier.startsWith(`${pkg.name}/`))
      return { pkg, subpath: specifier.slice(pkg.name.length + 1) };
  }
  return undefined;
}

function typeScriptGraph(layerMap) {
  const packages = new Map();
  for (const directory of packageDirectories()) {
    const manifest = readJson(join(directory, 'package.json'));
    packages.set(manifest.name, {
      name: manifest.name,
      directory: realpathSync(directory),
      manifest,
    });
  }
  const unknown = [...packages.keys()].filter((name) => !layerMap.typescript[name]).sort();
  const edges = [];
  const undeclared = [];
  for (const pkg of packages.values()) {
    const declarations = new Set([
      ...Object.keys(pkg.manifest.dependencies ?? {}),
      ...Object.keys(pkg.manifest.devDependencies ?? {}),
      ...Object.keys(pkg.manifest.peerDependencies ?? {}),
    ]);
    for (const dependency of declarations) {
      const target = packages.get(dependency);
      if (target)
        edges.push({
          ecosystem: 'typescript',
          from: moduleId(pkg.name),
          to: moduleId(target.name),
          evidence: 'package.json',
        });
    }
    for (const file of sourceFiles(pkg.directory)) {
      const fromSubpath = moduleSubpath(pkg, file);
      for (const specifier of importSpecifiers(file)) {
        let target = workspaceSpecifier(packages, specifier);
        if (!target && specifier.startsWith('.')) {
          const resolved = resolve(dirname(file), specifier);
          const targetPackage = packageForFile(packages, resolved);
          if (targetPackage)
            target = { pkg: targetPackage, subpath: moduleSubpath(targetPackage, resolved) };
        }
        if (!target) continue;
        if (target.pkg.name !== pkg.name && !declarations.has(target.pkg.name)) {
          undeclared.push(
            `${relative(root, file)} imports undeclared workspace package ${target.pkg.name} (${specifier})`,
          );
        }
        edges.push({
          ecosystem: 'typescript',
          from: moduleId(pkg.name, fromSubpath),
          to: moduleId(
            target.pkg.name,
            canonicalSubpath(layerMap, target.pkg.name, target.subpath),
          ),
          evidence: relative(root, file),
        });
      }
    }
  }
  const layers = new Map();
  for (const pkg of packages.values()) {
    layers.set(moduleId(pkg.name), layerFor(layerMap, pkg.name, '.'));
    for (const subpath of Object.keys(layerMap.typescript[pkg.name]?.subpaths ?? {})) {
      layers.set(moduleId(pkg.name, subpath), layerFor(layerMap, pkg.name, subpath));
    }
  }
  for (const edge of edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!layers.has(endpoint)) {
        const separator = endpoint.lastIndexOf(':');
        layers.set(
          endpoint,
          layerFor(layerMap, endpoint.slice(0, separator), endpoint.slice(separator + 1)),
        );
      }
    }
  }
  return {
    packages,
    unknown,
    edges: uniqueEdges(edges),
    undeclared: [...new Set(undeclared)].sort(),
    layers,
  };
}

function uniqueEdges(edges) {
  const result = new Map();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (!result.has(key)) result.set(key, edge);
  }
  return [...result.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

export function evaluateUndeclaredImports(imports) {
  return imports.map((message) => ({ kind: 'undeclared-workspace-import', message }));
}

export function evaluateFixture(fixture) {
  const layers = new Map(Object.entries(fixture.layers));
  return [
    ...evaluateEdges({
      edges: fixture.edges,
      layers,
      allowlist: fixture.allowlist ?? [],
      forced: new Set(fixture.forced ?? []),
    }),
    ...evaluateUndeclaredImports(fixture.undeclared ?? []),
    ...evaluateRustSourceRules(fixture.rustSourceRules ?? {}),
  ];
}

function main() {
  const started = performance.now();
  const layerMap = readJson(join(root, 'scripts/module-layers.json'));
  const allowlist = readJson(join(root, 'scripts/module-dependency-allowlist.json'));
  validateConfiguration(layerMap, allowlist);

  const rust = cargoGraph(layerMap);
  const sourceRules = rustSourceRules(rust.packages, layerMap);
  const typescript = typeScriptGraph(layerMap);
  const errors = [
    ...rust.unknown.map((name) => ({ kind: 'unknown-rust-crate', message: name })),
    ...typescript.unknown.map((name) => ({ kind: 'unknown-typescript-package', message: name })),
    ...evaluateUndeclaredImports(typescript.undeclared),
    ...evaluateRustSourceRules({
      ...sourceRules,
      allowlist: allowlist.sourceIncludes ?? [],
    }),
  ];
  const rustLayers = new Map(Object.entries(layerMap.rust));
  const forced = new Set((layerMap.exactForbiddenEdges ?? []).map(edgeKey));
  errors.push(
    ...evaluateEdges({
      edges: rust.edges,
      layers: rustLayers,
      allowlist: allowlist.edges.filter(({ ecosystem }) => ecosystem === 'rust'),
      forced,
    }),
  );
  errors.push(
    ...evaluateEdges({
      edges: typescript.edges,
      layers: typescript.layers,
      allowlist: allowlist.edges.filter(({ ecosystem }) => ecosystem === 'typescript'),
      forced,
    }),
  );

  if (errors.length) {
    for (const error of errors)
      process.stderr.write(`module dependency error [${error.kind}]: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  process.stdout.write(
    `module dependencies: ok (${rust.packages.length} Rust crates, ${rust.edges.length} Rust edges, ${typescript.packages.size} TypeScript packages, ${typescript.edges.length} TypeScript edges, ${allowlist.edges.length} edge exceptions, ${(allowlist.sourceIncludes ?? []).length} source-include exceptions, ${elapsed}s)\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
