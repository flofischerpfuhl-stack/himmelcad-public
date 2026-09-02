/**
 * Pure helpers for the PhotoLab R1 evidence ledger. The CLI reads artifacts;
 * this module never talks to the filesystem, clock, or git.
 */

export const USAGE = `PhotoLab R1 evidence ledger

Usage:
  node scripts/photolab-evidence-ledger.mjs --out docs/photolab-release-evidence-<YYYY-MM-DD>.md [options]

Options:
  --out <file>             Output Markdown path (required)
  --candidate <git-rev>    Release-candidate revision recorded in the ledger
  --e2e <dir>...           E2E output directories containing result.json
  --a11y <dir>             Directory containing a11y-report.json / a11y-summary.md
  --baselines <dir>        Directory containing visual-baselines manifest.json
  --cargo-log <file>...    Cargo test logs
  --node-log <file>...     Node test logs
  -h, --help               Show this help

The ledger only reads existing artifacts. It does not run tests, e2e, or
builds, and it does not certify that an R1 gate is proven closed.`;

/** Eight R1 gates, names copied from docs/ROADMAP.md lines 12-20. */
export const R1_GATES = Object.freeze([
  {
    id: 'r1-1',
    name: 'complete workflows from import through published products',
  },
  {
    id: 'r1-2',
    name: 'real-dataset accuracy and quality evidence',
  },
  {
    id: 'r1-3',
    name: 'deterministic lineage, reports, project recovery, and resume',
  },
  {
    id: 'r1-4',
    name: 'bounded cancellation across every expensive stage',
  },
  {
    id: 'r1-5',
    name: 'audited offline runtimes and license inventories',
  },
  {
    id: 'r1-6',
    name: 'installable packages and update behavior on supported platforms',
  },
  {
    id: 'r1-7',
    name: 'English UI, shared design-system conformance, accessibility, and visual tests',
  },
  {
    id: 'r1-8',
    name: 'PhotoLab outputs open through canonical contracts in Builder and WeltView',
  },
]);

const GOLDEN_E2E = [
  'node scripts/photolab-e2e.mjs \\',
  '  --golden-agisoft \\',
  '  --output .build/photolab-e2e/agisoft-quality-hybrid-golden \\',
  '  --horizontal-grid photolab/01_Transformation/Projektionsgitter/Bayern/kanu_ntv2_schwaben.gsb \\',
  "  --vertical-grid 'photolab/01_Transformation/Geoide/DHHN 2016/GCG2016_SU.tif'",
].join('\n');

const GOLDEN_CANDIDATE = [
  'pnpm photolab:golden:agisoft -- --candidate .build/photolab-e2e/agisoft-quality-hybrid-golden/result.json',
  'pnpm photolab:test:golden:agisoft',
].join('\n');

const CANCEL_COMMON = [
  "SOURCE='photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel/01_Photos'",
  'COMMON=(--source "$SOURCE" --max-images 24 --smoke --poll-ms 250 --max-cancel-ack-ms 2000 --max-cancel-terminal-ms 15000)',
].join('\n');

const CANCEL_STAGE_COMMANDS = [
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/aliked --profile fast --cancel-stage aliked --cancel-after-units 1',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/sift --profile qualityHybrid --cancel-stage sift --cancel-after-units 1',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/dedode --profile maximumRobustness --cancel-stage dedode --cancel-after-units 1',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mapper --profile qualityHybrid --cancel-stage mapper --cancel-after-units 1',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mvs --profile fast --products depth --cancel-stage mvs --cancel-after-units 1',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/raster --profile fast --products depth,dense,dem --cancel-stage raster --cancel-after-units 1',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mesh --profile fast --products depth,dense,dem,mesh --cancel-stage mesh --cancel-after-units 1',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/splat --profile fast --products splat --cancel-stage splat --cancel-after-units 1',
].join('\n');

const RESUME_COMMANDS = [
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/aliked --profile fast --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/sift --profile qualityHybrid --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/dedode --profile maximumRobustness --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mapper --profile qualityHybrid --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mvs --profile fast --products depth --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/raster --profile fast --products depth,dense,dem --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/mesh --profile fast --products depth,dense,dem,mesh --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/splat --profile fast --products splat --reuse --verify-resume',
  'node scripts/photolab-e2e.mjs "${COMMON[@]}" --output .build/photolab-cancel/aliked --profile qualityHybrid --reuse --expect-incompatible-checkpoint config',
].join('\n');

