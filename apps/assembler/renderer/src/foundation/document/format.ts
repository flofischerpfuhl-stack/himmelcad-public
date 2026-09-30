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
import type { EdgeRef, FaceRef, Feature } from './document.js';
import './coreKinds.js';
import { featureKindDefinition, type FormatHelpers } from './featureKinds.js';
import { isValidParameterName, type Parameter, type ParameterUnit } from './parameters.js';

export const PROJECT_FORMAT_ID = 'himmelcad-assembler';
/**
 * Schema history: 1 = rectangle/circle sketch profiles; 2 = constrained
 * sketches (entities, constraints, dimensions) and region-keyed extrude
 * profiles (`sketch/migration.ts` migrates 1 → 2); 3 = document parameters
 * (`parameters`, `model/parameters.ts`) and `*Expression` fields on
 * extrude/fillet/chamfer/shell (`v2 -> v3` adds an empty `parameters` array;
 * existing features already lack the optional expression fields).
 */
export const CURRENT_SCHEMA_VERSION = 3;

/** View-only state worth restoring on Open; never affects geometry or undo history. */
export interface ProjectViewState {
  /** Unknown modes (from newer apps) are ignored on load. */
  displayMode?: 'shaded' | 'wireframe' | 'xray' | 'visualized' | 'zebra' | 'curvature';
  /** Display toggles (`model/viewDisplay.ts`); absent = defaults. */
  display?: {
    edges?: boolean;
    hiddenEdges?: boolean;
    axes?: boolean;
  };
  camera?: {
    /** Last requested camera preset (e.g. `"iso"`, `"top"`); re-applied on Open. */
    preset?: string;
  };
  section?: {
    enabled?: boolean;
    axis?: 'X' | 'Y' | 'Z';
    offset?: number;
    flipped?: boolean;
    /** Face-aligned plane (overrides `axis`). */
    plane?: { normal: [number, number, number]; origin: [number, number, number]; label: string };
    /** 2D "section only" view. */
    sectionOnly?: boolean;
  };
  /** Pinned measurements (`model/measure.ts` `PinnedMeasurement`); malformed entries are dropped on load. */
  measurements?: unknown[];
  grid?: {
    visible?: boolean;
    snap?: boolean;
    step?: number;
    /** Zoom-dependent resolution; absent in older files, which then reopen locked at `step`. */
    auto?: boolean;
  };
  panels?: {
    items?: boolean;
    history?: boolean;
    parameters?: boolean;
  };
  /** Saved camera views (up to 8, `model/workspace.ts` `SavedView`); malformed entries are dropped on load. */
  savedViews?: unknown[];
}

/**
 * Items organisation (`model/items.ts`): body display names and folders.
 * Optional and additive — files without it load unchanged, older apps
 * ignore it (no schema bump needed: it never affects geometry).
 */
export interface ProjectItems {
  names: Record<string, string>;
  folders: { id: string; name: string; collapsed: boolean }[];
  parent: Record<string, string>;
}

/**
 * One imported STL, persisted as gzip+base64 mesh data
 * (`model/project/meshCodec.ts`) plus its document-level transform and
 * visibility. Never a `Feature`: a reference mesh is not a kernel/OCCT
 * input (`apps/assembler/README.md` "STL import").
 */
export interface ReferenceMeshRecordV1 {
  id: string;
  name: string;
  fileName: string;
  /** gzip+base64 of positions/normals/indices, see `meshCodec.ts`. */
  data: string;
  min: [number, number, number];
  max: [number, number, number];
  transform: { dx: number; dy: number; dz: number };
  hidden: boolean;
  /** `#RRGGBB` colour from the imported file (3MF/OBJ); optional and additive. */
  color?: string;
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
  /**
   * Preview image for the Home screen's recent projects: a small PNG of the
   * view at the last Save, as a `data:image/png;base64,…` URL (at most
   * {@link MAX_THUMBNAIL_CHARS}). Optional and additive (no schema bump):
   * written right after `projectName` so the Home screen reads it from the
   * start of the file without parsing the model; an invalid one is dropped
   * on load, never a reason to reject the project.
   */
  thumbnail?: string;
  features: Feature[];
  /** Document parameters ("variables"), schema v3+. Always present once loaded (defaults to `[]`). */
  parameters: Parameter[];
  referenceMeshes?: ReferenceMeshRecordV1[];
  viewState?: ProjectViewState;
  items?: ProjectItems;
  createdAt: string;
  modifiedAt: string;
}

