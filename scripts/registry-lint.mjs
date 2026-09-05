#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process, { stderr, stdout } from 'node:process';

const FUNCTION_ID_CELL = /^`([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)`/;
const DECISION_ID = /\b([A-Z]{2,4}-D\d+)\b/g;
const BOLD_DECISION_DEFINITION = /^\*\*([A-Z]{2,4}-D\d+)\b/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const SPEC_STATUS_TOKEN = /\b(specified|drafted)\b/i;
const DEFAULT_REGISTRY_PATH = 'docs/builder-program/REGISTRY.md';
const DEFAULT_PROGRAM_DIR = 'docs/builder-program';
const DEFAULT_SPECS_DIR = 'docs/builder-program/specs';

export const CHECK_ORDER = [
  'duplicate-function-ids',
  'function-ids-in-spec-absent-from-registry',
  'function-ids-in-registry-absent-from-spec',
  'consumer-rows-point-to-owner',
  'dangling-decision-ids',
  'spec-status-mismatch',
  'shortcut-key-collisions',
];

export function isSpecLintTarget(relativePath) {
  const base = relativePath.split(/[/\\]/).pop() ?? '';
  if (!base.endsWith('.md')) return false;
  return !/review|criteria/i.test(base);
}

export function specSlugFromPath(relativePath) {
  const base = relativePath.split(/[/\\]/).pop() ?? '';
  return base.replace(/\.md$/i, '');
}

export function parseCliArgs(argv) {
  let json = false;
  let summary = false;
  let fixRegistryStatus = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--fix-registry-status') fixRegistryStatus = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (json && summary) {
    throw new Error('Cannot combine --json and --summary');
  }
  return { json, summary, fixRegistryStatus };
}

export function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

export function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.includes('|', 1);
}

