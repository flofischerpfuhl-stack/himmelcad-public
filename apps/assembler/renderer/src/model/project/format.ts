/**
 * `.hcasm` project file format: JSON (UTF-8), one schema version per
 * released shape, strict validation on load (never a partial load of a
 * broken file — see `docs/PROJECT-FORMAT.md`'s "never publish a reference
 * to missing or unverified content" spirit, applied to a single-file CAD
 * document rather than the civil `.hcad` package).
 *
 * `format`/`schemaVersion` are load-bearing: a file the app cannot fully
 * understand is rejected with a clear message rather than opened read-only
 * or partially, because a CAD feature list is a single indivisible
 * document — there is no meaningful "read-only partial" B-rep history.
 */
import {
  type Feature,
  type BooleanFeature,
  type ChamferFeature,
  type EdgeRef,
  type ExtrudeFeature,
  type FaceRef,
  type FilletFeature,
  type ImportStepFeature,
  type MoveFeature,
  type SetAppearanceFeature,
  type ShellFeature,
  type SketchFeature,
} from '../document.js';
import { migrateSketchesV1ToV2 } from '../../sketch/migration.js';
import { validateSketchData } from '../../sketch/validation.js';
import { isModelingFeatureKind, validateModelingFeature } from './featureFormat.js';

export const PROJECT_FORMAT_ID = 'himmelcad-assembler';
/**
 * Schema history: 1 = rectangle/circle sketch profiles; 2 = constrained
 * sketches (entities, constraints, dimensions) and region-keyed extrude
 * profiles (`sketch/migration.ts` migrates 1 → 2).
 */
export const CURRENT_SCHEMA_VERSION = 2;

/** View-only state worth restoring on Open; never affects geometry or undo history. */
export interface ProjectViewState {
  displayMode?: 'shaded' | 'wireframe' | 'xray';
  camera?: {
    preset?: string;
  };
  panels?: {
    items?: boolean;
    history?: boolean;
  };
}

export interface ProjectFileV1 {
  format: typeof PROJECT_FORMAT_ID;
  /** Always the current schema once loaded (older files are migrated). */
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  /** `@himmelcad/assembler` package version that wrote the file, for diagnostics only. */
  appVersion: string;
  /** Always `"mm"` for Phase 1 — the app has no other unit. */
  units: 'mm';
  projectName: string;
  features: Feature[];
  viewState?: ProjectViewState;
  createdAt: string;
  modifiedAt: string;
}

export type ProjectFile = ProjectFileV1;

export class ProjectFormatError extends Error {}

// ---- validation --------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(isNumber);
}

function fail(path: string, message: string): never {
  throw new ProjectFormatError(`Invalid project file at ${path}: ${message}`);
}

function validateFaceSignature(v: unknown, path: string): void {
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v as Record<string, unknown>;
  if (!['plane', 'cylinder', 'cone', 'sphere', 'torus', 'other'].includes(r.surface as string)) {
    fail(`${path}.surface`, 'unknown surface kind');
  }
  if (r.normal !== null && !isVec3(r.normal)) fail(`${path}.normal`, 'expected a Vec3 or null');
  if (!isVec3(r.centroid)) fail(`${path}.centroid`, 'expected a Vec3');
  if (!isNumber(r.area)) fail(`${path}.area`, 'expected a number');
  if (!isNumber(r.adjacentFaces)) fail(`${path}.adjacentFaces`, 'expected a number');
}

function validateFaceRef(v: unknown, path: string): FaceRef {
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v as Record<string, unknown>;
  if (!isString(r.bodyId)) fail(`${path}.bodyId`, 'expected a string');
  if (!isString(r.key)) fail(`${path}.key`, 'expected a string');
  validateFaceSignature(r.signature, `${path}.signature`);
  return v as unknown as FaceRef;
}

function validateEdgeSignature(v: unknown, path: string): void {
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v as Record<string, unknown>;
  if (!['line', 'circle', 'ellipse', 'other'].includes(r.curve as string)) {
    fail(`${path}.curve`, 'unknown curve kind');
  }
  if (!isVec3(r.midpoint)) fail(`${path}.midpoint`, 'expected a Vec3');
  if (!isNumber(r.length)) fail(`${path}.length`, 'expected a number');
  if (r.direction !== null && !isVec3(r.direction)) {
    fail(`${path}.direction`, 'expected a Vec3 or null');
  }
}

function validateEdgeRef(v: unknown, path: string): EdgeRef {
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v as Record<string, unknown>;
  if (!isString(r.bodyId)) fail(`${path}.bodyId`, 'expected a string');
  if (!isString(r.key)) fail(`${path}.key`, 'expected a string');
  validateEdgeSignature(r.signature, `${path}.signature`);
  return v as unknown as EdgeRef;
}

function validateBase(r: Record<string, unknown>, path: string): void {
  if (!isString(r.id) || r.id === '') fail(`${path}.id`, 'expected a non-empty string');
  if (!isString(r.name)) fail(`${path}.name`, 'expected a string');
  if (!isBoolean(r.suppressed)) fail(`${path}.suppressed`, 'expected a boolean');
}

