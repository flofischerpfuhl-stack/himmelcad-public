import type { SnapResult, SourcePosition3 } from '@himmelcad/data';
import type {
  CanonicalEntity,
  MeasurementAnchorV1,
  MeasurementKindV1,
  MeasurementMetricV1,
  MeasurementV1,
  Position,
} from '@himmelcad/data/canonical';

export const MEASUREMENT_SCHEMA_ID = 'hcad.measurement@1' as const;
export const MEASUREMENT_ALGORITHM_ID = 'hcad.measurement.basic@1' as const;

export type MeasurementToolKind = 'point' | 'distance' | 'heightDifference';
export type MeasurementLengthUnit = 'm' | 'mm' | 'ft';

export interface MeasurementDisplaySettings {
  readonly lengthUnit: MeasurementLengthUnit;
  /** Project preference. Zoom may show fewer digits, never more. */
  readonly maximumDecimals: number;
}

export interface MeasurementValue {
  readonly kind: MeasurementToolKind;
  readonly metric: MeasurementMetricV1 | null;
  readonly metres: number | null;
  readonly point: Position | null;
}

export interface MeasurementToolSnapshot {
  readonly armed: boolean;
  readonly kind: MeasurementToolKind | null;
  readonly metric: MeasurementMetricV1 | null;
  readonly anchors: readonly MeasurementAnchorV1[];
  readonly preview: MeasurementAnchorV1 | null;
  readonly liveValue: MeasurementValue | null;
  readonly journalWrites: number;
  readonly revision: number;
}

export interface MeasurementCreateInput {
  readonly name: string;
  readonly measurement: MeasurementV1;
}

export interface MeasurementCommandSink<TResult = unknown> {
  create(input: MeasurementCreateInput): Promise<TResult>;
}

export interface MeasurementToolOptions<TResult = unknown> {
  readonly sink: MeasurementCommandSink<TResult>;
  readonly layerId: string;
  readonly creationViewId?: string | null;
  readonly provenance?: string;
  readonly nextName: (kind: MeasurementToolKind) => string;
}

/**
 * View-local measurement acquisition. Pointer updates are synchronous and
 * allocation-bounded; only the terminal accepted anchor crosses the command
 * sink, once, after the complete payload has been assembled.
 */
export class MeasurementToolController<TResult = unknown> {
  private kind: MeasurementToolKind | null = null;
  private metric: MeasurementMetricV1 | null = null;
  private anchors: MeasurementAnchorV1[] = [];
  private preview: MeasurementAnchorV1 | null = null;
  private committing = false;
  private armGeneration = 0;
  private writes = 0;
  private revision = 0;
  private cached: MeasurementToolSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: MeasurementToolOptions<TResult>) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): MeasurementToolSnapshot => {
    if (this.cached) return this.cached;
    const pending = this.preview ? [...this.anchors, this.preview] : this.anchors;
    this.cached = Object.freeze({
      armed: this.kind !== null,
      kind: this.kind,
      metric: this.metric,
      anchors: Object.freeze([...this.anchors]),
      preview: this.preview,
      liveValue:
        this.kind && pending.length > 0
          ? safeMeasurementValue(this.kind, this.metric, pending)
          : null,
      journalWrites: this.writes,
      revision: this.revision,
    });
    return this.cached;
  };

  arm(kind: MeasurementToolKind, metric: MeasurementMetricV1 | null = null): void {
    assertKindMetric(kind, metric);
    this.armGeneration += 1;
    this.kind = kind;
    this.metric = metric;
    this.anchors = [];
    this.preview = null;
    this.committing = false;
    this.changed();
  }

  setDistanceMetric(metric: MeasurementMetricV1): void {
    if (this.kind !== 'distance') throw new Error('Only Distance has a selectable metric.');
    assertKindMetric(this.kind, metric);
    if (this.metric === metric) return;
    this.metric = metric;
    this.changed();
  }

  /** Replaces only the transient winner. This method never invokes the sink. */
  pointer(anchor: MeasurementAnchorV1 | null): void {
    if (!this.kind || this.committing) return;
    this.preview = anchor;
    this.changed();
  }

  async acceptPreview(): Promise<TResult | null> {
    if (!this.kind || !this.preview) return null;
    return this.accept(this.preview);
  }

  async acceptTyped(position: SourcePosition3): Promise<TResult | null> {
    if (!this.kind) return null;
    return this.accept(fixedMeasurementAnchor(position));
  }

  cancel(): boolean {
    if (!this.kind) return false;
    this.armGeneration += 1;
    this.kind = null;
    this.metric = null;
    this.anchors = [];
    this.preview = null;
    this.committing = false;
    this.changed();
    return true;
  }

  private async accept(anchor: MeasurementAnchorV1): Promise<TResult | null> {
    const kind = this.kind;
    if (!kind || this.committing) return null;
    const next = [...this.anchors, anchor];
    const required = requiredAnchorCount(kind);
    if (next.length < required) {
      this.anchors = next;
      this.preview = null;
      this.changed();
      return null;
    }
    if (next.length !== required) throw new Error('measurement has too many anchors');
    if (!measurementValue(kind, this.metric, next)) {
      throw new Error('measurement does not yet have a complete exact value');
    }
    const measurement: MeasurementV1 = {
      schemaId: MEASUREMENT_SCHEMA_ID,
      schemaVersion: 1,
      measurementKind: kind,
      metric: this.metric,
      anchors: next,
      layerId: this.options.layerId,
      visible: true,
      creationViewId: this.options.creationViewId ?? null,
      provenance: this.options.provenance ?? 'ui',
      verification: { state: 'verified' },
      resultCache: null,
    };
    // Keep the tool armed on a failed command so the user can recover from a
    // stale exact anchor without losing the first point.
    const generation = this.armGeneration;
    this.committing = true;
    try {
      const result = await this.options.sink.create({
        name: this.options.nextName(kind),
        measurement,
      });
      this.writes += 1;
      if (generation === this.armGeneration) {
        this.kind = null;
        this.metric = null;
        this.anchors = [];
        this.preview = null;
        this.committing = false;
      }
      this.changed();
      return result;
    } catch (error) {
      // The exact pending anchors stay visible and retryable after stale-CAS or
      // storage failure. A new tool armed while this request was pending owns
      // its own generation and must not be mutated by the rejected request.
      if (generation === this.armGeneration) {
        this.committing = false;
        this.changed();
      }
      throw error;
    }
  }

  private changed(): void {
    this.revision += 1;
    this.cached = null;
    for (const listener of this.listeners) listener();
  }
}

