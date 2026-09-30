#!/usr/bin/env node
/**
 * Retargets named imports after declarations moved to another file
 * (assembler/MODULES.md §5): every `import { A, type B } from '<old>'` and
 * `export { A } from '<old>'` in the app, its tests and scripts that names
 * one of the symbols is split so those symbols come from `<new>` (merged
 * into an existing import of `<new>` when there is one). Move the
 * declarations themselves first; this only fixes the importers.
 *
 *   node apps/assembler/scripts/move-exports.mjs <old-file> <new-file> A,B,C [--dry-run]
 *
 * Paths are app-relative. Default and namespace imports are left alone.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['renderer/src', 'headless', 'electron', 'test', 'scripts'];
const toPosix = (p) => p.split(sep).join('/');

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.build', '.tsbuild'].includes(entry.name))
        listFiles(path, out);
    } else if (['.ts', '.tsx', '.mts', '.mjs'].includes(extname(entry.name))) out.push(path);
  }
  return out;
}

function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier.replace(/[?#].*$/u, ''));
  const candidates = /\.js$/u.test(base)
    ? [base.replace(/\.js$/u, '.ts'), base.replace(/\.js$/u, '.tsx'), base]
    : [base, `${base}.ts`, `${base}.tsx`];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function specifierFor(fromFile, target) {
  const ext = extname(target);
  const js = ext === '.ts' || ext === '.tsx' ? target.slice(0, -ext.length) + '.js' : target;
  let spec = toPosix(relative(dirname(fromFile), js));
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}

function render(kind, typeOnly, names, spec) {
  const list = names.map((n) => (n.type && !typeOnly ? `type ${n.text}` : n.text)).join(', ');
  return `${kind}${typeOnly ? ' type' : ''} { ${list} } from '${spec}';`;
}

function main() {
  const [oldRel, newRel, symbolList, ...flags] = process.argv.slice(2);
  if (!oldRel || !newRel || !symbolList) {
    throw new Error('usage: move-exports.mjs <old-file> <new-file> A,B,C [--dry-run]');
  }
  const dryRun = flags.includes('--dry-run');
  const oldFile = resolve(appRoot, oldRel);
  const newFile = resolve(appRoot, newRel);
  const symbols = new Set(
    symbolList
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  let changedFiles = 0;
  for (const file of SCAN_ROOTS.flatMap((root) => listFiles(join(appRoot, root)))) {
    if (file === newFile) continue;
    const source = readFileSync(file, 'utf8');
    const kindTs = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kindTs);
    const edits = [];
    const moved = { import: [], export: [] };
    const typeOnlyMoved = { import: true, export: true };
    let existingNew = { import: null, export: null };
    for (const statement of sf.statements) {
      const isImport = ts.isImportDeclaration(statement);
      const isExport = ts.isExportDeclaration(statement);
      if (!isImport && !isExport) continue;
      const spec = statement.moduleSpecifier;
      if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith('.')) continue;
      const target = resolveSpecifier(file, spec.text);
      const kind = isImport ? 'import' : 'export';
      let elements;
      let declTypeOnly;
      if (isImport) {
        const clause = statement.importClause;
        if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.name) {
          if (target === newFile) continue;
          if (
            target === oldFile &&
            clause?.namedBindings &&
            ts.isNamedImports(clause.namedBindings)
          ) {
            // default + named: not supported, report.
            if (
              clause.namedBindings.elements.some((e) =>
                symbols.has((e.propertyName ?? e.name).text),
              )
            )
              throw new Error(`${file}: default+named import of moved symbols is not supported`);
          }
          continue;
        }
        elements = clause.namedBindings.elements;
        declTypeOnly = clause.isTypeOnly;
      } else {
        if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
        elements = statement.exportClause.elements;
        declTypeOnly = statement.isTypeOnly;
      }
      const names = elements.map((e) => ({
        text: e.getText(sf).replace(/^type\s+/u, ''),
        name: (e.propertyName ?? e.name).text,
        type: declTypeOnly || e.isTypeOnly,
      }));
      if (target === newFile) {
        existingNew[kind] = { statement, names, declTypeOnly };
        continue;
      }
      if (target !== oldFile) continue;
      const keep = names.filter((n) => !symbols.has(n.name));
      const take = names.filter((n) => symbols.has(n.name));
      if (take.length === 0) continue;
      moved[kind].push(...take);
      if (!take.every((n) => n.type)) typeOnlyMoved[kind] = false;
      const replacement =
        keep.length === 0
          ? ''
          : render(kind, declTypeOnly && keep.every((n) => n.type), keep, spec.text);
      edits.push({ start: statement.getStart(sf), end: statement.end, text: replacement });
    }
    for (const kind of ['import', 'export']) {
      if (moved[kind].length === 0) continue;
      const spec = specifierFor(file, newFile);
      const existing = existingNew[kind];
      if (existing) {
        const all = [
          ...existing.names,
          ...moved[kind].filter((m) => !existing.names.some((n) => n.name === m.name)),
        ];
        const typeOnly = all.every((n) => n.type);
        edits.push({
          start: existing.statement.getStart(sf),
          end: existing.statement.end,
          text: render(kind, typeOnly, all, existing.statement.moduleSpecifier.text),
        });
      } else {
        // Insert after the first edited statement (keeps the import block together).
        const anchor = edits.find((e) => e.text !== undefined);
        const at = anchor ? anchor.end : 0;
        edits.push({
          start: at,
          end: at,
          text: `\n${render(kind, typeOnlyMoved[kind], moved[kind], spec)}`,
        });
      }
    }
    if (edits.length === 0) continue;
    let next = source;
    for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    }
    next = next.replace(/^\s*\n(?=\n)/gmu, '');
    changedFiles += 1;
    if (dryRun) process.stdout.write(`${toPosix(relative(appRoot, file))}\n`);
    else writeFileSync(file, next);
  }
  process.stdout.write(`${dryRun ? 'would update' : 'updated'} ${changedFiles} files\n`);
}

main();
