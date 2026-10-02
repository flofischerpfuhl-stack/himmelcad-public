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
import {
  featureFormatCapabilities,
  featureKindDefinition,
  type FormatHelpers,
} from './featureKinds.js';
import { requiredCapabilitiesList, unknownRequiredCapabilities } from './formatCapabilities.js';
import {
  isValidParameterName,
  PARAMETER_RANGE_FIELDS,
  type Parameter,
  type ParameterUnit,
} from './parameters.js';

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

/**
 * The section-view part of {@link ProjectViewState}: the document store's
 * own fields. Modules add theirs by augmenting this interface (display: the
 * face-aligned plane and "section only").
 */
export interface ProjectSectionView {
  enabled?: boolean;
  axis?: 'X' | 'Y' | 'Z';
  offset?: number;
  flipped?: boolean;
}

/**
 * View-only state worth restoring on Open; never affects geometry or undo
 * history. Lenient: only an object is required, parts are validated by
 * whoever applies them and malformed ones are ignored. The document store's
 * parts are declared here (camera preset, section, grid, panels); modules
 * add their parts by augmenting this interface and registering the key's
 * position in the file ({@link registerViewStatePart}): display (display
 * mode and toggles), measure (pinned measurements), the shell (saved views).
 */
export interface ProjectViewState {
  camera?: {
    /** Last requested camera preset (e.g. `"iso"`, `"top"`); re-applied on Open. */
    preset?: string;
  };
  section?: ProjectSectionView;
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
}

/**
 * Project-level data the modules keep next to the features (the items
 * organisation, reference meshes, …). Optional and additive: files without
 * a field load unchanged and older apps ignore it. A module augments this
 * interface and registers the field's strict validator and its position in
 * the file ({@link registerProjectFileField}), so this file knows only the
 * core fields.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface ProjectFileFields {}
export interface ProjectFileV1 extends ProjectFileFields {
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
  viewState?: ProjectViewState;
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
  // Range (Block 9, optional): resolved bounds/step plus their formulas. Whether the value
  // lies inside is not a format question: an out-of-range value loads and is flagged in the panel.
  const range: Partial<Parameter> = {};
  for (const field of PARAMETER_RANGE_FIELDS) {
    const value = r[field];
    if (value !== undefined) {
      if (!isNumber(value)) fail(`${path}.${field}`, 'expected a number');
      range[field] = value;
    }
    const expression = r[`${field}Expression`];
    if (expression !== undefined) {
      if (!isString(expression) || expression.trim() === '') {
        fail(`${path}.${field}Expression`, 'expected a non-empty string');
      }
      if (value === undefined)
        fail(`${path}.${field}`, `expected a number with ${field}Expression`);
      range[`${field}Expression`] = expression;
    }
  }
  if (range.step !== undefined && !(range.step > 0)) fail(`${path}.step`, 'expected a number > 0');
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
    fail(`${path}.min`, 'expected min ≤ max');
  }
  return {
    id: r.id,
    name: r.name,
    unit: r.unit as ParameterUnit,
    value: r.value,
    ...(r.expression !== undefined ? { expression: r.expression as string } : {}),
    ...range,
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

// ---- module file fields --------------------------------------------------------

/** Value checks and the path-qualified failure a field validator uses. */
export interface FileFieldHelpers {
  /** Throws {@link ProjectFormatError} for `path`. */
  fail(path: string, message: string): never;
  isRecord(v: unknown): v is Record<string, unknown>;
  isString(v: unknown): v is string;
  isNumber(v: unknown): v is number;
  isBoolean(v: unknown): v is boolean;
  isVec3(v: unknown): v is [number, number, number];
}

const FIELD_HELPERS: FileFieldHelpers = { fail, isRecord, isString, isNumber, isBoolean, isVec3 };

/**
 * A top-level project-file field a module owns (`ProjectFileFields`). On
 * load, `validate` checks the raw value strictly (any problem rejects the
 * whole file, never a partial load) and returns what is kept; on save the
 * field is written at `order` among the fields between `parameters` and
 * `createdAt`, unless `include` says it is empty.
 */
export interface ProjectFileFieldDefinition<K extends keyof ProjectFileFields> {
  key: K;
  /** Owning module id (`modules.json`). */
  module: string;
  order: number;
  validate(raw: unknown, helpers: FileFieldHelpers): NonNullable<ProjectFileFields[K]>;
  /** Whether a defined value is written (`false`: an empty list is left out). Default: always. */
  include?(value: NonNullable<ProjectFileFields[K]>): boolean;
}

interface FieldEntry {
  key: string;
  module: string;
  order: number;
  validate(raw: unknown, helpers: FileFieldHelpers): unknown;
  include?(value: never): boolean;
}

/** `viewState`'s position among the fields (reference meshes before it, items after it). */
export const VIEW_STATE_FIELD_ORDER = 200;

const CORE_KEYS = new Set([
  'format',
  'schemaVersion',
  'requires',
  'appVersion',
  'units',
  'projectName',
  'thumbnail',
  'features',
  'parameters',
  'viewState',
  'createdAt',
  'modifiedAt',
]);

const VIEW_STATE_FIELD: FieldEntry = {
  key: 'viewState',
  module: 'document',
  order: VIEW_STATE_FIELD_ORDER,
  validate: (raw) => {
    if (!isRecord(raw)) fail('viewState', 'expected an object');
    return raw;
  },
};