export function fixedMeasurementAnchor(position: SourcePosition3): MeasurementAnchorV1 {
  assertPosition(position);
  return { binding: 'fixed', position: { ...position } };
}

/** Converts an exact shared-kernel winner into the admitted associative anchor. */
export function attachedMeasurementAnchor(
  snap: SnapResult,
  entity: Pick<CanonicalEntity, 'id' | 'revision' | 'versionHash'>,
): MeasurementAnchorV1 {
  const target = snap.target;
  if (!target?.exact || !target.entityId || snap.entity !== target.entityId) {
    throw new Error('Only an exact canonical snap can create an attached measurement anchor.');
  }
  if (entity.id !== target.entityId) throw new Error('Snap source and canonical entity differ.');
  assertPosition(snap.position);
  return {
    binding: 'attached',
    entityId: entity.id,
    expectedRevision: entity.revision,
    expectedVersionHash: entity.versionHash,
    providerId: target.datasetKind,
    representationId: target.tileId ?? target.layerId ?? 'primary',
    primitiveAddress: stablePrimitiveAddress(target.primitive),
    sourceParameter: null,
    exactSourcePosition: { ...snap.position },
    offset: { x: 0, y: 0, z: 0 },
  };
}

export function measurementAnchorPosition(anchor: MeasurementAnchorV1): Position {
  if (anchor.binding === 'fixed') return anchor.position;
  return {
    x: anchor.exactSourcePosition.x + anchor.offset.x,
    y: anchor.exactSourcePosition.y + anchor.offset.y,
    z:
      anchor.exactSourcePosition.z === null ? null : anchor.exactSourcePosition.z + anchor.offset.z,
  };
}

export function measurementValue(
  kind: MeasurementKindV1,
  metric: MeasurementMetricV1 | null,
  anchors: readonly MeasurementAnchorV1[],
): MeasurementValue | null {
  assertKindMetric(kind, metric);
  if (anchors.length < requiredAnchorCount(kind)) return null;
  const first = measurementAnchorPosition(anchors[0]!);
  if (kind === 'point') return { kind, metric: null, metres: null, point: first };
  const second = measurementAnchorPosition(anchors[1]!);
  if (kind === 'heightDifference') {
    return {
      kind,
      metric: null,
      metres: heightDifferenceOnProjectMeasurementPlane(first, second),
      point: null,
    };
  }
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  if (metric === 'horizontal') {
    return { kind, metric, metres: Math.hypot(dx, dy), point: null };
  }
  if (first.z === null || second.z === null) {
    throw new Error('Spatial distance requires known Z at both anchors.');
  }
  return {
    kind,
    metric,
    metres: Math.hypot(dx, dy, second.z - first.z),
    point: null,
  };
}

