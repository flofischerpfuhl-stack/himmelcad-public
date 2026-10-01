#!/usr/bin/env node
/**
 * Module-direction check of HimmelCAD Assembler (ADR 0032, assembler/MODULES.md).
 *
 * Builder's `check-module-dependencies.mjs` checks workspace packages and
 * crates; Assembler's modules are folders inside one app package (see
 * MODULES.md "Package form"), so this check works on files. It reuses
 * Builder's TypeScript import scanner and allowlist discipline (exact
 * entries, a reason per entry, stale entries fail) and applies the
 * Assembler layer rules from `apps/assembler/modules.json`:
 *
 * - layers bottom-up: foundation, platform, domain, interface, product;
 *   an import may only point to a lower layer;
 * - inside foundation, platform and interface, a module may import only
 *   modules listed before it in the manifest;
 * - domain modules never import each other;
 * - some npm packages are reserved to one module (OCCT: geometry-kernel,
 *   planeGCS: sketch-solver) and some are forbidden in a layer (React in
 *   foundation, Electron outside the desktop host).
 *
 * Known violations live in `apps/assembler/module-allowlist.json`, one
 * entry per importing file and target; the list only ever shrinks.
 *
 * Usage: node scripts/check-assembler-modules.mjs [--write-allowlist] [--report]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importSpecifiers } from './check-module-dependencies.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'apps/assembler');
// Source roots relative to `apps/assembler`; `modules.json` `sourceRoots` overrides them (the web
// product's `../assembler-web/src` is one: products are compositions of the same modules).
const DEFAULT_SOURCE_ROOTS = ['renderer/src', 'headless', 'electron'];
const sourceRootsOf = (manifest) =>
  (manifest.sourceRoots ?? DEFAULT_SOURCE_ROOTS).filter((root) => existsSync(join(appRoot, root)));
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs']);
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'];
const LAYERS_WITH_ORDER = new Set(['foundation', 'platform', 'interface']);

const toPosix = (path) => path.split(sep).join('/');

/** Module of `file` (app-relative, posix) by longest matching prefix, or `undefined`. */
export function moduleOf(manifest, file) {
  let best;
  for (const module of manifest.modules) {
    for (const prefix of module.paths) {
      if (file.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
        best = { module, prefix };
      }
    }
  }
  return best?.module;
}

export function validateManifest(manifest) {
  const errors = [];
  const layers = new Set(manifest.layers);
  const ids = new Set();
  const prefixes = new Map();
  for (const module of manifest.modules) {
    if (!layers.has(module.layer))
      errors.push(`module ${module.id}: unknown layer ${module.layer}`);
    if (ids.has(module.id)) errors.push(`duplicate module id ${module.id}`);
    ids.add(module.id);
    for (const prefix of module.paths) {
      if (prefix.includes('*') || prefix.includes('\\'))
        errors.push(
          `module ${module.id}: path must be a posix prefix without wildcards: ${prefix}`,
        );
      if (prefixes.has(prefix))
        errors.push(`path ${prefix} is claimed by ${prefixes.get(prefix)} and ${module.id}`);
      prefixes.set(prefix, module.id);
    }
  }
  for (const [pkg, owners] of Object.entries(manifest.externalOnly ?? {})) {
    for (const owner of owners)
      if (!ids.has(owner)) errors.push(`externalOnly ${pkg}: unknown module ${owner}`);
  }
  return errors;
}

/**
 * The rule an import from module `from` to module `to` breaks, or `null`.
 * `manifest.modules` order is the order inside a layer.
 */
export function ruleFor(manifest, from, to) {
  if (from.id === to.id) return null;
  const layerIndex = (m) => manifest.layers.indexOf(m.layer);
  if (layerIndex(to) > layerIndex(from)) return 'upward';
  if (layerIndex(to) < layerIndex(from)) return null;
  if (from.layer === 'domain') return 'cross-domain';
  if (LAYERS_WITH_ORDER.has(from.layer)) {
    const index = (m) => manifest.modules.findIndex((candidate) => candidate.id === m.id);
    return index(to) < index(from) ? null : 'layer-order';
  }
  return null; // products may use each other's files (none do today)
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function externalRuleFor(manifest, from, specifier, fromFile = '') {
  const pkg = packageName(specifier);
  const owners = manifest.externalOnly?.[pkg];
  if (owners && !owners.includes(from.id)) return 'external-owner';
  // Files of a module that run in the Electron main process (e.g. `electron/slicerIpc.ts` of
  // `printers`) are Electron code by definition.
  const desktopProcess = (manifest.desktopProcessPaths ?? []).some((p) => fromFile.startsWith(p));
  if (pkg === 'electron' && desktopProcess) return null;
  if ((manifest.externalForbidden?.[from.layer] ?? []).includes(pkg)) return 'external-layer';
  return null;
}

function sourceFiles(sourceRoots) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.build', '.tsbuild'].includes(entry.name)) visit(path);
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  for (const sourceRoot of sourceRoots) visit(join(appRoot, sourceRoot));
  return files.sort();
}