/** Validates one feature and narrows it to {@link Feature}, or throws {@link ProjectFormatError}. */
function validateFeature(v: unknown, index: number): Feature {
  const path = `features[${index}]`;
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v;
  validateBase(r, path);
  switch (r.kind) {
    case 'sketch': {
      const plane = r.plane;
      if (!isRecord(plane)) fail(`${path}.plane`, 'expected an object');
      if (plane.kind === 'plane') {
        if (!['XY', 'XZ', 'YZ'].includes(plane.plane as string)) {
          fail(`${path}.plane.plane`, 'expected XY, XZ or YZ');
        }
        if (!isNumber(plane.offset)) fail(`${path}.plane.offset`, 'expected a number');
      } else if (plane.kind === 'face') {
        validateFaceRef(plane.face, `${path}.plane.face`);
      } else {
        fail(`${path}.plane.kind`, 'expected "plane" or "face"');
      }
      const sketchError = validateSketchData(r);
      if (sketchError) fail(`${path}.${sketchError.path}`, sketchError.message);
      return r as unknown as SketchFeature;
    }
    case 'extrude': {
      const profile = r.profile;
      if (!isRecord(profile)) fail(`${path}.profile`, 'expected an object');
      if (profile.kind === 'sketch') {
        if (!isString(profile.featureId)) fail(`${path}.profile.featureId`, 'expected a string');
        if (
          profile.regions !== undefined &&
          (!Array.isArray(profile.regions) || !profile.regions.every(isString))
        ) {
          fail(`${path}.profile.regions`, 'expected an array of region keys');
        }
      } else if (profile.kind === 'face') {
        validateFaceRef(profile.face, `${path}.profile.face`);
      } else {
        fail(`${path}.profile.kind`, 'expected "sketch" or "face"');
      }
      if (!isNumber(r.distance)) fail(`${path}.distance`, 'expected a number');
      if (!isBoolean(r.symmetric)) fail(`${path}.symmetric`, 'expected a boolean');
      if (!['new', 'join', 'cut'].includes(r.operation as string)) {
        fail(`${path}.operation`, 'expected "new", "join" or "cut"');
      }
      if (r.targetBodyId !== undefined && !isString(r.targetBodyId)) {
        fail(`${path}.targetBodyId`, 'expected a string');
      }
      return r as unknown as ExtrudeFeature;
    }
    case 'fillet':
    case 'chamfer': {
      if (!Array.isArray(r.edges) || r.edges.length === 0) {
        fail(`${path}.edges`, 'expected a non-empty array');
      }
      r.edges.forEach((e, i) => validateEdgeRef(e, `${path}.edges[${i}]`));
      const sizeField = r.kind === 'fillet' ? 'radius' : 'distance';
      if (!isNumber(r[sizeField])) fail(`${path}.${sizeField}`, 'expected a number');
      return r as unknown as FilletFeature | ChamferFeature;
    }
    case 'shell': {
      if (!isString(r.bodyId)) fail(`${path}.bodyId`, 'expected a string');
      if (!Array.isArray(r.faces) || r.faces.length === 0) {
        fail(`${path}.faces`, 'expected a non-empty array');
      }
      r.faces.forEach((f, i) => validateFaceRef(f, `${path}.faces[${i}]`));
      if (!isNumber(r.thickness)) fail(`${path}.thickness`, 'expected a number');
      return r as unknown as ShellFeature;
    }
    case 'boolean': {
      if (!['union', 'subtract', 'intersect'].includes(r.operation as string)) {
        fail(`${path}.operation`, 'expected "union", "subtract" or "intersect"');
      }
      if (!isString(r.targetBodyId)) fail(`${path}.targetBodyId`, 'expected a string');
      if (!Array.isArray(r.toolBodyIds) || !r.toolBodyIds.every(isString)) {
        fail(`${path}.toolBodyIds`, 'expected an array of strings');
      }
      return r as unknown as BooleanFeature;
    }
    case 'move': {
      for (const field of ['dx', 'dy', 'dz']) {
        if (!isNumber(r[field])) fail(`${path}.${field}`, 'expected a number');
      }
      if (!isString(r.bodyId)) fail(`${path}.bodyId`, 'expected a string');
      return r as unknown as MoveFeature;
    }
    case 'setAppearance': {
      if (!isString(r.bodyId)) fail(`${path}.bodyId`, 'expected a string');
      if (!isString(r.color) || !/^#[0-9a-fA-F]{6}$/.test(r.color)) {
        fail(`${path}.color`, 'expected a "#RRGGBB" string');
      }
      return r as unknown as SetAppearanceFeature;
    }
    case 'importStep': {
      if (!isString(r.data) || r.data === '') fail(`${path}.data`, 'expected a non-empty string');
      if (!isString(r.fileName)) fail(`${path}.fileName`, 'expected a string');
      return r as unknown as ImportStepFeature;
    }
    default:
      if (isModelingFeatureKind(r.kind)) {
        return validateModelingFeature(r, path, {
          fail,
          faceRef: validateFaceRef,
          edgeRef: validateEdgeRef,
        });
      }
      fail(`${path}.kind`, `unknown feature kind "${String(r.kind)}"`);
  }
}