/** MI-D13: the Release 0.5 measurement plane is project XY, so Δz is To.Z − From.Z. */
export function heightDifferenceOnProjectMeasurementPlane(from: Position, to: Position): number {
  if (from.z === null || to.z === null) {
    throw new Error('Height difference requires known Z at both anchors.');
  }
  return to.z - from.z;
}

export function visibleMeasurementDecimals(
  pixelsPerMetre: number,
  settings: MeasurementDisplaySettings,
  anchorPrecisionDecimals: number,
): number {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) {
    throw new TypeError('pixels per metre must be positive and finite');
  }
  const unitScale = displayUnitsPerMetre(settings.lengthUnit);
  const pixelsPerDisplayUnit = pixelsPerMetre / unitScale;
  const zoomDecimals = Math.max(
    0,
    Math.min(9, Math.floor(Math.log10(pixelsPerDisplayUnit)) + 1),
  );
  const sourceStepInDisplayUnits = 10 ** -Math.trunc(anchorPrecisionDecimals) * unitScale;
  const sourceDecimals = Math.max(
    0,
    Math.min(9, Math.floor(-Math.log10(sourceStepInDisplayUnits) + 1e-12)),
  );
  return Math.max(
    0,
    Math.min(
      Math.trunc(settings.maximumDecimals),
      sourceDecimals,
      zoomDecimals,
    ),
  );
}

export function formatMeasurementLength(
  metres: number,
  settings: MeasurementDisplaySettings,
  pixelsPerMetre: number,
  anchorPrecisionDecimals: number,
  prefix = '',
): string {
  if (!Number.isFinite(metres)) throw new TypeError('measurement value must be finite');
  const decimals = visibleMeasurementDecimals(pixelsPerMetre, settings, anchorPrecisionDecimals);
  const [value, suffix] = convertMetres(metres, settings.lengthUnit);
  return `${prefix}${value.toFixed(decimals)} ${suffix}`;
}

export function measurementLabel(
  value: MeasurementValue | null,
  settings: MeasurementDisplaySettings,
  pixelsPerMetre = 100,
  anchorPrecisionDecimals = 6,
): string {
  if (!value) return '—';
  if (value.kind === 'point') {
    const point = value.point!;
    const decimals = visibleMeasurementDecimals(pixelsPerMetre, settings, anchorPrecisionDecimals);
    const scale = displayUnitsPerMetre(settings.lengthUnit);
    return `X ${(point.x * scale).toFixed(decimals)}  Y ${(point.y * scale).toFixed(decimals)}  Z ${
      point.z === null ? '—' : (point.z * scale).toFixed(decimals)
    }`;
  }
  return formatMeasurementLength(
    value.metres!,
    settings,
    pixelsPerMetre,
    anchorPrecisionDecimals,
    value.kind === 'heightDifference' ? 'Δz ' : '',
  );
}

function requiredAnchorCount(kind: MeasurementToolKind): 1 | 2 {
  return kind === 'point' ? 1 : 2;
}

function safeMeasurementValue(
  kind: MeasurementKindV1,
  metric: MeasurementMetricV1 | null,
  anchors: readonly MeasurementAnchorV1[],
): MeasurementValue | null {
  try {
    return measurementValue(kind, metric, anchors);
  } catch {
    return null;
  }
}

function assertKindMetric(kind: MeasurementKindV1, metric: MeasurementMetricV1 | null): void {
  if (kind === 'distance' && metric === null) throw new Error('Distance requires a metric.');
  if (kind !== 'distance' && metric !== null) throw new Error(`${kind} does not accept a metric.`);
}

function assertPosition(position: SourcePosition3): void {
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    (position.z !== null && !Number.isFinite(position.z))
  ) {
    throw new TypeError('measurement anchor coordinates must be finite');
  }
}

function stablePrimitiveAddress(primitive: NonNullable<SnapResult['target']>['primitive']): string {
  return Object.keys(primitive)
    .sort()
    .map((key) => `${key}=${String(primitive[key as keyof typeof primitive])}`)
    .join(';');
}

function convertMetres(value: number, unit: MeasurementLengthUnit): readonly [number, string] {
  return [value * displayUnitsPerMetre(unit), unit];
}

function displayUnitsPerMetre(unit: MeasurementLengthUnit): number {
  if (unit === 'mm') return 1_000;
  if (unit === 'ft') return 1 / 0.3048;
  return 1;
}
