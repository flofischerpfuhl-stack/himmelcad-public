/**
 * Hand-written contract types for the renderer.
 * Generated counterparts (from Rust via ts-rs) will land in src/generated/
 * and re-export through this barrel. Until the Rust contract crate ships,
 * these definitions are authoritative for the renderer-only skeleton.
 */

export type EntityId = string & { readonly __brand: 'EntityId' };

export type ObjectHash = string & { readonly __brand: 'ObjectHash' };

export type EntityKind =
  | 'ProjectRoot'
  | 'Group'
  | 'Layer'
  | 'PointCloud'
  | 'PointCloudSegment'
  | 'SinglePoint'
  | 'Polyline3D'
  | 'Mesh'
  | 'TexturedMesh'
  | 'GaussianSplatCloud'
  | 'Text'
  | 'Axis'
  | 'AlignmentElement'
  | 'IfcElement'
  | 'Pipe'
  | 'Manhole'
  | 'SimulationOverlay';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export interface VisibilityState {
  visible: boolean;
  locked: boolean;
}

export interface EntitySnapshot {
  id: EntityId;
  kind: EntityKind;
  name: string;
  parent: EntityId | null;
  children: EntityId[];
  visibility: VisibilityState;
  versionHash: ObjectHash;
  bounds: Bounds3 | null;
}

export interface ProjectSnapshot {
  formatVersion: number;
  projectId: string;
  name: string;
  rootEntity: EntityId;
  entities: Record<string, EntitySnapshot>;
  renderOffset: Vec3;
}

export type SnapKind =
  | 'Point'
  | 'Vertex'
  | 'Edge'
  | 'Face'
  | 'Grid'
  | 'EstimatedSurface'
  | 'Free';

export interface SnapResult {
  position: Vec3;
  kind: SnapKind;
  entity: EntityId | null;
  confidence: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  source: 'renderer' | 'sidecar' | 'electron';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type CommandKind =
  | 'CreateProject'
  | 'OpenProject'
  | 'ImportPointCloudBatch'
  | 'RenameEntity'
  | 'SetEntityVisibility'
  | 'SetEntityStyle'
  | 'CreateSelectionMask'
  | 'ExtractPointCloudSegment'
  | 'SetPanelState';

export interface CommandRequest<P = unknown> {
  kind: CommandKind;
  payload: P;
}

export interface CommandResult {
  ok: boolean;
  affectedEntities: EntityId[];
  message?: string;
}