export function isSeparatorRow(line) {
  if (!isTableRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

export function parseMarkdownTables(markdown, firstLineNumber = 1) {
  const lines = markdown.split(/\n/);
  const tables = [];
  let index = 0;
  while (index < lines.length) {
    if (isTableRow(lines[index]) && index + 1 < lines.length && isSeparatorRow(lines[index + 1])) {
      const header = splitTableRow(lines[index]);
      const headerLine = firstLineNumber + index;
      index += 2;
      const rows = [];
      while (index < lines.length && isTableRow(lines[index]) && !isSeparatorRow(lines[index])) {
        rows.push({
          cells: splitTableRow(lines[index]),
          line: firstLineNumber + index,
          text: lines[index],
        });
        index += 1;
      }
      tables.push({ header, headerLine, rows });
      continue;
    }
    index += 1;
  }
  return tables;
}

export function extractFunctionId(cell) {
  const match = String(cell ?? '')
    .trim()
    .match(FUNCTION_ID_CELL);
  if (!match) return null;
  if (match[1].endsWith('.md')) return null;
  return match[1];
}

export function isCatalogTableHeader(header) {
  const first = String(header?.[0] ?? '')
    .replace(/`/g, '')
    .trim();
  return /^(id|function id)\b/i.test(first);
}

export function catalogSpecLink(header, cells) {
  const index = headerIndex(header, /spec\s*link/i);
  if (index !== -1) return String(cells[index] ?? '').trim();
  for (let i = 1; i < cells.length; i += 1) {
    const text = String(cells[i] ?? '').trim();
    if (/^owner:/i.test(text)) return text;
  }
  return '';
}

export function isConsumerSpecLink(specLink) {
  return /^owner:/i.test(String(specLink ?? '').trim());
}

export function parseOwnerMarker(specLink) {
  const match = String(specLink ?? '')
    .trim()
    .match(/^owner:\s*([A-Za-z][A-Za-z0-9_-]*)(?:\.md)?\b/);
  return match ? match[1].toLowerCase() : null;
}

export function parseCatalogRows(markdown, firstLineNumber = 1) {
  const rows = [];
  for (const table of parseMarkdownTables(markdown, firstLineNumber)) {
    if (!isCatalogTableHeader(table.header)) continue;
    for (const row of table.rows) {
      const id = extractFunctionId(row.cells[0]);
      if (!id) continue;
      const specLink = catalogSpecLink(table.header, row.cells);
      const consumer = isConsumerSpecLink(specLink);
      rows.push({
        id,
        line: row.line,
        cell: row.cells[0],
        specLink,
        consumer,
        owner: consumer ? parseOwnerMarker(specLink) : null,
      });
    }
  }
  return rows;
}

export function parseSpecStatusLine(markdown) {
  const lines = markdown.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^Status:\s*(.*)$/);
    if (!match) continue;
    const token = match[1].replace(/\*\*/g, '').match(SPEC_STATUS_TOKEN);
    return {
      status: token ? token[1].toLowerCase() : null,
      line: index + 1,
      raw: match[1],
    };
  }
  return { status: null, line: 1, raw: null };
}

function addUniqueId(ids, seen, id) {
  if (!id || seen.has(id)) return;
  seen.add(id);
  ids.push(id);
}

function headingDefinitionIds(title) {
  const ids = [];
  const seen = new Set();
  DECISION_ID.lastIndex = 0;
  for (const match of title.matchAll(DECISION_ID)) {
    addUniqueId(ids, seen, match[1]);
  }
  return ids;
}

export function parseDecisionDefinitions(markdown) {
  const definitions = [];
  const lines = markdown.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(ATX_HEADING);
    if (heading) {
      for (const id of headingDefinitionIds(heading[2])) {
        definitions.push({ id, line: index + 1 });
      }
      continue;
    }
    const bold = line.match(BOLD_DECISION_DEFINITION);
    if (bold) definitions.push({ id: bold[1], line: index + 1 });
  }
  return definitions;
}

export function parseDecisionCitations(markdown) {
  const citations = [];
  const lines = markdown.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    DECISION_ID.lastIndex = 0;
    let match = DECISION_ID.exec(lines[index]);
    while (match) {
      citations.push({ id: match[1], line: index + 1 });
      match = DECISION_ID.exec(lines[index]);
    }
  }
  return citations;
}

export function extractHeadingSection(markdown, test) {
  const lines = markdown.split(/\n/);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+(.*)$/);
    if (!heading) continue;
    if (start === -1 && test(heading[2], heading[1].length)) {
      start = index;
      level = heading[1].length;
      continue;
    }
    if (start !== -1 && heading[1].length <= level) {
      return {
        startLine: start + 1,
        endLine: index,
        text: lines.slice(start, index).join('\n'),
      };
    }
  }
  if (start === -1) return null;
  return {
    startLine: start + 1,
    endLine: lines.length,
    text: lines.slice(start).join('\n'),
  };
}

export function parseRegistryRows(registryMarkdown) {
  const section = extractHeadingSection(
    registryMarkdown,
    (title, level) => level === 2 && /^1\.\s+Registry rows\b/.test(title),
  );
  if (!section) return [];
  return parseCatalogRows(section.text, section.startLine).map((row) => ({
    ...row,
    file: DEFAULT_REGISTRY_PATH,
  }));
}

export function parseRegistryStatusTable(registryMarkdown) {
  const section = extractHeadingSection(
    registryMarkdown,
    (title, level) => level === 3 && /^4\.5\b/.test(title),
  );
  const listed = new Map();
  if (!section) return listed;
  for (const table of parseMarkdownTables(section.text, section.startLine)) {
    for (const row of table.rows) {
      const status = String(row.cells[0] ?? '')
        .replace(/`/g, '')
        .trim()
        .toLowerCase();
      if (status !== 'specified' && status !== 'drafted') continue;
      const specsCell = String(row.cells[1] ?? '').trim();
      const slugs = [...specsCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      if (slugs.length === 0 && /^none$/i.test(specsCell.replace(/`/g, '').trim())) continue;
      for (const slug of slugs) {
        listed.set(slug, { status, line: row.line });
      }
    }
  }
  return listed;
}

function headerIndex(header, pattern) {
  return header.findIndex((cell) => pattern.test(cell));
}

function normalizeOwner(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitShortcutKeys(cell) {
  const text = String(cell ?? '')
    .replace(/\*\*/g, '')
    .trim();
  if (!text || text === '—') return [];
  return text
    .split(/\s+\/\s+/)
    .map((key) => key.replaceAll('↑', 'Up').replaceAll('↓', 'Down').replace(/\s+/g, ' ').trim())
    .filter((key) => key && key !== '—');
}

function hasScopedMarker(text) {
  return /scoped/i.test(text);
}

function isUnclaimedShortcut(cells) {
  return cells.some((cell) => cell === '—') && /unclaimed/i.test(cells.join(' '));
}

export function parseShortcutClaims(registryMarkdown) {
  const section = extractHeadingSection(
    registryMarkdown,
    (title, level) => level === 2 && /^2\.\s+Shortcut map\b/.test(title),
  );
  if (!section) return [];
  const lines = section.text.split(/\n/);
  const claims = [];
  let currentHeading = lines[0] ?? '';
  let index = 0;
  while (index < lines.length) {
    const heading = lines[index].match(/^(#{1,6})\s+(.*)$/);
    if (heading) currentHeading = heading[2];
    if (isTableRow(lines[index]) && index + 1 < lines.length && isSeparatorRow(lines[index + 1])) {
      const tableMarkdown = lines.slice(index).join('\n');
      const [table] = parseMarkdownTables(tableMarkdown, section.startLine + index);
      index += 2 + table.rows.length;
      const keyIndex = headerIndex(table.header, /^key$/i);
      if (keyIndex !== 0) continue;
      const functionIndex = headerIndex(table.header, /^function$/i);
      const scopeIndex = headerIndex(table.header, /^scope$/i);
      const sourceIndex = headerIndex(table.header, /^source$/i);
      const ownerIndex =
        functionIndex !== -1 ? functionIndex : scopeIndex !== -1 ? scopeIndex : sourceIndex;
      const sectionScoped = hasScopedMarker(currentHeading);
      for (const row of table.rows) {
        if (isUnclaimedShortcut(row.cells)) continue;
        const ownerCell = ownerIndex === -1 ? row.cells[1] : row.cells[ownerIndex];
        const owner = normalizeOwner(ownerCell);
        if (!owner || owner === '—') continue;
        const scoped = sectionScoped || hasScopedMarker(`${row.text}\n${row.cells.join(' ')}`);
        for (const key of splitShortcutKeys(row.cells[0])) {
          claims.push({
            key,
            keyNormalized: key.toLowerCase(),
            owner,
            scoped,
            line: row.line,
            heading: currentHeading,
          });
        }
      }
      continue;
    }
    index += 1;
  }
  return claims;
}

function emptyFindings() {
  return Object.fromEntries(CHECK_ORDER.map((name) => [name, []]));
}

function pushFinding(findings, check, finding) {
  findings[check].push({
    file: finding.file,
    line: finding.line,
    message: finding.message,
    ...(finding.id ? { id: finding.id } : {}),
  });
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    if (left.file !== right.file) return left.file < right.file ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    if (left.message !== right.message) return left.message < right.message ? -1 : 1;
    return 0;
  });
}

function formatLocation(file, line) {
  return `${file}:${line}`;
}

function uniqueLocations(rows, exceptFile) {
  const seen = new Set();
  const locations = [];
  for (const row of rows) {
    if (row.file === exceptFile) continue;
    const key = formatLocation(row.file, row.line);
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(key);
  }
  return locations;
}

function addDecisionDefinitions(definitions, markdown, file) {
  for (const definition of parseDecisionDefinitions(markdown)) {
    if (!definitions.has(definition.id)) {
      definitions.set(definition.id, { file, line: definition.line });
    }
  }
}

export function lintCorpus({
  specs,
  registry,
  registryPath = DEFAULT_REGISTRY_PATH,
  programDocs = [],
}) {
  const findings = emptyFindings();
  const specRows = [];
  const definitions = new Map();
  const citations = [];
  const specStatuses = [];

  for (const spec of specs) {
    for (const row of parseCatalogRows(spec.content)) {
      specRows.push({ ...row, file: spec.path });
    }
    specStatuses.push({
      ...parseSpecStatusLine(spec.content),
      file: spec.path,
      slug: specSlugFromPath(spec.path),
    });
    addDecisionDefinitions(definitions, spec.content, spec.path);
    for (const citation of parseDecisionCitations(spec.content)) {
      citations.push({ ...citation, file: spec.path });
    }
  }

  for (const doc of programDocs) {
    addDecisionDefinitions(definitions, doc.content, doc.path);
  }
  addDecisionDefinitions(definitions, registry, registryPath);

  for (const citation of parseDecisionCitations(registry)) {
    citations.push({ ...citation, file: registryPath });
  }

  const registryRows = parseRegistryRows(registry);
  const registryIds = new Set(registryRows.map((row) => row.id));
  const definitionRows = specRows.filter((row) => !row.consumer);
  const consumerRows = specRows.filter((row) => row.consumer);
  const specIds = new Set(definitionRows.map((row) => row.id));
  const registryStatus = parseRegistryStatusTable(registry);
  const shortcutClaims = parseShortcutClaims(registry);
  const specSlugs = new Set(specStatuses.map((spec) => spec.slug));
  const definitionIdsBySlug = new Map();
  for (const row of definitionRows) {
    const slug = specSlugFromPath(row.file);
    const ids = definitionIdsBySlug.get(slug) ?? new Set();
    ids.add(row.id);
    definitionIdsBySlug.set(slug, ids);
  }

  const rowsById = new Map();
  for (const row of definitionRows) {
    const list = rowsById.get(row.id) ?? [];
    list.push(row);
    rowsById.set(row.id, list);
  }
  for (const [id, rows] of rowsById) {
    const files = new Set(rows.map((row) => row.file));
    if (files.size < 2) continue;
    for (const row of rows) {
      const others = uniqueLocations(rows, row.file);
      pushFinding(findings, 'duplicate-function-ids', {
        file: row.file,
        line: row.line,
        id,
        message: `\`${id}\` is cataloged in more than one spec (also ${others.join(', ')})`,
      });
    }
  }

  for (const row of definitionRows) {
    if (registryIds.has(row.id)) continue;
    pushFinding(findings, 'function-ids-in-spec-absent-from-registry', {
      file: row.file,
      line: row.line,
      id: row.id,
      message: `\`${row.id}\` is in the spec catalog but absent from REGISTRY.md §1`,
    });
  }

  for (const row of registryRows) {
    if (specIds.has(row.id)) continue;
    pushFinding(findings, 'function-ids-in-registry-absent-from-spec', {
      file: registryPath,
      line: row.line,
      id: row.id,
      message: `\`${row.id}\` is in REGISTRY.md §1 but absent from every spec catalog`,
    });
  }

  for (const row of consumerRows) {
    if (!row.owner) {
      pushFinding(findings, 'consumer-rows-point-to-owner', {
        file: row.file,
        line: row.line,
        id: row.id,
        message: `\`${row.id}\` consumer row has no owner spec name`,
      });
      continue;
    }
    if (!specSlugs.has(row.owner)) {
      pushFinding(findings, 'consumer-rows-point-to-owner', {
        file: row.file,
        line: row.line,
        id: row.id,
        message: `\`${row.id}\` consumer row names owner \`${row.owner}\`, which is not a spec in the corpus`,
      });
      continue;
    }
    if (definitionIdsBySlug.get(row.owner)?.has(row.id)) continue;
    pushFinding(findings, 'consumer-rows-point-to-owner', {
      file: row.file,
      line: row.line,
      id: row.id,
      message: `\`${row.id}\` consumer row names owner \`${row.owner}\`, which does not catalog this id`,
    });
  }

  for (const citation of citations) {
    if (definitions.has(citation.id)) continue;
    pushFinding(findings, 'dangling-decision-ids', {
      file: citation.file,
      line: citation.line,
      id: citation.id,
      message: `${citation.id} is cited but defined nowhere as a decision heading`,
    });
  }

  for (const spec of specStatuses) {
    const listed = registryStatus.get(spec.slug);
    if (!spec.status) {
      pushFinding(findings, 'spec-status-mismatch', {
        file: spec.file,
        line: spec.line,
        id: spec.slug,
        message: `spec has no specified/drafted status line; REGISTRY.md §4.5 ${
          listed ? `lists it as ${listed.status}` : 'does not list this spec'
        }`,
      });
      continue;
    }
    if (!listed) {
      pushFinding(findings, 'spec-status-mismatch', {
        file: spec.file,
        line: spec.line,
        id: spec.slug,
        message: `spec status is ${spec.status}; REGISTRY.md §4.5 does not list this spec`,
      });
      continue;
    }
    if (listed.status !== spec.status) {
      pushFinding(findings, 'spec-status-mismatch', {
        file: spec.file,
        line: spec.line,
        id: spec.slug,
        message: `spec status is ${spec.status}; REGISTRY.md §4.5 lists it as ${listed.status}`,
      });
    }
  }

  const claimsByKey = new Map();
  for (const claim of shortcutClaims) {
    const list = claimsByKey.get(claim.keyNormalized) ?? [];
    list.push(claim);
    claimsByKey.set(claim.keyNormalized, list);
  }
  for (const claims of claimsByKey.values()) {
    const owners = new Set(claims.map((claim) => claim.owner));
    if (owners.size < 2) continue;
    if (claims.some((claim) => claim.scoped)) continue;
    for (const claim of claims) {
      const others = [...owners].filter((owner) => owner !== claim.owner);
      pushFinding(findings, 'shortcut-key-collisions', {
        file: registryPath,
        line: claim.line,
        id: claim.key,
        message: `${claim.key} is claimed by ${claim.owner} and also by ${others.join('; ')} with no scoped marker`,
      });
    }
  }

  const checks = CHECK_ORDER.map((name) => {
    const checkFindings = sortFindings(findings[name]);
    return {
      name,
      status: checkFindings.length === 0 ? 'PASS' : 'FAIL',
      findings: checkFindings,
    };
  });
  return {
    ok: checks.every((check) => check.status === 'PASS'),
    checks,
  };
}

export function formatTextReport(report) {
  const lines = [];
  for (const check of report.checks) {
    lines.push(`${check.status} ${check.name} (${check.findings.length})`);
    for (const finding of check.findings) {
      lines.push(`${finding.file}:${finding.line}: ${finding.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatSummaryReport(report) {
  return `${report.checks
    .map((check) => `${check.status} ${check.name} ${check.findings.length}`)
    .join('\n')}\n`;
}

export function isProgramMarkdownPath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return (
    parts.length === 3 &&
    `${parts[0]}/${parts[1]}` === DEFAULT_PROGRAM_DIR &&
    parts[2].endsWith('.md')
  );
}

export function listSpecFiles(root) {
  const specsRoot = join(root, DEFAULT_SPECS_DIR);
  const files = [];
  for (const domain of readdirSync(specsRoot, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    for (const entry of readdirSync(join(specsRoot, domain.name), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relativePath = `${DEFAULT_SPECS_DIR}/${domain.name}/${entry.name}`;
      if (!isSpecLintTarget(relativePath)) continue;
      files.push(relativePath);
    }
  }
  return files.sort();
}

export function listProgramMarkdownFiles(root) {
  const programRoot = join(root, DEFAULT_PROGRAM_DIR);
  const files = [];
  for (const entry of readdirSync(programRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relativePath = `${DEFAULT_PROGRAM_DIR}/${entry.name}`;
    if (!isProgramMarkdownPath(relativePath)) continue;
    files.push(relativePath);
  }
  return files.sort();
}

export function lintWorkspace(root) {
  const specs = listSpecFiles(root).map((path) => ({
    path,
    content: readFileSync(join(root, path), 'utf8'),
  }));
  const registry = readFileSync(join(root, DEFAULT_REGISTRY_PATH), 'utf8');
  const programDocs = listProgramMarkdownFiles(root)
    .filter((path) => path !== DEFAULT_REGISTRY_PATH)
    .map((path) => ({
      path,
      content: readFileSync(join(root, path), 'utf8'),
    }));
  return lintCorpus({ specs, registry, registryPath: DEFAULT_REGISTRY_PATH, programDocs });
}

export function main(argv = process.argv.slice(2), options = {}) {
  const out = options.stdout ?? stdout;
  const err = options.stderr ?? stderr;
  const root = options.root ?? resolve(import.meta.dirname, '..');
  try {
    const args = parseCliArgs(argv);
    if (args.fixRegistryStatus) {
      err.write('--fix-registry-status is not implemented; this tool is read-only\n');
      return 2;
    }
    const report = lintWorkspace(root);
    if (args.json) out.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (args.summary) out.write(formatSummaryReport(report));
    else out.write(formatTextReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    err.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function isDirectRun(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = main();
}