/**
 * Strictly validates a parsed JSON value as a v1 project body (everything
 * except `format`/`schemaVersion`, already checked by {@link loadProjectFile}).
 * Throws {@link ProjectFormatError} with a path-qualified message on the
 * first problem found — never returns a partially valid project.
 */
function validateV1Body(raw: Record<string, unknown>): ProjectFileV1 {
  if (!isString(raw.appVersion)) fail('appVersion', 'expected a string');
  if (raw.units !== 'mm') fail('units', 'expected "mm"');
  if (!isString(raw.projectName) || raw.projectName.trim() === '') {
    fail('projectName', 'expected a non-empty string');
  }
  if (!Array.isArray(raw.features)) fail('features', 'expected an array');
  const features = raw.features.map((f, i) => validateFeature(f, i));
  const ids = new Set<string>();
  for (const f of features) {
    if (ids.has(f.id)) fail('features', `duplicate feature id "${f.id}"`);
    ids.add(f.id);
  }
  if (!isString(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt))) {
    fail('createdAt', 'expected an ISO 8601 date string');
  }
  if (!isString(raw.modifiedAt) || Number.isNaN(Date.parse(raw.modifiedAt))) {
    fail('modifiedAt', 'expected an ISO 8601 date string');
  }
  if (raw.viewState !== undefined && !isRecord(raw.viewState)) {
    fail('viewState', 'expected an object');
  }
  return {
    format: PROJECT_FORMAT_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: raw.appVersion,
    units: 'mm',
    projectName: raw.projectName,
    features,
    ...(raw.viewState !== undefined ? { viewState: raw.viewState as ProjectViewState } : {}),
    createdAt: raw.createdAt,
    modifiedAt: raw.modifiedAt,
  };
}

// ---- migration -----------------------------------------------------------------

type Migration = (body: Record<string, unknown>) => Record<string, unknown>;

/** One entry per schema version this app can read; `n` migrates a v`n` body to v`n+1`. */
const MIGRATIONS: Record<number, Migration> = {
  // v1 -> v2: rectangle/circle profiles become constrained sketches; extrude
  // profile indices become region keys; index-based face keys are renamed.
  1: (body) => ({ ...body, features: migrateSketchesV1ToV2(body.features) }),
};

/**
 * Migrates a raw parsed body from `fromVersion` up to {@link CURRENT_SCHEMA_VERSION},
 * then strictly validates the result. Rejects a version newer than this app
 * understands with a clear message (never silently drops fields).
 */
export function migrateAndValidate(
  fromVersion: number,
  body: Record<string, unknown>,
): ProjectFileV1 {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) {
    throw new ProjectFormatError(
      `Invalid project file: schemaVersion ${fromVersion} is not valid.`,
    );
  }
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new ProjectFormatError(
      `This project file was saved by a newer version of HimmelCAD Assembler ` +
        `(schema version ${fromVersion}; this app understands up to ${CURRENT_SCHEMA_VERSION}). ` +
        `Update the app to open it.`,
    );
  }
  let current = body;
  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v += 1) {
    const migrate = MIGRATIONS[v];
    if (!migrate) {
      throw new ProjectFormatError(
        `Invalid project file: no migration registered from schema version ${v}.`,
      );
    }
    current = migrate(current);
  }
  return validateV1Body(current);
}

/**
 * Parses and strictly validates a `.hcasm` file's JSON text. Never returns a
 * partially loaded project: any structural problem throws
 * {@link ProjectFormatError} with a human-readable message.
 */
export function loadProjectFile(text: string): ProjectFileV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProjectFormatError(
      `This file is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!isRecord(raw))
    throw new ProjectFormatError('This file is not a HimmelCAD Assembler project.');
  if (raw.format !== PROJECT_FORMAT_ID) {
    throw new ProjectFormatError(
      `This file is not a HimmelCAD Assembler project (expected format "${PROJECT_FORMAT_ID}", got ${JSON.stringify(raw.format)}).`,
    );
  }
  if (!isNumber(raw.schemaVersion)) {
    throw new ProjectFormatError('Invalid project file: missing or invalid schemaVersion.');
  }
  return migrateAndValidate(raw.schemaVersion, raw);
}

/** Serializes a document into v1 project file JSON text (pretty-printed for diffability). */
export function saveProjectFile(input: {
  projectName: string;
  features: Feature[];
  appVersion: string;
  viewState?: ProjectViewState;
  createdAt: string;
  modifiedAt?: string;
}): string {
  const file: ProjectFileV1 = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: input.appVersion,
    units: 'mm',
    projectName: input.projectName,
    features: input.features,
    ...(input.viewState ? { viewState: input.viewState } : {}),
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt ?? new Date().toISOString(),
  };
  return JSON.stringify(file, null, 2);
}
