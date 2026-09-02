#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import {
  USAGE,
  buildEvidenceLedger,
  formatMachine,
  parseCliArguments,
  parseCpuInfo,
  parseMemInfo,
  parseOsRelease,
} from './lib/photolab-evidence.mjs';

const workspaceRoot = resolve(import.meta.dirname, '..');

function main(argv) {
  const options = parseCliArguments(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.out == null) throw new Error('--out is required');

  const machine = readMachine();
  const candidateRev = options.candidate ?? 'absent';
  const { markdown } = buildEvidenceLedger({
    candidateRev,
    machine,
    e2eResults: loadE2eResults(options.e2e),
    a11yReports: loadJsonDocuments(options.a11y, 'a11y-report.json'),
    a11ySummaries: loadTextDocuments(options.a11y, 'a11y-summary.md'),
    baselineManifests: loadJsonDocuments(options.baselines, 'manifest.json'),
    visualReports: loadJsonDocuments(options.a11y, 'report.json'),
    cargoLogs: loadLogs(options.cargoLog),
    nodeLogs: loadLogs(options.nodeLog),
  });

  const outPath = resolve(options.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  process.stdout.write(`Wrote ${displayPath(outPath)}\n`);
  return 0;
}

function loadE2eResults(dirs) {
  const results = [];
  for (const dir of dirs) {
    const path = resolveResultJson(dir);
    if (path == null) continue;
    results.push({ sourcePath: displayPath(path), document: readJson(path) });
  }
  return results;
}

function loadJsonDocuments(root, fileName) {
  if (root == null) return [];
  const path = resolveNamedFile(root, fileName);
  if (!existsSync(path)) return [];
  return [{ sourcePath: displayPath(path), document: readJson(path) }];
}

function loadTextDocuments(root, fileName) {
  if (root == null) return [];
  const path = resolveNamedFile(root, fileName);
  if (!existsSync(path)) return [];
  return [{ sourcePath: displayPath(path), text: readFileSync(path, 'utf8') }];
}

function loadLogs(paths) {
  const logs = [];
  for (const path of paths) {
    const resolved = resolve(path);
    if (!existsSync(resolved)) {
      throw new Error(`log file is missing: ${path}`);
    }
    logs.push({ sourcePath: displayPath(resolved), text: readFileSync(resolved, 'utf8') });
  }
  return logs;
}

function resolveResultJson(dirOrFile) {
  const resolved = resolve(dirOrFile);
  if (existsSync(resolved) && basename(resolved) === 'result.json') return resolved;
  const nested = join(resolved, 'result.json');
  return existsSync(nested) ? nested : null;
}

function resolveNamedFile(root, fileName) {
  const resolved = resolve(root);
  if (existsSync(resolved) && basename(resolved) === fileName) return resolved;
  return join(resolved, fileName);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse ${displayPath(path)}: ${error.message}`);
  }
}

function displayPath(path) {
  const rel = relative(workspaceRoot, path);
  if (rel.startsWith('..') || rel === '') return path.split(sep).join('/');
  return rel.split(sep).join('/');
}

function readMachine() {
  const osRelease = parseOsRelease(readOptional('/etc/os-release'));
  const cpu = parseCpuInfo(readOptional('/proc/cpuinfo'));
  const ramKib = parseMemInfo(readOptional('/proc/meminfo'));
  return formatMachine({
    os: osRelease.PRETTY_NAME ?? osRelease.NAME ?? 'absent',
    cpuModel: cpu.cpuModel,
    coreCount: cpu.coreCount,
    ramKib,
  });
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