/** Every file (sources and assets such as CSS modules) under the source roots, app-relative. */
function allFiles(sourceRoots) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.build', '.tsbuild', 'public'].includes(entry.name))
          visit(path);
      } else files.push(toPosix(relative(appRoot, path)));
    }
  };
  for (const sourceRoot of sourceRoots) visit(join(appRoot, sourceRoot));
  return files.sort();
}

function resolveRelative(fromFile, specifier) {
  const bare = specifier.replace(/\?.*$/u, '');
  const base = resolve(dirname(fromFile), bare);
  const candidates = [];
  if (/\.js$/u.test(base))
    candidates.push(base.replace(/\.js$/u, '.ts'), base.replace(/\.js$/u, '.tsx'));
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(base + extension);
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function edgeKey(edge) {
  return `${edge.fromFile} -> ${edge.target}`;
}

/** Evaluates collected edges against the allowlist. Pure (used by the tests). */
export function evaluate({ manifest, files, edges, allowlist }) {
  const errors = validateManifest(manifest).map((message) => ({ kind: 'manifest', message }));
  for (const file of files) {
    if (!moduleOf(manifest, file))
      errors.push({ kind: 'unassigned-file', message: `${file} belongs to no module` });
  }
  for (const module of manifest.modules) {
    for (const prefix of module.paths) {
      if (prefix.endsWith('/')) continue; // module folders may be empty until files move in
      if (!files.some((file) => file.startsWith(prefix)))
        errors.push({
          kind: 'stale-manifest-path',
          message: `${module.id}: ${prefix} matches no file`,
        });
    }
  }
  const allowed = new Map();
  for (const group of allowlist.violations ?? []) {
    if (!group.reason)
      errors.push({
        kind: 'allowlist',
        message: `group without reason: ${group.from} -> ${group.to}`,
      });
    for (const entry of group.edges ?? []) {
      if (allowed.has(entry))
        errors.push({ kind: 'allowlist', message: `duplicate entry ${entry}` });
      allowed.set(entry, group);
    }
  }
  const seen = new Set();
  const violations = [];
  for (const edge of edges) {
    const from = moduleOf(manifest, edge.fromFile);
    if (!from) continue;
    let rule;
    let to;
    if (edge.external) {
      rule = externalRuleFor(manifest, from, edge.target, edge.fromFile);
      to = { id: packageName(edge.target) };
    } else {
      to = moduleOf(manifest, edge.target);
      if (!to) {
        errors.push({
          kind: 'unassigned-file',
          message: `${edge.target} (imported by ${edge.fromFile}) belongs to no module`,
        });
        continue;
      }
      rule = ruleFor(manifest, from, to);
    }
    if (!rule) continue;
    const key = edgeKey(edge);
    const violation = { ...edge, rule, fromModule: from.id, toModule: to.id, key };
    violations.push(violation);
    if (allowed.has(key)) seen.add(key);
    else
      errors.push({
        kind: rule,
        message: `${key} (${from.id} -> ${to.id}: ${describeRule(rule)})`,
      });
  }
  for (const key of allowed.keys()) {
    if (!seen.has(key))
      errors.push({
        kind: 'stale-allowlist',
        message: `${key} no longer violates a rule: remove it from the allowlist`,
      });
  }
  return { errors, violations };
}

function describeRule(rule) {
  return {
    upward: 'imports a higher layer',
    'cross-domain':
      'domain modules never import each other; use a registration or move the shared part down',
    'layer-order': 'imports a module listed after it in the same layer',
    'external-owner': 'this package is reserved to another module',
    'external-layer': 'this package is forbidden in this layer',
  }[rule];
}

function collect(manifest) {
  const sourceRoots = sourceRootsOf(manifest);
  const files = allFiles(sourceRoots);
  const edges = [];
  for (const path of sourceFiles(sourceRoots)) {
    const fromFile = toPosix(relative(appRoot, path));
    for (const specifier of importSpecifiers(path)) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(path, specifier);
        if (!target) continue; // tsc reports unresolved imports
        const targetFile = toPosix(relative(appRoot, target));
        // Outside the source roots (types/, packages); the web product's files are inside.
        if (targetFile.startsWith('..') && !moduleOf(manifest, targetFile)) continue;
        edges.push({ fromFile, target: targetFile, external: false });
      } else if (!specifier.startsWith('node:')) {
        edges.push({ fromFile, target: specifier, external: true });
      }
    }
  }
  const unique = new Map(edges.map((edge) => [edgeKey(edge), edge]));
  return { files, edges: [...unique.values()], manifest };
}