/** Operator commands taken from the named protocol docs; shown when a gate is not executed. */
export const OPERATOR_COMMANDS = Object.freeze({
  'r1-1': Object.freeze([GOLDEN_E2E]),
  'r1-2': Object.freeze([GOLDEN_E2E, GOLDEN_CANDIDATE]),
  'r1-3': Object.freeze([
    'pnpm photolab:test:e2e-contracts',
    `${CANCEL_COMMON}\n${RESUME_COMMANDS}`,
  ]),
  'r1-4': Object.freeze([
    'pnpm photolab:test:e2e-contracts',
    `${CANCEL_COMMON}\n${CANCEL_STAGE_COMMANDS}`,
  ]),
  'r1-5': Object.freeze([
    'pnpm --filter @himmelcad/photolab audit:release:linux',
    'pnpm --filter @himmelcad/photolab audit:release:win',
  ]),
  'r1-6': Object.freeze([
    'pnpm --filter @himmelcad/photolab smoke:package:linux',
    'pnpm --filter @himmelcad/photolab smoke:install:linux',
    'pnpm --filter @himmelcad/photolab smoke:package:win:static',
    'pnpm --filter @himmelcad/photolab smoke:package:win:wine',
    'pnpm --filter @himmelcad/photolab smoke:install:win',
  ]),
  'r1-7': Object.freeze([
    'pnpm photolab:check:english-ui',
    'pnpm photolab:test:a11y',
    'pnpm photolab:test:visual:baselines',
    'pnpm photolab:test:visual-baseline',
  ]),
  'r1-8': Object.freeze([
    'No executable G1c command is published in docs/photolab-cancellation-matrix.md, docs/photolab-agisoft-golden-dataset.md, docs/TEST-TIERS.md, or apps/photolab/package.json.',
  ]),
});

