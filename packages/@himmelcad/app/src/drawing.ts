import type { PointAcquisitionV1, Position } from '@himmelcad/data/canonical';

import {
  pointFromPolar,
  snapDirectionDegrees,
  type ConstructionPoint,
  type PolarConstructionValues,
} from './constructionInput.js';

export type DrawToolKind = 'line' | 'polyline' | 'boundary';
export type DrawRole = 'plain' | 'breakline' | 'boundary';
export type DrawVertexAcquisitionKind = 'pick' | 'typed' | 'constrained';

export interface DrawVertexAcquisition {
  readonly kind: DrawVertexAcquisitionKind;
  readonly point: ConstructionPoint;
  readonly snapKind?: string | null;
  readonly sourceEntityId?: string | null;
  readonly sourceRevision?: number | null;
  readonly providerId?: string | null;
  readonly primitiveAddress?: string | null;
  readonly constraint?: string | null;
}

export interface DrawCurveWrite {
  readonly entityId: string;
  readonly expectedRevision: number | null;
  readonly name: string;
  readonly tool: DrawToolKind;
  readonly role: DrawRole;
  readonly closed: boolean;
  readonly vertices: readonly ConstructionPoint[];
  readonly acquisitions: readonly PointAcquisitionV1[];
}

export interface DrawCurveWriteResult {
  readonly entityId: string;
  readonly revision: number;
  readonly commandId: string;
}

export interface DrawCurveSink {
  write(input: DrawCurveWrite): Promise<DrawCurveWriteResult>;
  undo(commandId: string): Promise<{ readonly entityId: string; readonly revision: number | null }>;
}

export interface DrawToolSnapshot {
  readonly armed: boolean;
  readonly kind: DrawToolKind | null;
  readonly role: DrawRole;
  readonly vertices: readonly DrawVertexAcquisition[];
  readonly preview: DrawVertexAcquisition | null;
  readonly entityId: string | null;
  readonly entityRevision: number | null;
  readonly committing: boolean;
  readonly error: string | null;
  readonly journalWrites: number;
}

export interface DrawSnapLatencySnapshot {
  readonly samples: number;
  readonly p95Ms: number | null;
  readonly maximumMs: number | null;
}

/** V-01-shaped bounded timing ring for the synchronous snap/refinement path. */
export class DrawSnapLatencyRing {
  private readonly values: Float64Array;
  private next = 0;
  private count = 0;

  constructor(readonly capacity = 2_048) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('snap latency ring capacity must be a positive integer');
    }
    this.values = new Float64Array(capacity);
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.values[this.next] = durationMs;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }

  snapshot(): DrawSnapLatencySnapshot {
    if (this.count === 0) return { samples: 0, p95Ms: null, maximumMs: null };
    const sorted = Array.from(this.values.slice(0, this.count)).sort((left, right) => left - right);
    return {
      samples: this.count,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      maximumMs: sorted.at(-1)!,
    };
  }
}