const DEFAULT_REASONS = {
  upward:
    'Known at the start of the ADR 0032 restructure (phase A): move the shared part down or invert the dependency through a registration (assembler/MODULES.md).',
  'cross-domain':
    'Known at the start of the ADR 0032 restructure (phase A): domain modules talk through foundation contracts and registrations, not directly.',
  'layer-order':
    'Known at the start of the ADR 0032 restructure (phase A): lower foundation/platform/interface modules must not depend on later ones.',
  'external-owner':
    'Known at the start of the ADR 0032 restructure (phase A): reach this library through its owning module.',
  'external-layer':
    'Known at the start of the ADR 0032 restructure (phase A): this layer must stay free of this library.',
};

function writeAllowlist(path, violations, previous) {
  const reasons = new Map(
    (previous.violations ?? []).map((group) => [
      `${group.from}|${group.to}|${group.rule}`,
      group.reason,
    ]),
  );
  const groups = new Map();
  for (const violation of violations) {
    const id = `${violation.fromModule}|${violation.toModule}|${violation.rule}`;
    const group = groups.get(id) ?? {
      from: violation.fromModule,
      to: violation.toModule,
      rule: violation.rule,
      reason: reasons.get(id) ?? DEFAULT_REASONS[violation.rule],
      edges: [],
    };
    group.edges.push(violation.key);
    groups.set(id, group);
  }
  const sorted = [...groups.values()]
    .map((group) => ({ ...group, edges: [...new Set(group.edges)].sort() }))
    .sort((a, b) => `${a.from}|${a.to}|${a.rule}`.localeCompare(`${b.from}|${b.to}|${b.rule}`));
  const document = {
    $comment:
      'Known module-direction violations of HimmelCAD Assembler (scripts/check-assembler-modules.mjs). Phase B of the ADR 0032 restructure drives this list to zero; it may only shrink. Regenerate with --write-allowlist after removing violations, never to admit new ones.',
    version: 1,
    violations: sorted,
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return sorted;
}

function report(violations) {
  const byPair = new Map();
  for (const violation of violations) {
    const id = `${violation.fromModule} -> ${violation.toModule} (${violation.rule})`;
    byPair.set(id, (byPair.get(id) ?? 0) + 1);
  }
  const byModule = new Map();
  for (const violation of violations) {
    byModule.set(violation.fromModule, (byModule.get(violation.fromModule) ?? 0) + 1);
  }
  process.stdout.write('Allowlisted violations by importing module:\n');
  for (const [module, count] of [...byModule].sort((a, b) => b[1] - a[1]))
    process.stdout.write(`  ${module}: ${count}\n`);
  process.stdout.write('By module pair:\n');
  for (const [pair, count] of [...byPair].sort((a, b) => b[1] - a[1]))
    process.stdout.write(`  ${pair}: ${count}\n`);
}

function main() {
  const started = performance.now();
  const manifest = JSON.parse(readFileSync(join(appRoot, 'modules.json'), 'utf8'));
  const allowlistPath = join(appRoot, 'module-allowlist.json');
  const allowlist = existsSync(allowlistPath)
    ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
    : { violations: [] };
  const collected = collect(manifest);
  if (process.argv.includes('--write-allowlist')) {
    const { violations } = evaluate({ ...collected, allowlist: { violations: [] } });
    const groups = writeAllowlist(allowlistPath, violations, allowlist);
    process.stdout.write(`wrote ${violations.length} entries in ${groups.length} groups\n`);
  }
  const current = process.argv.includes('--write-allowlist')
    ? JSON.parse(readFileSync(allowlistPath, 'utf8'))
    : allowlist;
  const { errors, violations } = evaluate({ ...collected, allowlist: current });
  if (process.argv.includes('--report')) report(violations);
  if (errors.length > 0) {
    for (const error of errors)
      process.stderr.write(`assembler module error [${error.kind}]: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  process.stdout.write(
    `assembler modules: ok (${manifest.modules.length} modules, ${collected.files.length} files, ${collected.edges.length} imports, ${violations.length} allowlisted violations, ${elapsed}s)\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
