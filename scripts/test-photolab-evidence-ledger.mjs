import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  aggregateGateStatus,
  assembleLedger,
  buildEvidenceLedger,
  classifyE2eGates,
  deriveStatus,
  formatMachine,
  parseA11yReport,
  parseA11ySummary,
  parseBaselineManifest,
  parseCargoLog,
  parseCliArguments,
  parseCpuInfo,
  parseE2eResult,
  parseMemInfo,
  parseNodeLog,
  parseOsRelease,
  parseVisualReport,
  recorded,
} from './lib/photolab-evidence.mjs';

const cli = resolve(import.meta.dirname, 'photolab-evidence-ledger.mjs');

const workflowE2e = () => ({
  schemaVersion: 1,
  source: '/data/photos',
  profile: 'fast',
  requestedProducts: ['depth', 'dense'],
  maxImages: 24,
  goldenAgisoft: false,
  cancellationPolicy: {
    targetStage: null,
    verifyResume: false,
    expectedIncompatibleField: null,
  },
  startedAt: '2026-09-02T15:31:35.123Z',
  stages: [{ name: 'commitImages', state: 'completed' }],
  imageCount: 24,
  alignedCameraCount: 24,
  products: [{ entityId: 'entity-dense' }, { entityId: 'entity-depth' }],
  candidateMetrics: {
    alignedImages: 24,
    densePointCount: 100,
    depthImageCount: 24,
    reprojectionRmsPixels: 0.5,
    selectedProductEntityIds: { dense: 'entity-dense', dem: null },
    targetEpsg: 31468,
    targetVerticalEpsg: 7837,
    gcpStatistics: null,
  },
  jobs: [
    { id: 'align', kind: 'alignPhotos', state: { kind: 'completed' } },
    {
      id: 'depth',
      kind: 'buildDepthMaps',
      lastCheckpointSequence: 120,
      state: { kind: 'completed' },
    },
  ],
  success: true,
});

const goldenE2e = () => ({
  ...workflowE2e(),
  profile: 'qualityHybrid',
  goldenAgisoft: true,
  imageCount: 135,
  requestedProducts: ['depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'],
});

const cancelE2e = () => ({
  ...workflowE2e(),
  success: false,
  error: 'cancelled',
  cancellationPolicy: {
    targetStage: 'mvs',
    verifyResume: false,
    expectedIncompatibleField: null,
  },
});

const resumeE2e = () => ({
  ...workflowE2e(),
  cancellationPolicy: {
    targetStage: null,
    verifyResume: true,
    expectedIncompatibleField: null,
  },
});

test('recorded prints absent for missing fields and keeps zero/false', () => {
  assert.equal(recorded(undefined), 'absent');
  assert.equal(recorded(null), 'absent');
  assert.equal(recorded(''), 'absent');
  assert.equal(recorded(0), 0);
  assert.equal(recorded(false), false);
});

test('parses e2e result.json identities and prints absent for missing fields', () => {
  const parsed = parseE2eResult(workflowE2e());
  assert.equal(parsed.kind, 'e2e-result');
  assert.equal(parsed.success, true);
  assert.equal(parsed.command, 'absent');
  assert.equal(parsed.input.imageCount, 24);
  assert.equal(parsed.input.profile, 'fast');
  assert.equal(parsed.input.source, '/data/photos');
  assert.deepEqual(parsed.output.productEntityIds, ['entity-dense', 'entity-depth']);
  assert.equal(parsed.output.candidateMetrics.densePointCount, 100);
  assert.equal(parsed.output.jobs[0].lastCheckpointSequence, 'absent');
  assert.equal(parsed.output.jobs[1].lastCheckpointSequence, 120);
  assert.match(parsed.verdict, /success=true/);

  const sparse = parseE2eResult({ schemaVersion: 1, success: false, error: 'boom' });
  assert.equal(sparse.input.source, 'absent');
  assert.equal(sparse.input.imageCount, 'absent');
  assert.equal(sparse.output.candidateMetrics, 'absent');
  assert.equal(sparse.output.productEntityIds, 'absent');
  assert.match(sparse.verdict, /success=false/);
  assert.match(sparse.verdict, /error=boom/);
});

test('classifies e2e artifacts onto R1 gates without interpreting completeness', () => {
  assert.deepEqual(classifyE2eGates(workflowE2e()), ['r1-1']);
  assert.deepEqual(classifyE2eGates(goldenE2e()), ['r1-1', 'r1-2']);
  assert.deepEqual(classifyE2eGates(cancelE2e()), ['r1-4']);
  assert.deepEqual(classifyE2eGates(resumeE2e()), ['r1-3']);
});