export type ProjectFile = ProjectFileV1;

/** Upper bound of a stored thumbnail data URL (a 320 × 200 PNG is typically 20–120 kB). */
export const MAX_THUMBNAIL_CHARS = 400_000;
const THUMBNAIL_PREFIX = 'data:image/png;base64,';

/** `true` for a PNG data URL of acceptable size (base64 alphabet only). */
export function isValidThumbnail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_THUMBNAIL_CHARS &&
    value.startsWith(THUMBNAIL_PREFIX) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(THUMBNAIL_PREFIX.length))
  );
}

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

function validateVec3Tuple(v: unknown, path: string): [number, number, number] {
  if (!isVec3(v)) fail(path, 'expected a Vec3');
  return v as [number, number, number];
}

function validateReferenceMesh(v: unknown, index: number): ReferenceMeshRecordV1 {
  const path = `referenceMeshes[${index}]`;
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v;
  if (!isString(r.id) || r.id === '') fail(`${path}.id`, 'expected a non-empty string');
  if (!isString(r.name)) fail(`${path}.name`, 'expected a string');
  if (!isString(r.fileName)) fail(`${path}.fileName`, 'expected a string');
  if (!isString(r.data) || r.data === '') fail(`${path}.data`, 'expected a non-empty string');
  const min = validateVec3Tuple(r.min, `${path}.min`);
  const max = validateVec3Tuple(r.max, `${path}.max`);
  if (!isRecord(r.transform)) fail(`${path}.transform`, 'expected an object');
  const t = r.transform;
  for (const field of ['dx', 'dy', 'dz']) {
    if (!isNumber(t[field])) fail(`${path}.transform.${field}`, 'expected a number');
  }
  if (!isBoolean(r.hidden)) fail(`${path}.hidden`, 'expected a boolean');
  if (r.color !== undefined && (!isString(r.color) || !/^#[0-9a-fA-F]{6}$/.test(r.color))) {
    fail(`${path}.color`, 'expected a "#RRGGBB" string');
  }
  return {
    id: r.id,
    name: r.name,
    fileName: r.fileName,
    data: r.data,
    min,
    max,
    transform: { dx: t.dx as number, dy: t.dy as number, dz: t.dz as number },
    hidden: r.hidden,
    ...(r.color !== undefined ? { color: r.color as string } : {}),
  };
}

function validateParameter(v: unknown, index: number): Parameter {
  const path = `parameters[${index}]`;
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v;
  if (!isString(r.id) || r.id === '') fail(`${path}.id`, 'expected a non-empty string');
  if (!isString(r.name) || !isValidParameterName(r.name)) {
    fail(
      `${path}.name`,
      'expected an identifier (letters, digits, underscore, not starting with a digit)',
    );
  }
  if (!['mm', 'deg', ''].includes(r.unit as string)) {
    fail(`${path}.unit`, 'expected "mm", "deg" or ""');
  }
  if (!isNumber(r.value)) fail(`${path}.value`, 'expected a number');
  if (r.expression !== undefined && !isString(r.expression)) {
    fail(`${path}.expression`, 'expected a string');
  }
  return {
    id: r.id,
    name: r.name,
    unit: r.unit as ParameterUnit,
    value: r.value,
    ...(r.expression !== undefined ? { expression: r.expression as string } : {}),
  };
}

function validateParameters(v: unknown): Parameter[] {
  if (!Array.isArray(v)) fail('parameters', 'expected an array');
  const parameters = v.map((p, i) => validateParameter(p, i));
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const p of parameters) {
    if (ids.has(p.id)) fail('parameters', `duplicate parameter id "${p.id}"`);
    ids.add(p.id);
    if (names.has(p.name)) fail('parameters', `duplicate parameter name "${p.name}"`);
    names.add(p.name);
  }
  return parameters;
}

