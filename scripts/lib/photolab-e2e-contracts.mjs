const PRODUCT_ENTITY_KINDS = new Set([
  'AlignmentRun',
  'MergedAlignmentRun',
  'PointCloud',
  'DepthMap',
  'DigitalElevationModel',
  'Orthomosaic',
  'Mesh',
  'TexturedMesh',
  'GaussianSplatCloud',
]);

export const CANCELLATION_STAGE_TARGETS = Object.freeze({
  aliked: ['extract aliked', 'aliked'],
  sift: ['extract sift', 'sift'],
  dedode: ['extract dedode', 'dedode'],
  mapper: [
    'build hybrid reconstructions',
    'global mapper',
    'incremental mapper',
    'glomap',
    'mapper',
  ],
  mvs: ['build depth maps', 'depth estimation', 'geometric consistency', 'portable mvs', 'mvs'],
  raster: ['build dem', 'build orthomosaic', 'raster', 'pyramid', 'orthomosaic', 'dem'],
  mesh: ['build mesh', 'mesh'],
  splat: ['build gaussian splat', 'train gaussian splat', 'brush', 'splat'],
});

export const REQUIRED_CANCELLATION_STAGES = Object.freeze(Object.keys(CANCELLATION_STAGE_TARGETS));

export function canonicalCancellationStage(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  if (Object.hasOwn(CANCELLATION_STAGE_TARGETS, normalized)) return normalized;
  for (const [target, labels] of Object.entries(CANCELLATION_STAGE_TARGETS)) {
    if (labels.some((label) => normalized.includes(label))) return target;
  }
  throw new Error(
    `Unknown cancellation stage “${value}”; expected ${Object.keys(CANCELLATION_STAGE_TARGETS).join(', ')}`,
  );
}

export function stageMatchesCancellationTarget(target, stageLabel) {
  const canonical = canonicalCancellationStage(target);
  if (!canonical) return false;
  const label = String(stageLabel ?? '').toLowerCase();
  return CANCELLATION_STAGE_TARGETS[canonical].some((candidate) => label.includes(candidate));
}

export class CancellationTracker {
  constructor({ target, afterUnits = 1, now = Date.now }) {
    this.target = canonicalCancellationStage(target);
    this.afterUnits = afterUnits;
    this.now = now;
    this.result = null;
  }

  shouldRequest(job) {
    return (
      this.target !== '' &&
      this.result == null &&
      job?.state?.kind === 'running' &&
      stageMatchesCancellationTarget(this.target, job?.progress?.stage?.label) &&
      Number(job?.progress?.metrics?.completedUnits ?? 0) >= this.afterUnits
    );
  }

  async request(job, cancel) {
    const requestedAtMs = this.now();
    const response = await cancel(job.id);
    const acknowledgedAtMs = this.now();
    assertCancellationAcknowledged(job, response);
    this.result = {
      requestedStage: this.target,
      observedStage: job.progress.stage.label,
      completedUnits: job.progress.metrics.completedUnits,
      requestedAt: new Date(requestedAtMs).toISOString(),
      acknowledgedAt: new Date(acknowledgedAtMs).toISOString(),
      acknowledgementLatencyMs: acknowledgedAtMs - requestedAtMs,
      acknowledgedState: response.job.state.kind,
      terminalState: null,
    };
    return response;
  }

  recordTerminal(job) {
    if (this.result == null) throw new Error('Cancellation reached terminal state before request');
    if (job?.state?.kind !== 'cancelled') {
      throw new Error(`Cancellation terminated as ${String(job?.state?.kind)}, expected cancelled`);
    }
    const terminalAtMs = this.now();
    this.result.terminalAt = new Date(terminalAtMs).toISOString();
    this.result.terminalLatencyMs = terminalAtMs - Date.parse(this.result.requestedAt);
    // Retained for old result readers; new assertions use the unambiguous field.
    this.result.latencyMs = this.result.terminalLatencyMs;
    this.result.terminalState = job.state.kind;
    return this.result;
  }
}