test('parses a11y-report.json critical/serious counts', () => {
  const parsed = parseA11yReport({
    schemaVersion: 1,
    generatedAt: '2026-09-02T17:59:04.802Z',
    enabled: true,
    axeVersion: '4.13.0',
    counts: { critical: 1, serious: 2, moderate: 0 },
    blockingCount: 3,
    keyboard: [{ ribbon: { unreachable: ['a'] }, panelControls: { unreachable: ['b', 'c'] } }],
  });
  assert.equal(parsed.output.critical, 1);
  assert.equal(parsed.output.serious, 2);
  assert.equal(parsed.output.keyboardUnreachableRibbon, 1);
  assert.equal(parsed.output.keyboardUnreachablePanel, 2);
  assert.equal(parsed.success, null);
  assert.deepEqual(parsed.gateIds, ['r1-7']);
});

test('parses a11y-summary.md critical/serious counts', () => {
  const parsed = parseA11ySummary('axe-core 4.13.0 · critical=0, serious=4, moderate=0, minor=0\n');
  assert.equal(parsed.output.critical, 0);
  assert.equal(parsed.output.serious, 4);
  assert.equal(parseA11ySummary('no counts here').output.critical, 'absent');
});

test('parses visual-baselines manifest chromium version and capture count', () => {
  const parsed = parseBaselineManifest({
    chromiumVersion: '151.0.7922.75',
    platform: 'linux-x64',
    viewports: ['1440x900', '1100x720'],
    captures: {
      '1440x900': ['main', 'ribbon'],
      '1100x720': ['main'],
    },
  });
  assert.equal(parsed.output.chromiumVersion, '151.0.7922.75');
  assert.equal(parsed.output.captureCount, 3);
  assert.deepEqual(parsed.gateIds, ['r1-7']);
});

test('parses visual-regression report.json without inventing a success field', () => {
  const parsed = parseVisualReport({
    baseline: { mode: 'off', chromiumVersion: '151.0.0.0', platform: 'linux-x64' },
    reports: [{ captures: ['a', 'b'], baselinesCompared: 0, baselinesWritten: 0, issues: [] }],
  });
  assert.equal(parsed.input.mode, 'off');
  assert.equal(parsed.output.captureCount, 2);
  assert.equal(parsed.success, null);
});

test('parses cargo and node test logs by counting recorded result lines', () => {
  const cargoOk = parseCargoLog(
    'test result: ok. 12 passed; 0 failed\nrunning 2 tests\ntest result: ok. 2 passed; 0 failed\n',
  );
  assert.equal(cargoOk.success, true);
  assert.deepEqual(cargoOk.output.okPassedCounts, [12, 2]);
  assert.equal(cargoOk.output.okLineCount, 2);

  const cargoFail = parseCargoLog('test result: FAILED. 11 passed; 1 failed\n');
  assert.equal(cargoFail.success, false);
  assert.deepEqual(cargoFail.output.failedPassedCounts, [11]);

  const nodeOk = parseNodeLog('# pass 4\n# fail 0\n');
  assert.equal(nodeOk.success, true);
  assert.deepEqual(nodeOk.output.passCounts, [4]);

  const nodeFail = parseNodeLog('# pass 3\n# fail 1\n');
  assert.equal(nodeFail.success, false);
});

test('gate status is executed, executed-failed, or not-executed from presence and success', () => {
  assert.equal(deriveStatus(true, true), 'executed');
  assert.equal(deriveStatus(true, false), 'executed-failed');
  assert.equal(deriveStatus(false, true), 'not-executed');
  assert.equal(deriveStatus(true, null), 'executed');
  assert.equal(aggregateGateStatus([]), 'not-executed');
  assert.equal(aggregateGateStatus([{ status: 'executed' }]), 'executed');
  assert.equal(
    aggregateGateStatus([{ status: 'executed' }, { status: 'executed-failed' }]),
    'executed-failed',
  );
});

test('assembleLedger assigns e2e success and failure to the classified gates', () => {
  const model = assembleLedger({
    candidateRev: 'abc123',
    machine: 'cores=2; cpu=Test; os=Linux; ramKib=1024',
    e2eResults: [
      { sourcePath: 'ok/result.json', document: workflowE2e() },
      { sourcePath: 'fail/result.json', document: cancelE2e() },
    ],
  });
  const byId = Object.fromEntries(model.gates.map((gate) => [gate.id, gate]));
  assert.equal(byId['r1-1'].status, 'executed');
  assert.equal(byId['r1-4'].status, 'executed-failed');
  assert.equal(byId['r1-2'].status, 'not-executed');
  assert.equal(byId['r1-4'].evidence[0].sourcePath, 'fail/result.json');
  assert.equal(byId['r1-1'].evidence[0].candidateRev, 'abc123');
});