function validateBase(r: Record<string, unknown>, path: string): void {
  if (!isString(r.id) || r.id === '') fail(`${path}.id`, 'expected a non-empty string');
  if (!isString(r.name)) fail(`${path}.name`, 'expected a string');
  if (!isBoolean(r.suppressed)) fail(`${path}.suppressed`, 'expected a boolean');
}

const FORMAT_HELPERS: FormatHelpers = {
  fail,
  faceRef: validateFaceRef,
  edgeRef: validateEdgeRef,
};

/**
 * Validates one feature and narrows it to {@link Feature}, or throws
 * {@link ProjectFormatError}. The kind's own fields are checked by the
 * validator its module registered (`featureKinds.ts`).
 */
function validateFeature(v: unknown, index: number): Feature {
  const path = `features[${index}]`;
  if (!isRecord(v)) fail(path, 'expected an object');
  const r = v;
  validateBase(r, path);
  const definition = featureKindDefinition(String(r.kind));
  if (!definition || typeof r.kind !== 'string') {
    fail(`${path}.kind`, `unknown feature kind "${String(r.kind)}"`);
  }
  definition.validate(r, path, FORMAT_HELPERS);
  return r as unknown as Feature;
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
  const parameters = validateParameters(raw.parameters ?? []);
  if (!isString(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt))) {
    fail('createdAt', 'expected an ISO 8601 date string');
  }
  if (!isString(raw.modifiedAt) || Number.isNaN(Date.parse(raw.modifiedAt))) {
    fail('modifiedAt', 'expected an ISO 8601 date string');
  }
  if (raw.viewState !== undefined && !isRecord(raw.viewState)) {
    fail('viewState', 'expected an object');
  }
  const items = raw.items !== undefined ? validateItems(raw.items) : undefined;
  let referenceMeshes: ReferenceMeshRecordV1[] | undefined;
  if (raw.referenceMeshes !== undefined) {
    if (!Array.isArray(raw.referenceMeshes)) fail('referenceMeshes', 'expected an array');
    referenceMeshes = raw.referenceMeshes.map((m, i) => validateReferenceMesh(m, i));
    const meshIds = new Set<string>();
    for (const m of referenceMeshes) {
      if (meshIds.has(m.id)) fail('referenceMeshes', `duplicate reference mesh id "${m.id}"`);
      meshIds.add(m.id);
    }
  }
  return {
    format: PROJECT_FORMAT_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: raw.appVersion,
    units: 'mm',
    projectName: raw.projectName,
    ...(isValidThumbnail(raw.thumbnail) ? { thumbnail: raw.thumbnail } : {}),
    features,
    parameters,
    ...(referenceMeshes !== undefined ? { referenceMeshes } : {}),
    ...(raw.viewState !== undefined ? { viewState: raw.viewState as ProjectViewState } : {}),
    ...(items ? { items } : {}),
    createdAt: raw.createdAt,
    modifiedAt: raw.modifiedAt,
  };
}

function validateStringRecord(v: unknown, path: string): Record<string, string> {
  if (!isRecord(v)) fail(path, 'expected an object');
  for (const [key, value] of Object.entries(v)) {
    if (!isString(value)) fail(`${path}.${key}`, 'expected a string');
  }
  return v as Record<string, string>;
}

function validateItems(v: unknown): ProjectItems {
  if (!isRecord(v)) fail('items', 'expected an object');
  const names = validateStringRecord(v.names ?? {}, 'items.names');
  const parent = validateStringRecord(v.parent ?? {}, 'items.parent');
  const folders = v.folders ?? [];
  if (!Array.isArray(folders)) fail('items.folders', 'expected an array');
  const ids = new Set<string>();
  const checked = folders.map((f, i) => {
    const path = `items.folders[${i}]`;
    if (!isRecord(f)) fail(path, 'expected an object');
    if (!isString(f.id) || f.id === '') fail(`${path}.id`, 'expected a non-empty string');
    if (ids.has(f.id)) fail(`${path}.id`, `duplicate folder id "${f.id}"`);
    ids.add(f.id);
    if (!isString(f.name)) fail(`${path}.name`, 'expected a string');
    if (f.collapsed !== undefined && !isBoolean(f.collapsed)) {
      fail(`${path}.collapsed`, 'expected a boolean');
    }
    return { id: f.id, name: f.name, collapsed: f.collapsed === true };
  });
  return { names, folders: checked, parent };
}