/** View-local drafting state. Only accepted vertices cross the sink boundary. */
export class DrawToolController {
  private kind: DrawToolKind | null = null;
  private role: DrawRole = 'plain';
  private vertices: DrawVertexAcquisition[] = [];
  private preview: DrawVertexAcquisition | null = null;
  private entityId: string | null = null;
  private entityRevision: number | null = null;
  private committing = false;
  private error: string | null = null;
  private journalWrites = 0;
  private cached: DrawToolSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly sink: DrawCurveSink,
    private readonly nextIdentity: (kind: DrawToolKind) => { entityId: string; name: string },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): DrawToolSnapshot => {
    if (this.cached) return this.cached;
    this.cached = Object.freeze({
      armed: this.kind !== null,
      kind: this.kind,
      role: this.role,
      vertices: Object.freeze([...this.vertices]),
      preview: this.preview,
      entityId: this.entityId,
      entityRevision: this.entityRevision,
      committing: this.committing,
      error: this.error,
      journalWrites: this.journalWrites,
    });
    return this.cached;
  };

  arm(kind: DrawToolKind, role: DrawRole = kind === 'boundary' ? 'boundary' : 'plain'): void {
    this.kind = kind;
    this.role = kind === 'boundary' ? 'boundary' : role;
    this.resetConstruction();
    this.changed();
  }

  setRole(role: DrawRole): void {
    if (!this.kind) return;
    this.role = this.kind === 'boundary' ? 'boundary' : role;
    this.changed();
  }

  pointer(acquisition: DrawVertexAcquisition | null): void {
    if (!this.kind || this.committing) return;
    this.preview = acquisition;
    this.error = null;
    this.changed();
  }

  async acceptPreview(): Promise<boolean> {
    return this.preview ? this.accept(this.preview) : false;
  }

  async acceptTyped(point: ConstructionPoint): Promise<boolean> {
    return this.accept({ kind: 'typed', point });
  }

  async acceptConstraint(
    directionDegrees: number,
    distance: number,
    vertical:
      | { readonly kind: 'deltaZ'; readonly value: number }
      | { readonly kind: 'slope'; readonly value: number },
  ): Promise<boolean> {
    const origin = this.vertices.at(-1)?.point;
    if (!origin) throw new Error('A constrained vertex requires a first vertex.');
    const direction = snapDirectionDegrees(directionDegrees, 45);
    if (vertical.kind === 'slope' && distance === 0 && vertical.value !== 0) {
      throw new RangeError('ZeroRunForSlope');
    }
    const polar: PolarConstructionValues = {
      directionDegrees: direction,
      distance,
      deltaZ: vertical.kind === 'slope' ? (distance * vertical.value) / 100 : vertical.value,
    };
    return this.accept({
      kind: 'constrained',
      point: pointFromPolar(origin, polar),
      constraint: JSON.stringify({ directionDegrees: direction, distance, vertical }),
    });
  }

  async finish(close = false): Promise<boolean> {
    if (!this.kind || this.committing) return false;
    const minimumVertices = this.kind === 'boundary' ? 3 : 2;
    if (this.vertices.length < minimumVertices) {
      this.error =
        this.kind === 'boundary'
          ? 'A boundary needs at least three accepted vertices before Close.'
          : 'A line needs at least two accepted vertices before Finish.';
      this.changed();
      return false;
    }
    await this.persist(this.kind === 'boundary' || close);
    this.kind = null;
    this.preview = null;
    this.changed();
    return true;
  }

  cancel(): boolean {
    if (!this.kind) return false;
    this.kind = null;
    this.preview = null;
    this.changed();
    return true;
  }

  /** Accepted construction is view-local, so cancellation never has canonical work to undo. */
  async cancelAll(): Promise<boolean> {
    if (!this.kind || this.committing) return false;
    this.kind = null;
    this.preview = null;
    this.vertices = [];
    this.entityId = null;
    this.entityRevision = null;
    this.error = null;
    this.changed();
    return true;
  }

  revertPending(): boolean {
    if (!this.preview) return false;
    this.preview = null;
    this.error = null;
    this.changed();
    return true;
  }

  async undoVertex(): Promise<boolean> {
    if (!this.kind || this.vertices.length === 0 || this.committing) return false;
    this.vertices.pop();
    this.preview = null;
    this.error = null;
    this.changed();
    return true;
  }

  private async accept(acquisition: DrawVertexAcquisition): Promise<boolean> {
    if (!this.kind || this.committing) return false;
    assertPoint(acquisition.point);
    if (
      this.kind === 'boundary' &&
      this.vertices.length >= 3 &&
      samePoint(acquisition.point, this.vertices[0]!.point)
    ) {
      return this.finish(true);
    }
    this.vertices.push(
      Object.freeze({ ...acquisition, point: Object.freeze({ ...acquisition.point }) }),
    );
    this.preview = null;
    if (this.kind === 'line' && this.vertices.length === 2) {
      await this.persist(false);
      this.kind = null;
    }
    this.changed();
    return true;
  }

  private async persist(closed: boolean): Promise<void> {
    const kind = this.kind;
    if (!kind || this.vertices.length < 2) return;
    const identity = this.entityId
      ? { entityId: this.entityId, name: '' }
      : this.nextIdentity(kind);
    this.committing = true;
    this.error = null;
    this.changed();
    try {
      const result = await this.sink.write({
        entityId: identity.entityId,
        expectedRevision: this.entityRevision,
        name: identity.name || `${kind[0]!.toUpperCase()}${kind.slice(1)}`,
        tool: kind,
        role: this.role,
        closed,
        vertices: this.vertices.map((vertex) => vertex.point),
        acquisitions: this.vertices.map(pointAcquisition),
      });
      this.entityId = result.entityId;
      this.entityRevision = result.revision;
      this.journalWrites += 1;
    } catch (error) {
      this.error = String(error);
      throw error;
    } finally {
      this.committing = false;
      this.changed();
    }
  }

  private resetConstruction(): void {
    this.vertices = [];
    this.preview = null;
    this.entityId = null;
    this.entityRevision = null;
    this.committing = false;
    this.error = null;
  }

  private changed(): void {
    this.cached = null;
    for (const listener of this.listeners) listener();
  }
}

export function pointAcquisition(vertex: DrawVertexAcquisition): PointAcquisitionV1 {
  const picked = vertex.kind === 'pick';
  if (picked && (!vertex.sourceEntityId || vertex.sourceRevision == null || !vertex.providerId)) {
    throw new Error('Picked vertices require exact source provenance.');
  }
  return {
    schemaId: 'hcad.component.point-acquisition@1',
    schemaVersion: 1,
    acquisition: picked ? 'pick' : 'typed',
    finalCoordinate: position(vertex.point),
    inputMode: vertex.kind,
    truth: picked ? 'exact' : 'typed',
    sourceEntityId: picked ? vertex.sourceEntityId! : null,
    sourceRevision: picked ? vertex.sourceRevision! : null,
    providerId: picked ? vertex.providerId! : null,
    primitiveAddress: vertex.primitiveAddress ?? null,
    constraint: vertex.constraint ?? (vertex.snapKind ? `snap:${vertex.snapKind}` : null),
    estimateConfirmed: false,
  };
}

function position(point: ConstructionPoint): Position {
  return { x: point.x, y: point.y, z: point.z };
}

function assertPoint(point: ConstructionPoint): void {
  if (![point.x, point.y, point.z].every(Number.isFinite)) {
    throw new TypeError('Draw vertex must have finite XYZ coordinates.');
  }
}

function samePoint(left: ConstructionPoint, right: ConstructionPoint): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) <= 1e-6;
}