test('same ledger inputs produce byte-identical Markdown', () => {
  const input = {
    candidateRev: 'deadbeef',
    machine: 'cores=8; cpu=Test CPU; os=Debian; ramKib=32000',
    e2eResults: [{ sourcePath: 'e2e/result.json', document: workflowE2e() }],
    a11yReports: [
      {
        sourcePath: 'a11y/a11y-report.json',
        document: { schemaVersion: 1, counts: { critical: 0, serious: 0 }, blockingCount: 0 },
      },
    ],
    baselineManifests: [
      {
        sourcePath: 'baselines/manifest.json',
        document: {
          chromiumVersion: '151.0.7922.75',
          captures: { '1440x900': ['main'] },
        },
      },
    ],
    cargoLogs: [{ sourcePath: 'cargo.log', text: 'test result: ok. 3 passed; 0 failed\n' }],
  };
  const first = buildEvidenceLedger(input).markdown;
  const second = buildEvidenceLedger(input).markdown;
  assert.equal(first, second);
  assert.match(first, /PhotoLab R1 release evidence ledger/);
  assert.match(first, /read-only/);
  assert.doesNotMatch(first, /2026-09-03T/);
  assert.match(first, /`r1-1`/);
  assert.match(first, /Status: `executed`/);
  assert.match(first, /Status: `not-executed`/);
});

test('parses CLI arguments including repeatable list flags', () => {
  assert.deepEqual(
    parseCliArguments([
      '--out',
      'docs/ledger.md',
      '--candidate',
      'abc',
      '--e2e',
      'one',
      'two',
      '--a11y',
      '.build/visual-regression',
      '--baselines',
      'apps/photolab/test/visual-baselines',
      '--cargo-log',
      'a.log',
      '--node-log',
      'b.log',
      'c.log',
    ]),
    {
      out: 'docs/ledger.md',
      candidate: 'abc',
      e2e: ['one', 'two'],
      a11y: '.build/visual-regression',
      baselines: 'apps/photolab/test/visual-baselines',
      cargoLog: ['a.log'],
      nodeLog: ['b.log', 'c.log'],
      help: false,
    },
  );
  assert.equal(parseCliArguments(['--help']).help, true);
  assert.throws(() => parseCliArguments(['--unexpected']), /Unknown argument: --unexpected/);
  assert.throws(() => parseCliArguments(['--out']), /--out requires a value/);
  assert.throws(() => parseCliArguments(['--e2e', '--out', 'x.md']), /--e2e requires a value/);
});

test('CLI requires --out, prints help, and writes a ledger from fixtures', () => {
  const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--out is required/);

  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--out <file>/);

  const unknown = spawnSync(process.execPath, [cli, '--nope'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument: --nope/);

  const root = mkdtempSync(join(tmpdir(), 'photolab-evidence-'));
  const e2eDir = join(root, 'e2e');
  mkdirSync(e2eDir);
  writeFileSync(join(e2eDir, 'result.json'), `${JSON.stringify(cancelE2e(), null, 2)}\n`);
  const out = join(root, 'ledger.md');
  const written = spawnSync(
    process.execPath,
    [cli, '--out', out, '--e2e', e2eDir, '--candidate', 'cafed00d'],
    { encoding: 'utf8' },
  );
  assert.equal(written.status, 0, written.stderr);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /cafed00d/);
  assert.match(text, /`executed-failed`/);
  assert.match(text, /r1-4/);
});

test('parses /proc machine identity with sorted keys', () => {
  const os = parseOsRelease('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian"\n');
  const cpu = parseCpuInfo('processor\t: 0\nmodel name\t: Test CPU\nprocessor\t: 1\n');
  const ramKib = parseMemInfo('MemTotal:       32864732 kB\n');
  assert.equal(os.PRETTY_NAME, 'Debian GNU/Linux 12 (bookworm)');
  assert.equal(cpu.cpuModel, 'Test CPU');
  assert.equal(cpu.coreCount, 2);
  assert.equal(ramKib, 32864732);
  assert.equal(
    formatMachine({
      os: os.PRETTY_NAME,
      cpuModel: cpu.cpuModel,
      coreCount: cpu.coreCount,
      ramKib,
    }),
    'cores=2; cpu=Test CPU; os=Debian GNU/Linux 12 (bookworm); ramKib=32864732',
  );
});