// ---- migration -----------------------------------------------------------------

/** One migration step of a raw body from schema version `n` to `n + 1`. */
export type FormatMigration = (body: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration steps by source version; `n` migrates a v`n` body to v`n+1`.
 * The module that owns the data a step rewrites registers it
 * ({@link registerFormatMigration}); steps of one version run in
 * registration order. v1 → v2 (sketches) is registered by the sketch solver
 * (`sketch-solver/sketchFeature.ts`).
 */
const MIGRATIONS = new Map<number, FormatMigration[]>();

/** Registers a migration step from schema version `fromVersion` to `fromVersion + 1`. */
export function registerFormatMigration(fromVersion: number, migrate: FormatMigration): void {
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion >= CURRENT_SCHEMA_VERSION) {
    throw new Error(`No schema version ${fromVersion} to migrate from`);
  }
  const steps = MIGRATIONS.get(fromVersion) ?? [];
  if (!steps.includes(migrate)) steps.push(migrate);
  MIGRATIONS.set(fromVersion, steps);
}

// v2 -> v3: document parameters ("variables"); older files simply have none.
registerFormatMigration(2, (body) => ({ ...body, parameters: body.parameters ?? [] }));

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
    const steps = MIGRATIONS.get(v);
    if (!steps || steps.length === 0) {
      throw new ProjectFormatError(
        `Invalid project file: no migration registered from schema version ${v}.`,
      );
    }
    for (const migrate of steps) current = migrate(current);
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
  // The validators recurse; a deeply nested (corrupt or hostile) file must fail as a format
  // error, not as a stack overflow (fuzzing finding F5, `assembler/ROBUSTNESS.md`).
  if (nestingDepth(raw, MAX_NESTING_DEPTH) > MAX_NESTING_DEPTH) {
    throw new ProjectFormatError(
      `Invalid project file: data is nested more than ${MAX_NESTING_DEPTH} levels deep.`,
    );
  }
  return migrateAndValidate(raw.schemaVersion, raw);
}

/** Far above any real project (features → sketch entities → points is under 10 levels). */
export const MAX_NESTING_DEPTH = 64;

/** Nesting depth of parsed JSON, iteratively; stops counting once past `limit`. */
function nestingDepth(value: unknown, limit: number): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (depth > deepest) deepest = depth;
    if (deepest > limit) return deepest;
    for (const child of Array.isArray(node) ? node : Object.values(node as object)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return deepest;
}

/** Serializes a document into v1 project file JSON text (pretty-printed for diffability). */
export function saveProjectFile(input: {
  projectName: string;
  features: Feature[];
  appVersion: string;
  parameters?: Parameter[];
  referenceMeshes?: ReferenceMeshRecordV1[];
  viewState?: ProjectViewState;
  items?: ProjectItems;
  /** Home screen preview (`data:image/png;base64,…`); dropped when invalid or too large. */
  thumbnail?: string | null;
  createdAt: string;
  modifiedAt?: string;
}): string {
  const file: ProjectFileV1 = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: input.appVersion,
    units: 'mm',
    projectName: input.projectName,
    // Early in the file: the Home screen reads it from the first bytes (`electron/recentFiles.ts`).
    ...(isValidThumbnail(input.thumbnail) ? { thumbnail: input.thumbnail } : {}),
    features: input.features,
    parameters: input.parameters ?? [],
    ...(input.referenceMeshes && input.referenceMeshes.length > 0
      ? { referenceMeshes: input.referenceMeshes }
      : {}),
    ...(input.viewState ? { viewState: input.viewState } : {}),
    ...(input.items ? { items: input.items } : {}),
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt ?? new Date().toISOString(),
  };
  return JSON.stringify(file, null, 2);
}