const fileFields: FieldEntry[] = [VIEW_STATE_FIELD];

/** Registers a module's project-file field (once per key). */
export function registerProjectFileField<K extends keyof ProjectFileFields>(
  definition: ProjectFileFieldDefinition<K>,
): void {
  const key = String(definition.key);
  if (CORE_KEYS.has(key)) throw new Error(`"${key}" is a core project-file field`);
  const known = fileFields.find((f) => f.key === key);
  if (known) {
    if (known === (definition as unknown as FieldEntry)) return;
    throw new Error(
      `Project-file field "${key}" is registered twice (${known.module}, ${definition.module})`,
    );
  }
  fileFields.push(definition as unknown as FieldEntry);
  fileFields.sort((a, b) => a.order - b.order);
}

const viewStateParts = new Map<string, { module: string; order: number }>();

/**
 * Registers a part of {@link ProjectViewState} and its position inside
 * `viewState` when saved (the parts keep one stable key order whichever
 * module writes first). Parts are lenient: they are validated where they
 * are applied, and malformed ones are ignored.
 */
export function registerViewStatePart(part: {
  key: keyof ProjectViewState;
  module: string;
  order: number;
}): void {
  const known = viewStateParts.get(part.key);
  if (known && known.module !== part.module) {
    throw new Error(
      `View-state part "${part.key}" is registered twice (${known.module}, ${part.module})`,
    );
  }
  viewStateParts.set(part.key, { module: part.module, order: part.order });
}

// The document store's own view-state parts (`commands/store.ts` applies them).
registerViewStatePart({ key: 'camera', module: 'commands', order: 200 });
registerViewStatePart({ key: 'section', module: 'commands', order: 300 });
registerViewStatePart({ key: 'grid', module: 'commands', order: 500 });
registerViewStatePart({ key: 'panels', module: 'commands', order: 600 });

/** `view` with its parts in their registered order (unregistered parts after them, as given). */
function orderedViewState(view: ProjectViewState): ProjectViewState {
  const keys = Object.keys(view);
  const rank = (key: string) => viewStateParts.get(key)?.order ?? Number.POSITIVE_INFINITY;
  const sorted = keys
    .map((key, index) => ({ key, index }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index);
  const out: Record<string, unknown> = {};
  for (const { key } of sorted) out[key] = (view as Record<string, unknown>)[key];
  return out as ProjectViewState;
}

/**
 * Strictly validates a parsed JSON value as a v1 project body (everything
 * except `format`/`schemaVersion`, already checked by {@link loadProjectFile}).
 * Throws {@link ProjectFormatError} with a path-qualified message on the
 * first problem found — never returns a partially valid project. The module
 * fields are checked by the validators their modules registered.
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
  const fields: Record<string, unknown> = {};
  for (const field of fileFields) {
    if (raw[field.key] !== undefined) {
      fields[field.key] = field.validate(raw[field.key], FIELD_HELPERS);
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
    ...fields,
    createdAt: raw.createdAt,
    modifiedAt: raw.modifiedAt,
  };
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
  // Minimum-reader rule (`formatCapabilities.ts`): a capability this build does not know
  // would otherwise be ignored and the feature built differently. A newer schema says so first.
  if (raw.schemaVersion <= CURRENT_SCHEMA_VERSION) {
    const required = unknownRequiredCapabilities(raw.requires);
    if (required.kind === 'malformed') fail('requires', required.message);
    if (required.kind === 'unknown') throw new ProjectFormatError(required.message);
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

/** What {@link saveProjectFile} writes: the core fields plus the modules' fields. */
export interface ProjectFileInput extends ProjectFileFields {
  projectName: string;
  features: Feature[];
  appVersion: string;
  parameters?: Parameter[];
  viewState?: ProjectViewState;
  /** Home screen preview (`data:image/png;base64,…`); dropped when invalid or too large. */
  thumbnail?: string | null;
  createdAt: string;
  modifiedAt?: string;
}

/**
 * Serializes a document into v1 project file JSON text (pretty-printed for
 * diffability). The module fields are written in their registered order
 * (only registered fields are written), the view-state parts in theirs.
 */
export function saveProjectFile(input: ProjectFileInput): string {
  const values = input as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const field of fileFields) {
    const value = values[field.key];
    if (value === undefined || value === null) continue;
    if (field.include && !field.include(value as never)) continue;
    fields[field.key] =
      field === VIEW_STATE_FIELD ? orderedViewState(value as ProjectViewState) : value;
  }
  // Written only when the document uses a geometry-changing optional field (`formatCapabilities.ts`).
  const requires = requiredCapabilitiesList(featureFormatCapabilities(input.features));
  const file = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...(requires ? { requires } : {}),
    appVersion: input.appVersion,
    units: 'mm',
    projectName: input.projectName,
    // Early in the file: the Home screen reads it from the first bytes (`electron/recentFiles.ts`).
    ...(isValidThumbnail(input.thumbnail) ? { thumbnail: input.thumbnail } : {}),
    features: input.features,
    parameters: input.parameters ?? [],
    ...fields,
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt ?? new Date().toISOString(),
  };
  return JSON.stringify(file, null, 2);
}
