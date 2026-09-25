#!/usr/bin/env node
// Fails when an installed npm package is not under a license that may be
// combined with this BUSL-1.1 project (see LICENSE and LICENSING.md).
//
// Usage:
//   node scripts/check-licenses.mjs --dir vendor/build/node_modules [--dir ...]
//   node scripts/check-licenses.mjs --pnpm          (pnpm workspaces, --prod tree)
//
// A package passes when at least one alternative of its SPDX expression
// ("A OR B") consists only of allowed licenses ("A AND B").

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'Zlib',
  'CC0-1.0',
  'Unlicense',
  'BSL-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC-BY-4.0',
  'OFL-1.1',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'WTFPL',
  // File-level copyleft: fine as long as the package's own files stay
  // unmodified or modified files stay under the same license.
  'MPL-2.0',
  'EPL-2.0',
  // This project's own license.
  'BUSL-1.1',
]);

// Packages whose package.json lacks or misstates the license. Each entry
// must be checked against the upstream LICENSE file.
const OVERRIDES = {
  khroma: 'MIT', // https://github.com/fabiospampinato/khroma/blob/master/license
};

function alternatives(expression) {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+/i)
    .map((alt) =>
      alt
        .split(/\s+AND\s+/i)
        .map((part) => part.trim())
        .filter(Boolean),
    );
}

function isAllowed(expression) {
  if (!expression) return false;
  return alternatives(expression).some(
    (parts) => parts.length > 0 && parts.every((p) => ALLOWED.has(p)),
  );
}

function licenseOf(pkg) {
  if (OVERRIDES[pkg.name]) return OVERRIDES[pkg.name];
  const raw = pkg.license ?? pkg.licenses;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((l) => l.type ?? l).join(' OR ');
  if (raw && typeof raw === 'object') return raw.type ?? '';
  return '';
}

function* walkNodeModules(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) yield* readPackage(join(path, scoped.name));
      }
    } else {
      yield* readPackage(path);
    }
  }
}

function* readPackage(path) {
  const manifest = join(path, 'package.json');
  if (existsSync(manifest)) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.name) yield { name: pkg.name, version: pkg.version, license: licenseOf(pkg), path };
  }
  yield* walkNodeModules(join(path, 'node_modules'));
}

function* pnpmPackages() {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const [license, pkgs] of Object.entries(JSON.parse(out))) {
    for (const pkg of pkgs) {
      yield {
        name: pkg.name,
        version: (pkg.versions ?? []).join(', '),
        license: OVERRIDES[pkg.name] ?? (license === 'Unknown' ? '' : license),
        path: pkg.paths?.[0] ?? '',
      };
    }
  }
}

const args = process.argv.slice(2);
const packages = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pnpm') packages.push(...pnpmPackages());
  else if (args[i] === '--dir') packages.push(...walkNodeModules(args[++i]));
  else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(2);
  }
}
if (packages.length === 0) {
  console.error('No packages found. Pass --pnpm or --dir <node_modules>.');
  process.exit(2);
}

const seen = new Set();
const violations = [];
for (const pkg of packages) {
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!isAllowed(pkg.license)) violations.push(pkg);
}

if (violations.length) {
  console.error(`License check failed for ${violations.length} package(s):`);
  for (const v of violations)
    console.error(`  ${v.name}@${v.version}: ${v.license || '(no license field)'}  ${v.path}`);
  console.error(
    'Replace the dependency, or verify the upstream LICENSE and add an OVERRIDES entry.',
  );
  process.exit(1);
}
console.log(`License check passed for ${seen.size} package(s).`);
