import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function packageDirectories(root) {
  const directories = [];
  for (const parent of ['apps', 'packages/@himmelcad']) {
    const absoluteParent = join(root, parent);
    if (!existsSync(absoluteParent)) continue;
    for (const entry of readdirSync(absoluteParent, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(parent, entry.name));
    }
  }
  if (existsSync(join(root, 'vendor/three-loader/package.json')))
    directories.push('vendor/three-loader');
  return directories;
}

export function loadNodeWorkspace(root) {
  const packages = new Map();
  for (const directory of packageDirectories(root)) {
    const manifestPath = join(root, directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest.name) continue;
    packages.set(manifest.name, { directory, manifest });
  }
  return packages;
}

export function packageForPath(packages, path) {
  return [...packages.entries()]
    .filter(([, value]) => path === value.directory || path.startsWith(`${value.directory}/`))
    .sort((a, b) => b[1].directory.length - a[1].directory.length)[0]?.[0];
}

export function reverseNodeClosure(packages, initialNames) {
  const selected = new Set(initialNames);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, { manifest }] of packages) {
      const dependencies = {
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
        ...(manifest.peerDependencies ?? {}),
      };
      if (
        !selected.has(name) &&
        Object.keys(dependencies).some((dependency) => selected.has(dependency))
      ) {
        selected.add(name);
        changed = true;
      }
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}

export function rustPackageForPath(root, path) {
  const match = /^(crates\/[^/]+)(?:\/|$)/.exec(path);
  if (!match) return undefined;
  const manifestPath = join(root, match[1], 'Cargo.toml');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = readFileSync(manifestPath, 'utf8');
  return /^name\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
}