export function assertCancellationAcknowledged(job, response) {
  if (response?.job?.id !== job?.id) {
    throw new Error(
      `Cancellation acknowledgement belongs to ${String(response?.job?.id)}, expected ${String(job?.id)}`,
    );
  }
  if (!['cancelRequested', 'cancelled'].includes(response?.job?.state?.kind)) {
    throw new Error(
      `Cancellation acknowledgement has invalid state ${String(response?.job?.state?.kind)}`,
    );
  }
}

export function assertCancellationLatencies(
  result,
  { maximumAcknowledgementMs, maximumTerminalMs, requireTerminal = false },
) {
  for (const [label, value] of [
    ['maximum acknowledgement', maximumAcknowledgementMs],
    ['maximum terminal', maximumTerminalMs],
  ]) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${label} latency must be non-negative`);
  }
  const acknowledgement = Number(result?.acknowledgementLatencyMs);
  if (!Number.isFinite(acknowledgement) || acknowledgement < 0) {
    throw new Error('Cancellation acknowledgement latency was not recorded');
  }
  if (acknowledgement > maximumAcknowledgementMs) {
    throw new Error(
      `Cancellation acknowledgement took ${acknowledgement} ms; limit is ${maximumAcknowledgementMs} ms`,
    );
  }
  if (!requireTerminal) return;
  const terminal = Number(result?.terminalLatencyMs);
  if (!Number.isFinite(terminal) || terminal < acknowledgement) {
    throw new Error('Cancellation terminal latency was not recorded monotonically');
  }
  if (result?.terminalState !== 'cancelled') {
    throw new Error(
      `Cancellation terminal state is ${String(result?.terminalState)}, expected cancelled`,
    );
  }
  if (terminal > maximumTerminalMs) {
    throw new Error(
      `Cancellation took ${terminal} ms to terminate; limit is ${maximumTerminalMs} ms`,
    );
  }
}

export function capturePublicationState(snapshot, products) {
  const entities = Object.values(snapshot?.manifest?.entities ?? {})
    .filter((entity) => PRODUCT_ENTITY_KINDS.has(entity.kind))
    .map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      versionHash: entity.versionHash,
      parent: entity.parent ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const catalog = (products ?? [])
    .map((product) => ({
      entityId: product.entityId,
      kind: product.kind,
      sha256: product.sha256 ?? product.manifestSha256 ?? null,
      relativePath: product.relativePath ?? null,
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  const activeRuns = [...(snapshot?.manifest?.activeRuns ?? [])].sort();
  return { entities, catalog, activeRuns };
}

export function assertNoPartialPublication(before, after) {
  const expected = JSON.stringify(before);
  const observed = JSON.stringify(after);
  if (expected !== observed) {
    throw new Error(
      `Cancelled job changed published products: before=${expected}, after=${observed}`,
    );
  }
}

export function immutableResumeIdentity(job) {
  const identity = {
    kind: job?.kind ?? null,
    configHash: job?.configHash ?? null,
    inputHash: job?.inputHash ?? null,
  };
  if (!identity.kind || !identity.configHash || !identity.inputHash) {
    throw new Error('Job does not expose kind, configHash and inputHash for resume validation');
  }
  return identity;
}

export function resumeCompatibility(expected, requested) {
  const mismatches = [];
  for (const key of ['kind', 'configHash', 'inputHash']) {
    if (expected?.[key] !== requested?.[key]) mismatches.push(key);
  }
  return { compatible: mismatches.length === 0, mismatches };
}

export function assertCompatibleResume(expected, requested) {
  const result = resumeCompatibility(expected, requested);
  if (!result.compatible) {
    throw new Error(`Resume identity mismatch: ${result.mismatches.join(', ')}`);
  }
}

export function assertIncompatibleCheckpointRejected(expected, requested) {
  const result = resumeCompatibility(expected, requested);
  if (result.compatible) {
    throw new Error('Incompatible checkpoint fixture unexpectedly matches the requested job');
  }
  return result.mismatches;
}
