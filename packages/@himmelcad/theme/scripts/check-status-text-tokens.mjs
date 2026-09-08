import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDir = resolve(packageDir, '../../..');
const cssRoots = [
  'packages/@himmelcad/ui',
  'packages/@himmelcad/console',
  'packages/@himmelcad/app',
  'apps/builder',
];
const plainStatusToken = /var\(--hc-(?:info|success|warning|error)\)/;
const colorDeclaration = /(?:^|[;{])\s*color\s*:\s*([^;}]+)/gm;
const findings = [];

for (const root of cssRoots) {
  for (const file of await cssModules(resolve(workspaceDir, root))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(colorDeclaration)) {
      if (!plainStatusToken.test(match[1])) continue;
      const declarationOffset = match.index + match[0].indexOf('color');
      const line = source.slice(0, declarationOffset).split('\n').length;
      findings.push(`${relative(workspaceDir, file)}:${line}: color: ${match[1].trim()}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Plain status tokens cannot be used for text color; use the matching *-fg token:\n${findings
      .map((finding) => `- ${finding}`)
      .join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('Shared CSS modules use foreground status tokens for text color.\n');
}

async function cssModules(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.build') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await cssModules(path)));
    else if (entry.isFile() && entry.name.endsWith('.module.css')) files.push(path);
  }
  return files;
}