export function recorded(value) {
  if (value === undefined || value === null) return 'absent';
  if (typeof value === 'string' && value.length === 0) return 'absent';
  return value;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

export function parseCliArguments(argv) {
  const options = {
    out: null,
    candidate: null,
    e2e: [],
    a11y: null,
    baselines: null,
    cargoLog: [],
    nodeLog: [],
    help: false,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      index += 1;
      continue;
    }
    if (arg === '--out') {
      options.out = takeOne(argv, index, '--out');
      index += 2;
      continue;
    }
    if (arg === '--candidate') {
      options.candidate = takeOne(argv, index, '--candidate');
      index += 2;
      continue;
    }
    if (arg === '--a11y') {
      options.a11y = takeOne(argv, index, '--a11y');
      index += 2;
      continue;
    }
    if (arg === '--baselines') {
      options.baselines = takeOne(argv, index, '--baselines');
      index += 2;
      continue;
    }
    if (arg === '--e2e') {
      const taken = takeMany(argv, index + 1, '--e2e');
      options.e2e.push(...taken.values);
      index = taken.nextIndex;
      continue;
    }
    if (arg === '--cargo-log') {
      const taken = takeMany(argv, index + 1, '--cargo-log');
      options.cargoLog.push(...taken.values);
      index = taken.nextIndex;
      continue;
    }
    if (arg === '--node-log') {
      const taken = takeMany(argv, index + 1, '--node-log');
      options.nodeLog.push(...taken.values);
      index = taken.nextIndex;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function takeOne(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function takeMany(argv, start, name) {
  const values = [];
  let index = start;
  while (index < argv.length && !String(argv[index]).startsWith('--')) {
    values.push(argv[index]);
    index += 1;
  }
  if (values.length === 0) throw new Error(`${name} requires a value`);
  return { values, nextIndex: index };
}

export function parseOsRelease(text) {
  const values = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    values[match[1]] = raw.replace(/^"(.*)"$/u, '$1');
  }
  return values;
}

export function parseCpuInfo(text) {
  let cpuModel = 'absent';
  let coreCount = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('processor')) coreCount += 1;
    const model = /^model name\s*:\s*(.*)$/.exec(line);
    if (model && cpuModel === 'absent') cpuModel = model[1].trim() || 'absent';
  }
  return { cpuModel, coreCount: coreCount > 0 ? coreCount : 'absent' };
}

export function parseMemInfo(text) {
  const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(String(text ?? ''));
  return match ? Number(match[1]) : 'absent';
}

export function formatMachine({ os, cpuModel, coreCount, ramKib }) {
  return [
    `cores=${recorded(coreCount)}`,
    `cpu=${recorded(cpuModel)}`,
    `os=${recorded(os)}`,
    `ramKib=${recorded(ramKib)}`,
  ].join('; ');
}

/**
 * present+success → executed; present+failure → executed-failed; absent →
 * not-executed. A present artifact with no success/failure field is executed
 * because the tool does not invent a verdict.
 */
export function deriveStatus(present, success) {
  if (!present) return 'not-executed';
  if (success === false) return 'executed-failed';
  return 'executed';
}

export function aggregateGateStatus(items) {
  if (!Array.isArray(items) || items.length === 0) return 'not-executed';
  if (items.some((item) => item.status === 'executed-failed')) return 'executed-failed';
  if (items.some((item) => item.status === 'executed')) return 'executed';
  return 'not-executed';
}

export function classifyE2eGates(result) {
  const gates = new Set();
  const policy = isRecord(result?.cancellationPolicy) ? result.cancellationPolicy : {};
  const cancelStage = policy.targetStage != null && String(policy.targetStage).trim() !== '';
  const resume =
    policy.verifyResume === true ||
    (policy.expectedIncompatibleField != null &&
      String(policy.expectedIncompatibleField).trim() !== '');
  const golden = result?.goldenAgisoft === true;
  if (golden) {
    gates.add('r1-1');
    gates.add('r1-2');
  }
  if (cancelStage) gates.add('r1-4');
  if (resume) gates.add('r1-3');
  if (!golden && !cancelStage && !resume) gates.add('r1-1');
  return [...gates].sort();
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function verdictText(success, extra = {}) {
  const parts = [`success=${success === null ? 'absent' : String(success)}`];
  for (const key of Object.keys(extra).sort()) {
    parts.push(`${key}=${recorded(extra[key])}`);
  }
  return parts.join('; ');
}

export function parseE2eResult(document) {
  const record = isRecord(document) ? document : {};
  const products = Array.isArray(record.products) ? record.products : [];
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  const stages = Array.isArray(record.stages) ? record.stages : [];
  const success = booleanOrNull(record.success);
  return {
    kind: 'e2e-result',
    gateIds: classifyE2eGates(record),
    command: recorded(record.command),
    success,
    verdict: verdictText(success, { error: recorded(record.error) }),
    input: sortKeys({
      goldenAgisoft: recorded(record.goldenAgisoft),
      imageCount: recorded(record.imageCount),
      maxImages: recorded(record.maxImages),
      profile: recorded(record.profile),
      requestedProducts: Array.isArray(record.requestedProducts)
        ? record.requestedProducts
        : 'absent',
      schemaVersion: recorded(record.schemaVersion),
      source: recorded(record.source),
      startedAt: recorded(record.startedAt),
    }),
    output: sortKeys({
      alignedCameraCount: recorded(record.alignedCameraCount),
      candidateMetrics: summarizeCandidateMetrics(record.candidateMetrics),
      jobs: jobs.length
        ? jobs
            .map((job) =>
              sortKeys({
                id: recorded(job?.id),
                kind: recorded(job?.kind),
                lastCheckpointSequence: recorded(job?.lastCheckpointSequence),
                state: recorded(job?.state?.kind),
              }),
            )
            .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        : 'absent',
      productEntityIds: products.length
        ? products.map((product) => recorded(product?.entityId)).sort()
        : 'absent',
      stages: stages.length
        ? stages.map((stage) =>
            sortKeys({
              message: recorded(stage?.message),
              name: recorded(stage?.name),
              state: recorded(stage?.state),
            }),
          )
        : 'absent',
    }),
  };
}

export function summarizeCandidateMetrics(metrics) {
  if (!isRecord(metrics)) return 'absent';
  return sortKeys({
    alignedImages: recorded(metrics.alignedImages),
    densePointCount: recorded(metrics.densePointCount),
    depthImageCount: recorded(metrics.depthImageCount),
    gcpStatistics: isRecord(metrics.gcpStatistics) ? sortKeys(metrics.gcpStatistics) : 'absent',
    reprojectionRmsPixels: recorded(metrics.reprojectionRmsPixels),
    selectedProductEntityIds: isRecord(metrics.selectedProductEntityIds)
      ? sortKeys(metrics.selectedProductEntityIds)
      : 'absent',
    targetEpsg: recorded(metrics.targetEpsg),
    targetVerticalEpsg: recorded(metrics.targetVerticalEpsg),
  });
}

export function parseA11yReport(document) {
  const record = isRecord(document) ? document : {};
  const counts = isRecord(record.counts) ? record.counts : null;
  const keyboard = Array.isArray(record.keyboard) ? record.keyboard : null;
  const success = booleanOrNull(record.success);
  return {
    kind: 'a11y-report',
    gateIds: ['r1-7'],
    command: recorded(record.command),
    success,
    verdict: verdictText(success, {
      blockingCount: recorded(record.blockingCount),
      enabled: recorded(record.enabled),
    }),
    input: sortKeys({
      axeVersion: recorded(record.axeVersion),
      generatedAt: recorded(record.generatedAt),
      schemaVersion: recorded(record.schemaVersion),
    }),
    output: sortKeys({
      blockingCount: recorded(record.blockingCount),
      critical: counts ? recorded(counts.critical) : 'absent',
      keyboardAuditCount: keyboard ? keyboard.length : 'absent',
      keyboardUnreachablePanel: keyboard
        ? sumUnreachable(keyboard, ['panelControls', 'unreachable'])
        : 'absent',
      keyboardUnreachableRibbon: keyboard
        ? sumUnreachable(keyboard, ['ribbon', 'unreachable'])
        : 'absent',
      serious: counts ? recorded(counts.serious) : 'absent',
    }),
  };
}

function sumUnreachable(audits, path) {
  let total = 0;
  let saw = false;
  for (const audit of audits) {
    let cursor = audit;
    for (const key of path) {
      cursor = cursor?.[key];
    }
    if (Array.isArray(cursor)) {
      saw = true;
      total += cursor.length;
    }
  }
  return saw ? total : 'absent';
}

export function parseA11ySummary(text) {
  const source = String(text ?? '');
  const match = /critical=(\d+),\s*serious=(\d+)/u.exec(source);
  const success = booleanOrNull(undefined);
  return {
    kind: 'a11y-summary',
    gateIds: ['r1-7'],
    command: 'absent',
    success,
    verdict: verdictText(success),
    input: sortKeys({ format: 'markdown' }),
    output: sortKeys({
      critical: match ? Number(match[1]) : 'absent',
      serious: match ? Number(match[2]) : 'absent',
    }),
  };
}

export function parseBaselineManifest(document) {
  const record = isRecord(document) ? document : {};
  const captures = isRecord(record.captures) ? record.captures : null;
  let captureCount = 'absent';
  if (captures) {
    captureCount = 0;
    for (const key of Object.keys(captures).sort()) {
      if (Array.isArray(captures[key])) captureCount += captures[key].length;
    }
  }
  const success = booleanOrNull(record.success);
  return {
    kind: 'visual-baselines',
    gateIds: ['r1-7'],
    command: recorded(record.command),
    success,
    verdict: verdictText(success),
    input: sortKeys({
      platform: recorded(record.platform),
      viewports: Array.isArray(record.viewports) ? [...record.viewports].sort() : 'absent',
    }),
    output: sortKeys({
      captureCount,
      chromiumVersion: recorded(record.chromiumVersion),
    }),
  };
}

export function parseVisualReport(document) {
  const record = isRecord(document) ? document : {};
  const baseline = isRecord(record.baseline) ? record.baseline : {};
  const reports = Array.isArray(record.reports) ? record.reports : [];
  const issues = reports.flatMap((report) =>
    Array.isArray(report?.issues) ? report.issues.map(String) : [],
  );
  const success = booleanOrNull(record.success);
  return {
    kind: 'visual-report',
    gateIds: ['r1-7'],
    command: recorded(record.command),
    success,
    verdict: verdictText(success, { issueCount: issues.length }),
    input: sortKeys({
      chromiumVersion: recorded(baseline.chromiumVersion),
      mode: recorded(baseline.mode),
      platform: recorded(baseline.platform),
    }),
    output: sortKeys({
      baselinesCompared: sumField(reports, 'baselinesCompared'),
      baselinesWritten: sumField(reports, 'baselinesWritten'),
      captureCount: reports.reduce(
        (sum, report) => sum + (Array.isArray(report?.captures) ? report.captures.length : 0),
        0,
      ),
      issueCount: issues.length,
    }),
  };
}

function sumField(reports, field) {
  return reports.reduce((sum, report) => {
    const value = report?.[field];
    return sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
}

const CARGO_OK = /test result: ok\. (\d+) passed/g;
const CARGO_FAIL = /test result: FAILED\. (\d+) passed/g;
const NODE_PASS = /^# pass (\d+)\s*$/gm;
const NODE_FAIL = /^# fail (\d+)\s*$/gm;

export function parseCargoLog(text) {
  const source = String(text ?? '');
  const okCounts = matchCounts(source, CARGO_OK);
  const failedCounts = matchCounts(source, CARGO_FAIL);
  const success = failedCounts.length > 0 ? false : okCounts.length > 0 ? true : null;
  return {
    kind: 'cargo-log',
    gateIds: [],
    command: 'absent',
    success,
    verdict: verdictText(success, {
      failedLineCount: failedCounts.length,
      okLineCount: okCounts.length,
    }),
    input: sortKeys({ format: 'cargo-test' }),
    output: sortKeys({
      failedLineCount: failedCounts.length,
      failedPassedCounts: failedCounts.length ? failedCounts : 'absent',
      okLineCount: okCounts.length,
      okPassedCounts: okCounts.length ? okCounts : 'absent',
    }),
  };
}

export function parseNodeLog(text) {
  const source = String(text ?? '');
  const passCounts = matchCounts(source, NODE_PASS);
  const failCounts = matchCounts(source, NODE_FAIL);
  const failed = failCounts.some((count) => count > 0);
  const success = failed ? false : passCounts.length > 0 ? true : null;
  return {
    kind: 'node-log',
    gateIds: [],
    command: 'absent',
    success,
    verdict: verdictText(success, {
      failLineCount: failCounts.length,
      passLineCount: passCounts.length,
    }),
    input: sortKeys({ format: 'node-test' }),
    output: sortKeys({
      failCounts: failCounts.length ? failCounts : 'absent',
      failLineCount: failCounts.length,
      passCounts: passCounts.length ? passCounts : 'absent',
      passLineCount: passCounts.length,
    }),
  };
}

function matchCounts(text, expression) {
  const counts = [];
  expression.lastIndex = 0;
  let match = expression.exec(text);
  while (match) {
    counts.push(Number(match[1]));
    match = expression.exec(text);
  }
  return counts;
}

function attachItem(parsed, { sourcePath, candidateRev, machine }) {
  return {
    ...parsed,
    sourcePath,
    candidateRev: recorded(candidateRev),
    machine: recorded(machine),
    status: deriveStatus(true, parsed.success),
  };
}

export function assembleLedger({
  candidateRev = 'absent',
  machine = 'absent',
  e2eResults = [],
  a11yReports = [],
  a11ySummaries = [],
  baselineManifests = [],
  visualReports = [],
  cargoLogs = [],
  nodeLogs = [],
} = {}) {
  const context = { candidateRev: recorded(candidateRev), machine: recorded(machine) };
  const evidence = [];
  for (const item of e2eResults) {
    evidence.push(
      attachItem(parseE2eResult(item.document), { ...context, sourcePath: item.sourcePath }),
    );
  }
  for (const item of a11yReports) {
    evidence.push(
      attachItem(parseA11yReport(item.document), { ...context, sourcePath: item.sourcePath }),
    );
  }
  for (const item of a11ySummaries) {
    evidence.push(
      attachItem(parseA11ySummary(item.text), { ...context, sourcePath: item.sourcePath }),
    );
  }
  for (const item of baselineManifests) {
    evidence.push(
      attachItem(parseBaselineManifest(item.document), { ...context, sourcePath: item.sourcePath }),
    );
  }
  for (const item of visualReports) {
    evidence.push(
      attachItem(parseVisualReport(item.document), { ...context, sourcePath: item.sourcePath }),
    );
  }
  const logs = [];
  for (const item of cargoLogs) {
    logs.push(attachItem(parseCargoLog(item.text), { ...context, sourcePath: item.sourcePath }));
  }
  for (const item of nodeLogs) {
    logs.push(attachItem(parseNodeLog(item.text), { ...context, sourcePath: item.sourcePath }));
  }
  evidence.sort(compareSource);
  logs.sort(compareSource);
  const gates = R1_GATES.map((gate) => {
    const items = evidence.filter((item) => item.gateIds.includes(gate.id));
    return {
      id: gate.id,
      name: gate.name,
      status: aggregateGateStatus(items),
      evidence: items,
      operatorCommands: OPERATOR_COMMANDS[gate.id],
    };
  });
  return {
    candidateRev: context.candidateRev,
    machine: context.machine,
    gates,
    logs,
  };
}

function compareSource(left, right) {
  return String(left.sourcePath).localeCompare(String(right.sourcePath));
}

/** Prettier-compatible GFM table so generated ledgers pass `prettier --check`. */
export function formatMarkdownTable(headers, rows, alignments = []) {
  const widths = headers.map((header, index) => {
    let width = Math.max(3, header.length);
    for (const row of rows) width = Math.max(width, String(row[index]).length);
    return width;
  });
  const padRow = (cells) => {
    const padded = cells.map((cell, index) => {
      const text = String(cell);
      const extra = widths[index] - text.length;
      if (alignments[index] === 'right') return `${' '.repeat(extra)}${text}`;
      if (alignments[index] === 'center') {
        const left = Math.floor(extra / 2);
        return `${' '.repeat(left)}${text}${' '.repeat(extra - left)}`;
      }
      return `${text}${' '.repeat(extra)}`;
    });
    return `| ${padded.join(' | ')} |`;
  };
  const separator = widths.map((width, index) => {
    const left = alignments[index] === 'left' || alignments[index] === 'center' ? ':' : '-';
    const right = alignments[index] === 'right' || alignments[index] === 'center' ? ':' : '-';
    return `${left}${'-'.repeat(width - 2)}${right}`;
  });
  return [padRow(headers), `| ${separator.join(' | ')} |`, ...rows.map(padRow)];
}

export function renderLedgerMarkdown(model) {
  const lines = [
    '# PhotoLab R1 release evidence ledger',
    '',
    'This file is generated by `scripts/photolab-evidence-ledger.mjs`. It is read-only',
    "evidence: it records artifact presence and each artifact's own verdict. It does",
    'not certify that an R1 gate is proven closed.',
    '',
    `- Candidate revision: ${fence(model.candidateRev)}`,
    `- Ledger host: ${fence(model.machine)}`,
    '',
    '## Summary',
    '',
    ...formatMarkdownTable(
      ['Id', 'Gate', 'Status', 'Evidence items'],
      model.gates.map((gate) => [
        gate.id,
        gate.name,
        `\`${gate.status}\``,
        String(gate.evidence.length),
      ]),
      [undefined, undefined, undefined, 'right'],
    ),
  ];
  for (const gate of model.gates) {
    lines.push('', `## \`${gate.id}\` — ${gate.name}`, '', `Status: \`${gate.status}\``, '');
    if (gate.evidence.length === 0) {
      lines.push('Evidence items found: none.', '');
    } else {
      lines.push('### Evidence', '');
      for (const item of gate.evidence) {
        lines.push(...renderEvidenceItem(item), '');
      }
    }
    lines.push('### Operator command', '', '```bash');
    for (const command of gate.operatorCommands) lines.push(command);
    lines.push('```');
  }
  lines.push('', '## Recorded test logs', '');
  if (model.logs.length === 0) {
    lines.push('No `--cargo-log` or `--node-log` artifacts were passed.', '');
  } else {
    lines.push(
      'These logs are transcribed from `--cargo-log` and `--node-log`. They are not',
      'assigned to an R1 gate.',
      '',
    );
    for (const item of model.logs) {
      lines.push(...renderEvidenceItem(item), '');
    }
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

function renderEvidenceItem(item) {
  return [
    `#### ${item.kind} ${fence(item.sourcePath)}`,
    '',
    `- Source path: ${fence(item.sourcePath)}`,
    `- Candidate revision: ${fence(item.candidateRev)}`,
    `- Machine: ${fence(item.machine)}`,
    `- Command: ${fence(item.command)}`,
    '- Input identity:',
    '',
    '```',
    stableJson(item.input),
    '```',
    '',
    '- Output identity:',
    '',
    '```',
    stableJson(item.output),
    '```',
    '',
    `- Result verdict: ${item.verdict}`,
    `- Status: \`${item.status}\``,
  ];
}

function fence(value) {
  const text = String(recorded(value));
  if (text === 'absent') return 'absent';
  return `\`${text.replace(/`/g, "'")}\``;
}

export function buildEvidenceLedger(input) {
  const model = assembleLedger(input);
  return { ...model, markdown: renderLedgerMarkdown(model) };
}
