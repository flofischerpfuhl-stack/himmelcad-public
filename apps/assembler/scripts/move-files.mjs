#!/usr/bin/env node
/**
 * Moves Assembler source files between module folders without breaking a
 * single import (assembler/MODULES.md §5). Never move module files by hand.
 *
 *   node apps/assembler/scripts/move-files.mjs <map.json> [--dry-run]
 *
 * `map.json` maps app-relative old paths to new paths; an entry ending in `/`
 * moves a whole folder. The script
 *
 * 1. rewrites every relative specifier that resolves to a moved file (or is
 *    written in a moved file): `import`/`export … from`, `import()`,
 *    `require()`, `import('…')` types, `declare module '…'` augmentations and
 *    `new URL('…', import.meta.url)` worker URLs — in `renderer/src`,
 *    `headless`, `electron`, `test`, `scripts` and `vite.config.ts`;
 * 2. `git mv`s the files;
 * 3. replaces the old paths in `module-allowlist.json`, `modules.json`
 *    file entries, `package.json` and the tsconfig files.
 *
 * Extension style is kept: `./a.js` for a TypeScript file stays a `.js`
 * specifier, `./x.worker.ts` stays `.ts`, `?url`-style queries are kept.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['renderer/src', 'headless', 'electron', 'test', 'scripts'];
const SCAN_FILES = ['vite.config.ts'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const TEXT_FILES = [
  'module-allowlist.json',
  'modules.json',
  'package.json',
  'tsconfig.json',
  'tsconfig.test.json',
  'tsconfig.headless.json',
  'tsconfig.electron.json',
  'tsconfig.typecheck-electron.json',
  'electron-builder.win.yml',
];

const toPosix = (p) => p.split(sep).join('/');
const abs = (rel) => join(appRoot, rel);
const rel = (path) => toPosix(relative(appRoot, path));

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.build', '.tsbuild', 'release'].includes(entry.name))
        listFiles(path, out);
    } else out.push(path);
  }
  return out;
}

/** Expands folder entries into a file-level map (app-relative posix paths). */
function expandMap(map) {
  const files = new Map();
  for (const [from, to] of Object.entries(map)) {
    if (from.endsWith('/')) {
      if (!to.endsWith('/')) throw new Error(`folder entry needs a folder target: ${from}`);
      for (const file of listFiles(abs(from))) {
        const local = rel(file).slice(from.length);
        files.set(rel(file), to + local);
      }
    } else {
      if (!existsSync(abs(from))) throw new Error(`no such file: ${from}`);
      files.set(from, to);
    }
  }
  for (const [from, to] of files) {
    if (existsSync(abs(to)) && !files.has(to))
      throw new Error(`target exists: ${to} (from ${from})`);
  }
  return files;
}

function resolveSpecifier(fromFile, specifier) {
  const bare = specifier.replace(/[?#].*$/u, '');
  const base = resolve(dirname(fromFile), bare);
  const candidates = [base];
  if (/\.js$/u.test(base))
    candidates.unshift(base.replace(/\.js$/u, '.ts'), base.replace(/\.js$/u, '.tsx'));
  candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, 'index.ts'));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** String-literal specifier nodes of one file: [{start, end, text}] (start/end exclude quotes). */
function specifierLiterals(path, source) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) {
      found.push({ start: node.getStart(sf) + 1, end: node.end - 1, text: node.text });
    }
  };
  const isImportMetaUrl = (node) =>
    node &&
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) add(node.name);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
        add(node.arguments[0]);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.length === 2 &&
      isImportMetaUrl(node.arguments[1])
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function newSpecifier(original, newFromFile, newTargetFile) {
  const query = /[?#].*$/u.exec(original)?.[0] ?? '';
  const bare = original.slice(0, original.length - query.length);
  let target = newTargetFile;
  const ext = extname(newTargetFile);
  if (/\.js$/u.test(bare) && (ext === '.ts' || ext === '.tsx')) {
    target = newTargetFile.slice(0, -ext.length) + '.js';
  } else if (!extname(bare) && (ext === '.ts' || ext === '.tsx')) {
    target = newTargetFile.slice(0, -ext.length);
  }
  let spec = toPosix(relative(dirname(newFromFile), target));
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec + query;
}

function main() {
  const [mapPath, ...flags] = process.argv.slice(2);
  if (!mapPath) throw new Error('usage: move-files.mjs <map.json> [--dry-run]');
  const dryRun = flags.includes('--dry-run');
  const moves = expandMap(JSON.parse(readFileSync(resolve(mapPath), 'utf8')));
  const movedAbs = new Map([...moves].map(([from, to]) => [abs(from), abs(to)]));
  const scan = [
    ...SCAN_ROOTS.flatMap((root) => listFiles(abs(root))),
    ...SCAN_FILES.map(abs).filter(existsSync),
  ].filter((file) => CODE_EXTENSIONS.has(extname(file)) || file.endsWith('.d.ts'));

  let rewritten = 0;
  for (const file of scan) {
    const source = readFileSync(file, 'utf8');
    const newFile = movedAbs.get(file) ?? file;
    const edits = [];
    for (const literal of specifierLiterals(file, source)) {
      if (!literal.text.startsWith('./') && !literal.text.startsWith('../')) continue;
      const target = resolveSpecifier(file, literal.text);
      if (!target) continue;
      const newTarget = movedAbs.get(target) ?? target;
      if (newFile === file && newTarget === target) continue;
      const replacement = newSpecifier(literal.text, newFile, newTarget);
      if (replacement !== literal.text) edits.push({ ...literal, replacement });
    }
    if (edits.length === 0) continue;
    let next = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }
    rewritten += edits.length;
    if (dryRun) {
      for (const edit of edits)
        process.stdout.write(`${rel(file)}: ${edit.text} -> ${edit.replacement}\n`);
    } else writeFileSync(file, next);
  }

  // Plain-text references (allowlist, manifest file entries, scripts, tsconfigs): longest paths first.
  const pairs = [...moves].sort((a, b) => b[0].length - a[0].length);
  for (const name of TEXT_FILES) {
    const path = abs(name);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    let next = source;
    for (const [from, to] of pairs) {
      next = next
        .replaceAll(`"${from}"`, `"${to}"`)
        .replaceAll(`${from} ->`, `${to} ->`)
        .replaceAll(`-> ${from}"`, `-> ${to}"`);
      // tsconfig/package.json style bare paths (e.g. "electron/slicerPaths.ts" inside a list).
    }
    if (next !== source && !dryRun) writeFileSync(path, next);
  }

  if (!dryRun) {
    for (const [from, to] of moves) {
      mkdirSync(dirname(abs(to)), { recursive: true });
      execFileSync('git', ['mv', from, to], { cwd: appRoot, stdio: 'inherit' });
    }
  }
  process.stdout.write(
    `${dryRun ? 'would move' : 'moved'} ${moves.size} files, rewrote ${rewritten} specifiers\n`,
  );
}

main();
